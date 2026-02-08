import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from '../proc/proc.mjs';
import { assertSafeRelativeRepoPath, getUncommittedOps } from './uncommitted_ops.mjs';

function gitEnv() {
  const clean = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('HAPPIER_STACK_')) continue;
    clean[k] = v;
  }
  return {
    ...clean,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

test('getUncommittedOps includes modified, deleted, and untracked paths', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'happy-review-uncommitted-ops-'));
  const env = gitEnv();
  try {
    await run('git', ['init', '-q'], { cwd: repo, env });
    await run('git', ['checkout', '-q', '-b', 'main'], { cwd: repo, env });

    await writeFile(join(repo, 'a.txt'), 'base-a\n', 'utf-8');
    await writeFile(join(repo, 'b.txt'), 'base-b\n', 'utf-8');
    await run('git', ['add', '.'], { cwd: repo, env });
    await run('git', ['commit', '-q', '-m', 'chore: base'], { cwd: repo, env });

    // Uncommitted changes: modify, delete, and add an untracked file.
    await writeFile(join(repo, 'a.txt'), 'changed-a\n', 'utf-8');
    await rm(join(repo, 'b.txt'));
    await writeFile(join(repo, 'c.txt'), 'untracked-c\n', 'utf-8');

    const ops = await getUncommittedOps({ cwd: repo, env });
    assert.ok(ops.checkout.has('a.txt'));
    assert.ok(ops.checkout.has('c.txt'));
    assert.ok(ops.remove.has('b.txt'));
    assert.equal(ops.all.size, 3);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('getUncommittedOps handles repositories with no commits', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'happy-review-uncommitted-ops-empty-head-'));
  const env = gitEnv();
  try {
    await run('git', ['init', '-q'], { cwd: repo, env });
    await run('git', ['checkout', '-q', '-b', 'main'], { cwd: repo, env });

    await writeFile(join(repo, 'first.txt'), 'hello\n', 'utf-8');

    const ops = await getUncommittedOps({ cwd: repo, env });
    assert.ok(ops.checkout.has('first.txt'));
    assert.equal(ops.remove.size, 0);
    assert.equal(ops.all.size, 1);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('assertSafeRelativeRepoPath rejects traversal and absolute paths', () => {
  assert.throws(() => assertSafeRelativeRepoPath('../outside'), /unsafe path/i);
  assert.throws(() => assertSafeRelativeRepoPath('/etc/passwd'), /unsafe path/i);
  assert.throws(() => assertSafeRelativeRepoPath('C:\\tmp\\x.txt'), /unsafe path/i);
});

test('assertSafeRelativeRepoPath allows normalized nested relative paths', () => {
  assert.equal(assertSafeRelativeRepoPath('apps/cli/src/index.ts'), 'apps/cli/src/index.ts');
  assert.equal(assertSafeRelativeRepoPath('./apps/cli/../cli/src/index.ts'), 'apps/cli/src/index.ts');
});

test('getUncommittedOps rejects absolute paths from git output', async (t) => {
  if (process.platform === 'win32') {
    t.skip('POSIX executable shim required for fake git binary');
    return;
  }

  const tmp = await mkdtemp(join(tmpdir(), 'happy-review-uncommitted-ops-abs-'));
  try {
    const fakeGit = join(tmp, 'git');
    await writeFile(
      fakeGit,
      [
        '#!/usr/bin/env node',
        'const args = process.argv.slice(2);',
        "if (args[0] === 'diff') {",
        "  process.stdout.write('M\\0/etc/passwd\\0');",
        '  process.exit(0);',
        '}',
        "if (args[0] === 'ls-files') {",
        '  process.exit(0);',
        '}',
        'process.exit(0);',
        '',
      ].join('\n'),
      'utf-8'
    );
    await chmod(fakeGit, 0o755);

    const env = {
      ...process.env,
      PATH: `${tmp}:${process.env.PATH ?? ''}`,
    };
    await assert.rejects(() => getUncommittedOps({ cwd: tmp, env }), /unsafe path/i);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
