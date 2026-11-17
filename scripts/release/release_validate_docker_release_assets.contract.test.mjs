import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

import {
  assertDockerReleaseAssetsAvailable,
  resolveDockerReleaseAssetsExecution,
  resolveDockerReleaseAssetsPlan,
  runDockerReleaseAssetsValidation,
} from '../pipeline/release-validation/executors/docker-release-assets.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const runScript = resolve(repoRoot, 'scripts', 'release', 'release-assets-e2e', 'run.sh');

test('Docker runtime invocations receive the release token by name without exposing its value', () => {
  const source = readFileSync(runScript, 'utf8');
  const header = 'set -euo pipefail\n' + source.slice(source.indexOf('mode="npm"'), source.indexOf('usage()'));
  const commands = source.split('\n').filter((line) => /run --rm --no-deps/.test(line));
  assert.ok(commands.some((line) => line.includes('"$remote_service"')));
  for (const [github, happier, expected] of [
    ['workflow-token', 'fallback-token', 'workflow-token'],
    [undefined, 'fallback-token', 'fallback-token'],
    [undefined, undefined, ''],
  ]) {
    const env = { ...process.env, EXPECTED_TOKEN: expected };
    delete env.GITHUB_TOKEN;
    delete env.HAPPIER_GITHUB_TOKEN;
    if (github !== undefined) env.GITHUB_TOKEN = github;
    if (happier !== undefined) env.HAPPIER_GITHUB_TOKEN = happier;
    const result = spawnSync('bash', ['-c', `${header}
      docker() {
        [[ "\${HAPPIER_GITHUB_TOKEN-}" == "$EXPECTED_TOKEN" ]] || return 31
        local found=0 previous="" arg
        for arg in "$@"; do
          [[ "$arg" != *token* && "$arg" != HAPPIER_GITHUB_TOKEN=* ]] || return 32
          if [[ "$previous" == -e && "$arg" == HAPPIER_GITHUB_TOKEN ]]; then found=1; fi
          previous="$arg"
        done
        [[ "$found" == 1 ]] || return 33
        # A child process must inherit the token too, as the Docker CLI does.
        bash -c '[[ "\${HAPPIER_GITHUB_TOKEN-}" == "$EXPECTED_TOKEN" ]]'
      }
      compose_run=(docker compose)
      compose_remote=(docker compose)
      compose_images=(docker compose)
      env_file=unused docker_env_file=unused remote_service=remote-daemon-authenticated-cli-smoke
      ${commands.join('\n')}
    `], { env, encoding: 'utf8' });
    assert.equal(result.status, 0, `Docker token boundary failed (${result.status}): ${result.stderr}`);
    assert.equal(result.stdout + result.stderr, '');
  }
});

