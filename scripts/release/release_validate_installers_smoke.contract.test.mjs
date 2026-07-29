import test from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveInstallersSmokeBinaryPath,
  resolveInstallersSmokeLifecycleSteps,
  resolveInstallersSmokeLifecycleStepTimeoutMs,
  resolveInstallersSmokePlan,
  resolveInstallersSmokePowerShellInvocation,
  resolveInstallersSmokePredecessorEnv,
  resolveInstallersSmokeStepEnv,
  resolveInstallersSmokeUpdateLifecycleSteps,
  resolveInstallersSmokeUpdatePlan,
} from '../pipeline/release-validation/executors/installers-smoke.mjs';

test('installers-smoke resolves published channel installer plans by platform', () => {
  assert.deepEqual(
    resolveInstallersSmokePlan({
      platform: 'linux',
      source: { kind: 'published-channel', ref: 'stable' },
    }),
    {
      platform: 'linux',
      tag: 'cli-stable',
      installer: 'install.sh',
      binaryName: 'happier',
      releaseChannel: 'stable',
      installerEnv: {
        HAPPIER_WITH_DAEMON: '0',
      },
    },
  );

  assert.deepEqual(
    resolveInstallersSmokePlan({
      platform: 'darwin',
      source: { kind: 'published-channel', ref: 'preview' },
    }),
    {
      platform: 'darwin',
      tag: 'cli-preview',
      installer: 'install-preview.sh',
      binaryName: 'hprev',
      releaseChannel: 'preview',
      installerEnv: {
        HAPPIER_WITH_DAEMON: '0',
      },
    },
  );

  assert.deepEqual(
    resolveInstallersSmokePlan({
      platform: 'win32',
      source: { kind: 'published-channel', ref: 'dev' },
    }),
    {
      platform: 'win32',
      tag: 'cli-dev',
      installer: 'install-dev.ps1',
      binaryName: 'hdev.exe',
      releaseChannel: 'publicdev',
      installerEnv: {
        HAPPIER_WITH_DAEMON: '0',
      },
    },
  );
});

test('installers-smoke resolves published rolling and versioned tags to the matching installer surface', () => {
  assert.deepEqual(
    resolveInstallersSmokePlan({
      platform: 'linux',
      source: { kind: 'published-tag', ref: 'cli-preview' },
    }),
    {
      platform: 'linux',
      tag: 'cli-preview',
      installer: 'install-preview.sh',
      binaryName: 'hprev',
      releaseChannel: 'preview',
      installerEnv: {
        HAPPIER_WITH_DAEMON: '0',
      },
    },
  );

  assert.deepEqual(
    resolveInstallersSmokePlan({
      platform: 'win32',
      source: { kind: 'published-tag', ref: 'cli-v0.2.4-dev.47.1' },
    }),
    {
      platform: 'win32',
      tag: 'cli-v0.2.4-dev.47.1',
      installer: 'install-dev.ps1',
      binaryName: 'hdev.exe',
      releaseChannel: 'publicdev',
      installerEnv: {
        HAPPIER_WITH_DAEMON: '0',
      },
    },
  );
});

test('installers-smoke resolves exact candidate plans from the supplied local-build ref', () => {
  assert.deepEqual(
    resolveInstallersSmokePlan({
      platform: 'linux',
      source: { kind: 'local-build', ref: '/candidate/candidate.json' },
      releaseChannel: 'dev',
    }),
    {
      platform: 'linux',
      tag: null,
      installer: 'install-dev.sh',
      binaryName: 'hdev',
      releaseChannel: 'publicdev',
      candidateManifestPath: '/candidate/candidate.json',
      installerEnv: {
        HAPPIER_WITH_DAEMON: '0',
      },
    },
  );

  assert.deepEqual(
    resolveInstallersSmokePlan({
      platform: 'win32',
      source: { kind: 'local-build', ref: 'candidate/candidate.json' },
      releaseChannel: 'dev',
    }),
    {
      platform: 'win32',
      tag: null,
      installer: 'install-dev.ps1',
      binaryName: 'hdev.exe',
      releaseChannel: 'publicdev',
      candidateManifestPath: 'candidate/candidate.json',
      installerEnv: {
        HAPPIER_WITH_DAEMON: '0',
      },
    },
  );
});

test('installers-smoke requires an explicit release channel for local-build sources', () => {
  assert.throws(
    () =>
      resolveInstallersSmokePlan({
        platform: 'linux',
        source: { kind: 'local-build', ref: '.' },
      }),
    /release-channel/i,
  );
});

