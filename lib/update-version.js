require('dotenv')
  .config({
    silent: true
  })

const { execSync, exec, spawnSync } = require('child_process')
const GitHub = require('github-base')
const { readFile, writeFile, ensureFile, removeSync } = require('fs-extra')
const semver = require('semver')
const analyzeCommit = require('@semantic-release/commit-analyzer/lib/analyze-commit')
const compareReleaseTypes = require('@semantic-release/commit-analyzer/lib/compare-release-types')
const writer = require('conventional-changelog-writer')
const notesGenerator = require('../lib/notes-generator')
const getStream = require('get-stream')
const intoStream = require('into-stream')
const { add, commit, push } = require('@semantic-release/git/lib/git')
const branchName = require('current-git-branch')
const { exit } = require('process')

const GIT_AUTHOR_NAME = process.env.VERSION_RELEASE_GIT_AUTHOR_NAME || process.env.CIRCLE_USERNAME
const GIT_AUTHOR_EMAIL = process.env.VERSION_RELEASE_GIT_AUTHOR_EMAIL

/**
 * Pull request filename
 *
 * @type {string}
*/
const PR_MESSAGE_FILENAME = 'pr_message.txt'

/**
 * Release tags list (@see {@link https://www.conventionalcommits.org/en/v1.0.0/})
 *
 * @type {Array<Object>}
 *
 * @example
 *
 * { breaking : 'major' },
 * { revert   : 'patch' },
 * { feat     : 'minor' },
 * { fix      : 'patch' },
 * { refactor : 'patch' },
 * { ci       : 'patch' },
 * { docs     : 'patch' },
 * { style    : 'patch' }
*/
const RELEASE_RULES = [
  { breaking: true, release: 'major' },
  { revert: true, release: 'patch' },
  { type: 'feat', release: 'minor' },
  { type: 'fix', release: 'patch' },
  { type: 'refactor', release: 'patch' },
  { type: 'ci', release: 'patch' },
  { type: 'docs', release: 'patch' },
  { type: 'style', release: 'patch' }
]

/**
 * Generate or not changelog and updates package.json version based on the release type parsed from PR messages
 *
 * @return {undefined}
*/
async function updateVersion() {
  try {
    await getPullRequestDescription()

    const parsedObjects = getParsedMessages()

    console.info(`Parsed messages from pull request: ${JSON.stringify(parsedObjects)}`)

    const releaseType = getReleaseType(parsedObjects)

    if (releaseType) {
      let lastReleaseVersion = await getLastVersion()

      if (!lastReleaseVersion)
        lastReleaseVersion = process.env.npm_package_version

      const nextReleaseVersion = semver.inc(lastReleaseVersion, releaseType)

      const changelogContext  = {
        version: nextReleaseVersion,
        isPatch: true
      }

      const nextReleaseNotes = await generateNotes(changelogContext, parsedObjects)

      console.info(`Notes generated: ${nextReleaseNotes}`)

      updatePackageJson(nextReleaseVersion)

      await generateChangelog(nextReleaseNotes)
      await commitVersionFiles(nextReleaseVersion)
    }
    else
      console.info('No relevant change detected, the version will not be updated')
  }
  catch (error) {
    console.error('Error while updating version: ', error)

    exit(1)
  }
}

/**
 * Parse a txt file with the PR messages into objects
 *
 * @return {Array} The parsed objects from pr messages text file
 *
 * @example Text:'feat(scope): broadcast $destroy event on scope destruction\nCloses #1' becomes
 *
 *  Returns:
 * [
 *  {
 *      type: 'feat',
 *      scope: 'scope',
 *      subject: 'broadcast $destroy event on scope destruction',
 *      merge: null,
 *      header: 'feat(scope): broadcast $destroy event on scope destruction',
 *      body: null,
 *      footer: 'Closes #1',
 *      notes: [],
 *      references:
 *      [ { action: 'Closes',
 *         owner: null,
 *         repository: null,
 *         issue: '1',
 *         raw: '#1',
 *         prefix: '#' } ],
 *      mentions: [],
 *      revert: null }
 * ]
*/
function getParsedMessages() {
  const parsedResult = execSync(
    `cat ./${PR_MESSAGE_FILENAME} | conventional-commits-parser ===`,
    { encoding : 'utf8' }
  )

  removeSync(`./${PR_MESSAGE_FILENAME}`)

  return JSON.parse(parsedResult)
}

/**
 * Gets the release type based on the commits objects
 *
 * @param {Array} commits The array with the parsed objects representing formatted messages
 *
 * @return {string} The release type (minor, major, patch) or null
*/
function getReleaseType(commits) {
  let releaseType = null

  commits
    .forEach(commit => {
      const commitReleaseType = analyzeCommit(RELEASE_RULES, commit)

      if (commitReleaseType && compareReleaseTypes(releaseType, commitReleaseType))
        releaseType = commitReleaseType
    })

  if (releaseType)
    console.info(`Release type detected: ${releaseType}`)

  return releaseType
}

