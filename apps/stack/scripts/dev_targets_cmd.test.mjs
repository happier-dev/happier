import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execFileAsync = promisify(execFile);
const script = join(import.meta.dirname, 'dev_targets.mjs');

async function run(args, storageDir, extraEnv = {}) {
  const result = await execFileAsync(process.execPath, [script, ...args, '--json'], {
    env: {
      ...process.env,
      HAPPIER_STACK_HOME_DIR: join(storageDir, 'home'),
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      HAPPIER_STACK_REPO_DIR: '',
      HAPPIER_STACK_ENV_FILE: '',
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
      ...extraEnv,
    },
  });
  return JSON.parse(result.stdout.trim());
}

async function runRaw(args, storageDir, extraEnv = {}) {
  try {
    const result = await execFileAsync(process.execPath, [script, ...args], {
      env: {
        ...process.env,
        HAPPIER_STACK_HOME_DIR: join(storageDir, 'home'),
        HAPPIER_STACK_STORAGE_DIR: storageDir,
        HAPPIER_STACK_REPO_DIR: '',
        HAPPIER_STACK_ENV_FILE: '',
        HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
        ...extraEnv,
      },
    });
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    return {
      code: Number(error?.code),
      stdout: String(error?.stdout ?? ''),
      stderr: String(error?.stderr ?? ''),
    };
  }
}