test('installers-smoke rejects unsupported source kinds', () => {
  assert.throws(
    () =>
      resolveInstallersSmokePlan({
        platform: 'linux',
        source: { kind: 'local-pack', ref: 'dist/release-assets/cli.tgz' },
      }),
    /supports only published-channel, published-tag, or local-build/i,
  );
});

test('installers-smoke lifecycle steps include reinstall/check/uninstall where supported', () => {
  assert.deepEqual(resolveInstallersSmokeLifecycleSteps({ platform: 'linux' }), [
    'install',
    'version',
    'help',
    'check',
    'reinstall',
    'check',
    'uninstall',
  ]);
  assert.deepEqual(resolveInstallersSmokeLifecycleSteps({ platform: 'darwin' }), [
    'install',
    'version',
    'help',
    'check',
    'reinstall',
    'check',
    'uninstall',
  ]);
  assert.deepEqual(resolveInstallersSmokeLifecycleSteps({ platform: 'win32' }), [
    'install',
    'version',
    'help',
    'reinstall',
  ]);
});

test('installers-smoke plans a real released-dev predecessor to exact candidate update and rollback', () => {
  assert.deepEqual(resolveInstallersSmokeUpdatePlan({
    platform: 'darwin',
    update: {
      from: { kind: 'published-channel', ref: 'dev' },
      to: { kind: 'local-build', ref: '/candidate/candidate.json' },
    },
    releaseChannel: 'dev',
  }), {
    mode: 'update-rollback',
    from: {
      platform: 'darwin',
      tag: 'cli-dev',
      installer: 'install-dev.sh',
      binaryName: 'hdev',
      releaseChannel: 'publicdev',
      installerEnv: {
        HAPPIER_WITH_DAEMON: '0',
      },
    },
    to: {
      platform: 'darwin',
      tag: null,
      installer: 'install-dev.sh',
      binaryName: 'hdev',
      releaseChannel: 'publicdev',
      candidateManifestPath: '/candidate/candidate.json',
      installerEnv: {
        HAPPIER_WITH_DAEMON: '0',
      },
    },
    lifecycleSteps: resolveInstallersSmokeUpdateLifecycleSteps({
      platform: 'darwin',
    }),
  });
  assert.deepEqual(
    resolveInstallersSmokeUpdateLifecycleSteps({ platform: 'darwin' }),
    [
      'predecessor-install',
      'predecessor-version',
      'candidate-update',
      'candidate-version',
      'rollback',
      'rollback-version',
      'candidate-reinstall',
      'candidate-version',
      'check',
      'uninstall',
    ],
  );
  assert.deepEqual(
    resolveInstallersSmokeUpdateLifecycleSteps({ platform: 'win32' }),
    [
      'predecessor-install',
      'predecessor-version',
      'candidate-update',
      'candidate-version',
      'rollback',
      'rollback-version',
      'candidate-reinstall',
      'candidate-version',
    ],
  );
  assert.throws(
    () => resolveInstallersSmokeUpdatePlan({
      platform: 'linux',
      update: {
        from: { kind: 'published-channel', ref: 'preview' },
        to: { kind: 'local-build', ref: '/candidate/candidate.json' },
      },
      releaseChannel: 'dev',
    }),
    /published-channel dev predecessor/u,
  );
});

test('installers-smoke forwards the Windows reinstall action through the executed step environment', () => {
  const baseEnv = { PATH: 'C:\\Windows\\System32' };
  assert.deepEqual(
    resolveInstallersSmokeStepEnv({
      baseEnv,
      platform: 'win32',
      step: 'candidate-reinstall',
    }),
    {
      PATH: 'C:\\Windows\\System32',
      HAPPIER_INSTALLER_ACTION: 'reinstall',
    },
  );
  assert.equal(
    resolveInstallersSmokeStepEnv({
      baseEnv,
      platform: 'win32',
      step: 'candidate-update',
    }),
    baseEnv,
  );
});

test('installers-smoke predecessor inherits the isolated home/PATH fences but not candidate assets', () => {
  assert.deepEqual(resolveInstallersSmokePredecessorEnv({
    candidateEnv: {
      HOME: '/tmp/isolated-home',
      HAPPIER_NO_PATH_UPDATE: '1',
      HAPPIER_RELEASE_ASSETS_DIR: '/candidate/native',
      HAPPIER_MINISIGN_PUBKEY: 'candidate-key',
      HAPPIER_INSTALL_VERSION: '0.2.10',
      PATH: '/candidate/tools:/usr/bin',
    },
    predecessorPlan: {
      releaseChannel: 'publicdev',
      installerEnv: {
        HAPPIER_WITH_DAEMON: '0',
      },
    },
  }), {
    HOME: '/tmp/isolated-home',
    HAPPIER_NO_PATH_UPDATE: '1',
    HAPPIER_CHANNEL: 'dev',
    HAPPIER_WITH_DAEMON: '0',
    PATH: '/candidate/tools:/usr/bin',
  });
});

