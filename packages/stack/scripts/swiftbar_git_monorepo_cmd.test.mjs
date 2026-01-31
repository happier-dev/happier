import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function run(cmd, args, { cwd, env } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += String(d)));
    proc.stderr.on('data', (d) => (stderr += String(d)));
    proc.on('error', reject);
    proc.on('exit', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

test('swiftbar git cache treats monorepo package dirs as git repos', async () => {
  const rootDir = process.cwd();
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-swiftbar-git-'));

  const repoRoot = join(tmp, 'repo');
  await mkdir(repoRoot, { recursive: true });
  await mkdir(join(repoRoot, 'packages', 'app'), { recursive: true });
  await writeFile(join(repoRoot, 'packages', 'app', 'README.md'), 'hello\n', 'utf-8');

  // Create a minimal git repo with one commit.
  await run('git', ['init'], { cwd: repoRoot });
  await run('git', ['add', '.'], { cwd: repoRoot });
  await run(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init'],
    { cwd: repoRoot }
  );

  const stacksHome = join(tmp, 'happy-stacks-home');
  const env = {
    ...process.env,
    HAPPY_STACKS_HOME_DIR: stacksHome,
    HAPPY_STACKS_CANONICAL_HOME_DIR: stacksHome,
  };

  const bashScript = [
    `set -euo pipefail`,
    `source "${rootDir}/extras/swiftbar/lib/utils.sh"`,
    `source "${rootDir}/extras/swiftbar/lib/git.sh"`,
    `active_dir="${repoRoot}/packages/app"`,
    `git_cache_refresh_one main main happy "$active_dir" >/dev/null 2>&1 || true`,
    `key="$(git_cache_key main main happy "$active_dir")"`,
    `IFS=$'\\t' read -r meta info wts <<<"$(git_cache_paths "$key")"`,
    `if [[ ! -f "$info" ]]; then echo "missing-info"; exit 2; fi`,
    `head -n 1 "$info"`,
  ].join('\n');

  const res = await run('bash', ['-lc', bashScript], { env });
  assert.equal(
    res.code,
    0,
    `expected bash exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
  );
  assert.match(res.stdout, /^ok\t/, `expected info.tsv to start with ok\\t, got:\n${res.stdout}`);

  await rm(tmp, { recursive: true, force: true });
});
