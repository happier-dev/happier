import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

function formatSpawnSyncResult(result) {
  const stdout = String(result.stdout || '').trim();
  const stderr = String(result.stderr || '').trim();
  const error = result.error ? String(result.error.stack || result.error.message || result.error) : '';
  const status = typeof result.status === 'number' ? String(result.status) : '<null>';
  const signal = result.signal ? String(result.signal) : '<null>';
  return [
    `status=${status}`,
    `signal=${signal}`,
    error ? `error=${error}` : '',
    stdout ? `stdout:\n${stdout}` : '',
    stderr ? `stderr:\n${stderr}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function commandExists(cmd) {
  return spawnSync('bash', ['-lc', `command -v ${cmd} >/dev/null 2>&1`], { stdio: 'ignore' }).status === 0;
}

function runWithHardTimeout(command, args, options) {
  const timeoutMs = Number(options.timeout ?? 0);
  if (process.platform === 'linux' && commandExists('timeout') && timeoutMs > 0) {
    const timeoutSeconds = Math.max(1, Math.ceil(timeoutMs / 1000));
    return spawnSync('timeout', ['--signal=KILL', '--kill-after=30s', `${timeoutSeconds}s`, command, ...args], {
      ...options,
      timeout: undefined,
    });
  }
  return spawnSync(command, args, options);
}

function didCommandTimeout(result) {
  if (result?.error?.code === 'ETIMEDOUT') return true;
  if (result?.status === 124 || result?.status === 137) return true;
  if (result?.signal === 'SIGKILL') return true;
  return false;
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

  const buildCli = runWithHardTimeout(
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
      // `inherit` makes it easier to read interactively, but on CI failures we need the full output.
      // Increase buffer because build logs can be large.
      maxBuffer: 50 * 1024 * 1024,
      // If this ever hangs on CI, fail with a clear timeout rather than blocking the entire suite.
      timeout: 15 * 60 * 1000,
    }
  );
  assert.equal(buildCli.status, 0, formatSpawnSyncResult(buildCli));

  const cliArtifactPath = join(repoRoot, 'dist', 'release-assets', 'cli', `happier-v${version}-${target}.tar.gz`);
  const cliExtract = await extractBinaryFromArtifact({ artifactPath: cliArtifactPath, binaryName: 'happier' });
  t.after(() => {
    spawnSync('bash', ['-lc', `rm -rf "${cliExtract.extractDir.replaceAll('"', '\\"')}"`], { stdio: 'ignore' });
  });
  const cliVersion = runWithHardTimeout(cliExtract.binaryPath, ['--version'], {
    cwd: '/tmp',
    encoding: 'utf-8',
    env: { ...process.env, HAPPIER_NONINTERACTIVE: '1' },
    timeout: 7000,
  });
  const cliTimedOut = didCommandTimeout(cliVersion);
  const cliExited = (cliVersion.status ?? 1) === 0;
  assert.ok(cliTimedOut || cliExited, cliVersion.stderr || cliVersion.stdout);
  const versionText = `${cliVersion.stdout || ''}${cliVersion.stderr || ''}`.trim();
  assert.ok(
    /version/i.test(versionText) || /^\d+\.\d+\.\d+([-+][0-9A-Za-z.-]+)?$/.test(versionText),
    `expected CLI version output, got: ${versionText || '<empty>'}`,
  );

  if (isLinuxTarget(target)) {
    const buildServer = runWithHardTimeout(
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
        maxBuffer: 50 * 1024 * 1024,
        // If this ever hangs on CI, fail with a clear timeout rather than blocking the entire suite.
        timeout: 15 * 60 * 1000,
      }
    );
    assert.equal(buildServer.status, 0, formatSpawnSyncResult(buildServer));

    const serverArtifactPath = join(repoRoot, 'dist', 'release-assets', 'server', `happier-server-v${version}-${target}.tar.gz`);
    const serverExtract = await extractBinaryFromArtifact({ artifactPath: serverArtifactPath, binaryName: 'happier-server' });
    t.after(() => {
      spawnSync('bash', ['-lc', `rm -rf "${serverExtract.extractDir.replaceAll('"', '\\"')}"`], { stdio: 'ignore' });
    });
    const serverDataDir = await mkdtemp(join(tmpdir(), 'happier-server-binary-smoke-data-'));
    t.after(() => {
      spawnSync('bash', ['-lc', `rm -rf "${serverDataDir.replaceAll('"', '\\"')}"`], { stdio: 'ignore' });
    });
    const serverBoot = runWithHardTimeout(serverExtract.binaryPath, [], {
      cwd: '/tmp',
      encoding: 'utf-8',
      env: {
        ...process.env,
        PORT: '3905',
        HAPPIER_SERVER_HOST: '127.0.0.1',
        HAPPY_DB_PROVIDER: 'sqlite',
        HAPPIER_DB_PROVIDER: 'sqlite',
        DATABASE_URL: `file:${serverDataDir}/happier-server-light.sqlite`,
        HAPPY_SERVER_LIGHT_DATA_DIR: serverDataDir,
        HAPPIER_SERVER_LIGHT_DATA_DIR: serverDataDir,
      },
      timeout: 7000,
    });
    const timedOut = didCommandTimeout(serverBoot);
    const cleanExit = (serverBoot.status ?? 1) === 0;
    const serverOutput = `${serverBoot.stderr || ''}\n${serverBoot.stdout || ''}`;
    assert.ok(timedOut || cleanExit, serverOutput);
    assert.doesNotMatch(serverOutput, /ERR_MODULE_NOT_FOUND|Cannot find module/i);
  }
});
