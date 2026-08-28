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

test('native launcher keeps Git commands on the authoritative checkout without probing a replica', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-git-authority-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  const projectionPath = join(stackDir, 'dev-target-exec-v1.sh');
  const remoteMarker = join(root, 'remote-called');
  await mkdir(binDir, { recursive: true });
  await mkdir(stackDir, { recursive: true });
  await writeFile(configPath, '{}\n', 'utf8');
  await writeFile(projectionPath, [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "dependency_direct_commands='node npm npx pnpm tsc vitest yarn'",
    "dependency_corepack_subcommands='npm pnpm yarn'",
    "validation_direct_commands='tsc vitest'",
    "validation_script_families='build check lint test typecheck vitest'",
    "primary_only_direct_commands='git'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'git'), '#!/bin/sh\nprintf "local-git:%s\\n" "$*"\n');
  await executable(join(binDir, 'mutagen'), `#!/bin/sh\nprintf remote > "${remoteMarker}"\nprintf 'happier-linux|Scanning|7||false|0\\n'\n`);
  await executable(join(binDir, 'ssh'), `#!/bin/sh\nprintf remote > "${remoteMarker}"\ncase "$*" in *getconf*) printf '8 1 0.5 9999999 10\\n' ;; esac\n`);

  const result = spawnSync('/bin/sh', [launcher, '--', 'git', 'status'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'local-git:status\n');
  await assert.rejects(readFile(remoteMarker), { code: 'ENOENT' });
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

test('native launcher discovers the matching repository projection when its directory name is not the stack token', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-renamed-workspace-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, 'repo-stack-unrelated-token');
  const configPath = join(stackDir, 'dev-targets.json');
  await mkdir(binDir, { recursive: true });
  await mkdir(stackDir, { recursive: true });
  await writeFile(configPath, '{}\n', 'utf8');
  await writeFile(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='local'",
    "fallback_mode='error'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "happier-linux|Watching|7||false|0\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 10\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *) printf "remote:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const invocation = {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  };
  const localResult = spawnSync('/bin/sh', [launcher, '--', '/usr/bin/printf', 'preserved-command\n'], invocation);
  const result = spawnSync('/bin/sh', [launcher, '--target=linux', '--', 'probe-command'], invocation);

  assert.equal(localResult.status, 0, localResult.stderr);
  assert.equal(localResult.stdout, 'preserved-command\n');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /remote:/);
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

test('remote heavyweight admission starts from the configured repository when SSH login cwd is external', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-remote-cwd-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const machineHome = join(root, 'machine-home');
  const configPath = join(stackDir, 'dev-targets.json');
  const projectionPath = join(stackDir, 'dev-target-exec-v1.sh');
  t.after(async () => await rm(root, { recursive: true, force: true }));
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(configPath, '{}\n', 'utf8');
  await writeFile(projectionPath, [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='darwin'",
    "target_1_ssh='darwin-host'",
    "target_1_ssh_config=''",
    `target_1_repo_dir='${repoRoot}'`,
    `target_1_cli_home='${machineHome}'`,
    `target_1_remote_path='${binDir}:/usr/bin:/bin'`,
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 0\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nif [ "$2" = list ]; then printf "%s|Watching|7||false|0\\n" "$3"; fi\nexit 0\n');
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Darwin\\n"\n');
  await executable(join(binDir, 'tsc'), '#!/bin/sh\nprintf "remote-tsc\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "4 0.1 0.9 22000000 20 0 0 0 0 0 0 0 0 0 0 darwin\\n" ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *)',
    '    remote_command=',
    '    for ssh_argument in "$@"; do remote_command=$ssh_argument; done',
    '    cd -- "$REMOTE_LOGIN_CWD"',
    '    /bin/sh -c "$remote_command"',
    '    ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'tsc', '--version'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      REMOTE_LOGIN_CWD: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, 'remote-tsc\n');
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

test('native launcher automatic placement remains compatible with GNU awk local scoring', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-gawk-score-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const reservedLoadMarker = join(root, 'reserved-load-variable');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeFile(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='1'",
    "fallback_mode='error'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
  await executable(join(binDir, 'sysctl'), '#!/bin/sh\nprintf "{ 100.0 100.0 100.0 }\\n"\n');
  await executable(join(binDir, 'memory_pressure'), '#!/bin/sh\nprintf "System-wide memory free percentage: 50%%\\n"\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    `for argument in "$@"; do case "$argument" in load=*) printf called > ${JSON.stringify(reservedLoadMarker)} ;; esac; done`,
    'exec /usr/bin/awk "$@"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|7||false|0\\n" "$3"\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 10 1 16000000 24000000 0 0 0 0 0 0 0 linux\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *) printf "remote:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--', 'probe-command'], {
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
  assert.match(result.stdout, /remote:/);
  assert.doesNotMatch(result.stdout, /wrong-local/);
  await assert.rejects(readFile(reservedLoadMarker), { code: 'ENOENT' });
});

test('native launcher exact target maps the repository-relative cwd and allocates a requested TTY on only the named healthy target', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-exact-target-'));
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
    "include_local='1'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac-host'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/mac-repo'",
    "target_1_cli_home='/remote/mac-home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='linux'",
    "target_2_ssh='linux-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/linux-repo'",
    "target_2_cli_home='/remote/linux-home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\n[ "$3" = "happier-mac--host" ] || exit 0\nprintf "%s|Watching|7||false|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac-host*) printf "8 6 0.5 22000000 10\\n" ;; *) printf "8 0.1 0.9 22000000 10\\n" ;; esac ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *probe-command*) printf "remote:mac:%s\\n" "$*"; printf "remote-error\\n" >&2; exit 23 ;;',
    '  *mac-host*) printf "remote:mac:%s\\n" "$*" ;;',
    '  *linux-host*) printf "wrong-target:linux\\n" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--tty', '--', 'probe-command', 'ok'], {
    cwd: join(repoRoot, 'apps', 'stack'),
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 23, result.stderr);
  assert.match(result.stderr, /selected mac-host/);
  assert.match(result.stderr, /remote-error/);
  assert.match(result.stdout, /remote:mac:/);
  assert.match(result.stdout, /-tt -S/);
  assert.match(result.stdout, /\/remote\/mac-repo\/apps\/stack/);
  assert.doesNotMatch(result.stdout, new RegExp(repoRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.doesNotMatch(result.stdout, /wrong-target:linux/);
});

test('native launcher exact target fails closed when its command connection is rejected', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-exact-connection-'));
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
    "include_local='1'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='2'",
    "target_1_name='mac-host'",
    "target_1_ssh='mac-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/mac-repo'",
    "target_1_cli_home='/remote/mac-home'",
    "target_1_remote_path='/usr/bin:/bin'",
    "target_2_name='linux'",
    "target_2_ssh='linux-host'",
    "target_2_ssh_config=''",
    "target_2_repo_dir='/remote/linux-repo'",
    "target_2_cli_home='/remote/linux-home'",
    "target_2_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|7||false|0\\n" "$3"\n');
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) case "$*" in *mac-host*) printf "8 0.1 0.9 22000000 10\\n" ;; *) printf "8 0.2 0.8 22000000 10\\n" ;; esac ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*mac-host*) exit 72 ;;',
    '  *-MNf*linux-host*|*-O\\ exit*) exit 0 ;;',
    '  *linux-host*) printf "wrong-target:linux\\n" ;;',
    'esac',
    '',
  ].join('\n'));

  const invocation = {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  };

  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  await writeFile(cacheDir, 'occupied\n');
  const cacheFailure = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command'], invocation);
  assert.equal(cacheFailure.status, 1, cacheFailure.stderr);
  assert.doesNotMatch(cacheFailure.stdout, /wrong-target:linux|wrong-local/);
  await rm(cacheDir);

  const temporaryFailure = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command'], {
    ...invocation,
    env: { ...invocation.env, TMPDIR: join(root, 'missing') },
  });
  assert.equal(temporaryFailure.status, 1, temporaryFailure.stderr);
  assert.doesNotMatch(temporaryFailure.stdout, /wrong-target:linux|wrong-local/);

  const result = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command'], invocation);

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /mac-host.*command connection/i);
  assert.doesNotMatch(result.stdout, /wrong-target:linux|wrong-local/);
});

