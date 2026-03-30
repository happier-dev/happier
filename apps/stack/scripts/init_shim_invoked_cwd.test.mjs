import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function runNode(args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr }));
  });
}

function runExecutable(command, args, { cwd, env }) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code, signal) => resolve({ code: code ?? (signal ? 1 : 0), signal, stdout, stderr }));
  });
}

test('hstack init shim preserves HAPPIER_STACK_INVOKED_CWD before changing directories', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-init-shim-'));

  const homeDir = join(tmp, 'home');
  const canonicalHomeDir = join(tmp, 'canonical');
  const workspaceDir = join(tmp, 'workspace');

  try {
    const res = await runNode(
      [
        join(rootDir, 'scripts', 'init.mjs'),
        `--home-dir=${homeDir}`,
        `--canonical-home-dir=${canonicalHomeDir}`,
        `--workspace-dir=${workspaceDir}`,
        '--no-runtime',
        '--no-bootstrap',
      ],
      { cwd: rootDir, env: { ...process.env } }
    );
    assert.equal(res.code, 0, `expected init to exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

    const shimPath = join(homeDir, 'bin', 'hstack');
    const shim = await readFile(shimPath, 'utf-8');
    assert.match(shim, /HAPPIER_STACK_INVOKED_CWD/, 'expected shim to reference HAPPIER_STACK_INVOKED_CWD');
    assert.match(
      shim,
      /HAPPIER_STACK_INVOKED_CWD:-\$\{PWD:-\$HOME\}/,
      'expected shim to tolerate launchd environments where PWD is unset'
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('hstack init shim prefers the current PATH node for repo CLI launches when HAPPIER_STACK_CLI_ROOT_DIR is set', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-init-shim-node-'));

  const homeDir = join(tmp, 'home');
  const canonicalHomeDir = join(tmp, 'canonical');
  const workspaceDir = join(tmp, 'workspace');
  const fakeCliRoot = join(tmp, 'fake-cli-root');
  const fakeBinDir = join(tmp, 'bin');
  const fakeNodePath = join(fakeBinDir, 'node');

  try {
    await mkdir(join(fakeCliRoot, 'bin'), { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });

    await writeFile(
      join(fakeCliRoot, 'bin', 'hstack.mjs'),
      [
        'process.stdout.write(JSON.stringify({',
        '  fakeNodeUsed: process.env.FAKE_NODE_USED === "1",',
        '  argv: process.argv.slice(2),',
        '}));',
        '',
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      fakeNodePath,
      `#!/bin/bash\nexport FAKE_NODE_USED=1\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 }
    );
    await chmod(fakeNodePath, 0o755);

    const initRes = await runNode(
      [
        join(rootDir, 'scripts', 'init.mjs'),
        `--home-dir=${homeDir}`,
        `--canonical-home-dir=${canonicalHomeDir}`,
        `--workspace-dir=${workspaceDir}`,
        `--cli-root-dir=${fakeCliRoot}`,
        '--no-runtime',
        '--no-bootstrap',
      ],
      { cwd: rootDir, env: { ...process.env } }
    );
    assert.equal(
      initRes.code,
      0,
      `expected init to exit 0, got ${initRes.code}\nstdout:\n${initRes.stdout}\nstderr:\n${initRes.stderr}`
    );

    const shimPath = join(homeDir, 'bin', 'hstack');
    const runRes = await runExecutable(
      shimPath,
      ['shim-probe'],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
          HAPPIER_STACK_NODE: join(tmp, 'missing-node'),
        },
      }
    );

    assert.equal(runRes.code, 0, `expected shim to exit 0\nstdout:\n${runRes.stdout}\nstderr:\n${runRes.stderr}`);
    const data = JSON.parse(runRes.stdout);
    assert.equal(data.fakeNodeUsed, true, `expected shim to use PATH node\nstdout:\n${runRes.stdout}`);
    assert.deepEqual(data.argv, ['shim-probe']);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('hstack init shim prefers the current PATH node for service-mode repo CLI launches', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-init-shim-service-node-'));

  const homeDir = join(tmp, 'home');
  const canonicalHomeDir = join(tmp, 'canonical');
  const workspaceDir = join(tmp, 'workspace');
  const fakeCliRoot = join(tmp, 'fake-cli-root');
  const fakeBinDir = join(tmp, 'bin');
  const pathNodePath = join(fakeBinDir, 'node');
  const pinnedNodePath = join(tmp, 'pinned-node');

  try {
    await mkdir(join(fakeCliRoot, 'bin'), { recursive: true });
    await mkdir(fakeBinDir, { recursive: true });

    await writeFile(
      join(fakeCliRoot, 'bin', 'hstack.mjs'),
      [
        'process.stdout.write(JSON.stringify({',
        '  fakeNodeUsed: process.env.FAKE_NODE_USED === "1",',
        '  pinnedNodeUsed: process.env.PINNED_NODE_USED === "1",',
        '  serviceMode: process.env.HAPPIER_STACK_SERVICE_MODE === "1",',
        '}));',
        '',
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      pathNodePath,
      `#!/bin/bash\nexport FAKE_NODE_USED=1\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 }
    );
    await chmod(pathNodePath, 0o755);
    await writeFile(
      pinnedNodePath,
      `#!/bin/bash\nexport PINNED_NODE_USED=1\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 }
    );
    await chmod(pinnedNodePath, 0o755);

    const initRes = await runNode(
      [
        join(rootDir, 'scripts', 'init.mjs'),
        `--home-dir=${homeDir}`,
        `--canonical-home-dir=${canonicalHomeDir}`,
        `--workspace-dir=${workspaceDir}`,
        `--cli-root-dir=${fakeCliRoot}`,
        '--no-runtime',
        '--no-bootstrap',
      ],
      { cwd: rootDir, env: { ...process.env } }
    );
    assert.equal(
      initRes.code,
      0,
      `expected init to exit 0, got ${initRes.code}\nstdout:\n${initRes.stdout}\nstderr:\n${initRes.stderr}`
    );

    const shimPath = join(homeDir, 'bin', 'hstack');
    const runRes = await runExecutable(
      shimPath,
      ['shim-probe'],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
          HAPPIER_STACK_NODE: pinnedNodePath,
          HAPPIER_STACK_SERVICE_MODE: '1',
        },
      }
    );

    assert.equal(runRes.code, 0, `expected shim to exit 0\nstdout:\n${runRes.stdout}\nstderr:\n${runRes.stderr}`);
    const data = JSON.parse(runRes.stdout);
    assert.equal(data.serviceMode, true);
    assert.equal(data.fakeNodeUsed, true, `expected shim to use the PATH node in service mode\nstdout:\n${runRes.stdout}`);
    assert.equal(data.pinnedNodeUsed, false, `expected shim not to force the pinned node in service mode when PATH resolves node\nstdout:\n${runRes.stdout}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('hstack init shim falls back to HAPPIER_STACK_NODE when PATH has no node', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-init-shim-node-fallback-'));

  const homeDir = join(tmp, 'home');
  const canonicalHomeDir = join(tmp, 'canonical');
  const workspaceDir = join(tmp, 'workspace');
  const fakeCliRoot = join(tmp, 'fake-cli-root');
  const pinnedNodePath = join(tmp, 'pinned-node');

  try {
    await mkdir(join(fakeCliRoot, 'bin'), { recursive: true });

    await writeFile(
      join(fakeCliRoot, 'bin', 'hstack.mjs'),
      [
        'process.stdout.write(JSON.stringify({',
        '  pinnedNodeUsed: process.env.PINNED_NODE_USED === "1",',
        '}));',
        '',
      ].join('\n'),
      'utf8'
    );
    await writeFile(
      pinnedNodePath,
      `#!/bin/bash\nexport PINNED_NODE_USED=1\nexec "${process.execPath}" "$@"\n`,
      { mode: 0o755 }
    );
    await chmod(pinnedNodePath, 0o755);

    const initRes = await runNode(
      [
        join(rootDir, 'scripts', 'init.mjs'),
        `--home-dir=${homeDir}`,
        `--canonical-home-dir=${canonicalHomeDir}`,
        `--workspace-dir=${workspaceDir}`,
        `--cli-root-dir=${fakeCliRoot}`,
        '--no-runtime',
        '--no-bootstrap',
      ],
      { cwd: rootDir, env: { ...process.env } }
    );
    assert.equal(
      initRes.code,
      0,
      `expected init to exit 0, got ${initRes.code}\nstdout:\n${initRes.stdout}\nstderr:\n${initRes.stderr}`
    );

    const shimPath = join(homeDir, 'bin', 'hstack');
    const runRes = await runExecutable(
      shimPath,
      ['shim-probe'],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          HAPPIER_STACK_NODE: pinnedNodePath,
          HAPPIER_STACK_SERVICE_MODE: '1',
        },
      }
    );

    assert.equal(runRes.code, 0, `expected shim to exit 0\nstdout:\n${runRes.stdout}\nstderr:\n${runRes.stderr}`);
    const data = JSON.parse(runRes.stdout);
    assert.equal(data.pinnedNodeUsed, true, `expected shim to fall back to the pinned node when PATH does not resolve node\nstdout:\n${runRes.stdout}`);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('hstack init shim fails clearly when repo CLI mode has no node available', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-init-shim-node-missing-'));

  const homeDir = join(tmp, 'home');
  const canonicalHomeDir = join(tmp, 'canonical');
  const workspaceDir = join(tmp, 'workspace');
  const fakeCliRoot = join(tmp, 'fake-cli-root');

  try {
    await mkdir(join(fakeCliRoot, 'bin'), { recursive: true });
    await writeFile(join(fakeCliRoot, 'bin', 'hstack.mjs'), 'process.exit(0);\n', 'utf8');

    const initRes = await runNode(
      [
        join(rootDir, 'scripts', 'init.mjs'),
        `--home-dir=${homeDir}`,
        `--canonical-home-dir=${canonicalHomeDir}`,
        `--workspace-dir=${workspaceDir}`,
        `--cli-root-dir=${fakeCliRoot}`,
        '--no-runtime',
        '--no-bootstrap',
      ],
      { cwd: rootDir, env: { ...process.env } }
    );
    assert.equal(initRes.code, 0);

    const shimPath = join(homeDir, 'bin', 'hstack');
    const runRes = await runExecutable(
      shimPath,
      ['shim-probe'],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          HAPPIER_STACK_NODE: join(tmp, 'missing-node'),
        },
      }
    );

    assert.notEqual(runRes.code, 0, 'expected shim to fail when no usable node is available');
    assert.match(runRes.stderr, /missing node runtime|install node|HAPPIER_STACK_NODE/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('hstack init shim still reports a missing runtime install when no runtime entry exists', async () => {
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'hstack-init-shim-runtime-missing-'));

  const homeDir = join(tmp, 'home');
  const canonicalHomeDir = join(tmp, 'canonical');
  const workspaceDir = join(tmp, 'workspace');

  try {
    const initRes = await runNode(
      [
        join(rootDir, 'scripts', 'init.mjs'),
        `--home-dir=${homeDir}`,
        `--canonical-home-dir=${canonicalHomeDir}`,
        `--workspace-dir=${workspaceDir}`,
        '--no-runtime',
        '--no-bootstrap',
      ],
      { cwd: rootDir, env: { ...process.env } }
    );
    assert.equal(initRes.code, 0);

    const shimPath = join(homeDir, 'bin', 'hstack');
    const runRes = await runExecutable(
      shimPath,
      ['shim-probe'],
      {
        cwd: rootDir,
        env: {
          ...process.env,
          PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
          HAPPIER_STACK_NODE: join(tmp, 'missing-node'),
        },
      }
    );

    assert.notEqual(runRes.code, 0);
    assert.match(runRes.stderr, /missing runtime install|force-runtime/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
