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

test('compiled hstack binary runs self-host help outside repo checkout', async (t) => {
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
  const build = spawnSync(
    process.execPath,
    [
      'scripts/release/build-hstack-binaries.mjs',
      '--channel=preview',
      `--version=${version}`,
      `--targets=${target}`,
    ],
    {
      cwd: repoRoot,
      encoding: 'utf-8',
      env: {
        ...process.env,
      },
    }
  );
  assert.equal(build.status, 0, build.stderr || build.stdout);

  const artifact = join(repoRoot, 'dist', 'release-assets', 'stack', `hstack-v${version}-${target}.tar.gz`);
  const extractDir = await mkdtemp(join(tmpdir(), 'hstack-binary-smoke-'));
  t.after(() => {
    spawnSync('bash', ['-lc', `rm -rf "${extractDir.replaceAll('"', '\\"')}"`], { stdio: 'ignore' });
  });
  const untar = spawnSync('tar', ['-xzf', artifact, '-C', extractDir], { encoding: 'utf-8' });
  assert.equal(untar.status, 0, untar.stderr);

  const entries = await readdir(extractDir);
  assert.ok(entries.length > 0, 'expected extracted artifact directory');
  const binaryPath = join(extractDir, entries[0], 'hstack');

  const help = spawnSync(binaryPath, ['self-host', '--help'], {
    cwd: '/tmp',
    encoding: 'utf-8',
    env: {
      ...process.env,
      HAPPIER_NONINTERACTIVE: '1',
    },
  });
  assert.equal(help.status, 0, help.stderr || help.stdout);
  assert.match(help.stdout, /hstack self-host install/);
  assert.match(help.stdout, /works without a repository checkout/);
});
