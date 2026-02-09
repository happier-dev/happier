import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function commandExists(cmd) {
  return spawnSync('bash', ['-lc', `command -v ${cmd} >/dev/null 2>&1`], { stdio: 'ignore' }).status === 0;
}

function currentTarget() {
  const os = process.platform === 'linux' ? 'linux' : process.platform === 'darwin' ? 'darwin' : '';
  const arch = process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : '';
  if (!os || !arch) return '';
  return `${os}-${arch}`;
}

function isLinuxTarget(target) {
  return String(target).startsWith('linux-');
}

async function extractBinaryFromArtifact({ artifactPath, binaryName }) {
  const extractDir = await mkdtemp(join(tmpdir(), 'happier-release-binary-smoke-'));
  const untar = spawnSync('tar', ['-xzf', artifactPath, '-C', extractDir], { encoding: 'utf-8' });
  assert.equal(untar.status, 0, untar.stderr);

  const entries = await readdir(extractDir);
  assert.ok(entries.length > 0, `expected extracted root in ${artifactPath}`);
  return {
    extractDir,
    binaryPath: join(extractDir, entries[0], binaryName),
  };
}

test('compiled happier and server binaries execute from isolated cwd', async (t) => {
  if (!commandExists('bun')) {
    t.skip('bun is required for compiled binary smoke tests');
    return;
  }
  const target = currentTarget();
  if (!target) {
    t.skip(`unsupported platform for smoke test: ${process.platform}-${process.arch}`);
    return;
  }

  const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const version = `0.0.0-smoke.${Date.now()}`;

  const buildCli = spawnSync(
    process.execPath,
    [
      'scripts/release/build-cli-binaries.mjs',
      '--channel=preview',
      `--version=${version}`,
      `--targets=${target}`,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf-8',
      env: { ...process.env },
    }
  );
  assert.equal(buildCli.status, 0, buildCli.stderr || buildCli.stdout);

  const cliArtifactPath = join(repoRoot, 'dist', 'release-assets', 'cli', `happier-v${version}-${target}.tar.gz`);
  const cliExtract = await extractBinaryFromArtifact({ artifactPath: cliArtifactPath, binaryName: 'happier' });
  t.after(() => {
    spawnSync('bash', ['-lc', `rm -rf "${cliExtract.extractDir.replaceAll('"', '\\"')}"`], { stdio: 'ignore' });
  });
  const cliVersion = spawnSync(cliExtract.binaryPath, ['--version'], {
    cwd: '/tmp',
    encoding: 'utf-8',
    env: { ...process.env, HAPPIER_NONINTERACTIVE: '1' },
    timeout: 7000,
  });
  const cliTimedOut = cliVersion.error && cliVersion.error.code === 'ETIMEDOUT';
  const cliExited = (cliVersion.status ?? 1) === 0;
  assert.ok(cliTimedOut || cliExited, cliVersion.stderr || cliVersion.stdout);
  assert.match(`${cliVersion.stdout || ''}${cliVersion.stderr || ''}`, /version/i);

  if (isLinuxTarget(target)) {
    const buildServer = spawnSync(
      process.execPath,
      [
        'scripts/release/build-server-binaries.mjs',
        '--channel=preview',
        `--version=${version}`,
        `--targets=${target}`,
      ],
      {
        cwd: repoRoot,
        encoding: 'utf-8',
        env: { ...process.env },
      }
    );
    assert.equal(buildServer.status, 0, buildServer.stderr || buildServer.stdout);

    const serverArtifactPath = join(repoRoot, 'dist', 'release-assets', 'server', `happier-server-v${version}-${target}.tar.gz`);
    const serverExtract = await extractBinaryFromArtifact({ artifactPath: serverArtifactPath, binaryName: 'happier-server' });
    t.after(() => {
      spawnSync('bash', ['-lc', `rm -rf "${serverExtract.extractDir.replaceAll('"', '\\"')}"`], { stdio: 'ignore' });
    });
    const serverBoot = spawnSync(serverExtract.binaryPath, [], {
      cwd: '/tmp',
      encoding: 'utf-8',
      env: { ...process.env, PORT: '3905', HAPPIER_SERVER_HOST: '127.0.0.1' },
      timeout: 7000,
    });
    const timedOut = serverBoot.error && serverBoot.error.code === 'ETIMEDOUT';
    const cleanExit = (serverBoot.status ?? 1) === 0;
    assert.ok(timedOut || cleanExit, serverBoot.stderr || serverBoot.stdout);
    assert.doesNotMatch(`${serverBoot.stderr || ''}\n${serverBoot.stdout || ''}`, /ERR_MODULE_NOT_FOUND|Cannot find module/i);
  }
});
