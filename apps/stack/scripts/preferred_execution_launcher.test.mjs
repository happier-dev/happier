import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = resolve(import.meta.dirname, '..', '..', '..');
const launcher = join(repoRoot, 'apps', 'stack', 'bin', 'hstack-exec');
const repoToken = repoRoot.split('/').at(-1)
  .toLowerCase()
  .replace(/[^a-z0-9-]+/g, '-')
  .replace(/-+/g, '-')
  .replace(/^-|-$/g, '') || 'repo';
const executionNeutralEnv = Object.fromEntries(
  Object.entries(process.env).filter(([key]) => ![
    'HAPPIER_DEV_TARGET_EXECUTION',
    'HAPPIER_PREFERRED_EXECUTION',
    'HAPPIER_EXEC_CONFIG_PATH',
  ].includes(key)),
);

async function executable(path, contents) {
  await writeFile(path, contents, 'utf8');
  await chmod(path, 0o755);
}

test('native launcher bypasses Node when no repository target configuration can exist', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-local-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const tokenToolMarker = join(root, 'token-tool-called');
  await mkdir(binDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  for (const command of ['dirname', 'basename', 'tr', 'sed']) {
    await executable(
      join(binDir, command),
      `#!/bin/sh\nprintf '%s\\n' ${command} >> "${tokenToolMarker}"\nexec /usr/bin/${command} "$@"\n`,
    );
  }
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "direct:%s\\n" "$1"\n');

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'direct:ok\n');
  await assert.rejects(readFile(tokenToolMarker), { code: 'ENOENT' });
});

test('automatic local execution does not pin descendant commands to the local host', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-local-env-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  await mkdir(binDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await executable(
    join(binDir, 'probe-command'),
    '#!/bin/sh\nprintf "%s\\n" "${HAPPIER_PREFERRED_EXECUTION-unset}"\n',
  );

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'unset\n');
});

test('explicit local execution is selected per invocation without consulting target configuration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-explicit-local-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  await mkdir(binDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "local:%s\\n" "$1"\n');

  const result = spawnSync('/bin/sh', [launcher, '--local', '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'local:ok\n');
});

