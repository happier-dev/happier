import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { runCommandCapture, runNodeCapture } from './testkit/core/run_node_capture.mjs';

const script = new URL('./host.mjs', import.meta.url).pathname;
const launcher = new URL('../bin/hstack.mjs', import.meta.url).pathname;

test('host status reports an absent candidate without creating or starting a VM', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-host-status-' });
  const result = await runNodeCapture([script, 'status', '--json'], {
    env: {
      ...process.env,
      HAPPIER_STACK_HOME_DIR: fixture.path('home'),
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    configured: false,
    authoritative: false,
    activation: null,
    doctor: null,
  });
});

test('dev-vm setup preserves retained mount configuration when mount overrides are omitted', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-vm-setup-mount-preservation-' });
  const home = fixture.path('home');
  const bin = fixture.path('bin');
  const limaHome = fixture.path('lima');
  const mountDir = fixture.path('vm-home');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(bin, { recursive: true }),
    writeFile(join(bin, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n', 'utf8'),
    writeFile(join(bin, 'limactl'), [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then printf "limactl version 2.1.0\\n"; exit 0; fi',
      'if [ "$1" = "list" ]; then printf "No instance matching candidate found. unmatched instances\\n" >&2; exit 1; fi',
      'if [ "$1" = "shell" ]; then',
      '  case "$*" in',
      '    *HAPPIER_SWAP_GIB*) printf "{\\"ok\\":true}\\n" ;;',
      '    *printf*HOME*USER*) printf "/home/happier\\0happier" ;;',
      '  esac',
      '  exit 0',
      'fi',
      'exit 0',
      '',
    ].join('\n'), 'utf8'),
    writeFile(join(home, 'execution-host.json'), `${JSON.stringify({
      version: 1,
      mode: 'managed-lima',
      activation: 'candidate',
      instance: 'candidate',
      limaHome,
      profile: 'small',
      pressureProfile: 'none',
      guestWorkspaceDir: '/home/happier/.happier-stack/workspace',
      mirrorWorkspaceDir: fixture.path('workspace-mirror'),
      autoMount: true,
      hostMountDir: mountDir,
    })}\n`, 'utf8'),
  ]);
  await Promise.all([
    chmod(join(bin, 'uname'), 0o755),
    chmod(join(bin, 'limactl'), 0o755),
  ]);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HAPPIER_STACK_HOME_DIR: home,
    HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
  };
  const result = await runNodeCapture([script, 'setup', '--no-install', '--json'], { env });

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'execution-host.json'), 'utf8')), {
    version: 1,
    mode: 'managed-lima',
    activation: 'candidate',
    instance: 'candidate',
    limaHome,
    profile: 'small',
    pressureProfile: 'none',
    guestWorkspaceDir: '/home/happier/.happier-stack/workspace',
    mirrorWorkspaceDir: fixture.path('workspace-mirror'),
    autoMount: true,
    hostMountDir: mountDir,
  });
});

test('dev-vm forward status reads the execution-host-owned tunnel state without starting the VM', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-vm-forward-status-' });
  const home = fixture.path('home');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(fixture.path('mirror'), { recursive: true }),
  ]);
  await writeFile(fixture.path('home', 'execution-host.json'), `${JSON.stringify({
    version: 1,
    mode: 'managed-lima',
    activation: 'candidate',
    instance: 'candidate',
    limaHome: fixture.path('lima'),
    profile: 'small',
    guestWorkspaceDir: '/home/happier/workspace',
    mirrorWorkspaceDir: fixture.path('mirror'),
  })}\n`, 'utf8');

  const result = await runNodeCapture([script, 'forward', 'status', '--json'], {
    env: {
      ...process.env,
      HAPPIER_STACK_HOME_DIR: home,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status, 'absent');
});

test('dev-vm exec preserves an explicit guest cwd through direct hstack and the Yarn convenience command', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-host-exec-' });
  const home = fixture.path('home');
  const bin = fixture.path('bin');
  const log = fixture.path('limactl.log');
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(fixture.path('mirror'), { recursive: true });
  await writeFile(fixture.path('bin', 'uname'), '#!/bin/sh\necho Darwin\n', 'utf8');
  const instance = {
    name: 'candidate', status: 'Running', vmType: 'vz', arch: 'aarch64',
    cpus: 8, memory: 16 * 1024 ** 3, disk: 160 * 1024 ** 3,
    config: {
      mounts: [],
      vmOpts: { vz: { diskImageFormat: 'raw', rosetta: { enabled: false, binfmt: false } } },
      ssh: { forwardAgent: false },
      containerd: { user: false, system: false },
      portForwards: [
        { guestIP: '0.0.0.0', guestIPMustBeZero: false, proto: 'any', ignore: true },
      ],
    },
  };
  await writeFile(fixture.path('bin', 'limactl'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
    'if [ "$1" = "--version" ]; then echo "limactl version 2.1.0"; exit 0; fi',
    `if [ "$1" = "list" ]; then echo '${JSON.stringify(instance)}'; exit 0; fi`,
    'exit 0',
    '',
  ].join('\n'), 'utf8');
  await Promise.all([
    chmod(fixture.path('bin', 'uname'), 0o755),
    chmod(fixture.path('bin', 'limactl'), 0o755),
  ]);
  await writeFile(fixture.path('home', 'execution-host.json'), `${JSON.stringify({
    version: 1,
    mode: 'managed-lima',
    activation: 'candidate',
    instance: 'candidate',
    limaHome: fixture.path('lima'),
    profile: 'small',
    guestWorkspaceDir: '/home/happier/workspace',
    mirrorWorkspaceDir: fixture.path('mirror'),
  })}\n`, 'utf8');

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_HOME_DIR: home,
    HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
  };
  const command = ['exec', '--guest-cwd=/home/happier/workspace/dev', '--', 'sh', '-lc', 'pwd'];

  const direct = await runNodeCapture([launcher, 'dev-vm', ...command], { env });
  assert.equal(direct.code, 0, direct.stderr);

  const yarn = await runCommandCapture('yarn', ['-s', 'dev-vm', '--', ...command], {
    cwd: new URL('..', import.meta.url).pathname,
    env,
  });
  assert.equal(yarn.code, 0, yarn.stderr);

  const calls = await readFile(log, 'utf8');
  assert.equal((calls.match(/shell --workdir \/home\/happier\/workspace\/dev candidate -- sh -lc pwd/g) ?? []).length, 2);
  assert.doesNotMatch(calls, /create|delete/);
});