test('dev-targets command adds, shows, diagnoses, lists, and removes stack-scoped targets', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-targets-cmd-'));
  try {
    const binDir = join(root, 'bin');
    await mkdir(binDir, { recursive: true });
    for (const executable of ['mutagen', 'ssh']) {
      const path = join(binDir, executable);
      await writeFile(path, '#!/bin/sh\nexit 0\n');
      await chmod(path, 0o700);
    }

    const added = await run(
      [
        'add',
        'linux',
        '--stack=repo-test',
        '--platform=posix',
        '--ssh=happier-stack-linux',
        '--ssh-config-file=/tmp/lima-happier-stack-linux.conf',
        '--lima-instance=hslqa',
        '--lima-home=/tmp/lima-happier',
        '--repo-dir=/home/dev/happier',
        '--cli-home-dir=/home/dev/.happier/linux',
      ],
      root,
    );
    assert.equal(added.target.name, 'linux');
    assert.equal(added.target.sshConfigFile, '/tmp/lima-happier-stack-linux.conf');
    assert.equal(added.target.limaInstance, 'hslqa');
    assert.equal(added.target.limaHome, '/tmp/lima-happier');

    const shown = await run(['show', 'linux', '--stack=repo-test'], root);
    assert.equal(shown.target.repoDir, '/home/dev/happier');

    const diagnosed = await run(['doctor', 'linux', '--stack=repo-test'], root, {
      PATH: `${binDir}:${process.env.PATH}`,
    });
    assert.equal(diagnosed.ok, true);
    assert.equal(diagnosed.mutagen.ok, true);
    assert.deepEqual(
      diagnosed.targets.map((target) => ({ name: target.name, ok: target.ok })),
      [{ name: 'linux', ok: true }],
    );

    const listed = await run(['list', '--stack=repo-test'], root);
    assert.deepEqual(listed.targets.map((target) => target.name), ['linux']);

    const removed = await run(['remove', 'linux', '--stack=repo-test'], root);
    assert.equal(removed.removed, true);
    const empty = await run(['list', '--stack=repo-test'], root);
    assert.deepEqual(empty.targets, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dev-targets placement upgrades v1 safely, preserves policy while editing targets, and can downgrade explicitly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-targets-placement-'));
  try {
    await run([
      'add',
      'mac',
      '--stack=repo-test',
      '--platform=posix',
      '--ssh=mac',
      '--repo-dir=/repo',
      '--cli-home-dir=/home',
    ], root);

    const placed = await run(
      ['placement', 'set', 'expo', 'mac', '--stack=repo-test'],
      root,
    );
    assert.equal(placed.config.version, 2);
    assert.deepEqual(placed.config.runtimePlacement.expo, {
      mode: 'prefer-target',
      target: 'mac',
      fallback: 'local',
    });
    assert.deepEqual(placed.config.runtimePlacement.server, { mode: 'local' });

    const commands = await run(
      ['placement', 'set', 'commands', 'mac', '--stack=repo-test'],
      root,
    );
    assert.equal(commands.config.commandExecution.target, 'mac');
    assert.equal(commands.config.runtimePlacement.expo.target, 'mac');

    const automatic = await run(
      [
        'placement', 'set', 'commands', 'auto', '--stack=repo-test',
        '--include-local', '--fallback=error', '--load-probe-ttl-ms=20000',
        '--unavailable-probe-ttl-ms=180000',
      ],
      root,
    );
    assert.deepEqual(automatic.config.commandExecution, {
      mode: 'auto',
      targets: ['mac'],
      includeLocal: true,
      fallback: 'error',
      loadProbeTtlMs: 20000,
      unavailableProbeTtlMs: 180000,
    });

    await run([
      'add',
      'linux',
      '--stack=repo-test',
      '--platform=posix',
      '--ssh=linux',
      '--repo-dir=/repo-linux',
      '--cli-home-dir=/home-linux',
    ], root);
    const shown = await run(['placement', 'show', '--stack=repo-test'], root);
    assert.equal(shown.config.version, 2, 'adding a target must not downgrade placement config');
    assert.equal(shown.config.runtimePlacement.expo.target, 'mac');
    assert.equal(shown.config.targets.length, 2);
    assert.deepEqual(
      shown.config.commandExecution.targets,
      ['mac', 'linux'],
      'an automatic all-target pool should follow configured target additions',
    );

    const blockedRemoval = await runRaw(['remove', 'mac', '--stack=repo-test'], root);
    assert.equal(blockedRemoval.code, 1);
    assert.match(blockedRemoval.stderr, /referenced by placement/i);

    const localExpo = await run(
      ['placement', 'set', 'expo', 'local', '--stack=repo-test'],
      root,
    );
    assert.deepEqual(localExpo.config.runtimePlacement.expo, { mode: 'local' });
    await run(['placement', 'set', 'daemon', 'local', '--stack=repo-test'], root);
    const removed = await run(['remove', 'mac', '--stack=repo-test'], root);
    assert.equal(removed.removed, true);
    assert.deepEqual(removed.config.commandExecution.targets, ['linux']);

    const downgraded = await run(
      ['placement', 'clear', '--downgrade-v1', '--stack=repo-test'],
      root,
    );
    assert.equal(downgraded.config.version, 1);
    assert.equal(downgraded.config.targets.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dev-targets status, sync, and exec share the moving mirror without implicit flush or a command queue', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-targets-exec-'));
  try {
    const binDir = join(root, 'bin');
    const logPath = join(root, 'commands.log');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, 'mutagen'),
      [
        '#!/bin/sh',
        'printf "mutagen|%s|%s\\n" "$MUTAGEN_DATA_DIRECTORY" "$*" >> "$DEV_TARGET_COMMAND_LOG"',
        'if [ "$1 $2" = "sync list" ]; then',
        '  printf \'[{"name":"happier-linux","paused":false,"status":"watching","successfulCycles":4}]\\n\'',
        'fi',
        'exit 0',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(binDir, 'ssh'),
      [
        '#!/bin/sh',
        'printf "ssh|%s\\n" "$*" >> "$DEV_TARGET_COMMAND_LOG"',
        'exit "${DEV_TARGET_SSH_EXIT:-0}"',
        '',
      ].join('\n'),
    );
    await chmod(join(binDir, 'mutagen'), 0o700);
    await chmod(join(binDir, 'ssh'), 0o700);

    await run(
      [
        'add',
        'linux',
        '--stack=repo-test',
        '--platform=posix',
        '--ssh=happier-stack-linux',
        '--repo-dir=/home/dev/happier',
        '--cli-home-dir=/home/dev/.happier/linux',
      ],
      root,
    );
    const commandEnv = {
      PATH: `${binDir}:${process.env.PATH}`,
      DEV_TARGET_COMMAND_LOG: logPath,
    };

    const status = await run(['status', 'linux', '--stack=repo-test'], root, commandEnv);
    assert.equal(status.status.state, 'ready');
    assert.equal(status.status.sessionName, 'happier-linux');

    const synced = await run(['sync', 'linux', '--stack=repo-test'], root, commandEnv);
    assert.equal(synced.sync.flushed, true);

    await writeFile(logPath, '');
    const executed = await runRaw(
      [
        'exec',
        'linux',
        '--stack=repo-test',
        '--cwd=apps/cli',
        '--env=CI=1',
        '--',
        'rg',
        '--json',
        'needle',
      ],
      root,
      commandEnv,
    );
    assert.equal(executed.code, 0);
    const executionLog = await readFile(logPath, 'utf8');
    assert.match(executionLog, /mutagen\|.*\/mutagen\/data\|sync list happier-linux/);
    assert.doesNotMatch(executionLog, /sync flush/);
    assert.match(executionLog, /ssh\|.*happier-stack-linux.*apps\/cli.*CI.*rg.*--json.*needle/);

    await writeFile(logPath, '');
    const yarnStyleExecution = await runRaw(
      ['exec', 'linux', '--stack=repo-test', 'rg', '--json', 'needle'],
      root,
      commandEnv,
    );
    assert.equal(yarnStyleExecution.code, 0, 'the repo-local Yarn 1 shortcut may consume the -- separator');
    assert.match(await readFile(logPath, 'utf8'), /ssh\|.*rg.*--json.*needle/);

    const invalidEnvironment = await runRaw(
      ['exec', 'linux', '--stack=repo-test', '--env', 'BROKEN', '--', 'pwd'],
      root,
      commandEnv,
    );
    assert.equal(invalidEnvironment.code, 1);
    assert.match(invalidEnvironment.stderr, /--env requires KEY=VALUE/);

    const failed = await runRaw(
      ['exec', 'linux', '--stack=repo-test', '--', 'false'],
      root,
      { ...commandEnv, DEV_TARGET_SSH_EXIT: '7' },
    );
    assert.equal(failed.code, 7, 'remote command exit status must be preserved');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dev-targets sync-service detached owns continuous synchronization independently of Stack', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-targets-sync-service-'));
  try {
    const binDir = join(root, 'bin');
    await mkdir(binDir, { recursive: true });
    const mutagen = join(binDir, 'mutagen');
    await writeFile(mutagen, [
      '#!/bin/sh',
      'if [ "$1 $2" = "sync list" ]; then',
      '  printf \'[{"name":"happier-linux","paused":false,"status":"watching","successfulCycles":2}]\\n\'',
      'fi',
      'exit 0',
      '',
    ].join('\n'));
    await chmod(mutagen, 0o700);
    await run([
      'add',
      'linux',
      '--stack=repo-test',
      '--platform=windows',
      '--ssh=linux',
      '--repo-dir=C:/repo',
      '--cli-home-dir=C:/home',
    ], root);
    const commandEnv = { PATH: `${binDir}:${process.env.PATH}` };

    const started = await run(
      ['sync-service', 'start', '--detached', '--stack=repo-test'],
      root,
      commandEnv,
    );
    assert.equal(started.detached, true);
    assert.equal(started.statuses[0].status.state, 'ready');

    const status = await run(['sync-service', 'status', '--stack=repo-test'], root, commandEnv);
    assert.equal(status.independent, true);
    assert.equal(status.preparation.state, 'ready');
    assert.equal(status.preparation.targets.linux.state, 'ready');
    assert.equal(status.statuses[0].status.state, 'ready');

    const stopped = await run(['sync-service', 'stop', '--stack=repo-test'], root, commandEnv);
    assert.equal(stopped.released, true);
    const afterStop = await runRaw(['sync-service', 'status', '--stack=repo-test'], root, commandEnv);
    assert.equal(afterStop.code, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dev-targets exec auto takes the fast local fallback when no target is configured', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-targets-auto-local-'));
  try {
    const result = await runRaw([
      'exec', 'auto', '--stack=repo-test', '--',
      process.execPath, '-e', 'process.stdout.write("auto-local")',
    ], root);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.stdout, 'auto-local');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('dev-targets add provisions a dedicated POSIX SSH connection and discovers remote defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hstack-dev-targets-provision-'));
  try {
    const binDir = join(root, 'bin');
    const authorizedPath = join(root, 'authorized');
    await mkdir(binDir, { recursive: true });
    await writeFile(
      join(binDir, 'ssh-keygen'),
      [
        '#!/bin/sh',
        'key_path=',
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "-f" ]; then shift; key_path=$1; fi',
        '  shift',
        'done',
        'printf private > "$key_path"',
        'printf "ssh-ed25519 AAAATEST happier-dev-target\\n" > "$key_path.pub"',
        '',
      ].join('\n'),
    );
    await writeFile(
      join(binDir, 'ssh-copy-id'),
      '#!/bin/sh\nprintf "installing dedicated key\\n"\ntouch "$DEV_TARGET_AUTHORIZED_PATH"\n',
    );
    await writeFile(
      join(binDir, 'ssh'),
      [
        '#!/bin/sh',
        'last=',
        'for value in "$@"; do last=$value; done',
        'if [ "$last" = "true" ]; then',
        '  [ -f "$DEV_TARGET_AUTHORIZED_PATH" ] && exit 0',
        '  exit 255',
        'fi',
        'printf "%s\\n" "__HAPPIER_UNAME__=Darwin"',
        'printf "%s\\n" "__HAPPIER_HOME__=/Users/leeroy"',
        'printf "%s\\n" "__HAPPIER_PATH__=/Users/leeroy/.nvm/node/bin:/opt/homebrew/bin:/usr/bin:/bin"',
        'printf "%s\\n" "__HAPPIER_NODE__=/Users/leeroy/.nvm/node/bin/node"',
        'printf "%s\\n" "__HAPPIER_COREPACK__=/Users/leeroy/.nvm/node/bin/corepack"',
        '',
      ].join('\n'),
    );
    for (const executable of ['ssh-keygen', 'ssh-copy-id', 'ssh']) {
      await chmod(join(binDir, executable), 0o700);
    }

    const added = await run(
      [
        'add',
        'mac',
        '--stack=repo-test',
        '--host=100.98.30.76',
        '--user=leeroy',
      ],
      root,
      {
        PATH: `${binDir}:${process.env.PATH}`,
        DEV_TARGET_AUTHORIZED_PATH: authorizedPath,
      },
    );

    assert.equal(added.target.name, 'mac');
    assert.equal(added.target.platform, 'posix');
    assert.equal(added.target.ssh, 'happier-dev-target-mac');
    assert.equal(added.target.repoDir, '/Users/leeroy/happier-dev');
    assert.equal(added.target.cliHomeDir, '/Users/leeroy/.happier/dev-targets/mac');
    assert.deepEqual(added.target.remotePath.slice(0, 2), [
      '/Users/leeroy/.nvm/node/bin',
      '/opt/homebrew/bin',
    ]);
    assert.equal(await readFile(authorizedPath, 'utf8').catch(() => null), '');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
