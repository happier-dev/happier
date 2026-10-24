import { execFile as execFileCallback, spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { openCodeIntelligenceStore, type CodeIntelligenceStore } from '../store/codeIntelligenceStore';
import { observeCheckout } from './observeCheckout';

const execFile = promisify(execFileCallback);

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFile('git', [...args], { cwd });
  return stdout.trim();
}

async function setup(): Promise<Readonly<{ root: string; repo: string; store: CodeIntelligenceStore }>> {
  const root = await mkdtemp(join(tmpdir(), 'ci-observe-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, 'shop');
  await execFile('git', ['init', '-b', 'main', repo]);
  await git(repo, ['config', 'user.email', 'dev@example.com']);
  await git(repo, ['config', 'user.name', 'Dev']);
  await writeFile(join(repo, 'cart.ts'), 'export function total(items: number[]): number {\n  return items.length;\n}\n');
  await writeFile(join(repo, 'checkout.ts'), 'import { total } from "./cart";\nexport const pay = () => total([]);\n');
  await git(repo, ['add', '.']);
  await git(repo, ['commit', '-m', 'initial']);
  const store = openCodeIntelligenceStore({ dbPath: join(root, 'ci.sqlite') });
  cleanups.push(() => store.close());
  return { root, repo, store };
}

function observe(store: CodeIntelligenceStore, cwd: string) {
  let now = 1_000;
  return observeCheckout({
    store,
    cwd,
    registrationSource: 'session',
    excludedPathPrefixes: [],
    resolvePlausibleSessionIds: () => ['claude:abc'],
    nowMs: () => (now += 1),
  });
}

describe('observeCheckout', () => {
  it('baselines a new checkout, then records a new commit once with its changed symbols and textual impact', async () => {
    const { repo, store } = await setup();

    const first = await observe(store, repo);
    expect(first?.newCommits).toEqual([]);
    expect(store.listEventsAfter({ afterSeq: 0, limit: 10 }).events.map((event) => event.kind)).toEqual([
      'repository_registered',
      'worktree_observed',
    ]);

    await writeFile(join(repo, 'cart.ts'), 'export function total(items: number[]): number {\n  return items.length * 2;\n}\n');
    await git(repo, ['commit', '-am', 'fix: double totals']);
    const head = await git(repo, ['rev-parse', 'HEAD']);

    const second = await observe(store, repo);
    expect(second?.newCommits.map((commit) => commit.sha)).toEqual([head]);
    const commit = store.getCommit({ repositoryId: second!.checkout.repositoryId, sha: head });
    expect(commit?.subject).toBe('fix: double totals');
    expect(commit?.changedFiles.map((file) => [file.path, file.status])).toEqual([['cart.ts', 'modified']]);
    expect(commit?.changedSymbols.map((symbol) => [symbol.name, symbol.changeKind])).toEqual([['total', 'modified']]);
    expect(commit?.impactedReferences).toEqual([{ symbolName: 'total', filePath: 'checkout.ts', evidence: 'textual_reference' }]);
    expect(commit?.plausibleSessionIds).toEqual(['claude:abc']);

    const third = await observe(store, repo);
    expect(third?.newCommits).toEqual([]);
    expect(store.listEventsAfter({ afterSeq: 0, limit: 10 }).events.filter((event) => event.kind === 'commit_observed')).toHaveLength(1);
  });

  it('keeps linked worktrees under one repository and never re-observes a commit reached by a branch pointer move', async () => {
    const { root, repo, store } = await setup();
    const worktree = join(root, 'shop-feature');
    await git(repo, ['worktree', 'add', '-b', 'feature', worktree]);

    const main = await observe(store, repo);
    const linked = await observe(store, worktree);
    expect(linked?.checkout.repositoryId).toBe(main?.checkout.repositoryId);
    expect(linked?.checkout.isLinkedWorktree).toBe(true);

    await writeFile(join(worktree, 'checkout.ts'), 'import { total } from "./cart";\nexport const pay = () => total([1]);\n');
    await git(worktree, ['commit', '-am', 'feat: pay one item']);
    const featureHead = await git(worktree, ['rev-parse', 'HEAD']);
    expect((await observe(store, worktree))?.newCommits.map((commit) => commit.observedInWorktreePath)).toEqual([linked!.checkout.worktreePath]);

    await git(repo, ['merge', '--ff-only', 'feature']);
    const afterMerge = await observe(store, repo);
    expect(afterMerge?.checkout.headCommit).toBe(featureHead);
    expect(afterMerge?.newCommits).toEqual([]);

    await git(repo, ['switch', '-c', 'release']);
    await observe(store, repo);
    const kinds = store.listEventsAfter({ afterSeq: 0, limit: 20 }).events.map((event) => event.kind);
    expect(kinds.filter((kind) => kind === 'commit_observed')).toHaveLength(1);
    expect(kinds.filter((kind) => kind === 'repository_registered')).toHaveLength(1);
    expect(kinds).toContain('branch_changed');
    expect(store.listRepositories()[0]?.worktrees).toHaveLength(2);
  });

  it('records the first commit of a repository that was registered before it had any commits', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ci-observe-unborn-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    const repo = join(root, 'fresh');
    await execFile('git', ['init', '-b', 'main', repo]);
    await git(repo, ['config', 'user.email', 'dev@example.com']);
    await git(repo, ['config', 'user.name', 'Dev']);
    const store = openCodeIntelligenceStore({ dbPath: join(root, 'ci.sqlite') });
    cleanups.push(() => store.close());

    expect((await observe(store, repo))?.checkout.headCommit).toBeNull();

    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'cart.ts'), 'export function total(items: number[]): number {\n  return items.length;\n}\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'initial']);

    const [commit] = (await observe(store, repo))!.newCommits;
    expect(commit?.subject).toBe('initial');
    expect(commit?.parentCount).toBe(0);
    expect(commit?.changedSymbols.map((symbol) => [symbol.filePath, symbol.name, symbol.changeKind])).toEqual([['src/cart.ts', 'total', 'added']]);
  });

  it('never scans the old content of a file renamed out of an excluded path', async () => {
    const { repo, store } = await setup();
    const observeExcluding = () => observeCheckout({
      store,
      cwd: repo,
      registrationSource: 'session',
      excludedPathPrefixes: ['secrets/'],
      resolvePlausibleSessionIds: () => [],
      nowMs: Date.now,
    });
    await mkdir(join(repo, 'secrets'));
    await writeFile(join(repo, 'secrets', 'keys.ts'), 'export function signingKey(): string {\n  return "a";\n}\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'add keys']);
    await observeExcluding();

    await mkdir(join(repo, 'src'));
    await git(repo, ['mv', 'secrets/keys.ts', 'src/keys.ts']);
    await writeFile(join(repo, 'src', 'keys.ts'), 'export function signingKey(): string {\n  return "b";\n}\n');
    await git(repo, ['commit', '-am', 'move keys']);
    const result = await observeExcluding();

    expect(result?.newCommits[0]?.changedSymbols).toEqual([]);
  });

  it('asks the filesystem policy about a working directory before running git in it', async () => {
    const { repo, store } = await setup();
    const asked: string[] = [];

    const result = await observeCheckout({
      store,
      cwd: repo,
      registrationSource: 'session',
      excludedPathPrefixes: [],
      resolvePlausibleSessionIds: () => [],
      nowMs: Date.now,
      isPathAllowed: (path) => {
        asked.push(path);
        return false;
      },
    });

    expect(result).toBeNull();
    // Refused before the checkout was resolved, so git never ran there.
    expect(asked).toEqual([repo]);
    expect(store.listRepositories()).toEqual([]);
  });

  it('records a commit whose file list exceeds git output limits, with its true file count', async () => {
    const { repo, store } = await setup();
    await observe(store, repo);
    // One commit adding 25k files with long paths: its name-status listing is larger than the
    // SCM runner's output cap, as when a dependency tree is committed.
    const parent = await git(repo, ['rev-parse', 'HEAD']);
    const lines = [`commit refs/heads/main\ncommitter Dev <dev@example.com> 1000000000 +0000\ndata 4\nbulk\nfrom ${parent}\n`];
    for (let index = 0; index < 25_000; index += 1) lines.push(`M 100644 inline lib/${'x'.repeat(190)}/${index}.txt\ndata 0\n`);
    const importer = spawn('git', ['fast-import', '--quiet'], { cwd: repo, stdio: ['pipe', 'ignore', 'inherit'] });
    const imported = new Promise<void>((resolve, reject) => importer.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`fast-import ${code}`)))));
    importer.stdin.end(`${lines.join('')}\n`);
    await imported;

    const result = await observe(store, repo);

    expect(result?.newCommits.map((commit) => [commit.subject, commit.changedFiles.length, commit.changedFileCount])).toEqual([['bulk', 500, 25_000]]);
    // The checkpoint moved past it, so it is not read again.
    expect((await observe(store, repo))?.newCommits).toEqual([]);
  }, 60_000);

  it('returns null for a directory outside any git repository', async () => {
    const { root, store } = await setup();
    expect(await observe(store, root)).toBeNull();
  });
});