test('dev-vm help gives the Yarn forwarding form for guest cwd arguments', async () => {
  const result = await runNodeCapture([launcher, 'dev-vm', '--help'], {
    env: {
      ...process.env,
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.match(
    result.stdout,
    /yarn -s dev-vm -- exec --guest-cwd=\/absolute\/path -- COMMAND \[ARG\.\.\.\]/,
  );
});

test('dev-vm doctor repairs only the existing Lima guest agent when explicitly requested', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-vm-forwarding-repair-' });
  const home = fixture.path('home');
  const bin = fixture.path('bin');
  const log = fixture.path('limactl.log');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(fixture.path('mirror'), { recursive: true }),
  ]);
  await writeFile(fixture.path('bin', 'uname'), '#!/bin/sh\necho Darwin\n', 'utf8');
  const instance = {
    name: 'candidate', status: 'Running', vmType: 'vz', arch: 'aarch64',
    cpus: 8, memory: 16 * 1024 ** 3, disk: 160 * 1024 ** 3,
    config: {
      mounts: [],
      vmOpts: { vz: { diskImageFormat: 'raw', rosetta: { enabled: false, binfmt: false } } },
      ssh: { forwardAgent: false },
      containerd: { user: false, system: false },
      portForwards: [
        { guestIP: '0.0.0.0', guestIPMustBeZero: false, proto: 'any', ignore: true },
      ],
    },
  };
  await writeFile(fixture.path('bin', 'limactl'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
    'if [ "$1" = "--version" ]; then echo "limactl version 2.1.0"; exit 0; fi',
    `if [ "$1" = "list" ]; then echo '${JSON.stringify(instance)}'; exit 0; fi`,
    'if [ "$1" = "shell" ]; then exit 0; fi',
    'exit 1',
    '',
  ].join('\n'), 'utf8');
  await Promise.all([
    chmod(fixture.path('bin', 'uname'), 0o755),
    chmod(fixture.path('bin', 'limactl'), 0o755),
  ]);
  await writeFile(fixture.path('home', 'execution-host.json'), `${JSON.stringify({
    version: 1,
    mode: 'managed-lima',
    activation: 'candidate',
    instance: 'candidate',
    limaHome: fixture.path('lima'),
    profile: 'small',
    guestWorkspaceDir: '/home/happier/workspace',
    mirrorWorkspaceDir: fixture.path('mirror'),
  })}\n`, 'utf8');

  const result = await runNodeCapture([script, 'doctor', '--repair-forwarding', '--json'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HAPPIER_STACK_HOME_DIR: home,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  // This fixture deliberately has neither a MacFUSE mount nor a retained backup,
  // so the aggregate doctor remains attention-required. The repair result itself
  // must still be published before that aggregate health exit status.
  assert.equal(result.code, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).forwardingRepair, { restarted: true });
  const calls = await readFile(log, 'utf8');
  assert.match(calls, /shell candidate -- sh -lc .*systemctl kill -s SIGKILL lima-guestagent\.service/);
  assert.match(calls, /systemctl reset-failed lima-guestagent\.service/);
  assert.match(calls, /systemctl start lima-guestagent\.service/);
  assert.match(calls, /shell candidate -- sh -lc systemctl is-active --quiet lima-guestagent\.service/);
  assert.doesNotMatch(calls, /\b(?:stop|start) candidate\b/);
});

test('dev-vm mount exposes the guest home through the managed Lima SSH identity', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-vm-mount-' });
  const home = fixture.path('home');
  const bin = fixture.path('bin');
  const limaHome = fixture.path('lima');
  const mountDir = fixture.path('workspace');
  const sshConfig = fixture.path('lima', 'candidate', 'ssh.config');
  const sshfsLog = fixture.path('sshfs.log');
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(fixture.path('mirror'), { recursive: true });
  await mkdir(fixture.path('lima', 'candidate'), { recursive: true });
  await writeFile(sshConfig, 'Host lima-candidate\n  HostName 127.0.0.1\n');
  await writeFile(fixture.path('bin', 'mount'), '#!/bin/sh\nexit 0\n');
  await writeFile(fixture.path('bin', 'sshfs'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" > ${JSON.stringify(sshfsLog)}`,
    'exit 0',
    '',
  ].join('\n'));
  await writeFile(fixture.path('bin', 'limactl'), [
    '#!/bin/sh',
    'if [ "$1" = "shell" ]; then printf %s /home/happier; exit 0; fi',
    'exit 1',
    '',
  ].join('\n'));
  await Promise.all([
    chmod(fixture.path('bin', 'mount'), 0o755),
    chmod(fixture.path('bin', 'sshfs'), 0o755),
    chmod(fixture.path('bin', 'limactl'), 0o755),
  ]);
  await writeFile(fixture.path('home', 'execution-host.json'), `${JSON.stringify({
    version: 2,
    mode: 'managed-lima',
    activation: 'active',
    instance: 'candidate',
    limaHome,
    profile: 'small',
    guestWorkspaceDir: '/home/happier/.happier-stack/workspace',
    mirrorWorkspaceDir: fixture.path('mirror'),
    controllerEntrypoint: fixture.path('mirror', '0.3', 'apps', 'stack', 'scripts', 'execution_host_bridge.mjs'),
    workspaces: [{
      id: '0.3',
      hostSourceDir: fixture.path('source'),
      hostMirrorDir: fixture.path('mirror', '0.3'),
      guestDir: '/home/happier/.happier-stack/workspace/0.3',
    }],
  })}\n`);

  const mountArgs = process.platform === 'darwin'
    ? [script, 'mount', 'status', `--mount-dir=${mountDir}`, '--json']
    : [script, 'mount', 'enable', `--mount-dir=${mountDir}`, '--json'];
  const result = await runNodeCapture(mountArgs, {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HAPPIER_STACK_HOME_DIR: home,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  assert.equal(result.code, 0, result.stderr);
  if (process.platform === 'darwin') {
    // This host-level fixture intentionally does not create a real FUSE mount.
    // macFUSE availability is host state; its explicit unavailable branch is
    // covered by workspace_mount.test.mjs with an injected filesystem boundary.
    assert.equal(JSON.parse(result.stdout).mounted, false);
    return;
  }
  assert.equal(JSON.parse(result.stdout).mounted, true);
  assert.deepEqual(
    JSON.parse(await readFile(fixture.path('home', 'execution-host.json'), 'utf8')),
    {
      version: 2,
      mode: 'managed-lima',
      activation: 'active',
      instance: 'candidate',
      limaHome,
      profile: 'small',
      pressureProfile: 'none',
      guestWorkspaceDir: '/home/happier/.happier-stack/workspace',
      mirrorWorkspaceDir: fixture.path('mirror'),
      controllerEntrypoint: fixture.path('mirror', '0.3', 'apps', 'stack', 'scripts', 'execution_host_bridge.mjs'),
      autoMount: true,
      hostMountDir: mountDir,
      workspaces: [{
        id: '0.3',
        hostSourceDir: fixture.path('source'),
        hostMirrorDir: fixture.path('mirror', '0.3'),
        guestDir: '/home/happier/.happier-stack/workspace/0.3',
      }],
    },
  );
  assert.match(
    await readFile(sshfsLog, 'utf8'),
    new RegExp(`^-F ${sshConfig.replaceAll('/', '\\/')} lima-candidate:\/home\/happier ${mountDir.replaceAll('/', '\\/')} `),
  );
});

test('dev-vm mount status rejects a stale SSHFS entry and normal mount recovers it without a VM restart', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-vm-mount-recover-' });
  const home = fixture.path('home');
  const bin = fixture.path('bin');
  const limaHome = fixture.path('lima');
  const mountDir = fixture.path('workspace');
  const state = fixture.path('mount-state');
  const log = fixture.path('mount.log');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(mountDir, { recursive: true }),
    mkdir(fixture.path('mirror'), { recursive: true }),
    mkdir(fixture.path('lima', 'candidate'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(state, 'stale\n', 'utf8'),
    writeFile(fixture.path('lima', 'candidate', 'ssh.config'), 'Host lima-candidate\n', 'utf8'),
    writeFile(fixture.path('bin', 'mount'), [
      '#!/bin/sh',
      `state=${JSON.stringify(state)}`,
      `mount_dir=${JSON.stringify(mountDir)}`,
      'if [ "$(cat "$state")" != "absent" ]; then printf "macfuse on %s (osxfuse)\\n" "$mount_dir"; fi',
      '',
    ].join('\n'), 'utf8'),
    writeFile(fixture.path('bin', 'ls'), [
      '#!/bin/sh',
      `state=${JSON.stringify(state)}`,
      `mount_dir=${JSON.stringify(mountDir)}`,
      `printf 'ls %s\\n' "$*" >> ${JSON.stringify(log)}`,
      'if [ "$1" = "-A" ] && [ "$2" = "$mount_dir" ] && [ "$(cat "$state")" = "stale" ]; then',
      '  printf "ls: %s: Device not configured\\n" "$mount_dir" >&2',
      '  exit 1',
      'fi',
      'exec /bin/ls "$@"',
      '',
    ].join('\n'), 'utf8'),
    writeFile(fixture.path('bin', 'umount'), [
      '#!/bin/sh',
      `printf 'umount %s\\n' "$*" >> ${JSON.stringify(log)}`,
      `test "$1" = ${JSON.stringify(mountDir)} || exit 1`,
      `printf 'absent\\n' > ${JSON.stringify(state)}`,
      '',
    ].join('\n'), 'utf8'),
    writeFile(fixture.path('bin', 'sshfs'), [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then printf "SSHFS version 3\\n"; exit 0; fi',
      `printf 'sshfs %s\\n' "$*" >> ${JSON.stringify(log)}`,
      `printf 'mounted\\n' > ${JSON.stringify(state)}`,
      '',
    ].join('\n'), 'utf8'),
    writeFile(fixture.path('bin', 'limactl'), [
      '#!/bin/sh',
      `printf 'limactl %s\\n' "$*" >> ${JSON.stringify(log)}`,
      'if [ "$1" = "shell" ]; then printf %s /home/happier; exit 0; fi',
      'exit 1',
      '',
    ].join('\n'), 'utf8'),
  ]);
  await Promise.all(['mount', 'ls', 'umount', 'sshfs', 'limactl'].map((name) => chmod(fixture.path('bin', name), 0o755)));
  await writeFile(fixture.path('home', 'execution-host.json'), `${JSON.stringify({
    version: 1,
    mode: 'managed-lima',
    activation: 'candidate',
    instance: 'candidate',
    limaHome,
    profile: 'small',
    guestWorkspaceDir: '/home/happier/.happier-stack/workspace',
    mirrorWorkspaceDir: fixture.path('mirror'),
  })}\n`, 'utf8');
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HAPPIER_STACK_HOME_DIR: home,
    HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
  };

  const stale = await runNodeCapture([script, 'mount', 'status', `--mount-dir=${mountDir}`, '--json'], { env });
  assert.equal(stale.code, 0, stale.stderr);
  assert.equal(JSON.parse(stale.stdout).mounted, true);
  assert.equal(JSON.parse(stale.stdout).health.code, 'mount_unreachable');
  const staleText = await runNodeCapture([script, 'mount', 'status', `--mount-dir=${mountDir}`], { env });
  assert.equal(staleText.code, 0, staleText.stderr);
  assert.match(staleText.stdout, /\[dev-vm\] workspace mount: mount_unreachable/);

  const recovered = await runNodeCapture([script, 'mount', `--mount-dir=${mountDir}`, '--json'], { env });
  assert.equal(recovered.code, 0, recovered.stderr);
  assert.deepEqual(JSON.parse(recovered.stdout).health, { ok: true, code: 'mounted' });
  const operations = await readFile(log, 'utf8');
  assert.match(operations, new RegExp(`umount ${mountDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.match(operations, /sshfs -F /);
  assert.match(operations, /limactl shell candidate -- sh -lc printf %s "\$HOME"/);
  assert.doesNotMatch(operations, /limactl (?:stop|start) candidate/);
});

test('dev-vm backup reaches the canonical execution-host snapshot owner without exposing Stack secrets', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-vm-backup-' });
  const home = fixture.path('mac-home');
  const guestHome = fixture.path('guest-home');
  const bin = fixture.path('bin');
  const limaHome = fixture.path('lima');
  const destination = fixture.path('mac-backups');
  const stackDir = fixture.path('guest-home', '.happier', 'stacks', 'main');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(fixture.path('lima', 'candidate'), { recursive: true }),
    mkdir(fixture.path('guest-home', '.happier', 'stacks', 'main', 'server-light', 'files'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(fixture.path('lima', 'candidate', 'ssh.config'), 'Host lima-candidate\n', 'utf8'),
    writeFile(fixture.path('guest-home', '.happier', 'stacks', 'main', 'env'), 'HAPPIER_SERVER_SECRET=do-not-print-this\n', 'utf8'),
    writeFile(fixture.path('guest-home', '.happier', 'stacks', 'main', 'server-light', 'files', 'upload.txt'), 'upload\n', 'utf8'),
    writeFile(fixture.path('guest-home', '.happier', 'stacks', 'main', 'server-light', 'handy-master-secret.txt'), 'do-not-print-this\n', { mode: 0o600 }),
    writeFile(fixture.path('bin', 'limactl'), [
      '#!/bin/sh',
      `export HOME=${JSON.stringify(guestHome)}`,
      'export TMPDIR=/tmp',
      'if [ "$1" = "shell" ]; then',
      '  shift',
      '  while [ "$1" != "python3" ]; do shift; done',
      '  shift',
      '  exec python3 "$@"',
      'fi',
      'exit 1',
      '',
    ].join('\n'), 'utf8'),
    writeFile(fixture.path('bin', 'scp'), [
      '#!/bin/sh',
      'for argument in "$@"; do source="$argument"; done',
      'for argument in "$@"; do',
      '  case "$argument" in lima-candidate:*) source="$argument" ;; esac',
      'done',
      'remote_path="${source#*:}"',
      'for argument in "$@"; do target="$argument"; done',
      'cp "$remote_path" "$target"',
      '',
    ].join('\n'), 'utf8'),
  ]);
  await Promise.all([
    chmod(fixture.path('bin', 'limactl'), 0o755),
    chmod(fixture.path('bin', 'scp'), 0o755),
  ]);
  const initialize = await runCommandCapture('python3', ['-c', [
    'import sqlite3, sys',
    'connection = sqlite3.connect(sys.argv[1])',
    'connection.execute("CREATE TABLE _prisma_migrations (migration_name TEXT NOT NULL)")',
    'connection.execute("INSERT INTO _prisma_migrations VALUES (\\\"initial\\\")")',
    'connection.commit()',
    'connection.close()',
  ].join('; '), fixture.path('guest-home', '.happier', 'stacks', 'main', 'server-light', 'happier-server-light.sqlite')]);
  assert.equal(initialize.code, 0, initialize.stderr);
  await writeFile(fixture.path('mac-home', 'execution-host.json'), `${JSON.stringify({
    version: 1,
    mode: 'managed-lima',
    activation: 'candidate',
    instance: 'candidate',
    limaHome,
    profile: 'small',
    guestWorkspaceDir: '/home/leeroy.guest/.happier-stack/workspace',
    mirrorWorkspaceDir: fixture.path('mirror'),
  })}\n`, 'utf8');

  const result = await runNodeCapture([script, 'backup', `--destination=${destination}`, '--retention=1', '--json'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HAPPIER_STACK_HOME_DIR: home,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  assert.equal(result.code, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.destination, destination);
  assert.equal(parsed.database.integrity, 'ok');
  assert.equal((await readdir(destination)).filter((name) => name.endsWith('.tar.gz')).length, 1);
  assert.doesNotMatch(result.stdout, /do-not-print-this/);
});

test('dev-vm backup schedule persists explicit Stack names without starting the VM', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-vm-backup-schedule-' });
  const home = fixture.path('mac-home');
  const bin = fixture.path('bin');
  const launchctlLog = fixture.path('launchctl.log');
  const destinationRoot = fixture.path('backups');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(fixture.path('lima'), { recursive: true }),
    mkdir(fixture.path('mirror'), { recursive: true }),
    mkdir(fixture.path('vm-home'), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(fixture.path('bin', 'launchctl'), [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${JSON.stringify(launchctlLog)}`,
      'exit 0',
      '',
    ].join('\n'), 'utf8'),
    writeFile(join(home, 'execution-host.json'), `${JSON.stringify({
      version: 1,
      mode: 'managed-lima',
      activation: 'active',
      instance: 'happier-dev',
      limaHome: fixture.path('lima'),
      profile: 'heavy',
      guestWorkspaceDir: '/home/leeroy.guest/.happier-stack/workspace',
      mirrorWorkspaceDir: fixture.path('mirror'),
      hostMountDir: fixture.path('vm-home'),
    })}\n`, 'utf8'),
  ]);
  await chmod(fixture.path('bin', 'launchctl'), 0o755);
  const stacks = ['repo-remote-dev-d72117acdb', 'repo-dev-a1cc5e0671'];
  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${process.env.PATH ?? ''}`,
    HAPPIER_STACK_HOME_DIR: home,
    HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
  };
  const enabled = await runNodeCapture([
    script,
    'backup',
    'schedule',
    'enable',
    `--stacks=${stacks.join(',')}`,
    '--interval-hours=24',
    `--destination-root=${destinationRoot}`,
    '--json',
  ], { env });
  assert.equal(enabled.code, 0, enabled.stderr);
  assert.deepEqual(JSON.parse(enabled.stdout).schedule.stackNames, stacks);
  const plist = await readFile(join(home, 'Library', 'LaunchAgents', 'dev.happier.stack.dev-vm-backup.plist'), 'utf8');
  assert.match(plist, new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(plist, new RegExp(script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(plist, /\.happier-stack\/bin\/hstack/);

  const status = await runNodeCapture([script, 'backup', 'schedule', 'status', '--json'], { env });
  assert.equal(status.code, 0, status.stderr);
  assert.deepEqual(JSON.parse(status.stdout).stacks.map((stack) => stack.stackName), stacks);
  assert.doesNotMatch(await readFile(launchctlLog, 'utf8'), /kickstart|start/);
});

test('hstack registry exposes the dev-vm controller without retaining the unreleased host alias', async () => {
  const result = await runNodeCapture([launcher, '--help'], {
    env: {
      ...process.env,
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /hstack dev-vm setup\|activate\|mirror \[status\|sync\|stop\]\|mount \[status\|enable\|disable\]\|unmount\|backup \[status\|schedule enable\|status\|disable\]\|forward \[status\|reconcile\|stop\]\|recovery \[enable\|status\|disable\|run\]\|status\|doctor \[--repair-forwarding\]\|start\|stop\|shell\|exec/);
  assert.doesNotMatch(result.stdout, /hstack host setup/);
});

test('hstack dev-vm keeps the native controller path without an execution-host profile', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-vm-no-profile-' });
  const env = {
    ...process.env,
    HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
    HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
  };
  const sandbox = `--sandbox-dir=${fixture.path('sandbox')}`;
  const devVm = await runNodeCapture([launcher, sandbox, 'dev-vm', 'status', '--json'], { env });
  assert.equal(devVm.code, 0, devVm.stderr);
  assert.deepEqual(JSON.parse(devVm.stdout), {
    configured: false,
    authoritative: false,
    activation: null,
    doctor: null,
  });

  const retiredAlias = await runNodeCapture([launcher, sandbox, 'help', 'host'], { env });
  assert.notEqual(retiredAlias.code, 0);
  assert.match(retiredAlias.stderr, /unknown command: host/);
});

test('host mirror status inspects continuous candidate sync without touching the VM', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-host-mirror-status-' });
  const home = fixture.path('home');
  const bin = fixture.path('bin');
  await mkdir(fixture.path('home', 'execution-host-candidate'), { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(fixture.path('home', 'execution-host.json'), `${JSON.stringify({
    version: 1,
    mode: 'managed-lima',
    activation: 'candidate',
    instance: 'candidate',
    limaHome: fixture.path('lima'),
    profile: 'small',
    guestWorkspaceDir: '/home/happier/workspace',
    mirrorWorkspaceDir: fixture.path('mirror'),
  })}\n`);
  await writeFile(
    fixture.path('home', 'execution-host-candidate', 'state.v1.json'),
    `${JSON.stringify({
      version: 1,
      activation: 'candidate',
      authoritative: false,
      sourceDir: '/Users/dev/happier/dev',
      guestRepositoryDir: '/home/happier/workspace/dev',
      capture: { head: 'a'.repeat(40), refCount: 1, refsDigest: '0'.repeat(64), worktreeHeadCount: 1 },
    })}\n`,
  );
  await writeFile(fixture.path('bin', 'mutagen'), [
    '#!/bin/sh',
    'if [ "$1 $2" = "sync list" ]; then',
    '  echo \'[{"name":"happier-execution--host--candidate","status":"watching","successfulCycles":1}]\'',
    '  exit 0',
    'fi',
    'exit 9',
    '',
  ].join('\n'));
  await chmod(fixture.path('bin', 'mutagen'), 0o755);

  const result = await runNodeCapture([script, 'mirror', 'status', '--json'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HAPPIER_STACK_HOME_DIR: home,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).status.state, 'ready');
});

test('active execution profile delegates an ordinary hstack command before local workspace admission', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-host-active-' });
  const home = fixture.path('home');
  const bin = fixture.path('bin');
  const log = fixture.path('limactl.log');
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  await mkdir(fixture.path('mirror'), { recursive: true });
  await writeFile(fixture.path('bin', 'uname'), '#!/bin/sh\necho Darwin\n', 'utf8');
  const instance = {
    name: 'candidate', status: 'Running', vmType: 'vz', arch: 'aarch64',
    cpus: 8, memory: 16 * 1024 ** 3, disk: 160 * 1024 ** 3,
    config: {
      mounts: [],
      vmOpts: { vz: { diskImageFormat: 'raw', rosetta: { enabled: false, binfmt: false } } },
      ssh: { forwardAgent: false },
      containerd: { user: false, system: false },
      portForwards: [
        { guestIP: '0.0.0.0', guestIPMustBeZero: false, proto: 'any', ignore: true },
      ],
    },
  };
  await writeFile(fixture.path('bin', 'limactl'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
    'if [ "$1" = "--version" ]; then echo "limactl version 2.1.0"; exit 0; fi',
    `if [ "$1" = "list" ]; then echo '${JSON.stringify(instance)}'; exit 0; fi`,
    'if [ "$1" = "shell" ]; then',
    '  case "$*" in',
    '    *"timeout 5 loginctl"*|*"command -v node"*) exit 0 ;;',
    '    *"HAPPIER_STACK_REPO_DIR"*) exit 3 ;;',
    '  esac',
    '  exit 23',
    'fi',
    'exit 0',
    '',
  ].join('\n'), 'utf8');
  await Promise.all([
    chmod(fixture.path('bin', 'uname'), 0o755),
    chmod(fixture.path('bin', 'limactl'), 0o755),
  ]);
  await writeFile(fixture.path('home', 'execution-host.json'), `${JSON.stringify({
    version: 1,
    mode: 'managed-lima',
    activation: 'active',
    instance: 'candidate',
    limaHome: fixture.path('lima'),
    profile: 'small',
    guestWorkspaceDir: '/home/happier/workspace',
    mirrorWorkspaceDir: fixture.path('mirror'),
  })}\n`, 'utf8');

  const result = await runNodeCapture([launcher, 'where', '--json'], {
    cwd: fixture.path('mirror'),
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HAPPIER_STACK_HOME_DIR: home,
      HAPPIER_STACK_CLI_ROOT_DISABLE: '1',
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  assert.equal(result.code, 23, result.stderr);
  assert.match(await readFile(log, 'utf8'), /shell --workdir \/home\/happier\/workspace candidate -- env HAPPIER_STACK_EXECUTION_HOST_REENTRY=1/);
});

test('dev-vm recovery enable installs a next-login LaunchAgent without touching the current VM', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-vm-recovery-enable-' });
  const home = fixture.path('mac-home');
  const bin = fixture.path('bin');
  const interactivePathMarker = fixture.path('interactive-path-must-not-be-copied');
  const launchctlLog = fixture.path('launchctl.log');
  const mirrorRoot = fixture.path('workspace-mirror');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(mirrorRoot, { recursive: true }),
  ]);
  await writeFile(join(bin, 'launchctl'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(launchctlLog)}`,
    'if [ "$1" = "print" ]; then exit 113; fi',
    'exit 0',
    '',
  ].join('\n'), 'utf8');
  await chmod(join(bin, 'launchctl'), 0o755);
  await writeFile(join(home, 'execution-host.json'), `${JSON.stringify({
    version: 2,
    mode: 'managed-lima',
    activation: 'active',
    instance: 'happier-dev',
    limaHome: fixture.path('lima'),
    profile: 'heavy',
    guestWorkspaceDir: '/home/leeroy.guest/.happier-stack/workspace',
    mirrorWorkspaceDir: mirrorRoot,
    autoMount: true,
    hostMountDir: fixture.path('vm-home'),
    controllerEntrypoint: fixture.path('controller.mjs'),
    workspaces: [
      {
        id: '0.2',
        stackName: 'repo-remote-dev-d72117acdb',
        hostSourceDir: fixture.path('source-0.2'),
        hostMirrorDir: join(mirrorRoot, '0.2'),
        guestDir: '/home/leeroy.guest/.happier-stack/workspace/0.2',
      },
      {
        id: '0.3',
        stackName: 'repo-dev-a1cc5e0671',
        hostSourceDir: fixture.path('source-0.3'),
        hostMirrorDir: join(mirrorRoot, '0.3'),
        guestDir: '/home/leeroy.guest/.happier-stack/workspace/0.3',
      },
    ],
  })}\n`, 'utf8');

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${bin}:${interactivePathMarker}:${process.env.PATH ?? ''}`,
    HAPPIER_STACK_HOME_DIR: home,
    HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
  };
  const result = await runNodeCapture([script, 'recovery', 'enable', '--json'], { env });

  assert.equal(result.code, 0, result.stderr);
  const enabled = JSON.parse(result.stdout);
  assert.equal(enabled.launchAgent.label, 'dev.happier.stack.dev-vm-recovery');
  assert.equal(enabled.launchAgent.loaded, false);
  assert.equal(enabled.launchAgent.nextLogin, true);
  const plist = await readFile(join(home, 'Library', 'LaunchAgents', 'dev.happier.stack.dev-vm-recovery.plist'), 'utf8');
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /recovery<\/string>\s*<string>run<\/string>/);
  assert.doesNotMatch(plist, /access\.key|HAPPIER_STACK_ENV_FILE|HAPPIER_SERVER_URL/);
  assert.equal(plist.includes(interactivePathMarker), false);

  const status = await runNodeCapture([script, 'recovery', 'status', '--json'], { env });
  assert.equal(status.code, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).health.code, 'next_login');

  const disabled = await runNodeCapture([script, 'recovery', 'disable', '--json'], { env });
  assert.equal(disabled.code, 0, disabled.stderr);
  assert.equal(JSON.parse(disabled.stdout).removed, true);
  await assert.rejects(readFile(join(home, 'Library', 'LaunchAgents', 'dev.happier.stack.dev-vm-recovery.plist'), 'utf8'));
  assert.match(await readFile(launchctlLog, 'utf8'), /print gui\/\d+\/dev\.happier\.stack\.dev-vm-recovery/);
  assert.match(await readFile(launchctlLog, 'utf8'), /bootout gui\/\d+\/dev\.happier\.stack\.dev-vm-recovery/);
});

test('dev-vm recovery runs only the configured primary VM lifecycle, tunnel, and independent 0.3 sync owners', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-vm-recovery-run-' });
  const home = fixture.path('mac-home');
  const bin = fixture.path('bin');
  const log = fixture.path('limactl.log');
  const mirrorRoot = fixture.path('workspace-mirror');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(mirrorRoot, { recursive: true }),
  ]);
  await writeFile(join(home, 'execution-host.json'), `${JSON.stringify({
    version: 2,
    mode: 'managed-lima',
    activation: 'active',
    instance: 'happier-dev',
    limaHome: fixture.path('lima'),
    profile: 'heavy',
    guestWorkspaceDir: '/home/leeroy.guest/.happier-stack/workspace',
    mirrorWorkspaceDir: mirrorRoot,
    autoMount: false,
    controllerEntrypoint: fixture.path('controller.mjs'),
    workspaces: [
      {
        id: '0.2',
        stackName: 'repo-remote-dev-d72117acdb',
        hostSourceDir: fixture.path('source-0.2'),
        hostMirrorDir: join(mirrorRoot, '0.2'),
        guestDir: '/home/leeroy.guest/.happier-stack/workspace/0.2',
      },
      {
        id: '0.3',
        stackName: 'repo-dev-a1cc5e0671',
        hostSourceDir: fixture.path('source-0.3'),
        hostMirrorDir: join(mirrorRoot, '0.3'),
        guestDir: '/home/leeroy.guest/.happier-stack/workspace/0.3',
      },
    ],
  })}\n`, 'utf8');
  await writeFile(join(bin, 'limactl'), [
    '#!/bin/sh',
    `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
    'if [ "$1" = "list" ]; then echo \'{"name":"happier-dev","status":"Stopped"}\'; exit 0; fi',
    'if [ "$1" = "start" ]; then exit 0; fi',
    'if [ "$1" = "shell" ]; then',
    '  case "$*" in',
    '    *"HAPPIER_STACK_REPO_DIR"*) exit 3 ;;',
    '    *"dev-targets sync-service start --detached --json"*) exit 0 ;;',
    '  esac',
    '  exit 31',
    'fi',
    'exit 32',
    '',
  ].join('\n'), 'utf8');
  await chmod(join(bin, 'limactl'), 0o755);

  const result = await runNodeCapture([script, 'recovery', 'run', '--json'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: home,
      HAPPIER_STACK_HOME_DIR: home,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  assert.equal(result.code, 0, result.stderr);
  const recovery = JSON.parse(result.stdout);
  assert.deepEqual(recovery.serviceTunnels.map((tunnel) => [tunnel.workspaceId, tunnel.status]), [
    ['0.2', 'missing'],
    ['0.3', 'missing'],
  ]);
  assert.equal(recovery.sync.workspaceId, '0.3');
  assert.equal(recovery.sync.status, 'started');
  const calls = await readFile(log, 'utf8');
  assert.match(calls, /^start happier-dev$/m);
  assert.match(calls, /shell --workdir \/home\/leeroy\.guest\/.happier-stack\/workspace\/0\.3 happier-dev -- env .*dev-targets sync-service start --detached --json/);
  assert.equal((calls.match(/dev-targets sync-service start --detached --json/g) ?? []).length, 1);
  assert.doesNotMatch(calls, /hstack\.mjs (?:start|dev|tui)(?:\s|$)/);
});

