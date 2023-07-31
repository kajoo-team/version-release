require('dotenv')
  .config({
    silent: true
  })

const { pathExists } = require('fs-extra')
const { exec } = require('child_process')
const { exit } = require('process')
const GitHub = require('github-base')
const parseChangelog = require('changelog-parser')

const updateVersion = require('./update-version')

/**
 * Settings for {@link releaseVersion}
 * @typedef {Object} ReleaseVersionParams
 *
 * @property {Boolean} [npmPublish = true] Whether it should `npm publish` or not
*/

/**
 * Default `params` for {@link releaseVersion}
 * @type {ReleaseVersionParams}
 *
 * @property {Boolean} [npmPublish = true] Whether it should `npm publish` or not
*/
const DEFAULT_RELEASE_VERSION_PARAMS = {
  npmPublish: true
}

/**
 * Generates a `release` and (maybe) publishes the package
 * @async
 *
 * @param {ReleaseVersionParams} params The release params (@see {@link ReleaseVersionParams})
 *
 * @return {Object} The release object
*/
async function releaseVersion(params = DEFAULT_RELEASE_VERSION_PARAMS) {
  try {
    const isChangelogFile = await pathExists('CHANGELOG.md')

    let releaseObject = null

    if (isChangelogFile) {
      const notesObject = await getLastNoteFromChangelog()

      const lastReleaseVersion = await updateVersion
        .getLastVersion()

      if (
        notesObject && (
          !lastReleaseVersion
          || (lastReleaseVersion != notesObject.version)
        )
      ) {
        releaseObject = await generateRelease(notesObject)

        console.info(releaseObject)

        if (params.npmPublish)
          await exec('npm publish')
      }
      else
        console.info('No changes between changelog last release and repository last release version, no release will be generated')
    }
    else
      console.info('No `CHANGELOG` file found, no release will be generated')

    return releaseObject
  }
  catch (error) {
    console.error('Error while releasing version: ', error)

    exit(1)
  }
}

/**
 * Gets the last release note from the `CHANGELOG` file
 * @async
 *
 * @return {Object} The release note object
 *
 * @example
 * {
 *   version: '1.0.0',
 *   title: '1.0.0 (dd-MM-YYYY)',
 *   body: '### Changes\n\n* Update API\n* Fix bug #1'
 * }
*/
async function getLastNoteFromChangelog() {
  let lastChangelogRelease = null

  const parsedChangelog = await parseChangelog('CHANGELOG.md')

  if (
    parsedChangelog
    && parsedChangelog.versions
    && parsedChangelog.versions.length
    && parsedChangelog.versions[0]
  ) {
    lastChangelogRelease = parsedChangelog.versions[0]
  }

  return lastChangelogRelease
}

/**
 * Generates a `release` from a release note object
 * @async
 *
 * @param {Object} notesObject The `release note` object (@see {@link getLastNoteFromChangelog})
 *
 * @return {Object} The release object
*/
async function generateRelease(notesObject) {
  const github = new GitHub({
    token: process.env.GH_TOKEN
  })

  const release = {
    tag_name          : `v${notesObject.version}`,
    name              : `v${notesObject.version}`,
    body              : `## ${notesObject.title}\n\n${notesObject.body}`,
    target_commitish  : 'master',
    draft             : false,
    prerelease        : false
  }

  console.warn('[generateRelease]', `/repos/${process.env.CIRCLE_PROJECT_USERNAME}/${process.env.CIRCLE_PROJECT_REPONAME}/releases`, { release })

  try {
    await github
      .post(`/repos/${process.env.CIRCLE_PROJECT_USERNAME}/${process.env.CIRCLE_PROJECT_REPONAME}/releases`, release)
  }
  catch (e) {
    console.warn('[generateRelease]', e)

    return release
  }

  return release
}

module.exports = releaseVersion