test('native launcher preserves a successful remote command when the login shell exit hook fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-remote-exit-hook-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const remoteRepo = join(root, 'remote-repo');
  const remoteHome = join(root, 'remote-home');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(join(stackDir, 'dev-target-command-load-native'), { recursive: true });
  await mkdir(remoteRepo, { recursive: true });
  await mkdir(remoteHome, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeFile(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    `target_1_repo_dir='${remoteRepo}'`,
    `target_1_cli_home='${remoteHome}'`,
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|7||false|0\\n" "$3"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 10\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *"&& [ -x "*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *)',
    '    remote_command=; for ssh_argument in "$@"; do remote_command=$ssh_argument; done',
    '    eval "set -- $remote_command"',
    '    case "$3" in *"set +e"*) ;; *) exit 41 ;; esac',
    '    printf "%s\\n" "$3" | /bin/bash -c \'source /dev/stdin\'',
    '    ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--target=linux', '--', '/usr/bin/true'], {
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
});

test('native launcher exact target bypasses local automatic placement from a freshly generated projection', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-exact-local-policy-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    version: 3,
    targets: [{
      name: 'mac-host',
      platform: 'posix',
      ssh: 'mac-host',
      repoDir: '/remote/mac-repo',
      cliHomeDir: '/remote/mac-home',
      remotePath: ['/usr/bin', '/bin'],
    }],
    runtimePlacement: {
      server: { mode: 'local' },
      expo: { mode: 'local' },
      daemon: { mode: 'local' },
    },
    commandExecution: { mode: 'local' },
  }), 'utf8');
  await executable(join(binDir, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|7||false|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 10\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *) printf "remote:mac:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /selected mac-host/);
  assert.match(result.stdout, /remote:mac:/);
  assert.doesNotMatch(result.stdout, /wrong-local/);
});

test('native launcher refreshes a projection produced by older generator bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-generator-stale-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  const projectionPath = join(stackDir, 'dev-target-exec-v1.sh');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    version: 3,
    targets: [{
      name: 'mac-host',
      platform: 'posix',
      ssh: 'mac-host',
      repoDir: '/remote/mac-repo',
      cliHomeDir: '/remote/mac-home',
      remotePath: ['/usr/bin', '/bin'],
    }],
    runtimePlacement: {
      server: { mode: 'local' },
      expo: { mode: 'local' },
      daemon: { mode: 'local' },
    },
    commandExecution: { mode: 'local' },
  }), 'utf8');
  await writeFile(projectionPath, [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='local'",
    "fallback_mode='local'",
    "target_count='0'",
    '',
  ].join('\n'));
  const oldTimestamp = new Date(0);
  await utimes(configPath, oldTimestamp, oldTimestamp);
  await utimes(projectionPath, oldTimestamp, oldTimestamp);
  await executable(join(binDir, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|7||false|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 10\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *) printf "remote:mac:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));

  const result = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /remote:mac:/);
  assert.doesNotMatch(result.stdout, /wrong-local/);
});

test('native launcher exact target re-probes a previously unavailable command immediately', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-exact-recovery-'));
  const binDir = join(root, 'bin');
  const stackDir = join(root, 'stack');
  const configPath = join(stackDir, 'dev-targets.json');
  const healthyMarker = join(root, 'healthy');
  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await writeFile(configPath, JSON.stringify({
    version: 3,
    targets: [{
      name: 'mac-host',
      platform: 'posix',
      ssh: 'mac-host',
      repoDir: '/remote/mac-repo',
      cliHomeDir: '/remote/mac-home',
      remotePath: ['/usr/bin', '/bin'],
    }],
    runtimePlacement: {
      server: { mode: 'local' },
      expo: { mode: 'local' },
      daemon: { mode: 'local' },
    },
    commandExecution: { mode: 'local' },
  }), 'utf8');
  await executable(join(binDir, 'node'), `#!/bin/sh\nexec ${process.execPath} "$@"\n`);
  await executable(
    join(binDir, 'mutagen'),
    '#!/bin/sh\nprintf "%s|Watching|7||false|0\\n" "$3"\n',
  );
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    `if [ ! -f ${JSON.stringify(healthyMarker)} ]; then exit 1; fi`,
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5 22000000 10\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *) printf "remote:mac:%s\\n" "$*" ;;',
    'esac',
    '',
  ].join('\n'));
  const invocation = {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_EXEC_CONFIG_PATH: configPath,
      HAPPIER_STACK_STORAGE_DIR: join(root, 'stacks'),
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  };

  const unavailable = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command'], invocation);
  assert.notEqual(unavailable.status, 0);
  await writeFile(healthyMarker, 'ready\n', 'utf8');

  const recovered = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command'], invocation);
  assert.equal(recovered.status, 0, recovered.stderr);
  assert.match(recovered.stdout, /remote:mac:/);
  assert.doesNotMatch(recovered.stdout, /wrong-local/);
});

test('native launcher exact target fails closed when no target configuration exists', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-exact-unconfigured-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  await mkdir(binDir, { recursive: true });
  await mkdir(storageDir, { recursive: true });
  await executable(join(binDir, 'probe-command'), '#!/bin/sh\nprintf "wrong-local\\n"\n');

  const result = spawnSync('/bin/sh', [launcher, '--target=mac-host', '--', 'probe-command'], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      HAPPIER_STACK_STORAGE_DIR: storageDir,
      PATH: `${binDir}:/usr/bin:/bin`,
    },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no target configuration/i);
  assert.doesNotMatch(result.stdout, /wrong-local/);
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