test('docker release-assets plans local-build runs through the local harness path', () => {
  const plan = resolveDockerReleaseAssetsPlan({
    platform: 'linux',
    source: { kind: 'local-build', ref: 'HEAD' },
    update: null,
  });

  assert.deepEqual(plan, {
    mode: 'local',
    monorepo: 'local',
    stackSpec: null,
    cliSpec: null,
    withRemoteDaemon: true,
    withRemoteServer: true,
    remoteInstaller: 'shim',
    remoteAuthMode: 'reuse-cli',
    withRelayUpgrade: true,
    relayUpgradeFromChannel: 'preview',
    relayUpgradeDb: 'both',
    args: [
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
  });
});

test('docker release-assets plans published dev channel runs through npm next specs without relay upgrade', () => {
  const plan = resolveDockerReleaseAssetsPlan({
    platform: 'linux',
    source: { kind: 'published-channel', ref: 'dev' },
    update: null,
  });

  assert.deepEqual(plan, {
    mode: 'npm',
    monorepo: 'github',
    stackSpec: '@happier-dev/stack@next',
    cliSpec: '@happier-dev/cli@next',
    withRemoteDaemon: false,
    withRemoteServer: false,
    remoteInstaller: 'official',
    remoteAuthMode: 'reuse-cli',
    withRelayUpgrade: false,
    relayUpgradeFromChannel: null,
    relayUpgradeDb: null,
    args: [
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
  });
});

test('docker release-assets plans published preview to local-build relay upgrades through the existing harness flags', () => {
  const plan = resolveDockerReleaseAssetsPlan({
    platform: 'linux',
    source: null,
    update: {
      from: { kind: 'published-channel', ref: 'preview' },
      to: { kind: 'local-build', ref: 'HEAD' },
    },
  });

  assert.deepEqual(plan, {
    mode: 'local',
    monorepo: 'local',
    stackSpec: null,
    cliSpec: null,
    withRemoteDaemon: true,
    withRemoteServer: true,
    remoteInstaller: 'shim',
    remoteAuthMode: 'reuse-cli',
    withRelayUpgrade: true,
    relayUpgradeFromChannel: 'preview',
    relayUpgradeDb: 'both',
    args: [
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
  });
});

test('docker release-assets plans published stable to immutable server candidate upgrades', () => {
  const plan = resolveDockerReleaseAssetsPlan({
    platform: 'linux',
    source: null,
    update: {
      from: { kind: 'published-channel', ref: 'stable' },
      to: { kind: 'published-tag', ref: 'server-v0.2.11' },
    },
  });
  assert.equal(plan.relayUpgradeFromChannel, 'stable');
  assert.equal(plan.relayUpgradeToServerTag, 'server-v0.2.11');
  assert.equal(plan.relayUpgradeToServerVersion, '0.2.11');
  assert.equal(plan.withRemoteServer, false);
  assert.ok(plan.args.includes('--no-remote-server'));
  assert.ok(!plan.args.includes('--with-remote-server'));
});

test('docker release-assets rejects non-linux platforms', () => {
  assert.throws(
    () =>
      resolveDockerReleaseAssetsPlan({
        platform: 'darwin',
        source: { kind: 'local-build', ref: 'HEAD' },
        update: null,
      }),
    /linux/i,
  );
});

test('docker release-assets rejects unsupported direct source kinds', () => {
  assert.throws(
    () =>
      resolveDockerReleaseAssetsPlan({
        platform: 'linux',
        source: { kind: 'local-pack', ref: 'dist/cli.tgz' },
        update: null,
      }),
    /supports only --source local-build or --source published-channel/i,
  );
});

test('docker release-assets rejects relay upgrade sources that the harness cannot represent', () => {
  assert.throws(
    () =>
      resolveDockerReleaseAssetsPlan({
        platform: 'linux',
        source: null,
        update: {
          from: { kind: 'published-channel', ref: 'dev' },
          to: { kind: 'local-build', ref: 'HEAD' },
        },
      }),
    /relay upgrade.*stable\\|preview/i,
  );
});

test('docker release-assets resolves a bash execution plan around the existing harness', () => {
  const execution = resolveDockerReleaseAssetsExecution({
    repoRoot,
    platform: 'linux',
    source: { kind: 'published-channel', ref: 'stable' },
    update: null,
  });

  assert.deepEqual(execution, {
    type: 'command',
    command: 'bash',
    args: [
      runScript,
      '--mode=npm',
      '--monorepo=github',
      '--stack-spec=@happier-dev/stack@latest',
      '--cli-spec=@happier-dev/cli@latest',
      '--no-remote-daemon',
      '--no-remote-server',
      '--remote-installer=official',
      '--remote-auth-mode=reuse-cli',
      '--no-relay-upgrade',
    ],
    cwd: repoRoot,
  });
});

test('docker release-assets validation performs docker preflight before running the harness', () => {
  /** @type {Array<{ command: string; args: string[]; options?: unknown }>} */
  const calls = [];

  runDockerReleaseAssetsValidation({
    repoRoot,
    platform: 'linux',
    source: { kind: 'published-channel', ref: 'preview' },
    update: null,
    assertDockerAvailable: () => {
      calls.push({ command: 'assert-docker', args: [] });
    },
    exec: (command, args, options) => {
      calls.push({ command, args, options });
      return '';
    },
  });

  assert.deepEqual(calls, [
    { command: 'assert-docker', args: [] },
    {
      command: 'bash',
      args: [
        runScript,
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
      options: {
        cwd: repoRoot,
        stdio: 'inherit',
      },
    },
  ]);
});

test('docker release-assets docker preflight surfaces a helpful running-daemon hint', () => {
  assert.throws(
    () =>
      assertDockerReleaseAssetsAvailable({
        exec: () => {
          throw new Error('docker info failed');
        },
      }),
    /requires Docker to be running/i,
  );
});
