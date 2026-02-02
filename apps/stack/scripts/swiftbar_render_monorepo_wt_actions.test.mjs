import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const scriptsDir = dirname(fileURLToPath(import.meta.url));
  const rootDir = dirname(scriptsDir);
  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-swiftbar-mono-wt-'));

  const workspaceDir = join(tmp, 'workspace');
  const monorepoRoot = join(workspaceDir, 'main');
  const appPkg = join(monorepoRoot, 'apps', 'ui');
  const cliPkg = join(monorepoRoot, 'apps', 'cli');
  const serverPkg = join(monorepoRoot, 'apps', 'server');
  await mkdir(appPkg, { recursive: true });
  await mkdir(cliPkg, { recursive: true });
  await mkdir(serverPkg, { recursive: true });
  await writeFile(join(appPkg, 'README.md'), 'app\n', 'utf-8');
  await writeFile(join(cliPkg, 'README.md'), 'cli\n', 'utf-8');
  await writeFile(join(serverPkg, 'README.md'), 'server\n', 'utf-8');

  await git(monorepoRoot, ['init']);
  await git(monorepoRoot, ['add', '.']);
  await git(monorepoRoot, ['-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-m', 'init']);

  const wtPath = join(workspaceDir, 'pr', 'foo');
  await mkdir(join(workspaceDir, 'pr'), { recursive: true });
  await git(monorepoRoot, ['worktree', 'add', '-b', 'pr/foo', wtPath, 'HEAD']);

  const stackDir = join(tmp, 'stack');
  await mkdir(stackDir, { recursive: true });
  const envFile = join(stackDir, 'env');
  await writeFile(
    envFile,
    [
      `HAPPIER_STACK_REPO_DIR=${monorepoRoot}`,
      '',
    ].join('\n'),
    'utf-8'
  );

  const bashScript = [
    `set -euo pipefail`,
    `export HAPPIER_STACK_SWIFTBAR_GIT_MODE=live`,
    `export HAPPIER_STACK_WORKSPACE_DIR="${workspaceDir}"`,
    `export HAPPIER_STACK_CLI_ROOT_DIR="${rootDir}"`,
    `export hstack_BIN="/bin/echo"`,
    `export hstack_TERM="/bin/echo"`,
    `export hstack_ROOT_DIR="${rootDir}"`,
    `source "${rootDir}/extras/swiftbar/lib/utils.sh"`,
    `source "${rootDir}/extras/swiftbar/lib/icons.sh"`,
    `source "${rootDir}/extras/swiftbar/lib/git.sh"`,
    `source "${rootDir}/extras/swiftbar/lib/render.sh"`,
    `render_component_repo "" "happier-cli" "stack" "exp1" "${envFile}" "${monorepoRoot}"`,
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