test('dev-vm recovery keeps guest failure diagnostics out of its launchd output', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-vm-recovery-redaction-' });
  const home = fixture.path('mac-home');
  const bin = fixture.path('bin');
  const mirrorRoot = fixture.path('workspace-mirror');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(bin, { recursive: true }),
    mkdir(mirrorRoot, { recursive: true }),
  ]);
  await writeFile(join(home, 'execution-host.json'), `${JSON.stringify({
    version: 2,
    mode: 'managed-lima',
    activation: 'active',
    instance: 'happier-dev',
    limaHome: fixture.path('lima'),
    profile: 'heavy',
    guestWorkspaceDir: '/home/leeroy.guest/.happier-stack/workspace',
    mirrorWorkspaceDir: mirrorRoot,
    autoMount: false,
    controllerEntrypoint: fixture.path('controller.mjs'),
    workspaces: [{
      id: '0.3',
      stackName: 'repo-dev-a1cc5e0671',
      hostSourceDir: fixture.path('source-0.3'),
      hostMirrorDir: join(mirrorRoot, '0.3'),
      guestDir: '/home/leeroy.guest/.happier-stack/workspace/0.3',
    }],
  })}\n`, 'utf8');
  await writeFile(join(bin, 'limactl'), [
    '#!/bin/sh',
    'if [ "$1" = "list" ]; then echo \'{"name":"happier-dev","status":"Running"}\'; exit 0; fi',
    'if [ "$1" = "shell" ]; then',
    '  case "$*" in',
    '    *"HAPPIER_STACK_REPO_DIR"*) printf "HAPPIER_SERVER_SECRET=do-not-log-this\\n" >&2; exit 41 ;;',
    '    *"dev-targets sync-service start --detached --json"*) exit 0 ;;',
    '  esac',
    'fi',
    'exit 42',
    '',
  ].join('\n'), 'utf8');
  await chmod(join(bin, 'limactl'), 0o755);

  const result = await runNodeCapture([script, 'recovery', 'run', '--json'], {
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      HOME: home,
      HAPPIER_STACK_HOME_DIR: home,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  assert.equal(result.code, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).serviceTunnels[0].status, 'failed');
  assert.equal(JSON.parse(result.stdout).sync.status, 'started');
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /do-not-log-this/);
});