test('native launcher uses Node once to publish a stale validated projection, then executes natively', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-target-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-test`);
  await mkdir(binDir, { recursive: true });
  await mkdir(stackDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{"version":1,"targets":[]}\n', 'utf8');
  await executable(join(binDir, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);

  const result = spawnSync('/bin/sh', [launcher, '--', '/usr/bin/true'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(
    await readFile(join(stackDir, 'dev-target-exec-v1.sh'), 'utf8'),
    /^command_mode='local'$/m,
  );
});

test('native launcher refreshes an explicit stale projection instead of silently falling back locally', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-explicit-stale-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  const projectionPath = join(stackDir, 'dev-target-exec-v1.sh');
  await mkdir(binDir, { recursive: true });
  await mkdir(stackDir, { recursive: true });
  await writeFile(configPath, '{"version":1,"targets":[]}\n', 'utf8');
  await writeFile(projectionPath, [
    "HSTACK_EXEC_PROJECTION_VERSION='1'",
    `projection_repo_root='${repoRoot}'`,
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);

  const result = spawnSync('/bin/sh', [launcher, '--', '/usr/bin/true'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(await readFile(projectionPath, 'utf8'), /^HSTACK_EXEC_PROJECTION_VERSION='2'$/m);
});

test('native launcher preserves the canonical repository cwd boundary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-cwd-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  await mkdir(binDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await executable(join(binDir, 'node'), '#!/bin/sh\nprintf "node:%s\\n" "$*"\n');

  const result = spawnSync('/bin/sh', [launcher, '--', '/usr/bin/true'], {
    cwd: root,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /working directory must stay inside the repository/i);
  assert.equal(result.stdout, '');
});

test('native launcher ignores an inherited local preference and dispatches to the least-loaded host without Node', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-native-target-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(join(stackDir, 'dev-target-command-load-native', 'mac2.cache.lock'), { recursive: true });
  await utimes(
    join(stackDir, 'dev-target-command-load-native', 'mac2.cache.lock'),
    new Date(0),
    new Date(0),
  );
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeFile(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Scanning|7||false|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac2-host*) printf "8 1 0.5\\n" ;; *) printf "8 4 0.5\\n" ;; esac ;;',
    '  *) printf "remote:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_PREFERRED_EXECUTION: 'local',
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac2/);
  assert.match(result.stdout, /remote:.*mac2-host.*probe-command.*ok/);
});

test('native launcher excludes a target without enough repository scratch space', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-full-disk-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeFile(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|7||false|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac2-host*) printf "8 0.5 0.8 220000 99\\n" ;; *) printf "8 4 0.5 22000000 98\\n" ;; esac ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *mac2-host*) printf "wrong-target:mac2\\n" ;;',
    '  *mac-host*) printf "remote:mac:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.match(result.stdout, /remote:mac:/);
  assert.doesNotMatch(result.stdout, /wrong-target:mac2/);
});

test('native launcher admits APFS targets that round capacity to 100 percent with useful free space', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-apfs-free-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeFile(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|7||false|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 0.5 0.8 7340032 100\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *mac-host*) printf "remote:mac:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.match(result.stdout, /remote:mac:/);
});

test('native launcher re-probes a cached unavailable target as soon as its sync becomes ready', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-sync-recovered-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeFile(join(cacheDir, 'mac.cache'), `${Math.floor(Date.now() / 1_000)} 0 - 1\n`);
  await writeFile(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|8||false|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 0.5 0.8 7340032 50\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *mac-host*) printf "remote:mac:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.match(result.stdout, /remote:mac:/);
});

test('native launcher retries another target when the selected host is unreachable before dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-predispatch-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeFile(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|7||false|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac2-host*) printf "8 4 0.5\\n" ;; *) printf "8 1 0.5\\n" ;; esac ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*mac-host*) exit 255 ;;',
    '  *-MNf*mac2-host*) exit 0 ;;',
    '  *mac2-host*) printf "remote:mac2:%s\\n" "$*" ;;',
    '  *mac-host*) exit 255 ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.match(result.stderr, /selected mac2 /);
  assert.match(result.stdout, /remote:mac2:.*probe-command.*ok/);
});

test('native launcher accounts for an in-flight dispatch before routing another command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-in-flight-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const holdMarker = join(root, 'first-started');
  const releaseMarker = join(root, 'release-first');
  const collisionMarker = join(root, 'second-selected-busy-target');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeFile(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|7||false|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac2-host*) printf "2 0.25 0.5\\n" ;; *) printf "8 2.4 0.5\\n" ;; esac ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *mac2-host*)',
    '    if [ -e "$HOLD_MARKER" ]; then : > "$COLLISION_MARKER"; printf "remote:mac2-second\\n"; exit 0; fi',
    '    : > "$HOLD_MARKER"',
    '    while [ ! -e "$RELEASE_MARKER" ]; do sleep 0.02; done',
    '    printf "remote:mac2-first\\n"',
    '    ;;',
    '  *mac-host*) printf "remote:mac-second\\n" ;;',
    'esac',
    '',
  ].join('\n'));
  const env = {
    ...executionNeutralEnv,
    HOME: root,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
    HOLD_MARKER: holdMarker,
    RELEASE_MARKER: releaseMarker,
    COLLISION_MARKER: collisionMarker,
  };

  const first = spawn('/bin/sh', [launcher, '--', 'probe-command', 'first'], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const firstOutput = { stdout: '', stderr: '' };
  first.stdout.on('data', (chunk) => { firstOutput.stdout += chunk; });
  first.stderr.on('data', (chunk) => { firstOutput.stderr += chunk; });
  let second;
  let dispatchError;
  try {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      try {
        await readFile(holdMarker);
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    await readFile(holdMarker);
    second = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'second'], {
      cwd: repoRoot,
      env,
      encoding: 'utf8',
    });
  } catch (error) {
    dispatchError = error;
  } finally {
    await writeFile(releaseMarker, '', 'utf8');
  }
  const firstStatus = await new Promise((resolveExit) => first.once('exit', resolveExit));

  if (dispatchError) throw dispatchError;

  assert.equal(firstStatus, 0, firstOutput.stderr);
  assert.match(firstOutput.stderr, /selected mac2/);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stderr, /selected mac /);
  assert.match(second.stdout, /remote:mac-second/);
  await assert.rejects(readFile(collisionMarker), { code: 'ENOENT' });
});

test('native launcher excludes a low-load target that cannot launch the requested command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-command-capability-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeFile(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='mac2'",
    "target_2_ssh='mac2-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/repo'",
    "target_2_cli_home='/remote/home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|7||false|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac2-host*) printf "8 1 0.5\\n" ;; *) printf "8 4 0.5\\n" ;; esac ;;',
    '  *command\\ -v*probe-command*) case "$*" in *mac2-host*) exit 1 ;; *) exit 0 ;; esac ;;',
    '  *) printf "remote:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac /);
  assert.match(result.stdout, /remote:.*mac-host.*probe-command.*ok/);
  assert.doesNotMatch(result.stdout, /mac2-host/);
});

test('native launcher bootstraps Yarn commands before dispatching them and leaves raw searches bootstrap-free', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-dependency-admission-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeFile(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    "dependency_direct_commands='node npm npx pnpm tsc vitest yarn'",
    "dependency_corepack_subcommands='npm pnpm yarn'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='mac2'",
    "target_1_ssh='mac2-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|7||false|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *remote_dependency_bootstrap.mjs*typecheck:local*) printf "typed-after-bootstrap:%s\\n" "$*" ;;',
    '  *typecheck:local*) printf "typed-without-bootstrap\\n"; exit 42 ;;',
    '  *remote_dependency_bootstrap.mjs*) printf "unexpected-bootstrap\\n"; exit 43 ;;',
    '  *rg*) printf "raw-search:%s\\n" "$*" ;;',
    '  *) printf "unexpected:%s\\n" "$*"; exit 44 ;;',
    'esac',
    '',
  ].join('\n'));
  const env = {
    ...executionNeutralEnv,
    HOME: root,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
  };

  const typed = spawnSync('/bin/sh', [launcher, '--script=typecheck:local'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(typed.status, 0, typed.stderr);
  assert.match(typed.stdout, /typed-after-bootstrap/);
  assert.match(typed.stdout, /remote_dependency_bootstrap\.mjs/);
  assert.match(typed.stdout, /node .*remote_dependency_bootstrap\.mjs/);
  assert.doesNotMatch(typed.stdout, /corepack .*yarn .*node .*remote_dependency_bootstrap\.mjs/);
  assert.match(typed.stdout, /HAPPIER_STACK_PM_CACHE_BASE_DIR.*remote\/home\/cache/);

  const raw = spawnSync('/bin/sh', [launcher, '--', 'rg', '-n', 'needle'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(raw.status, 0, raw.stderr);
  assert.match(raw.stdout, /raw-search/);
  assert.doesNotMatch(raw.stdout, /remote_dependency_bootstrap\.mjs/);
});

test('native launcher keeps an unprepared dependency target out of automatic routing when install scratch is insufficient', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-cold-dependency-disk-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeFile(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    "dependency_direct_commands='node'",
    "dependency_corepack_subcommands=''",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='mac2'",
    "target_1_ssh='mac2-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nprintf "local-node:%s\\n" "$*"\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|7||false|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 98\\n" ;;',
    '  *command\\ -v*) case "$*" in *node_modules/.yarn-integrity*df\\ -Pk*) exit 76 ;; *) exit 0 ;; esac ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *remote_dependency_bootstrap.mjs*) printf "unexpected-remote-bootstrap\\n"; exit 42 ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'node', '--version'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /no healthy execution target is available; running locally/i);
  assert.equal(result.stdout, 'local-node:--version\n');
  assert.doesNotMatch(result.stdout, /unexpected-remote-bootstrap/);
});

test('native launcher falls back locally instead of queueing behind a remote dependency refresh', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-busy-dependencies-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const dependencyBusyMarker = join(root, 'dependency-busy');
  const dependencyStaleMarker = join(root, 'dependency-stale');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeFile(dependencyBusyMarker, '1\n');
  await writeFile(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    "dependency_direct_commands='node'",
    "dependency_corepack_subcommands=''",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='mac'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nprintf "local-node:%s\\n" "$*"\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|7||false|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5\\n" ;;',
    `  *dependency-install.lock*) [ -f "${dependencyStaleMarker}" ] && case "$*" in *kill\\ -0*) exit 0 ;; esac; [ -f "${dependencyBusyMarker}" ] && exit 75; exit 0 ;;`,
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *remote_dependency_bootstrap.mjs*) printf "remote-node:%s\\n" "$*" ;;',
    '  *) printf "unexpected-remote:%s\\n" "$*"; exit 44 ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'node', '--version'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /no healthy execution target is available; running locally/i);
  assert.equal(result.stdout, 'local-node:--version\n');
  assert.doesNotMatch(result.stdout, /unexpected-remote/);

  const commandCacheDir = join(stackDir, 'dev-target-command-load-native');
  const commandCacheName = (await readdir(commandCacheDir)).find((name) => name.startsWith('mac.command.'));
  assert.ok(commandCacheName);
  assert.match(
    await readFile(join(commandCacheDir, commandCacheName), 'utf8'),
    /^\d+ 0 busy\n$/,
  );
  await writeFile(
    join(commandCacheDir, commandCacheName),
    `${Math.floor(Date.now() / 1_000) - 6} 0 busy\n`,
  );
  await writeFile(dependencyStaleMarker, '1\n');

  const recovered = spawnSync('/bin/sh', [launcher, '--', 'node', '--version'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stderr, /selected mac /);
  assert.match(recovered.stdout, /remote-node:/);
});

test('native launcher cancellation verifies the recorded process identity before terminating it', async () => {
  const source = await readFile(launcher, 'utf8');
  assert.ok(source.includes('ps -p \\"\\$pid\\" -o command='));
  assert.ok(source.includes('case \\"\\$command\\" in *\\"\\$execution_id\\"*'));
});

test('native launcher executes locally when configured command targets are not POSIX', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-native-local-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  await mkdir(binDir, { recursive: true });
  await mkdir(stackDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeFile(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "target_count='0'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "local:%s\\n" "$1"\n');

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'local:ok\n');
});

test('Windows launcher is explicitly local-only and does not start the Node router', async () => {
  const cmd = await readFile(join(repoRoot, 'apps', 'stack', 'bin', 'hstack-exec.cmd'), 'utf8');
  const powershell = await readFile(join(repoRoot, 'apps', 'stack', 'bin', 'hstack-exec.ps1'), 'utf8');
  assert.doesNotMatch(cmd, /\bnode\b/i);
  assert.match(cmd, /powershell/i);
  assert.doesNotMatch(powershell, /HAPPIER_PREFERRED_EXECUTION/);
  assert.match(powershell, /\$invocation\[0\] -eq '--local'/);
});
