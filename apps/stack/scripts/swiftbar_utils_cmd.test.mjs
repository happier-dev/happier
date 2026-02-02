import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
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

test('swiftbar utils: sums process metrics (cpu + mem)', async () => {
  const rootDir = process.cwd();
  const bashScript = [
    `set -euo pipefail`,
    `source "${rootDir}/apps/stack/extras/swiftbar/lib/utils.sh"`,
    `out="$(swiftbar_sum_metrics_cpu_mem "1.5|100|00:01" "2.25|50|00:02" "" "-")"`,
    `echo "$out"`,
  ].join('\n');
  const res = await run('bash', ['-lc', bashScript], { cwd: rootDir, env: process.env });
  assert.equal(
    res.code,
    0,
    `expected bash exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`
  );
  assert.equal(res.stdout.trim(), '3.8|150', `expected cpu|mem sum, got: ${res.stdout.trim()}`);
});

test('swiftbar utils: derives worktree spec from path', async () => {
  const rootDir = process.cwd();
  const bashScript = [
    `set -euo pipefail`,
    `export HAPPIER_STACK_WORKSPACE_DIR="/x"`,
    `source "${rootDir}/apps/stack/extras/swiftbar/lib/utils.sh"`,
    `echo "$(swiftbar_worktree_spec_from_path "/x/main" "happier")"`,
    `echo "$(swiftbar_worktree_spec_from_path "/x/pr/foo" "happier")"`,
    `v="$(swiftbar_worktree_spec_from_path "/x/other/place" "happier")"`,
    `printf '%s\\n' "$v"`,
  ].join('\n');
  const res = await run('bash', ['-lc', bashScript], { cwd: rootDir, env: process.env });
  assert.equal(res.code, 0, `expected bash exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.equal(res.stdout, 'main\npr/foo\n\n', `unexpected output:\n${res.stdout}`);
});

test('swiftbar utils: finds git root by walking up from nested package dir', async () => {
  const rootDir = process.cwd();
  const tmp = await mkdtemp(join(tmpdir(), 'happier-stack-swiftbar-utils-'));
  const repoRoot = join(tmp, 'repo');
  const pkgDir = join(repoRoot, 'apps', 'ui');
  await mkdir(join(repoRoot, '.git'), { recursive: true });
  await mkdir(pkgDir, { recursive: true });

  const bashScript = [
    `set -euo pipefail`,
    `source "${rootDir}/apps/stack/extras/swiftbar/lib/utils.sh"`,
    `echo "$(swiftbar_find_git_root_upwards "${pkgDir}")"`,
  ].join('\n');
  const res = await run('bash', ['-lc', bashScript], { cwd: rootDir, env: process.env });
  assert.equal(res.code, 0, `expected bash exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.equal(res.stdout.trim(), repoRoot);

  await rm(tmp, { recursive: true, force: true });
});

test('swiftbar utils: derives repo key from component dir path', async () => {
  const rootDir = process.cwd();
  const bashScript = [
    `set -euo pipefail`,
    `export HAPPIER_STACK_WORKSPACE_DIR="/x"`,
    `source "${rootDir}/apps/stack/extras/swiftbar/lib/utils.sh"`,
    `echo "$(swiftbar_repo_key_from_path "/x/main/apps/ui")"`,
    `echo "$(swiftbar_repo_key_from_path "/x/pr/foo/apps/ui")"`,
    `echo "$(swiftbar_repo_key_from_path "/x/other/place")"`,
  ].join('\n');
  const res = await run('bash', ['-lc', bashScript], { cwd: rootDir, env: process.env });
  assert.equal(res.code, 0, `expected bash exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  assert.equal(res.stdout, 'happier\nhappier\n\n');
});