test('installers-smoke resolves the managed binary path for each native installer surface', () => {
  const normalizeSlashes = (value) => String(value).replaceAll('\\', '/');
  const linuxPath = resolveInstallersSmokeBinaryPath({
    platform: 'linux',
    installDir: '/tmp/happier-install',
    requestedBinDir: '/tmp/bin',
    binaryName: 'happier',
  });
  const darwinPath = resolveInstallersSmokeBinaryPath({
    platform: 'darwin',
    installDir: '/tmp/happier-install',
    requestedBinDir: '/tmp/bin',
    binaryName: 'happier',
  });
  assert.equal(
    normalizeSlashes(linuxPath),
    '/tmp/bin/happier',
  );
  assert.equal(
    normalizeSlashes(darwinPath),
    '/tmp/bin/happier',
  );
  assert.equal(darwinPath, linuxPath);
  assert.equal(
    resolveInstallersSmokeBinaryPath({
      platform: 'win32',
      installDir: 'C:\\Users\\lee\\.happier',
      requestedBinDir: 'C:\\Users\\lee\\.local\\bin',
      binaryName: 'hdev.exe',
    }),
    'C:\\Users\\lee\\.happier\\bin\\hdev.exe',
  );
});

test('installers-smoke lifecycle step timeout is bounded and configurable', () => {
  assert.equal(resolveInstallersSmokeLifecycleStepTimeoutMs({ env: {} }), 300_000);
  assert.equal(
    resolveInstallersSmokeLifecycleStepTimeoutMs({
      env: {
        HAPPIER_INSTALLERS_SMOKE_STEP_TIMEOUT_MS: '120000',
      },
    }),
    120_000,
  );
  assert.equal(
    resolveInstallersSmokeLifecycleStepTimeoutMs({
      env: {
        HAPPIER_INSTALLERS_SMOKE_STEP_TIMEOUT_MS: '-10',
      },
    }),
    30_000,
  );
  assert.equal(
    resolveInstallersSmokeLifecycleStepTimeoutMs({
      env: {
        HAPPIER_INSTALLERS_SMOKE_STEP_TIMEOUT_MS: '999999999',
      },
    }),
    1_800_000,
  );
});

test('installers-smoke applies a larger default install timeout for win32 local-build', () => {
  assert.equal(
    resolveInstallersSmokeLifecycleStepTimeoutMs({
      env: {},
      platform: 'win32',
      sourceKind: 'local-build',
      step: 'install',
    }),
    600_000,
  );
  assert.equal(
    resolveInstallersSmokeLifecycleStepTimeoutMs({
      env: {},
      platform: 'win32',
      sourceKind: 'local-build',
      step: 'version',
    }),
    300_000,
  );
});

test('installers-smoke runs the Windows installer through Windows PowerShell when pwsh is unavailable', () => {
  const invocation = resolveInstallersSmokePowerShellInvocation({
    installerPath: 'C:\\Users\\lee\\AppData\\Local\\Temp\\happier smoke\\install-dev.ps1',
    installerArgs: ['--check'],
    commandResolver: (command) => command === 'powershell.exe'
      ? 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
      : null,
  });

  assert.deepEqual(invocation, {
    command: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    args: [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      'C:\\Users\\lee\\AppData\\Local\\Temp\\happier smoke\\install-dev.ps1',
      '--check',
    ],
  });
});

test('installers-smoke preserves pwsh preference when both PowerShell hosts are available', () => {
  const resolvedCandidates = [];
  const invocation = resolveInstallersSmokePowerShellInvocation({
    installerPath: 'C:\\install.ps1',
    installerArgs: [],
    commandResolver: (command) => {
      resolvedCandidates.push(command);
      return `C:\\tools\\${command}`;
    },
  });

  assert.equal(invocation.command, 'C:\\tools\\pwsh.exe');
  assert.deepEqual(
    resolvedCandidates,
    ['pwsh.exe'],
    'the smoke must admit a real executable rather than a bare pwsh name that could resolve to a cmd shim',
  );
});

test('installers-smoke fails clearly when no supported PowerShell host is available', () => {
  assert.throws(
    () => resolveInstallersSmokePowerShellInvocation({
      installerPath: 'C:\\install.ps1',
      commandResolver: () => null,
    }),
    /requires PowerShell.*pwsh.*powershell\.exe/i,
  );
});