test('native launcher passively waits for a contended dispatch reservation, cancels, and reclaims stale locks', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-dispatch-backoff-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  const dispatchLock = join(cacheDir, 'dispatch.lock');
  const sleepAttempts = join(root, 'dispatch-sleep-attempts');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(dispatchLock, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeFile(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='remote'",
    "target_1_ssh='remote-host'",
    "target_1_ssh_config=''",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|7||false|0\\n" "$3"\n');
  await executable(join(binDir, 'sleep'), [
    '#!/bin/sh',
    'printf "%s\\n" "$1" >> "$DISPATCH_SLEEP_ATTEMPTS"',
    'exec /bin/sleep "${DISPATCH_SLEEP_ACTUAL_SECONDS-$1}"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'stat'), [
    '#!/bin/sh',
    'case "$1" in',
    '  -c) printf "1\\n" ;;',
    '  -f) printf "/\\n" ;;',
    '  *) exec /usr/bin/stat "$@" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "8 1 0.5\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *remote-host*) printf "remote:dispatch\\n" ;;',
    'esac',
    '',
  ].join('\n'));
  const env = {
    ...executionNeutralEnv,
    HOME: root,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    DISPATCH_SLEEP_ATTEMPTS: sleepAttempts,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
  };
  const waiter = spawn('/bin/sh', [launcher, '--', 'probe-command', 'status'], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = { stdout: '', stderr: '' };
  waiter.stdout.on('data', (chunk) => { output.stdout += chunk; });
  waiter.stderr.on('data', (chunk) => { output.stderr += chunk; });
  const waitForFile = async (path, label) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        await readFile(path);
        return;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const waitForExit = async (child) => {
    if (child.exitCode != null) return child.exitCode;
    return await new Promise((resolveExit) => child.once('exit', resolveExit));
  };
  try {
    await waitForFile(sleepAttempts, 'the dispatch lock retry');
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    const sleeps = (await readFile(sleepAttempts, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(sleeps.length, 1, `expected one passive dispatch retry, received ${sleeps.join(',')}`);
    assert.match(sleeps[0], /^[23]$/, `expected a 2–3 second dispatch retry delay, received ${sleeps[0]}`);
    assert.equal(waiter.exitCode, null, output.stderr);
    waiter.kill('SIGTERM');
    const status = await new Promise((resolveExit) => {
      const timeout = setTimeout(() => resolveExit('timeout'), 1_000);
      waiter.once('exit', (exitStatus) => {
        clearTimeout(timeout);
        resolveExit(exitStatus);
      });
    });
    assert.equal(status, 130, output.stderr);
    assert.doesNotMatch(output.stderr, /temporarily unavailable/);
    await utimes(dispatchLock, new Date(1_000), new Date(1_000));
    const stale = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'stale'], {
      cwd: repoRoot,
      env: { ...env, DISPATCH_SLEEP_ACTUAL_SECONDS: '0.01' },
      encoding: 'utf8',
    });
    assert.equal(stale.status, 0, stale.stderr);
    assert.match(stale.stdout, /remote:dispatch/);
  } finally {
    if (waiter.exitCode == null) waiter.kill('SIGKILL');
    await waitForExit(waiter);
  }
});

test('native launcher keeps Linux control commands preferred and adapts recognized worker tools to pressure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-resource-governor-'));
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
    "validation_direct_commands='tsc vitest'",
    "validation_script_families='build check lint test typecheck vitest'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
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
    '  *getconf*) case "${GOVERNOR_PRESSURE-}" in quiet) printf "14 1 0.8 22000000 20 2 48000000 72000000 0 0 0 0 0 0 0 linux\\n" ;; *) printf "14 360 0.8 22000000 20 420 48000000 72000000 0 0 90 0 0 0 0 linux\\n" ;; esac ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *) remote_command=; for ssh_argument in "$@"; do remote_command=$ssh_argument; done; eval "set -- $remote_command"; /bin/bash -n -c "$3" || exit $?; printf "remote:%s\\n" "$*" ;;',
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

  const control = spawnSync('/bin/sh', [launcher, '--', 'probe-command', 'status'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const vitest = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', 'fixture.test.ts'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const search = spawnSync('/bin/sh', [launcher, '--', 'rg', 'needle', 'sources'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const typecheck = spawnSync('/bin/sh', [launcher, '--', 'node', 'scripts/workspaces/runTypeScriptCli.mjs', '--noEmit'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const scriptedVitest = spawnSync('/bin/sh', [launcher, '--script=test:local'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const scriptedTypecheck = spawnSync('/bin/sh', [launcher, '--script=typecheck:local'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const quietVitest = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', 'fixture.test.ts'], {
    cwd: repoRoot,
    env: { ...env, GOVERNOR_PRESSURE: 'quiet' },
    encoding: 'utf8',
  });
  const explicitVitestWorkers = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', '--maxWorkers=6'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const explicitVitestPoolWorkers = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run', '--poolOptions.forks.maxForks=6'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  const explicitVitestEnvironment = spawnSync('/bin/sh', [launcher, '--', 'vitest', 'run'], {
    cwd: repoRoot,
    env: { ...env, VITEST_MAX_THREADS: '7' },
    encoding: 'utf8',
  });
  const explicitTypeScriptEnvironment = spawnSync('/bin/sh', [launcher, '--', 'node', 'scripts/workspaces/runTypeScriptCli.mjs', '--noEmit'], {
    cwd: repoRoot,
    env: { ...env, GOMAXPROCS: '7' },
    encoding: 'utf8',
  });

  for (const result of [
    control,
    vitest,
    search,
    typecheck,
    scriptedVitest,
    scriptedTypecheck,
    quietVitest,
    explicitVitestWorkers,
    explicitVitestPoolWorkers,
    explicitVitestEnvironment,
    explicitTypeScriptEnvironment,
  ]) {
    assert.equal(result.status, 0, result.stderr);
  }
  assert.doesNotMatch(control.stdout, /nice -n 10|--maxWorkers|--threads|--singleThreaded/);
  assert.match(vitest.stdout, /VITEST_MAX_THREADS=1.*VITEST_MIN_THREADS=1.*nice -n 10.*vitest/s);
  assert.match(vitest.stdout, /VITEST_MAX_FORKS=1.*VITEST_MIN_FORKS=1/s);
  assert.doesNotMatch(vitest.stdout, /--maxWorkers=1/);
  assert.doesNotMatch(vitest.stdout, /fi;;/);
  assert.match(search.stdout, /nice -n 10.*rg.*--threads=1/s);
  assert.match(typecheck.stdout, /GOMAXPROCS=1.*nice -n 10.*runTypeScriptCli\.mjs/s);
  assert.doesNotMatch(typecheck.stdout, /--singleThreaded/);
  assert.match(scriptedVitest.stdout, /VITEST_MAX_THREADS=1.*nice -n 10.*corepack.*yarn.*test:local/s);
  assert.match(scriptedTypecheck.stdout, /GOMAXPROCS=1.*nice -n 10.*corepack.*yarn.*typecheck:local/s);
  assert.match(quietVitest.stdout, /nice -n 10.*vitest/s);
  assert.doesNotMatch(quietVitest.stdout, /VITEST_MAX_THREADS=|--maxWorkers/);
  assert.match(explicitVitestWorkers.stdout, /vitest.*--maxWorkers=6/s);
  assert.doesNotMatch(explicitVitestWorkers.stdout, /VITEST_MAX_THREADS=1|VITEST_MAX_FORKS=1/);
  assert.match(explicitVitestPoolWorkers.stdout, /vitest.*--poolOptions\.forks\.maxForks=6/s);
  assert.doesNotMatch(explicitVitestPoolWorkers.stdout, /VITEST_MAX_THREADS=1|VITEST_MAX_FORKS=1/);
  assert.match(explicitVitestEnvironment.stdout, /VITEST_MAX_THREADS=.*7/s);
  assert.doesNotMatch(explicitVitestEnvironment.stdout, /VITEST_MAX_THREADS=1|VITEST_MAX_FORKS=1/);
  assert.match(explicitTypeScriptEnvironment.stdout, /GOMAXPROCS=.*7/s);
  assert.doesNotMatch(explicitTypeScriptEnvironment.stdout, /GOMAXPROCS=1/);
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
    '  *getconf*) printf "8 1 0.5 22000000 20 2 12000000 24000000 1000 8000000 0.1 0.2 0.3 4 5 linux\\n" ;;',
    '  *command\\ -v*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *remote_dependency_bootstrap.mjs*remote_validation_preparation.mjs*typecheck:local*) printf "typed-after-preparation:%s\\n" "$*" ;;',
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

  const componentTyped = spawnSync('/bin/sh', [launcher, '--script=typecheck:local'], {
    cwd: join(repoRoot, 'apps', 'cli'),
    env,
    encoding: 'utf8',
  });
  assert.equal(componentTyped.status, 0, componentTyped.stderr);
  assert.match(componentTyped.stdout, /typed-after-preparation/);
  assert.match(componentTyped.stdout, /remote_validation_preparation\.mjs/);
  assert.match(componentTyped.stdout, /--component-relative-dir=apps\/cli/);

  const raw = spawnSync('/bin/sh', [launcher, '--', 'rg', '-n', 'needle'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(raw.status, 0, raw.stderr);
  assert.match(raw.stdout, /raw-search/);
  assert.doesNotMatch(raw.stdout, /remote_dependency_bootstrap\.mjs/);

  const provenanceLines = (await readFile(
    join(stackDir, 'dev-target-command-load-native', 'provenance.jsonl'),
    'utf8',
  )).trim().split('\n').map((line) => JSON.parse(line));
  const admittedClasses = provenanceLines
    .filter((entry) => entry.phase === 'admitted')
    .map((entry) => entry.commandClass);
  assert.deepEqual(admittedClasses, ['full-validation', 'targeted-validation', 'source-search']);
  assert.equal(provenanceLines.filter((entry) => entry.phase === 'completed').length, 3);
  assert.equal(provenanceLines.every((entry) => entry.schemaVersion === 1), true);
  assert.equal(provenanceLines.every((entry) => !('commandArgs' in entry)), true);
  assert.equal(provenanceLines.every((entry) => (
    entry.phase !== 'admitted' || entry.activeClassReservations === 0
  )), true);
  assert.deepEqual(
    {
      runQueue: provenanceLines[0].runQueue,
      memAvailableKiB: provenanceLines[0].memAvailableKiB,
      swapUsedKiB: provenanceLines[0].swapUsedKiB,
      memoryPsiAvg10: provenanceLines[0].memoryPsiAvg10,
      swapInPages: provenanceLines[0].swapInPages,
      platform: provenanceLines[0].platform,
    },
    {
      runQueue: 2,
      memAvailableKiB: 12_000_000,
      swapUsedKiB: 1_000,
      memoryPsiAvg10: 0.2,
      swapInPages: 4,
      platform: 'linux',
    },
  );
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

test('native launcher ordinary automatic dispatch uses the ready moving mirror without flushing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-moving-mirror-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  const remoteMarker = join(root, 'remote-command-ran');
  const localMarker = join(root, 'local-command-ran');
  const flushMarker = join(root, 'mutagen-flush-ran');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeFile(join(cacheDir, 'provenance.jsonl'), '');
  const cachedAt = Math.floor(Date.now() / 1_000);
  await writeFile(join(cacheDir, 'linux.cache'), `${cachedAt} 1 0.000000 4\n`);
  await writeFile(join(cacheDir, 'linux.command.2560848116.cache'), `${cachedAt} 1\n`);
  await writeFile(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_sync_name='named-linux-sync'",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'probe-command'), `#!/bin/sh\n: > "${localMarker}"\nprintf 'local:%s\\n' "$*"\n`);
  await executable(join(binDir, 'mutagen'), `#!/bin/sh\n[ "$2" != flush ] || { : > "${flushMarker}"; exit 73; }\nexit 92\n`);
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    `  *) : > "${remoteMarker}"; printf 'remote:%s\\n' "$*" ;;`,
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
  assert.match(result.stderr, /selected linux /);
  assert.match(result.stdout, /remote:.*probe-command.*ok/);
  await readFile(remoteMarker);
  await assert.rejects(readFile(localMarker), { code: 'ENOENT' });
  await assert.rejects(readFile(flushMarker), { code: 'ENOENT' });
});

test('native launcher exact target flushes the selected Mutagen session before remote dispatch and fails closed after a flush failure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-sync-flush-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const cacheDir = join(stackDir, 'dev-target-command-load-native');
  const remoteMarker = join(root, 'remote-command-ran');
  const localMarker = join(root, 'local-command-ran');
  const flushMarker = join(root, 'mutagen-flushes');
  const flushWaitStarted = join(root, 'mutagen-flush-started');
  const flushWaitRelease = join(root, 'mutagen-flush-release');
  const flushWaitFinished = join(root, 'mutagen-flush-finished');
  const flushWaitTerminated = join(root, 'mutagen-flush-terminated');
  const mutagenDataDir = join(stackDir, 'mutagen', 'data');
  const mutagenSshPath = join(stackDir, 'mutagen', 'openssh');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await mkdir(mutagenDataDir, { recursive: true });
  await mkdir(mutagenSshPath, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  // Keep automatic placement entirely on its fresh load and command caches.
  // The first SSH in this test must therefore be the selected-target dispatch
  // path, which is the stale-byte boundary the flush protects.
  const cachedAt = Math.floor(Date.now() / 1_000);
  await writeFile(join(cacheDir, 'linux.cache'), `${cachedAt} 1 0.000000 4\n`);
  await writeFile(join(cacheDir, 'linux.command.2560848116.cache'), `${cachedAt} 1\n`);
  await writeFile(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='local'",
    "load_ttl_seconds='15'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    "target_1_sync_name='named-linux-sync'",
    "target_1_repo_dir='/remote/repo'",
    "target_1_cli_home='/remote/home'",
    "target_1_remote_path='/usr/bin:/bin'",
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), '#!/bin/sh\nexit 97\n');
  await executable(join(binDir, 'probe-command'), `#!/bin/sh\n: > "${localMarker}"\nprintf 'local:%s\\n' "$*"\n`);
  await executable(join(binDir, 'mutagen'), [
    '#!/bin/sh',
    'case "$2" in',
    `  flush) : > "${remoteMarker}.fresh"; printf '%s|%s|%s\\n' "$MUTAGEN_DATA_DIRECTORY" "$MUTAGEN_SSH_PATH" "$3" >> "${flushMarker}"; if [ "\${FLUSH_WAIT-}" = 1 ]; then trap ': > "$FLUSH_WAIT_TERMINATED"; exit 0' TERM; : > "$FLUSH_WAIT_STARTED"; while [ ! -e "$FLUSH_WAIT_RELEASE" ]; do sleep 0.02; done; : > "$FLUSH_WAIT_FINISHED"; fi; [ "\${FLUSH_FAIL-}" != 1 ] || exit 73 ;;`,
    '  *) exit 92 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    `if [ ! -e "${remoteMarker}.fresh" ]; then printf '%s\\n' 'remote dispatch attempted before sync flush' >&2; exit 74; fi`,
    'case "$*" in',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    `  *) : > "${remoteMarker}"; printf 'remote:%s\\n' "$*" ;;`,
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
  const successful = spawnSync('/bin/sh', [launcher, '--target=linux', '--', 'probe-command', 'ok'], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  assert.equal(successful.status, 0, successful.stderr);
  assert.match(successful.stdout, /remote:.*probe-command.*ok/);
  assert.equal(
    await readFile(flushMarker, 'utf8'),
    `${mutagenDataDir}|${mutagenSshPath}|named-linux-sync\n`,
  );
  await readFile(remoteMarker);

  await rm(remoteMarker, { force: true });
  const exactFailure = spawnSync('/bin/sh', [launcher, '--target=linux', '--', 'probe-command', 'exact'], {
    cwd: repoRoot,
    env: { ...env, FLUSH_FAIL: '1' },
    encoding: 'utf8',
  });
  assert.equal(exactFailure.status, 1, exactFailure.stderr);
  assert.match(exactFailure.stderr, /sync flush failed.*linux/);
  assert.equal(exactFailure.stdout, '');
  await assert.rejects(readFile(localMarker), { code: 'ENOENT' });
  await assert.rejects(readFile(remoteMarker), { code: 'ENOENT' });
  assert.deepEqual((await readdir(cacheDir)).filter((entry) => entry.startsWith('linux.active.')), []);

  const waitForFile = async (path, label) => {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try {
        await readFile(path);
        return;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const waitForFlushExit = async () => {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try {
        await readFile(flushWaitTerminated);
        return;
      } catch {
        try {
          await readFile(flushWaitFinished);
          return;
        } catch {
          await new Promise((resolveWait) => setTimeout(resolveWait, 20));
        }
      }
    }
    throw new Error('timed out waiting for the fake sync flush to exit');
  };
  const flushing = spawn('/bin/sh', [launcher, '--target=linux', '--', 'probe-command', 'cancelled-flush'], {
    cwd: repoRoot,
    env: {
      ...env,
      FLUSH_WAIT: '1',
      FLUSH_WAIT_STARTED: flushWaitStarted,
      FLUSH_WAIT_RELEASE: flushWaitRelease,
      FLUSH_WAIT_FINISHED: flushWaitFinished,
      FLUSH_WAIT_TERMINATED: flushWaitTerminated,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    await waitForFile(flushWaitStarted, 'the selected sync flush');
    flushing.kill('SIGTERM');
    const exit = await new Promise((resolveExit) => flushing.once('exit', (code, signal) => resolveExit({ code, signal })));
    assert.deepEqual(exit, { code: 130, signal: null });
    await waitForFile(flushWaitTerminated, 'the interrupted sync flush to terminate');
    await assert.rejects(readFile(remoteMarker), { code: 'ENOENT' });
    assert.deepEqual((await readdir(cacheDir)).filter((entry) => entry.startsWith('linux.active.')), []);
  } finally {
    await writeFile(flushWaitRelease, '', 'utf8');
    await waitForFlushExit();
    if (flushing.exitCode == null && flushing.signalCode == null) flushing.kill('SIGTERM');
  }
});

test('native launcher admits heavyweight local and remote jobs, reclaims stale owners, and cancels waiters', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-heavyweight-admission-'));
  const binDir = join(root, 'bin');
  const storageDir = join(root, 'stacks');
  const stackDir = join(storageDir, `repo-${repoToken}-native`);
  const machineHome = join(root, 'machine-home');
  const admissionRoot = join(root, '.happier', 'heavyweight-admission-v1');
  const holdMarker = join(root, 'first-started');
  const releaseMarker = join(root, 'release-first');
  const cancelledMarker = join(root, 'cancelled-command-ran');
  const runningMarker = join(root, 'running-command-started');
  const terminatedMarker = join(root, 'running-command-terminated');
  const collisionMarker = join(root, 'remote-command-ran-before-admission');
  const scopeMarker = join(root, 'systemd-scope-invocations');
  const staleOwner = join(admissionRoot, 'owners', '999999-stale');
  const staleWaiter = join(admissionRoot, 'waiters', '999998-stale');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await mkdir(join(stackDir, 'mutagen', 'data'), { recursive: true });
  await mkdir(staleOwner, { recursive: true });
  await writeFile(join(staleOwner, 'process'), '999999 stale\n', 'utf8');
  await writeFile(join(stackDir, 'dev-targets.json'), '{}\n');
  await writeFile(join(stackDir, 'dev-target-exec-v1.sh'), [
    "HSTACK_EXEC_PROJECTION_VERSION='2'",
    "dependency_direct_commands='node npm npx pnpm tsc vitest yarn'",
    "dependency_corepack_subcommands='npm pnpm yarn'",
    "validation_direct_commands='tsc vitest'",
    "validation_script_families='build check lint test typecheck vitest'",
    `projection_repo_root='${repoRoot}'`,
    "command_mode='auto'",
    "include_local='0'",
    "fallback_mode='error'",
    "load_ttl_seconds='0'",
    "unavailable_ttl_seconds='120'",
    "target_count='1'",
    "target_1_name='linux'",
    "target_1_ssh='linux-host'",
    "target_1_ssh_config=''",
    `target_1_repo_dir='${repoRoot}'`,
    `target_1_cli_home='${machineHome}'`,
    `target_1_remote_path='${binDir}:/usr/bin:/bin'`,
    '',
  ].join('\n'));
  await executable(join(binDir, 'node'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *remote_dependency_bootstrap.mjs*) exec vitest remote-bootstrap ;;',
    '  *node_modules/vitest/vitest.mjs*) exec vitest "$@" ;;',
    '  *generateBundledPluginEntries.ts*) exec vitest remote-bundled-plugin-generator ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  await executable(join(binDir, 'corepack'), '#!/bin/sh\n[ "${1-}" = yarn ] && shift\nexec vitest "$@"\n');
  for (const packageManager of ['yarn', 'npm', 'pnpm']) {
    await executable(join(binDir, packageManager), '#!/bin/sh\nexec vitest "$@"\n');
  }
  await executable(join(binDir, 'tsc'), '#!/bin/sh\nexec vitest "$@"\n');
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "4\\n"\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    'case "$*" in',
    '  */proc/loadavg*) printf "0\\n" ;;',
    '  */proc/meminfo*) case "$1" in *MemAvailable*) printf "48000000 72000000\\n" ;; *) printf "72000000\\n" ;; esac ;;',
    '  */proc/pressure/memory*) printf "0\\n" ;;',
    '  *) exec /usr/bin/awk "$@" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'mutagen'), '#!/bin/sh\nprintf "%s|Watching|7||false|0\\n" "$3"\n');
  await executable(join(binDir, 'systemctl'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *show-environment*) exit 0 ;;',
    '  *LoadState*) printf "loaded\\n"; exit 0 ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'systemd-run'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" >> "$SYSTEMD_SCOPE_MARKER"',
    'while [ "$#" -gt 0 ]; do',
    '  [ "$1" = -- ] && { shift; break; }',
    '  shift',
    'done',
    'exec "$@"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'vitest'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *local-first*)',
    '    : > "$HOLD_MARKER"',
    '    while [ ! -e "$RELEASE_MARKER" ]; do sleep 0.02; done',
    '    printf "local-first\\n"',
    '    ;;',
    '  *local-cancel*)',
    '    : > "$CANCELLED_MARKER"',
    '    printf "local-cancel\\n"',
    '    ;;',
    '  *local-running-cancel*)',
    '    : > "$RUNNING_MARKER"',
    '    trap \': > "$TERMINATED_MARKER"; exit 0\' TERM',
    '    while :; do sleep 1; done',
    '    ;;',
    '  *remote-node-vitest*|*remote-third*|*remote-bootstrap*|*install*)',
    '    if [ ! -e "$RELEASE_MARKER" ]; then : > "$COLLISION_MARKER"; fi',
    '    printf "remote-heavy\\n"',
    '    ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'ssh'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *getconf*) printf "4 0 0.8 22000000 20 0 48000000 72000000 0 0 0 0 0 0 0 linux\\n" ;;',
    '  *"&& command -v "*) exit 0 ;;',
    '  *-MNf*|*-O\\ exit*) exit 0 ;;',
    '  *)',
    '    remote_command=',
    '    for ssh_argument in "$@"; do remote_command=$ssh_argument; done',
    '    cd -- "$REMOTE_LOGIN_CWD"',
    '    /bin/sh -c "$remote_command"',
    '    ;;',
    'esac',
    '',
  ].join('\n'));

  const env = {
    ...executionNeutralEnv,
    HOME: root,
    HAPPIER_STACK_CLI_HOME_DIR: machineHome,
    HAPPIER_STACK_STORAGE_DIR: storageDir,
    npm_node_execpath: '',
    npm_execpath: '',
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
    HOLD_MARKER: holdMarker,
    RELEASE_MARKER: releaseMarker,
    CANCELLED_MARKER: cancelledMarker,
    RUNNING_MARKER: runningMarker,
    TERMINATED_MARKER: terminatedMarker,
    COLLISION_MARKER: collisionMarker,
    SYSTEMD_SCOPE_MARKER: scopeMarker,
    REMOTE_LOGIN_CWD: root,
  };
  const collect = (child) => {
    const output = { stdout: '', stderr: '' };
    child.stdout.on('data', (chunk) => { output.stdout += chunk; });
    child.stderr.on('data', (chunk) => { output.stderr += chunk; });
    return output;
  };
  const waitFor = async (predicate, label) => {
    for (let attempt = 0; attempt < 500; attempt += 1) {
      if (await predicate()) return;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const waitForExit = async (child) => {
    if (child.exitCode != null) return child.exitCode;
    return await new Promise((resolveExit) => child.once('exit', resolveExit));
  };

  const first = spawn('/bin/sh', [launcher, '--local', '--script=test:local-first'], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const firstOutput = collect(first);
  let cancelled;
  let remote;
  let nodeVitest;
  let nodeBundledPluginGenerator;
  let installs = [];
  let running;
  try {
    await waitFor(async () => {
      try {
        await readFile(holdMarker);
        return true;
      } catch {
        return false;
      }
    }, 'the first heavyweight job');
    await assert.rejects(readdir(staleOwner), { code: 'ENOENT' });
    await writeFile(staleWaiter, '999998 stale\n', 'utf8');

    nodeVitest = spawn('/bin/sh', [launcher, '--', 'node', 'node_modules/vitest/vitest.mjs', 'remote-node-vitest.test.ts'], {
      cwd: join(repoRoot, 'apps', 'stack'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const nodeVitestOutput = collect(nodeVitest);
    await waitFor(
      () => /waiting for heavyweight admission/.test(nodeVitestOutput.stderr) || nodeVitest.exitCode != null,
      'a Node-launched Vitest admission wait behind the local job',
    );
    assert.match(nodeVitestOutput.stderr, /waiting for heavyweight admission/, `Node-launched Vitest output\nstdout: ${nodeVitestOutput.stdout}\nstderr: ${nodeVitestOutput.stderr}`);
    await assert.rejects(readFile(collisionMarker), { code: 'ENOENT' });

    nodeBundledPluginGenerator = spawn('/bin/sh', [
      launcher,
      '--',
      'node',
      '--experimental-strip-types',
      'scripts/migrations/extensions/generateBundledPluginEntries.ts',
      '--mode',
      'write',
      '--scope',
      'all',
    ], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const nodeBundledPluginGeneratorOutput = collect(nodeBundledPluginGenerator);
    await waitFor(
      () => /waiting for heavyweight admission/.test(nodeBundledPluginGeneratorOutput.stderr)
        || nodeBundledPluginGenerator.exitCode != null,
      'a direct bundled-plugin generator admission wait behind the local job',
    );
    assert.match(
      nodeBundledPluginGeneratorOutput.stderr,
      /waiting for heavyweight admission/,
      `Direct bundled-plugin generator output\nstdout: ${nodeBundledPluginGeneratorOutput.stdout}\nstderr: ${nodeBundledPluginGeneratorOutput.stderr}`,
    );
    await assert.rejects(readFile(collisionMarker), { code: 'ENOENT' });

    cancelled = spawn('/bin/sh', [launcher, '--local', '--', 'vitest', 'run', 'local-cancel.test.ts'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const cancelledOutput = collect(cancelled);
    await waitFor(() => /waiting for heavyweight admission/.test(cancelledOutput.stderr), 'a cancellable local admission wait');
    await readFile(staleWaiter);
    cancelled.kill('SIGTERM');
    assert.equal(await waitForExit(cancelled), 130, cancelledOutput.stderr);
    await assert.rejects(readFile(cancelledMarker), { code: 'ENOENT' });

    remote = spawn('/bin/sh', [launcher, '--', 'tsc', '--noEmit', 'remote-third.ts'], {
      cwd: join(repoRoot, 'apps', 'stack'),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const remoteOutput = collect(remote);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    await assert.rejects(readFile(collisionMarker), { code: 'ENOENT' });
    await waitFor(() => /waiting for heavyweight admission/.test(remoteOutput.stderr), 'a remote admission wait behind the local job');
    for (const argumentsForInstall of [
      ['corepack', 'yarn', 'install', '--immutable'],
      ['yarn', 'install', '--immutable'],
      ['npm', 'install', '--ignore-scripts'],
      ['pnpm', 'install', '--frozen-lockfile'],
    ]) {
      const install = spawn('/bin/sh', [launcher, '--', ...argumentsForInstall], {
        cwd: repoRoot,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const output = collect(install);
      await waitFor(
        () => /waiting for heavyweight admission/.test(output.stderr),
        `a remote dependency-install admission wait (stdout=${output.stdout}; stderr=${output.stderr})`,
      );
      installs.push({ install, output });
    }
    await assert.rejects(readFile(collisionMarker), { code: 'ENOENT' });
    await writeFile(releaseMarker, '', 'utf8');

    assert.equal(await waitForExit(first), 0, firstOutput.stderr);
    assert.equal(await waitForExit(remote), 0, remoteOutput.stderr);
    assert.equal(await waitForExit(nodeVitest), 0, nodeVitestOutput.stderr);
    assert.equal(
      await waitForExit(nodeBundledPluginGenerator),
      0,
      nodeBundledPluginGeneratorOutput.stderr,
    );
    await assert.rejects(readFile(staleWaiter), { code: 'ENOENT' });
    for (const { install, output } of installs) {
      assert.equal(await waitForExit(install), 0, output.stderr);
      assert.match(output.stderr, /admitted heavyweight command.*class=dependency-install/);
    }
    assert.match(firstOutput.stdout, /local-first/);
    assert.match(remoteOutput.stdout, /remote-heavy/);
    assert.match(remoteOutput.stderr, /admitted heavyweight command/);
    assert.match(nodeVitestOutput.stdout, /remote-heavy/);
    assert.match(nodeBundledPluginGeneratorOutput.stdout, /remote-heavy/);
    assert.match(nodeVitestOutput.stderr, /admitted heavyweight command/);
    assert.match(
      await readFile(scopeMarker, 'utf8'),
      /--user --scope --quiet --slice=happier-jobs\.slice --nice=10 -- bash -c .*remote_dependency_bootstrap\.mjs.*remote_validation_preparation\.mjs.*tsc.*remote-third/s,
    );
    assert.match(
      await readFile(scopeMarker, 'utf8'),
      /--user --scope --quiet --slice=happier-jobs\.slice --nice=10 -- bash -c .*remote_validation_preparation\.mjs.*'node' 'node_modules\/vitest\/vitest\.mjs' 'remote-node-vitest/s,
    );
    assert.deepEqual(await readdir(join(admissionRoot, 'waiters')), []);

    running = spawn('/bin/sh', [launcher, '--local', '--', 'vitest', 'run', 'local-running-cancel.test.ts'], {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const runningOutput = collect(running);
    await waitFor(async () => {
      try {
        await readFile(runningMarker);
        return true;
      } catch {
        return false;
      }
    }, 'a running heavyweight command');
    running.kill('SIGTERM');
    assert.equal(await waitForExit(running), 130, runningOutput.stderr);
    await waitFor(async () => {
      try {
        await readFile(terminatedMarker);
        return true;
      } catch {
        return false;
      }
    }, 'the running heavyweight child to terminate');
    assert.deepEqual(await readdir(join(admissionRoot, 'owners')), []);
  } finally {
    await writeFile(releaseMarker, '', 'utf8');
    if (cancelled && cancelled.exitCode == null) cancelled.kill('SIGTERM');
    if (remote && remote.exitCode == null) remote.kill('SIGTERM');
    if (nodeVitest && nodeVitest.exitCode == null) nodeVitest.kill('SIGTERM');
    if (nodeBundledPluginGenerator && nodeBundledPluginGenerator.exitCode == null) {
      nodeBundledPluginGenerator.kill('SIGTERM');
    }
    for (const { install } of installs) {
      if (install.exitCode == null) install.kill('SIGTERM');
    }
    if (running && running.exitCode == null) running.kill('SIGTERM');
    if (first.exitCode == null) first.kill('SIGTERM');
  }
});

test('native launcher derives two heavyweight admission slots from an 8 CPU, 24 GiB Linux worker profile', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-heavyweight-profile-'));
  const binDir = join(root, 'bin');
  const firstMarker = join(root, 'first-admitted');
  const secondMarker = join(root, 'second-admitted');
  const thirdMarker = join(root, 'third-admitted');
  const releaseMarker = join(root, 'release');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "8\\n"\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    'case "$*" in',
    '  */proc/loadavg*) case "$1" in *split*) printf "0\\n" ;; *) printf "0.1\\n" ;; esac ;;',
    '  */proc/meminfo*) case "$1" in *MemAvailable*) printf "16777216 25165824\\n" ;; *) printf "25165824\\n" ;; esac ;;',
    '  */proc/pressure/memory*) printf "1.4\\n" ;;',
    '  *) exec /usr/bin/awk "$@" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'hold'), [
    '#!/bin/sh',
    ': > "$1"',
    'while [ ! -e "$2" ]; do sleep 0.02; done',
    '',
  ].join('\n'));
  const env = {
    ...executionNeutralEnv,
    HOME: root,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
  };
  const waitForFile = async (path, label, diagnostic = () => '') => {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try {
        await readFile(path);
        return;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    throw new Error(`timed out waiting for ${label}${diagnostic()}`);
  };
  const waitForExit = async (child) => {
    if (child.exitCode != null) return child.exitCode;
    return await new Promise((resolveExit) => child.once('exit', resolveExit));
  };
  const run = (marker) => spawn('/bin/sh', [
    launcher,
    '--heavyweight-admission',
    '--class=validation',
    '--machine=worker-profile',
    '--',
    'hold',
    marker,
    releaseMarker,
  ], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const first = run(firstMarker);
  let second;
  let third;
  const outputFor = (child) => {
    const output = { stdout: '', stderr: '' };
    child.stdout.on('data', (chunk) => { output.stdout += chunk; });
    child.stderr.on('data', (chunk) => { output.stderr += chunk; });
    return output;
  };
  const firstOutput = outputFor(first);
  let thirdStderr = '';
  try {
    await waitForFile(firstMarker, 'the first worker-profile admission', () =>
      ` (first exit=${first.exitCode}; stderr=${firstOutput.stderr})`,
    );
    second = run(secondMarker);
    await waitForFile(secondMarker, 'the second worker-profile admission');
    third = run(thirdMarker);
    third.stderr.on('data', (chunk) => { thirdStderr += chunk; });
    for (let attempt = 0; attempt < 250; attempt += 1) {
      if (/waiting for heavyweight admission.*active=2\/2/.test(thirdStderr)) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    assert.match(thirdStderr, /waiting for heavyweight admission.*active=2\/2/);
    await assert.rejects(readFile(thirdMarker), { code: 'ENOENT' });
    await writeFile(releaseMarker, '', 'utf8');
    assert.equal(await waitForExit(first), 0);
    assert.equal(await waitForExit(second), 0);
    assert.equal(await waitForExit(third), 0);
  } finally {
    await writeFile(releaseMarker, '', 'utf8');
    for (const child of [first, second, third]) {
      if (child && child.exitCode == null) child.kill('SIGTERM');
    }
  }
});

test('native launcher never removes a successor heavyweight admission lock while reclaiming stale state', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-heavyweight-lock-successor-'));
  const binDir = join(root, 'bin');
  const admissionRoot = join(root, '.happier', 'heavyweight-admission-v1');
  const lockPath = join(admissionRoot, 'lock');
  const disappearanceMarker = join(root, 'successor-lock-disappeared');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await mkdir(join(admissionRoot, 'owners'), { recursive: true });
  await mkdir(join(admissionRoot, 'waiters'), { recursive: true });
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "4\\n"\n');
  await executable(join(binDir, 'awk'), [
    '#!/bin/sh',
    'case "$*" in',
    '  */proc/loadavg*) printf "0\\n" ;;',
    '  */proc/meminfo*) case "$1" in *MemAvailable*) printf "16777216 25165824\\n" ;; *) printf "25165824\\n" ;; esac ;;',
    '  */proc/pressure/memory*) printf "1.4\\n" ;;',
    '  *) exec /usr/bin/awk "$@" ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(binDir, 'rm'), [
    '#!/bin/sh',
    'case " $* " in',
    '  *" $HEAVYWEIGHT_LOCK_PATH "*)',
    '    if [ ! -e "$DISAPPEARANCE_MARKER" ]; then',
    '      /bin/rm -f -- "$HEAVYWEIGHT_LOCK_PATH"',
    '      printf "%s -\\n" "$SUCCESSOR_PID" > "$HEAVYWEIGHT_LOCK_PATH"',
    '      /bin/rm -f -- "$HEAVYWEIGHT_LOCK_PATH"',
    '      : > "$DISAPPEARANCE_MARKER"',
    '      exit 0',
    '    fi',
    '    ;;',
    'esac',
    'exec /bin/rm "$@"',
    '',
  ].join('\n'));
  await writeFile(lockPath, '999999 stale\n', 'utf8');
  const successor = spawn('/bin/sh', ['-c', 'sleep 10'], { stdio: 'ignore' });
  const result = spawnSync('/bin/sh', [
    launcher,
    '--heavyweight-admission',
    '--class=validation',
    '--machine=successor-race',
    '--',
    '/usr/bin/true',
  ], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: root,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
      HEAVYWEIGHT_LOCK_PATH: lockPath,
      DISAPPEARANCE_MARKER: disappearanceMarker,
      SUCCESSOR_PID: String(successor.pid),
    },
    encoding: 'utf8',
    timeout: 10_000,
  });
  try {
    assert.equal(result.status, 0, result.stderr);
    await assert.rejects(readFile(disappearanceMarker), { code: 'ENOENT' });
  } finally {
    if (successor.exitCode == null) successor.kill('SIGTERM');
  }
});

test('native launcher backs off heavyweight lock acquisition under contention', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-heavyweight-lock-backoff-'));
  const binDir = join(root, 'bin');
  const admissionRoot = join(root, '.happier', 'heavyweight-admission-v1');
  const lockPath = join(admissionRoot, 'lock');
  const lockAttempts = join(root, 'lock-attempts');
  const holderReady = join(root, 'holder-ready');
  const sleepAttempts = join(root, 'sleep-attempts');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  await mkdir(binDir, { recursive: true });
  await mkdir(join(admissionRoot, 'owners'), { recursive: true });
  await mkdir(join(admissionRoot, 'waiters'), { recursive: true });
  await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
  await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "4\\n"\n');
  await executable(join(binDir, 'flock'), [
    '#!/bin/sh',
    'printf "x\\n" >> "$FLOCK_ATTEMPTS"',
    'exec /usr/bin/flock "$@"',
    '',
  ].join('\n'));
  await executable(join(binDir, 'sleep'), [
    '#!/bin/sh',
    'printf "%s\\n" "$1" >> "$SLEEP_ATTEMPTS"',
    'exec /bin/sleep "$@"',
    '',
  ].join('\n'));
  const holder = spawn('/bin/sh', [
    '-c',
    'exec 9>>"$1"; /usr/bin/flock -x 9; : > "$2"; sleep 10',
    'lock-holder',
    lockPath,
    holderReady,
  ], { stdio: 'ignore' });
  for (let attempt = 0; attempt < 250; attempt += 1) {
    try {
      await readFile(holderReady);
      break;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  await readFile(holderReady);
  const env = {
    ...executionNeutralEnv,
    HOME: root,
    FLOCK_ATTEMPTS: lockAttempts,
    SLEEP_ATTEMPTS: sleepAttempts,
    PATH: `${binDir}:/usr/bin:/bin`,
    TMPDIR: root,
  };
  const waiter = spawn('/bin/sh', [
    launcher,
    '--heavyweight-admission',
    '--class=validation',
    '--machine=lock-backoff',
    '--',
    '/usr/bin/true',
  ], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const waitForExit = async (child) => {
    if (child.exitCode != null) return child.exitCode;
    return await new Promise((resolveExit) => child.once('exit', resolveExit));
  };
  try {
    for (let attempt = 0; attempt < 250; attempt += 1) {
      try {
        await readFile(lockAttempts);
        break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 2_200));
    const attempts = (await readFile(lockAttempts, 'utf8')).trim().split('\n').filter(Boolean).length;
    const sleeps = (await readFile(sleepAttempts, 'utf8')).trim().split('\n').filter(Boolean);
    assert.equal(holder.exitCode, null);
    await readFile(lockPath);
    assert.ok(attempts <= 2, `expected at most two flock attempts while a lock is held, received ${attempts} (sleeps=${sleeps.join(',')})`);
    assert.ok(sleeps.length > 0, 'expected the contended waiter to record a passive retry delay');
    assert.ok(sleeps.every((delay) => delay === String(2 + (waiter.pid % 2))), `expected a 2–3 second PID-jittered retry delay, received ${sleeps.join(',')}`);
    waiter.kill('SIGTERM');
    assert.equal(await waitForExit(waiter), 130);
  } finally {
    if (waiter.exitCode == null) waiter.kill('SIGTERM');
    if (holder.exitCode == null) holder.kill('SIGTERM');
  }
});

test('native launcher scopes admitted Linux work only when the systemd user slice is ready', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'happier-preferred-launcher-heavyweight-scope-'));
  const readyBin = join(root, 'ready-bin');
  const fallbackBin = join(root, 'fallback-bin');
  const scopedMarker = join(root, 'scoped-command');
  const fallbackMarker = join(root, 'fallback-command');
  const scopedArguments = join(root, 'systemd-run-arguments');
  const fallbackScopeAttempt = join(root, 'unexpected-systemd-run');
  t.after(async () => await rm(root, { recursive: true, force: true }));

  for (const binDir of [readyBin, fallbackBin]) {
    await mkdir(binDir, { recursive: true });
    await executable(join(binDir, 'uname'), '#!/bin/sh\nprintf "Linux\\n"\n');
    await executable(join(binDir, 'getconf'), '#!/bin/sh\nprintf "4\\n"\n');
    await executable(join(binDir, 'awk'), [
      '#!/bin/sh',
      'case "$*" in',
      '  */proc/loadavg*) case "$1" in *split*) printf "0\\n" ;; *) printf "0.1\\n" ;; esac ;;',
      '  */proc/meminfo*) case "$1" in *MemAvailable*) printf "16777216 25165824\\n" ;; *) printf "25165824\\n" ;; esac ;;',
      '  */proc/pressure/memory*) printf "1.4\\n" ;;',
      '  *) exec /usr/bin/awk "$@" ;;',
      'esac',
      '',
    ].join('\n'));
    await executable(join(binDir, 'scoped-command'), '#!/bin/sh\nprintf "%s\\n" "$1" > "$SCOPED_MARKER"\n');
  }
  await executable(join(readyBin, 'systemctl'), [
    '#!/bin/sh',
    'case "$*" in',
    '  *show-environment*) exit 0 ;;',
    '  *LoadState*) printf "loaded\\n"; exit 0 ;;',
    '  *) exit 1 ;;',
    'esac',
    '',
  ].join('\n'));
  await executable(join(readyBin, 'systemd-run'), [
    '#!/bin/sh',
    'printf "%s\\n" "$*" > "$SYSTEMD_RUN_ARGUMENTS"',
    'while [ "$#" -gt 0 ]; do',
    '  [ "$1" = -- ] && { shift; break; }',
    '  shift',
    'done',
    'exec "$@"',
    '',
  ].join('\n'));
  await executable(join(fallbackBin, 'systemctl'), '#!/bin/sh\nexit 1\n');
  await executable(join(fallbackBin, 'systemd-run'), [
    '#!/bin/sh',
    'printf "unexpected\\n" > "$FALLBACK_SCOPE_ATTEMPT"',
    'exit 42',
    '',
  ].join('\n'));

  const run = (binDir, home, marker) => spawnSync('/bin/sh', [
    launcher,
    '--heavyweight-admission',
    '--class=validation',
    '--machine=scope-profile',
    '--',
    'scoped-command',
    marker === scopedMarker ? 'scoped' : 'fallback',
  ], {
    cwd: repoRoot,
    env: {
      ...executionNeutralEnv,
      HOME: home,
      SCOPED_MARKER: marker,
      SYSTEMD_RUN_ARGUMENTS: scopedArguments,
      FALLBACK_SCOPE_ATTEMPT: fallbackScopeAttempt,
      PATH: `${binDir}:/usr/bin:/bin`,
      TMPDIR: root,
    },
    encoding: 'utf8',
  });

  const scoped = run(readyBin, join(root, 'ready-home'), scopedMarker);
  assert.equal(scoped.status, 0, scoped.stderr);
  assert.equal(await readFile(scopedMarker, 'utf8'), 'scoped\n');
  assert.match(
    await readFile(scopedArguments, 'utf8'),
    /--user --scope --quiet --slice=happier-jobs\.slice --nice=10 -- scoped-command scoped/,
  );

  const fallback = run(fallbackBin, join(root, 'fallback-home'), fallbackMarker);
  assert.equal(fallback.status, 0, fallback.stderr);
  assert.equal(await readFile(fallbackMarker, 'utf8'), 'fallback\n');
  await assert.rejects(readFile(fallbackScopeAttempt), { code: 'ENOENT' });
});

test('Windows launcher is explicitly local-only and does not start the Node router', async () => {
  const cmd = await readFile(join(repoRoot, 'apps', 'stack', 'bin', 'hstack-exec.cmd'), 'utf8');
  const powershell = await readFile(join(repoRoot, 'apps', 'stack', 'bin', 'hstack-exec.ps1'), 'utf8');
  assert.doesNotMatch(cmd, /\bnode\b/i);
  assert.match(cmd, /powershell/i);
  assert.doesNotMatch(powershell, /HAPPIER_PREFERRED_EXECUTION/);
  assert.match(powershell, /\$invocation\[0\] -eq '--local'/);
});