test('dev-vm recovery refuses a candidate execution-host profile', async (t) => {
  const fixture = await createTempFixture(t, { prefix: 'hstack-dev-vm-recovery-candidate-' });
  const home = fixture.path('mac-home');
  await Promise.all([
    mkdir(home, { recursive: true }),
    mkdir(fixture.path('workspace-mirror'), { recursive: true }),
  ]);
  await writeFile(join(home, 'execution-host.json'), `${JSON.stringify({
    version: 1,
    mode: 'managed-lima',
    activation: 'candidate',
    instance: 'happier-dev',
    limaHome: fixture.path('lima'),
    profile: 'heavy',
    guestWorkspaceDir: '/home/leeroy.guest/.happier-stack/workspace',
    mirrorWorkspaceDir: fixture.path('workspace-mirror'),
  })}\n`, 'utf8');

  const result = await runNodeCapture([script, 'recovery', 'enable', '--json'], {
    env: {
      ...process.env,
      HOME: home,
      HAPPIER_STACK_HOME_DIR: home,
      HAPPIER_STACK_DISABLE_STACK_ENV_AUTOLOAD: '1',
    },
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /requires the active managed execution-host profile/);
  await assert.rejects(readFile(join(home, 'Library', 'LaunchAgents', 'dev.happier.stack.dev-vm-recovery.plist'), 'utf8'));
});
