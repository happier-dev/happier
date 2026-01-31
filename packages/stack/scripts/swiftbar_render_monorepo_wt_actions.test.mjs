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

async function git(cwd, args) {
  const res = await run('git', args, { cwd });
  assert.equal(res.code, 0, `git ${args.join(' ')} failed\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);
  return res.stdout.trim();
}

test('swiftbar: monorepo stacks do not offer per-component worktree switching', async () => {
  const rootDir = process.cwd();
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-swiftbar-mono-wt-'));

  const componentsDir = join(tmp, 'components');
  const monorepoRoot = join(componentsDir, 'happy');
  const appPkg = join(monorepoRoot, 'packages', 'app');
  const cliPkg = join(monorepoRoot, 'packages', 'cli');
  const serverPkg = join(monorepoRoot, 'packages', 'server');
  await mkdir(appPkg, { recursive: true });
  await mkdir(cliPkg, { recursive: true });
  await mkdir(serverPkg, { recursive: true });
  await writeFile(join(appPkg, 'README.md'), 'app\n', 'utf-8');
  await writeFile(join(cliPkg, 'README.md'), 'cli\n', 'utf-8');
  await writeFile(join(serverPkg, 'README.md'), 'server\n', 'utf-8');

  await git(monorepoRoot, ['init']);
  await git(monorepoRoot, ['add', '.']);
  await git(monorepoRoot, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init']);

  const wtPath = join(componentsDir, '.worktrees', 'happy', 'slopus', 'pr', 'foo');
  await mkdir(join(componentsDir, '.worktrees', 'happy', 'slopus', 'pr'), { recursive: true });
  await git(monorepoRoot, ['worktree', 'add', '-b', 'slopus/pr/foo', wtPath, 'HEAD']);

  const stackDir = join(tmp, 'stack');
  await mkdir(stackDir, { recursive: true });
  const envFile = join(stackDir, 'env');
  await writeFile(
    envFile,
    [
      `HAPPY_STACKS_COMPONENT_DIR_HAPPY=${appPkg}`,
      `HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI=${cliPkg}`,
      `HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER=${serverPkg}`,
      '',
    ].join('\n'),
    'utf-8'
  );

  const bashScript = [
    `set -euo pipefail`,
    `export HAPPY_STACKS_SWIFTBAR_GIT_MODE=live`,
    `export HAPPY_LOCAL_DIR="${rootDir}"`,
    `PNPM_BIN="/bin/echo"`,
    `source "${rootDir}/extras/swiftbar/lib/utils.sh"`,
    `source "${rootDir}/extras/swiftbar/lib/icons.sh"`,
    `source "${rootDir}/extras/swiftbar/lib/git.sh"`,
    `source "${rootDir}/extras/swiftbar/lib/render.sh"`,
    `render_component_repo "" "happy-cli" "stack" "exp1" "${envFile}" "${monorepoRoot}"`,
  ].join('\n');

  const res = await run('bash', ['-lc', bashScript], { cwd: rootDir, env: process.env });
  assert.equal(res.code, 0, `expected bash exit 0, got ${res.code}\nstdout:\n${res.stdout}\nstderr:\n${res.stderr}`);

  assert.ok(!res.stdout.includes('Use in stack |'), `expected no per-worktree "Use in stack" actions\n${res.stdout}`);
  assert.ok(
    res.stdout.includes('Select monorepo worktree (interactive)'),
    `expected monorepo worktree selector action\n${res.stdout}`
  );

  await rm(tmp, { recursive: true, force: true });
});
