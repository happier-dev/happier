import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyRepositoryPlacement,
  collectEnvironmentManifest,
  detectSecurityProcessFamilies,
} from './environment_manifest.mjs';

test('benchmark environment observations classify repository placement and security products without retaining paths', () => {
  assert.equal(classifyRepositoryPlacement('/Users/alice/Library/Mobile Documents/com~apple~CloudDocs/repo'), 'known-cloud-provider');
  assert.equal(classifyRepositoryPlacement('/Users/alice/Documents/repo'), 'possibly-managed-home-folder');
  assert.equal(classifyRepositoryPlacement('/opt/src/repo'), 'local-path');
  assert.deepEqual(detectSecurityProcessFamilies([
    '/Applications/Microsoft Defender.app/Contents/MacOS/wdavdaemon',
    '/Library/CS/falconctl',
    '/usr/bin/node',
  ].join('\n')), ['crowdstrike', 'microsoft-defender']);
});

test('collectEnvironmentManifest records reproducibility facts without environment values or dirty paths', async () => {
  const manifest = await collectEnvironmentManifest({
    cwd: '/repo/private-name',
    env: {
      PATH: '/tools',
      GITHUB_TOKEN: 'must-not-leak',
      HAPPIER_STACK_HOME_DIR: '/private/home',
    },
    boundary: {
      nowIso: () => '2026-08-25T12:00:00.000Z',
      platform: () => ({
        os: 'darwin',
        arch: 'arm64',
        release: '26.0.0',
        cpuCount: 18,
        cpuModel: 'Apple M5 Max',
        totalMemoryBytes: 128,
      }),
      toolVersion: async (tool) => `${tool} version`,
      git: async () => ({ head: 'abc123', dirtyEntryCount: 7, branch: 'dev' }),
      filesystem: async () => ({ type: 'apfs', deviceClass: 'local' }),
      hostObservations: async () => ({
        repositoryPlacement: 'possibly-managed-home-folder',
        spotlight: { available: true, indexingEnabled: false },
        timeMachine: { available: true, excluded: true },
        securityProcessFamilies: ['microsoft-defender'],
      }),
    },
  });

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.capturedAt, '2026-08-25T12:00:00.000Z');
  assert.deepEqual(manifest.git, { head: 'abc123', dirtyEntryCount: 7, branch: 'dev' });
  assert.equal(manifest.tools.node, 'node version');
  assert.equal(manifest.environment.present.GITHUB_TOKEN, true);
  assert.equal(manifest.environment.present.HAPPIER_STACK_HOME_DIR, true);
  assert.equal(manifest.host.repositoryPlacement, 'possibly-managed-home-folder');
  assert.deepEqual(manifest.host.securityProcessFamilies, ['microsoft-defender']);
  assert.doesNotMatch(JSON.stringify(manifest), /must-not-leak|private-name|private\/home/);
});
