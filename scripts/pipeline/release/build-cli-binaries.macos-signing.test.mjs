import assert from 'node:assert/strict';
import test from 'node:test';

import { finalizeMacOSPayloadForArchive } from './notarize-standalone-binary.mjs';

test('local Darwin archive builds repair and verify the complete Mach-O payload before packaging', () => {
  const repairs = [];
  const refreshes = [];
  const notarizations = [];

  const result = finalizeMacOSPayloadForArchive({
    target: { os: 'darwin', arch: 'arm64' },
    stageDir: '/tmp/stage',
    platform: 'darwin',
    repairSignature: (payloadPath, { finalizePayloadBeforeSnapshot }) => {
      repairs.push(payloadPath);
      finalizePayloadBeforeSnapshot();
      return {
        signatureType: 'adhoc',
        payload: 'stage',
        payloadSha256: 'a'.repeat(64),
      };
    },
    notarizePayload: (argv) => {
      notarizations.push(argv);
    },
    refreshRuntimeAssetManifest: () => refreshes.push('before-evidence'),
  });

  assert.equal(result?.signatureType, 'adhoc');
  assert.deepEqual(repairs, ['/tmp/stage']);
  assert.deepEqual(refreshes, ['before-evidence']);
  assert.deepEqual(notarizations, []);
});

test('release Darwin archive builds Developer-ID sign and notarize the complete staged payload before packaging', () => {
  const repairs = [];
  const notarizations = [];
  const refreshes = [];

  const result = finalizeMacOSPayloadForArchive({
    target: { os: 'darwin', arch: 'x64' },
    stageDir: '/tmp/stage',
    platform: 'darwin',
    signingIdentity: 'Developer ID Application: Happier Dev (TEAMID)',
    notarizationOutputPath: '/tmp/notary/darwin-x64.cli.json',
    repairSignature: (binaryPath) => {
      repairs.push(binaryPath);
    },
    notarizePayload: (argv, { finalizePayloadBeforeSnapshot }) => {
      notarizations.push(argv);
      finalizePayloadBeforeSnapshot();
      return { signingIdentity: 'Developer ID Application: Happier Dev (TEAMID)' };
    },
    refreshRuntimeAssetManifest: () => refreshes.push('before-evidence'),
  });

  assert.equal(result?.signingIdentity, 'Developer ID Application: Happier Dev (TEAMID)');
  assert.deepEqual(repairs, []);
  assert.deepEqual(refreshes, ['before-evidence']);
  assert.deepEqual(notarizations, [[
    '--payload',
    '/tmp/stage',
    '--identity',
    'Developer ID Application: Happier Dev (TEAMID)',
    '--out',
    '/tmp/notary/darwin-x64.cli.json',
  ]]);
});

test('Darwin release signing requires identity and evidence path together', () => {
  assert.throws(
    () => finalizeMacOSPayloadForArchive({
      target: { os: 'darwin', arch: 'arm64' },
      stageDir: '/tmp/stage',
      platform: 'darwin',
      signingIdentity: 'Developer ID Application: Happier Dev (TEAMID)',
    }),
    /must be provided together/i,
  );
});

test('non-Darwin archive builds do not invoke the macOS signing owner', () => {
  let invoked = false;
  const result = finalizeMacOSPayloadForArchive({
    target: { os: 'linux', arch: 'x64' },
    stageDir: '/tmp/stage',
    platform: 'linux',
    repairSignature: () => {
      invoked = true;
    },
    notarizePayload: () => {
      invoked = true;
    },
  });

  assert.equal(result, null);
  assert.equal(invoked, false);
});
