import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as buildModule from './build_stack_artifacts.mjs';

test('assertSelectedBuildPrerequisites does not require bun for web-only builds', () => {
  assert.equal(typeof buildModule.assertSelectedBuildPrerequisites, 'function');
  assert.doesNotThrow(() =>
    buildModule.assertSelectedBuildPrerequisites({
      selection: {
        components: {
          web: true,
          server: false,
          daemon: false,
        },
      },
      commandProbe: () => false,
    }),
  );
});

test('assertSelectedBuildPrerequisites fails fast when server artifacts need bun', () => {
  assert.equal(typeof buildModule.assertSelectedBuildPrerequisites, 'function');
  assert.throws(
    () =>
      buildModule.assertSelectedBuildPrerequisites({
        selection: {
          components: {
            web: false,
            server: true,
            daemon: false,
          },
        },
        commandProbe: () => false,
        env: {
          HOME: '/definitely-missing-home',
          BUN_INSTALL: '',
          USERPROFILE: '',
        },
      }),
    /bun.*required.*server/i,
  );
});

test('assertSelectedBuildPrerequisites fails fast for activate-runtime builds before web export starts', () => {
    assert.equal(typeof buildModule.assertSelectedBuildPrerequisites, 'function');
    assert.throws(
    () =>
      buildModule.assertSelectedBuildPrerequisites({
        selection: {
          components: {
            web: true,
            server: true,
            daemon: true,
          },
        },
        commandProbe: () => false,
        env: {
          HOME: '/definitely-missing-home',
          BUN_INSTALL: '',
          USERPROFILE: '',
        },
      }),
    /bun.*server and daemon/i,
  );
});

test('assertSelectedBuildPrerequisites fails fast when daemon artifacts need yarn or corepack', () => {
  assert.equal(typeof buildModule.assertSelectedBuildPrerequisites, 'function');
  assert.throws(
    () =>
      buildModule.assertSelectedBuildPrerequisites({
        selection: {
          components: {
            web: false,
            server: false,
            daemon: true,
          },
        },
        commandProbe: (cmd) => cmd === 'bun',
      }),
    /yarn or corepack/i,
  );
});

test('assertSelectedBuildPrerequisites accepts bun from BUN_INSTALL even when PATH probe misses it', () => {
  assert.equal(typeof buildModule.assertSelectedBuildPrerequisites, 'function');
  const tempRoot = mkdtempSync(join(tmpdir(), 'stack-build-prereq-bun-'));
  try {
    const bunInstallDir = join(tempRoot, '.bun');
    const bunBinDir = join(bunInstallDir, 'bin');
    const bunPath = join(bunBinDir, process.platform === 'win32' ? 'bun.exe' : 'bun');
    mkdirSync(bunBinDir, { recursive: true });
    writeFileSync(bunPath, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n', {
      mode: 0o755,
    });

    assert.doesNotThrow(() =>
      buildModule.assertSelectedBuildPrerequisites({
        selection: {
          components: {
            web: false,
            server: true,
            daemon: false,
          },
        },
        commandProbe: () => false,
        env: {
          BUN_INSTALL: bunInstallDir,
        },
      }),
    );
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('ensureArtifactSourceInputsReady refreshes cli dist before daemon artifact builds', async (t) => {
  assert.equal(typeof buildModule.ensureArtifactSourceInputsReady, 'function');
  const ensureCliBuiltCalls = [];
  const ensureCliBuiltMock = async (...args) => {
    ensureCliBuiltCalls.push(args);
    return { built: true, reason: 'changed' };
  };

  await buildModule.ensureArtifactSourceInputsReady({
    selection: {
      components: {
        web: false,
        server: false,
        daemon: true,
      },
    },
    repoDir: '/repo',
    env: { HAPPIER_STACK_CLI_BUILD_MODE: 'auto' },
    ensureCliBuiltImpl: ensureCliBuiltMock,
  });

  assert.equal(ensureCliBuiltCalls.length, 1);
  assert.deepEqual(ensureCliBuiltCalls[0], [
    join('/repo', 'apps', 'cli'),
    {
      buildCli: true,
      quiet: true,
      env: { HAPPIER_STACK_CLI_BUILD_MODE: 'auto' },
    },
  ]);
});

test('ensureArtifactSourceInputsReady skips cli dist refresh when daemon artifacts are not selected', async (t) => {
  assert.equal(typeof buildModule.ensureArtifactSourceInputsReady, 'function');
  const ensureCliBuiltCalls = [];
  const ensureCliBuiltMock = async (...args) => {
    ensureCliBuiltCalls.push(args);
    return { built: true, reason: 'changed' };
  };

  await buildModule.ensureArtifactSourceInputsReady({
    selection: {
      components: {
        web: true,
        server: true,
        daemon: false,
      },
    },
    repoDir: '/repo',
    env: {},
    ensureCliBuiltImpl: ensureCliBuiltMock,
  });

  assert.equal(ensureCliBuiltCalls.length, 0);
});
