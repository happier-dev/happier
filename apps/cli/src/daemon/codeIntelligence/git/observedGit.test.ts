import { execFile as execFileCallback, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { listNewCommits, parseNumstatZ } from './observedGit';

const execFile = promisify(execFileCallback);
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** Builds a linear history of `count` commits quickly through `git fast-import`. */
async function createLinearHistory(count: number): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'ci-observed-git-'));
  cleanups.push(() => rm(repo, { recursive: true, force: true }));
  await execFile('git', ['init', '-q', '-b', 'main', repo]);
  const importer = spawn('git', ['fast-import', '--quiet'], { cwd: repo, stdio: ['pipe', 'ignore', 'inherit'] });
  const done = new Promise<void>((resolve, reject) => {
    importer.on('error', reject);
    importer.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fast-import exited ${code}`))));
  });
  const chunks: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    chunks.push(`commit refs/heads/main\nmark :${index}\ncommitter Dev <dev@example.com> ${1_000_000 + index} +0000\ndata 1\nc\n${index > 1 ? `from :${index - 1}\n` : ''}\n`);
  }
  importer.stdin.end(chunks.join(''));
  await done;
  return repo;
}

describe('listNewCommits', () => {
  it('lists a bounded range even when the full range would exceed git output limits', async () => {
    // 110k SHAs is more than the SCM runner's output cap; a repository registered before its first
    // commit and then fetched into reaches exactly this range.
    const repo = await createLinearHistory(110_000);
    const { stdout } = await execFile('git', ['rev-parse', 'HEAD'], { cwd: repo });
    const head = stdout.trim();

    const range = await listNewCommits({ worktreePath: repo, previousHead: null, currentHead: head, maxCommits: 50 });

    expect(range?.shas).toHaveLength(50);
    expect(range?.shas.at(-1)).toBe(head);
    expect(range?.omittedCount).toBe(109_950);
  }, 60_000);
});

describe('parseNumstatZ', () => {
  it('keeps a path that contains a tab whole, as git -z writes it unquoted', () => {
    // `git diff-tree -r -M -z --numstat`: "<ins>\t<del>\t<path>\0", or "<ins>\t<del>\t\0<old>\0<new>\0" for a rename.
    const stats = parseNumstatZ('3\t1\tsrc/odd\tname.ts\0' + '2\t0\t\0old.ts\0new.ts\0' + '-\t-\tlogo.png\0');

    expect(Object.fromEntries(stats)).toEqual({
      'src/odd\tname.ts': { insertions: 3, deletions: 1 },
      'new.ts': { insertions: 2, deletions: 0 },
      'logo.png': { insertions: null, deletions: null },
    });
  });
});