/**
 * Updates the package.json file version
 *
 * @param {string} version The version to update on the file
 *
 * @return {undefined}
*/
function updatePackageJson(version) {
  console.info('Write version %s to package.json', version)

  spawnSync(
    'npm',
    ['version', version, '--no-git-tag-version', '--allow-same-version']
  )
}

/**
 * Gets the description of the branch PR and creates text file with it's messages
 *
 * @return {undefined}
*/
async function getPullRequestDescription() {
  const github = new GitHub({
    token: process.env.GH_TOKEN
  })

  console.warn('[getPullRequestDescription]', `/repos/${process.env.CIRCLE_PROJECT_USERNAME}/${process.env.CIRCLE_PROJECT_REPONAME}/pulls?head="${process.env.CIRCLE_PROJECT_USERNAME}:${branchName()}"`)

  const { body } = await github
    .get(`/repos/${process.env.CIRCLE_PROJECT_USERNAME}/${process.env.CIRCLE_PROJECT_REPONAME}/pulls?head="${process.env.CIRCLE_PROJECT_USERNAME}:${branchName()}"`)

  if (!body || !body.length) {
    console.info('No pull request found, exiting process')

    exit(1)
  }
  else if (body.length && body[0]) {
    console.warn('[getPullRequestDescription]', body.map(b => b.url))

    const pr = body
      .find(b => b.head.ref == branchName())

    if (pr) {
      const prMessage = pr.body

      if (prMessage == '') {
        console.info('No description found on Pull Request')

        exit(1)
      }
      else
        await writeFile(`./${PR_MESSAGE_FILENAME}`,  prMessage)
    }
    else {
      console.info(`No pull request found for "${branchName()}", exiting process`)

      exit(1)
    }
  }
}

/**
 * Gets the last release version from Github, if no release is found gets the version from package.json
 *
 * @return {string} The last `package` version
*/
async function getLastVersion() {
  let lastVersion = null

  const github = new GitHub({
    token: process.env.GH_TOKEN
  })

  try {
    console.warn('[getLastVersion]', `/repos/${process.env.CIRCLE_PROJECT_USERNAME}/${process.env.CIRCLE_PROJECT_REPONAME}/releases/latest`)

    const { body } = await github
      .get(`/repos/${process.env.CIRCLE_PROJECT_USERNAME}/${process.env.CIRCLE_PROJECT_REPONAME}/releases/latest`)
      .catch(error => {
        console.error('Could not find the latest release', error)

        return { body: null }
      })

    if (body) {
      const tagName = body.tag_name

      console.info('Getting last version from latest release')

      lastVersion = semver.clean(tagName)
    }

    console.info('Last version detected: ', lastVersion)

    return lastVersion
  }
  catch (e) {
    console.error('[getLastVersion]', e)
    return lastVersion
  }
}

/**
 * Generates a CHANGELOG.md or updates it with new release notes
 * @async
 *
 * @param {string} notes The content to be added on the changelog file
 *
 * @return {undefined}
*/
async function generateChangelog(notes) {
  if (notes) {
    const changelogPath = 'CHANGELOG.md'

    await ensureFile(changelogPath)

    const currentFile = (await readFile(changelogPath))
      .toString()
      .trim()

    if (currentFile)
      console.info('Update %s', changelogPath)
    else
      console.info('Create %s', changelogPath)

    const content = `${notes.trim()}\n${currentFile ? `\n${currentFile}\n` : ''}`

    await writeFile(changelogPath,  content)
  }
}

/**
 * Generates a string in conventional-changelog format with the release notes
 *
 * @param {Object} changelogContext Object with the changelog options ex: { version: 1.0.0 }
 * @param {Array} parsedCommits Parsed commits objects
 *
 * @return {string} A string in conventional-changelog format with the release notes
*/
async function generateNotes(changelogContext, parsedCommits) {
  return await getStream(intoStream.object(parsedCommits)
    .pipe(writer(changelogContext, (await notesGenerator).writerOpts)))
}

/**
 * Commit the release files (changelog and package.json) on the branch
 *
 * @param {string} nextReleaseVersion The new release version
 *
 * @return {undefined}
*/
async function commitVersionFiles(nextReleaseVersion) {
  await exec(`git config user.name ${GIT_AUTHOR_NAME}`)
  await exec(`git config user.email ${GIT_AUTHOR_EMAIL}`)

  const filesToCommit = ['package.json', 'CHANGELOG.md']

  await add(filesToCommit)

  console.info('commited files: %o', filesToCommit)

  await commit(`chore(release): updating version to ${nextReleaseVersion} [skip ci]`)
  await push(`https://${process.env.GH_TOKEN}@github.com/${process.env.CIRCLE_PROJECT_USERNAME}/${process.env.CIRCLE_PROJECT_REPONAME}.git`, branchName())
}

module.exports =  { updateVersion, getLastVersion }