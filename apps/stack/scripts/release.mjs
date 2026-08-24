#!/usr/bin/env node

// Stack used to own a second npm version/publish sequence here. Release
// channel, candidate construction, and npm publication now belong together in
// the target-owned pipeline, so this retained package-script entrypoint is
// migration-only rather than a competing publisher.
process.stderr.write([
  '[hstack] `npm run release` no longer versions or publishes @happier-dev/stack directly.',
  '',
  'From the repository root, use the target-owned release pipeline:',
  '  node scripts/pipeline/run.mjs npm-release --channel <dev|preview|production> --publish-stack true --authorized-sha <release-admitted-sha> --mode <pack|pack+publish>',
  '',
  'Use the pipeline flags to select the release channel and artifact-only or publish mode.',
  '',
].join('\n'));
process.exitCode = 2;
