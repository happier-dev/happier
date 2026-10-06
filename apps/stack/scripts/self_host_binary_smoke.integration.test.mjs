import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTempFixture } from './testkit/core/temp_fixture.mjs';
import { readBundledAgentNativeHomeEnvironmentKeys } from './utils/env/scrub_env.mjs';

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
      'scripts/pipeline/release/build-hstack-binaries.mjs',
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
      // If this ever hangs on CI, fail with a clear timeout rather than blocking the entire suite.
      timeout: 15 * 60 * 1000,
      maxBuffer: 50 * 1024 * 1024,
    }
  );
  assert.equal(build.status, 0, formatSpawnSyncResult(build));

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

test('compiled hstack scrubs its canonical Agent native-home projection without a checkout or Node', async (t) => {
  if (!commandExists('bun')) {
    t.skip('bun is required for compiled binary smoke tests');
    return;
  }
  const target = currentTarget();
  if (!target) {
    t.skip(`unsupported platform for smoke test: ${process.platform}-${process.arch}`);
    return;
  }
  const fixture = await createTempFixture(t, { prefix: 'hstack-agent-home-binary-' });
  const repoRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
  const entrypoint = fixture.path('agent-home-probe.mjs');
  const keys = readBundledAgentNativeHomeEnvironmentKeys();
  const inherited = Object.fromEntries(keys.map((key) => [key, '/foreign-agent-home']));
  await writeFile(entrypoint, `
    import { scrubHappierStackEnv, STACK_WRAPPER_CLEAR_UNPREFIXED_KEYS } from ${JSON.stringify(resolve(repoRoot, 'apps/stack/scripts/utils/env/scrub_env.mjs').replaceAll('\\', '/'))};
    console.log(JSON.stringify(scrubHappierStackEnv(${JSON.stringify({ ...inherited, KEEP_OTHER_HOME: '/unrelated-home' })}, {
      clearUnprefixedKeys: STACK_WRAPPER_CLEAR_UNPREFIXED_KEYS,
    })));
  `);
  const version = `0.0.0-agent-home-smoke.${Date.now()}`;
  const build = spawnSync(process.execPath, [
    'scripts/pipeline/release/build-hstack-binaries.mjs', '--channel=preview',
    `--version=${version}`, `--targets=${target}`, `--entrypoint=${entrypoint}`,
  ], { cwd: repoRoot, encoding: 'utf8', timeout: 15 * 60 * 1000, maxBuffer: 50 * 1024 * 1024 });
  assert.equal(build.status, 0, formatSpawnSyncResult(build));
  const extracted = fixture.path('extracted');
  await mkdir(extracted);
  const artifact = join(repoRoot, 'dist/release-assets/stack', `hstack-v${version}-${target}.tar.gz`);
  const untar = spawnSync('tar', ['-xzf', artifact, '-C', extracted], { encoding: 'utf8' });
  assert.equal(untar.status, 0, formatSpawnSyncResult(untar));
  const entries = await readdir(extracted);
  const binaryPath = join(extracted, entries[0], 'hstack');
  const result = spawnSync(binaryPath, [], { cwd: fixture.root, encoding: 'utf8', env: { PATH: '' } });
  assert.equal(result.status, 0, formatSpawnSyncResult(result));
  const scrubbed = JSON.parse(result.stdout);
  for (const key of keys) assert.equal(scrubbed[key], undefined, `inherited ${key} must not survive`);
  assert.equal(scrubbed.KEEP_OTHER_HOME, '/unrelated-home');
});
