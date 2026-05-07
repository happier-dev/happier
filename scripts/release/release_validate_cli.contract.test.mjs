import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runCliUpdateValidation } from '../pipeline/release-validation/executors/cli-update.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const scriptPath = resolve(repoRoot, 'scripts', 'pipeline', 'release-validation', 'validate-release.mjs');

test('release-validate resolves a published-channel dry-run request', async () => {
  const raw = execFileSync(
    process.execPath,
    [
      scriptPath,
      '--suite',
      'installers-smoke',
      '--platform',
      'linux',
      '--source',
      'published-channel',
      '--ref',
      'preview',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const parsed = JSON.parse(raw);
  assert.deepEqual(parsed, {
    ok: true,
    dryRun: true,
    suite: 'installers-smoke',
    platform: 'linux',
    source: {
      kind: 'published-channel',
      ref: 'preview',
    },
    update: null,
    execution: {
      type: 'installers-smoke',
      plan: {
        platform: 'linux',
        tag: 'cli-preview',
        installer: 'install-preview.sh',
        binaryName: 'hprev',
        releaseChannel: 'preview',
        installerEnv: {
          HAPPIER_WITH_DAEMON: '0',
        },
      },
    },
  });
});

test('release-validate resolves an installers-smoke published-tag dry-run request', async () => {
  const raw = execFileSync(
    process.execPath,
    [
      scriptPath,
      '--suite',
      'installers-smoke',
      '--platform',
      'win32',
      '--source',
      'published-tag',
      '--ref',
      'cli-v0.2.4-dev.47.1',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const parsed = JSON.parse(raw);
  assert.deepEqual(parsed, {
    ok: true,
    dryRun: true,
    suite: 'installers-smoke',
    platform: 'win32',
    source: {
      kind: 'published-tag',
      ref: 'cli-v0.2.4-dev.47.1',
    },
    update: null,
    execution: {
      type: 'installers-smoke',
      plan: {
        platform: 'win32',
        tag: 'cli-v0.2.4-dev.47.1',
        installer: 'install-dev.ps1',
        binaryName: 'hdev.exe',
        releaseChannel: 'publicdev',
        installerEnv: {
          HAPPIER_WITH_DAEMON: '0',
        },
      },
    },
  });
});

test('release-validate resolves a local-build installers-smoke dry-run request when release-channel is provided', async () => {
  const raw = execFileSync(
    process.execPath,
    [
      scriptPath,
      '--suite',
      'installers-smoke',
      '--platform',
      'linux',
      '--source',
      'local-build',
      '--ref',
      '.',
      '--release-channel',
      'preview',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const parsed = JSON.parse(raw);
  assert.deepEqual(parsed, {
    ok: true,
    dryRun: true,
    suite: 'installers-smoke',
    platform: 'linux',
    source: {
      kind: 'local-build',
      ref: '.',
    },
    update: null,
    execution: {
      type: 'installers-smoke',
      plan: {
        platform: 'linux',
        tag: null,
        installer: 'install-preview.sh',
        binaryName: 'hprev',
        releaseChannel: 'preview',
        installerEnv: {
          HAPPIER_WITH_DAEMON: '0',
        },
      },
    },
  });
});

test('release-validate resolves explicit from/to dry-run updates', async () => {
  const raw = execFileSync(
    process.execPath,
    [
      scriptPath,
      '--suite',
      'cli-update',
      '--platform',
      'darwin',
      '--from-source',
      'published-tag',
      '--from-ref',
      'cli-preview',
      '--to-source',
      'local-build',
      '--to-ref',
      'HEAD',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const parsed = JSON.parse(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.suite, 'cli-update');
  assert.equal(parsed.platform, 'darwin');
  assert.equal(parsed.source, null);
  assert.deepEqual(parsed.update, {
    from: {
      kind: 'published-tag',
      ref: 'cli-preview',
    },
    to: {
      kind: 'local-build',
      ref: 'HEAD',
    },
  });
  assert.deepEqual(parsed.execution?.env, {
    HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_FROM_SOURCE_KIND: 'published-tag',
    HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_FROM_SOURCE_REF: 'cli-preview',
    HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_TO_SOURCE_KIND: 'local-build',
    HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_TO_SOURCE_REF: 'HEAD',
  });
});

test('release-validate rejects cli-update updates that do not start from a published source', async () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          scriptPath,
          '--suite',
          'cli-update',
          '--platform',
          'linux',
          '--from-source',
          'local-build',
          '--from-ref',
          'HEAD',
          '--to-source',
          'local-pack',
          '--to-ref',
          'dist/happier.tgz',
          '--dry-run',
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
        },
      ),
    /suite cli-update supports update source pairs/i,
  );
});

test('release-validate plans cli-update continuity against the core e2e lane', async () => {
  const raw = execFileSync(
    process.execPath,
    [
      scriptPath,
      '--suite',
      'cli-update',
      '--platform',
      'linux',
      '--from-source',
      'published-channel',
      '--from-ref',
      'preview',
      '--to-source',
      'local-build',
      '--to-ref',
      'HEAD',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const parsed = JSON.parse(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.suite, 'cli-update');
  assert.deepEqual(parsed.update, {
    from: {
      kind: 'published-channel',
      ref: 'preview',
    },
    to: {
      kind: 'local-build',
      ref: 'HEAD',
    },
  });
  assert.deepEqual(parsed.execution, {
    type: 'command',
    command: process.execPath,
    args: [
      resolve(repoRoot, 'packages', 'tests', 'scripts', 'run-vitest-with-heartbeat.mjs'),
      '--config',
      resolve(repoRoot, 'packages', 'tests', 'vitest.core.slow.config.ts'),
      resolve(
        repoRoot,
        'packages',
        'tests',
        'suites',
        'core-e2e',
        'session.continuity.fakeClaude.cliUpdate.slow.e2e.test.ts',
      ),
    ],
    cwd: resolve(repoRoot, 'packages', 'tests'),
    env: {
      HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_FROM_SOURCE_KIND: 'published-channel',
      HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_FROM_SOURCE_REF: 'preview',
      HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_TO_SOURCE_KIND: 'local-build',
      HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_TO_SOURCE_REF: 'HEAD',
    },
  });
});

test('release-validate materializes cli-update local-build targets before running the continuity lane', async () => {
  const calls = [];
  const windowsComspec = 'C:\\Windows\\System32\\cmd.exe';
  runCliUpdateValidation({
    repoRoot,
    update: {
      from: { kind: 'published-channel', ref: 'preview' },
      to: { kind: 'local-build', ref: 'HEAD' },
    },
    platform: 'win32',
    npmExecPath: 'C:\\npm\\node_modules\\npm\\bin\\npm-cli.js',
    comspec: windowsComspec,
    exec(command, args, options = {}) {
      calls.push({ command, args, options });
      if (args[0]?.endsWith('/apps/cli/scripts/packTarball.mjs')) {
        const packDestinationFlagIndex = args.indexOf('--dest-dir');
        assert.notEqual(packDestinationFlagIndex, -1);
        const packDestination = args[packDestinationFlagIndex + 1];
        assert.equal(typeof packDestination, 'string');
        mkdirSync(packDestination, { recursive: true });
        const tarballPath = resolve(packDestination, 'happier-dev-cli-0.0.0.tgz');
        writeFileSync(tarballPath, 'fixture');
        return `${tarballPath}\n`;
      }
      if (args[0] === '-tzf') {
        return [
          'package/dist/index.mjs',
          'package/package-dist/index.mjs',
        ].join('\n');
      }
    },
  });

  assert.equal(calls.length, 4);
  assert.equal(calls[0].command, windowsComspec);
  assert.equal(calls[0].options.windowsVerbatimArguments, true);
  assert.match(calls[0].args.join(' '), /yarn\.cmd/);
  assert.match(calls[0].args.join(' '), /workspace/);
  assert.match(calls[0].args.join(' '), /@happier-dev\/cli/);
  assert.match(calls[0].args.join(' '), /build/);
  assert.doesNotMatch(calls[0].args.join(' '), /npm-cli\.js/);
  assert.equal(calls[0].options.cwd, repoRoot);
  assert.equal(calls[1].command, process.execPath);
  assert.equal(calls[1].args[0], resolve(repoRoot, 'apps', 'cli', 'scripts', 'packTarball.mjs'));
  assert.equal(calls[1].options.cwd, resolve(repoRoot, 'apps', 'cli'));
  assert.equal(calls[2].command, 'tar');
  assert.equal(calls[2].args[0], '-tzf');
  assert.equal(calls[3].command, process.execPath);

  const packDestinationFlagIndex = calls[1].args.indexOf('--dest-dir');
  assert.notEqual(packDestinationFlagIndex, -1);
  assert.deepEqual(calls[3].options.env, {
    ...process.env,
    HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_FROM_SOURCE_KIND: 'published-channel',
    HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_FROM_SOURCE_REF: 'preview',
    HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_TO_SOURCE_KIND: 'local-pack',
    HAPPIER_RELEASE_VALIDATION_CLI_UPDATE_TO_SOURCE_REF: resolve(
      calls[1].args[packDestinationFlagIndex + 1],
      'happier-dev-cli-0.0.0.tgz',
    ),
  });
});

test('release-validate rejects malformed cli-update local-build packs before running continuity e2e', async () => {
  const calls = [];
  assert.throws(
    () =>
      runCliUpdateValidation({
        repoRoot,
        update: {
          from: { kind: 'published-channel', ref: 'preview' },
          to: { kind: 'local-build', ref: 'HEAD' },
        },
        exec(command, args, options = {}) {
          calls.push({ command, args, options });
          if (args[0]?.endsWith('/apps/cli/scripts/packTarball.mjs')) {
            const packDestinationFlagIndex = args.indexOf('--dest-dir');
            assert.notEqual(packDestinationFlagIndex, -1);
            const packDestination = args[packDestinationFlagIndex + 1];
            assert.equal(typeof packDestination, 'string');
            mkdirSync(packDestination, { recursive: true });
            const tarballPath = resolve(packDestination, 'happier-dev-cli-0.0.0.tgz');
            writeFileSync(tarballPath, 'fixture');
            return `${tarballPath}\n`;
          }
          if (args[0] === '-tzf') {
            return 'package/bin/happier.mjs\n';
          }
        },
      }),
    /missing required runtime entries/i,
  );

  assert.equal(calls.length, 3);
  assert.equal(calls[2].command, 'tar');
});

test('release-validate plans artifact verification against a local build source', async () => {
  const raw = execFileSync(
    process.execPath,
    [
      scriptPath,
      '--suite',
      'artifact-verify',
      '--platform',
      'linux',
      '--source',
      'local-build',
      '--ref',
      'dist/release-assets/cli',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const parsed = JSON.parse(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.suite, 'artifact-verify');
  assert.equal(parsed.platform, 'linux');
  assert.deepEqual(parsed.source, {
    kind: 'local-build',
    ref: 'dist/release-assets/cli',
  });
  assert.equal(parsed.update, null);
  assert.deepEqual(parsed.execution, {
    type: 'command',
    command: process.execPath,
    args: [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'verify-artifacts.mjs'),
      '--artifacts-dir',
      resolve(repoRoot, 'dist/release-assets/cli'),
    ],
    cwd: repoRoot,
  });
});

test('release-validate forwards artifact verification flags through the centralized executor', async () => {
  const raw = execFileSync(
    process.execPath,
    [
      scriptPath,
      '--suite',
      'artifact-verify',
      '--platform',
      'linux',
      '--source',
      'local-build',
      '--ref',
      'dist/release-assets/server',
      '--checksums',
      'dist/release-assets/server/checksums-happier-server-v1.2.3.txt',
      '--public-key',
      'scripts/release/installers/happier-release.pub',
      '--skip-smoke',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const parsed = JSON.parse(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.suite, 'artifact-verify');
  assert.deepEqual(parsed.execution, {
    type: 'command',
    command: process.execPath,
    args: [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'verify-artifacts.mjs'),
      '--artifacts-dir',
      resolve(repoRoot, 'dist/release-assets/server'),
      '--checksums',
      resolve(repoRoot, 'dist/release-assets/server/checksums-happier-server-v1.2.3.txt'),
      '--public-key',
      resolve(repoRoot, 'scripts/release/installers/happier-release.pub'),
      '--skip-smoke',
    ],
    cwd: repoRoot,
  });
});

test('release-validate plans artifact verification from a centralized product/version target', async () => {
  const raw = execFileSync(
    process.execPath,
    [
      scriptPath,
      '--suite',
      'artifact-verify',
      '--platform',
      'linux',
      '--product',
      'cli',
      '--version',
      '1.2.3-preview.4',
      '--release-channel',
      'preview',
      '--skip-smoke',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const parsed = JSON.parse(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.suite, 'artifact-verify');
  assert.equal(parsed.source, null);
  assert.deepEqual(parsed.execution, {
    type: 'command',
    command: process.execPath,
    args: [
      resolve(repoRoot, 'scripts', 'pipeline', 'release', 'verify-artifacts.mjs'),
      '--artifacts-dir',
      resolve(repoRoot, 'dist/release-assets/cli'),
      '--checksums',
      resolve(repoRoot, 'dist/release-assets/cli/checksums-happier-v1.2.3-preview.4.txt'),
      '--public-key',
      resolve(repoRoot, 'scripts/release/installers/happier-release.pub'),
      '--skip-smoke',
    ],
    cwd: repoRoot,
  });
});

test('release-validate rejects invalid explicit artifact verify release channels', async () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          scriptPath,
          '--suite',
          'artifact-verify',
          '--platform',
          'linux',
          '--product',
          'cli',
          '--version',
          '1.2.3-preview.4',
          '--release-channel',
          'banana',
          '--dry-run',
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
        },
      ),
    /artifact-verify release-channel must be stable\|preview\|dev/i,
  );
});

test('release-validate plans the centralized binary smoke lane for linux local builds', async () => {
  const raw = execFileSync(
    process.execPath,
    [
      scriptPath,
      '--suite',
      'binary-smoke',
      '--platform',
      'linux',
      '--source',
      'local-build',
      '--ref',
      'HEAD',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const parsed = JSON.parse(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.suite, 'binary-smoke');
  assert.equal(parsed.platform, 'linux');
  assert.deepEqual(parsed.source, {
    kind: 'local-build',
    ref: 'HEAD',
  });
  assert.equal(parsed.update, null);
  assert.deepEqual(parsed.execution, {
    type: 'commands',
    steps: [
      {
        name: 'self-host-binary-smoke',
        command: 'timeout',
        args: [
          '--signal=KILL',
          '--kill-after=30s',
          '25m',
          process.execPath,
          '--test',
          resolve(repoRoot, 'apps', 'stack', 'scripts', 'self_host_binary_smoke.integration.test.mjs'),
        ],
        cwd: repoRoot,
      },
      {
        name: 'release-binary-smoke',
        command: 'timeout',
        args: [
          '--signal=KILL',
          '--kill-after=30s',
          '45m',
          process.execPath,
          '--test',
          resolve(repoRoot, 'apps', 'stack', 'scripts', 'release_binary_smoke.integration.test.mjs'),
        ],
        cwd: repoRoot,
      },
    ],
  });
});

test('release-validate rejects binary smoke planning on non-linux platforms', async () => {
  assert.throws(
    () =>
      execFileSync(
        process.execPath,
        [
          scriptPath,
          '--suite',
          'binary-smoke',
          '--platform',
          'darwin',
          '--source',
          'local-build',
          '--ref',
          'HEAD',
          '--dry-run',
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 30_000,
        },
      ),
    /binary-smoke currently supports only --platform linux/i,
  );
});

test('release-validate plans docker release-assets against a published channel through the centralized executor', async () => {
  const raw = execFileSync(
    process.execPath,
    [
      scriptPath,
      '--suite',
      'docker-release-assets',
      '--platform',
      'linux',
      '--source',
      'published-channel',
      '--ref',
      'dev',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const parsed = JSON.parse(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.suite, 'docker-release-assets');
  assert.equal(parsed.platform, 'linux');
  assert.deepEqual(parsed.source, {
    kind: 'published-channel',
    ref: 'publicdev',
  });
  assert.equal(parsed.update, null);
  assert.deepEqual(parsed.execution, {
    type: 'command',
    command: 'bash',
    args: [
      resolve(repoRoot, 'scripts', 'release', 'release-assets-e2e', 'run.sh'),
      '--mode=npm',
      '--monorepo=github',
      '--stack-spec=@happier-dev/stack@next',
      '--cli-spec=@happier-dev/cli@next',
      '--no-remote-daemon',
      '--no-remote-server',
      '--remote-installer=official',
      '--remote-auth-mode=reuse-cli',
      '--no-relay-upgrade',
    ],
    cwd: repoRoot,
  });
});

test('release-validate plans docker release-assets relay upgrades from published preview to local-build', async () => {
  const raw = execFileSync(
    process.execPath,
    [
      scriptPath,
      '--suite',
      'docker-release-assets',
      '--platform',
      'linux',
      '--from-source',
      'published-channel',
      '--from-ref',
      'preview',
      '--to-source',
      'local-build',
      '--to-ref',
      'HEAD',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const parsed = JSON.parse(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.suite, 'docker-release-assets');
  assert.equal(parsed.platform, 'linux');
  assert.equal(parsed.source, null);
  assert.deepEqual(parsed.update, {
    from: {
      kind: 'published-channel',
      ref: 'preview',
    },
    to: {
      kind: 'local-build',
      ref: 'HEAD',
    },
  });
  assert.deepEqual(parsed.execution, {
    type: 'command',
    command: 'bash',
    args: [
      resolve(repoRoot, 'scripts', 'release', 'release-assets-e2e', 'run.sh'),
      '--mode=local',
      '--monorepo=local',
      '--with-remote-daemon',
      '--with-remote-server',
      '--remote-installer=shim',
      '--remote-auth-mode=reuse-cli',
      '--with-relay-upgrade',
      '--relay-upgrade-from-channel=preview',
      '--relay-upgrade-db=both',
    ],
    cwd: repoRoot,
  });
});

test('release-validate plans daemon continuity against the local-build continuity e2e lane', async () => {
  const raw = execFileSync(
    process.execPath,
    [
      scriptPath,
      '--suite',
      'daemon-continuity',
      '--platform',
      'linux',
      '--source',
      'local-build',
      '--ref',
      'HEAD',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const parsed = JSON.parse(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.suite, 'daemon-continuity');
  assert.deepEqual(parsed.source, {
    kind: 'local-build',
    ref: 'HEAD',
  });
  assert.deepEqual(parsed.execution, {
    type: 'command',
    command: process.execPath,
    args: [
      resolve(repoRoot, 'packages', 'tests', 'scripts', 'run-vitest-with-heartbeat.mjs'),
      '--config',
      resolve(repoRoot, 'packages', 'tests', 'vitest.core.slow.config.ts'),
      resolve(
        repoRoot,
        'packages',
        'tests',
        'suites',
        'core-e2e',
        'daemon.continuity.fakeClaude.reattach.slow.e2e.test.ts',
      ),
    ],
    cwd: resolve(repoRoot, 'packages', 'tests'),
  });
});

test('release-validate plans session continuity against the local-build server-restart e2e lane', async () => {
  const raw = execFileSync(
    process.execPath,
    [
      scriptPath,
      '--suite',
      'session-continuity',
      '--platform',
      'linux',
      '--source',
      'local-build',
      '--ref',
      'HEAD',
      '--dry-run',
    ],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    },
  );

  const parsed = JSON.parse(raw);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.suite, 'session-continuity');
  assert.deepEqual(parsed.source, {
    kind: 'local-build',
    ref: 'HEAD',
  });
  assert.deepEqual(parsed.execution, {
    type: 'command',
    command: process.execPath,
    args: [
      resolve(repoRoot, 'packages', 'tests', 'scripts', 'run-vitest-with-heartbeat.mjs'),
      '--config',
      resolve(repoRoot, 'packages', 'tests', 'vitest.core.slow.config.ts'),
      resolve(
        repoRoot,
        'packages',
        'tests',
        'suites',
        'core-e2e',
        'session.continuity.fakeClaude.serverRestart.slow.e2e.test.ts',
      ),
    ],
    cwd: resolve(repoRoot, 'packages', 'tests'),
  });
});
