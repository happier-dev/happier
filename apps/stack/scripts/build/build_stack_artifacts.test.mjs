import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as buildModule from './build_stack_artifacts.mjs';
import { artifactPayloadDir, writeArtifactManifest } from '../runtime/shared/artifact_manifest.mjs';

test('runtime artifact identity inputs include only the toolchains consumed by each component', async () => {
  assert.equal(typeof buildModule.collectRuntimeBuildToolchainInputs, 'function');
  const calls = [];
  const inputs = await buildModule.collectRuntimeBuildToolchainInputs({
    selection: {
      components: { web: true, server: true, daemon: true },
    },
    env: { HAPPIER_BUN_PATH: '/toolchain/bun' },
    commandProbe: (command) => command === 'corepack',
    resolveBunCommandImpl: () => '/toolchain/bun',
    resolveYarnCommandImpl: () => ({ cmd: 'corepack', args: ['yarn'] }),
    runCaptureImpl: async (command, args) => {
      calls.push([command, args]);
      return command === '/toolchain/bun' ? '1.2.3\n' : '1.22.22\n';
    },
    nodeVersion: 'v22.22.1',
  });

  assert.deepEqual(inputs, {
    web: ['node=v22.22.1'],
    server: ['node=v22.22.1', 'bun=1.2.3'],
    daemon: ['node=v22.22.1', 'bun=1.2.3', 'yarn=1.22.22'],
  });
  assert.deepEqual(calls, [
    ['/toolchain/bun', ['--version']],
    ['corepack', ['yarn', '--version']],
  ]);

  const webOnly = await buildModule.collectRuntimeBuildToolchainInputs({
    selection: {
      components: { web: true, server: false, daemon: false },
    },
    runCaptureImpl: async () => {
      throw new Error('web-only builds must not probe Bun or Yarn');
    },
    nodeVersion: 'v22.22.1',
  });
  assert.deepEqual(webOnly, {
    web: ['node=v22.22.1'],
    server: [],
    daemon: [],
  });
});

async function writePublishedWebArtifact({ stackBaseDir, fingerprint, createdAt, complete = true }) {
  const artifactDir = join(stackBaseDir, 'artifacts', 'web', fingerprint);
  const payloadDir = artifactPayloadDir(artifactDir);
  await mkdir(payloadDir, { recursive: true });
  if (complete) {
    await writeFile(join(payloadDir, 'index.html'), '<!doctype html>', 'utf8');
  }
  await writeArtifactManifest({
    artifactDir,
    manifest: {
      version: 1,
      component: 'web',
      artifactFingerprint: fingerprint,
      sourceFingerprint: `source-${fingerprint}`,
      createdAt,
      payloadDir: 'payload',
      entrypoint: 'index.html',
    },
  });
  return { artifactDir, payloadDir };
}

test('server-only builds reuse the latest valid published web artifact without invoking the web builder', async () => {
  assert.equal(typeof buildModule.buildSelectedStackArtifacts, 'function');
  const stackBaseDir = mkdtempSync(join(tmpdir(), 'stack-server-web-reuse-'));
  try {
    const publishedWeb = await writePublishedWebArtifact({
      stackBaseDir,
      fingerprint: 'published-web',
      createdAt: '2026-08-12T09:00:00.000Z',
    });
    await writePublishedWebArtifact({
      stackBaseDir,
      fingerprint: 'incomplete-newer-web',
      createdAt: '2026-08-12T10:00:00.000Z',
      complete: false,
    });

    const calls = [];
    const artifacts = await buildModule.buildSelectedStackArtifacts({
      selection: {
        components: { web: false, server: true, daemon: false },
      },
      stackBaseDir,
      buildComponent: async (component, _builder, options = {}) => {
        calls.push({ component, options });
        assert.notEqual(component, 'web', 'explicit --server must not invoke the web builder');
        assert.equal(component, 'server');
        return {
          artifactDir: join(stackBaseDir, 'artifacts', 'server', 'server-with-published-web'),
          manifest: {
            artifactFingerprint: 'server-with-published-web',
            webArtifactFingerprint: options.webArtifactFingerprint,
          },
        };
      },
    });

    assert.deepEqual(calls.map(({ component }) => component), ['server']);
    assert.equal(calls[0].options.webArtifactFingerprint, 'published-web');
    assert.equal(calls[0].options.uiWebDistPath, publishedWeb.payloadDir);
    assert.equal(artifacts.web.manifest.artifactFingerprint, 'published-web');
    assert.equal(artifacts.server.manifest.webArtifactFingerprint, 'published-web');
  } finally {
    await rm(stackBaseDir, { recursive: true, force: true });
  }
});

test('web-selected server builds use the fresh web artifact rather than a published fallback', async () => {
  assert.equal(typeof buildModule.buildSelectedStackArtifacts, 'function');
  const freshWebArtifact = {
    artifactDir: '/fresh/web-artifact',
    manifest: { artifactFingerprint: 'fresh-web' },
  };
  const calls = [];

  const artifacts = await buildModule.buildSelectedStackArtifacts({
    selection: {
      components: { web: true, server: true, daemon: false },
    },
    stackBaseDir: '/published/artifacts',
    buildComponent: async (component, _builder, options = {}) => {
      calls.push({ component, options });
      if (component === 'web') return freshWebArtifact;
      assert.equal(component, 'server');
      return {
        artifactDir: '/fresh/server-artifact',
        manifest: {
          artifactFingerprint: 'fresh-server',
          webArtifactFingerprint: options.webArtifactFingerprint,
        },
      };
    },
  });

  assert.deepEqual(calls.map(({ component }) => component), ['web', 'server']);
  assert.equal(calls[1].options.webArtifactFingerprint, 'fresh-web');
  assert.equal(calls[1].options.uiWebDistPath, artifactPayloadDir('/fresh/web-artifact'));
  assert.equal(artifacts.web, freshWebArtifact);
});

test('server-only builds publish one canonical web artifact when none is available', async () => {
  assert.equal(typeof buildModule.buildSelectedStackArtifacts, 'function');
  const stackBaseDir = mkdtempSync(join(tmpdir(), 'stack-server-web-missing-'));
  const calls = [];
  try {
    const artifacts = await buildModule.buildSelectedStackArtifacts({
      selection: {
        components: { web: false, server: true, daemon: false },
      },
      stackBaseDir,
      buildComponent: async (component, _builder, options = {}) => {
        calls.push({ component, options });
        if (component === 'web') {
          return {
            artifactDir: join(stackBaseDir, 'artifacts', 'web', 'fresh-web'),
            manifest: { artifactFingerprint: 'fresh-web' },
          };
        }
        assert.equal(component, 'server');
        return {
          artifactDir: join(stackBaseDir, 'artifacts', 'server', 'server-with-fresh-web'),
          manifest: {
            artifactFingerprint: 'server-with-fresh-web',
            webArtifactFingerprint: options.webArtifactFingerprint,
          },
        };
      },
    });

    assert.deepEqual(calls.map(({ component }) => component), ['web', 'server']);
    assert.equal(calls[1].options.webArtifactFingerprint, 'fresh-web');
    assert.equal(
      calls[1].options.uiWebDistPath,
      artifactPayloadDir(join(stackBaseDir, 'artifacts', 'web', 'fresh-web')),
    );
    assert.equal(artifacts.web.manifest.artifactFingerprint, 'fresh-web');
    assert.equal(artifacts.server.manifest.webArtifactFingerprint, 'fresh-web');
  } finally {
    await rm(stackBaseDir, { recursive: true, force: true });
  }
});

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
