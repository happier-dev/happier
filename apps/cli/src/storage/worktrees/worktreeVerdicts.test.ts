import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createStorageCategoryCatalog } from '../categoryCatalog';
import type { StorageWorktree } from '../categories/types';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
it('binds registered and provisional worktrees to current accepted Project anchors without guessing from paths', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-project-verdicts-')); roots.push(root);
    const checkout = join(root, '.dev', 'worktree', 'checkout');
    const provisional = join(root, '.dev', 'worktree', 'provisional');
    await mkdir(checkout, { recursive: true }); await mkdir(provisional);
    const catalog = createStorageCategoryCatalog({ happyHomeDir: join(root, 'home'), activeServerDir: join(root, 'server'), tempRoot: join(root, 'tmp'),
        readProjects: () => ({ status: 'ready', projects: [{ repositoryRoot: root, projectId: 'accepted-anchor' },
            { repositoryRoot: root, projectId: 'another-anchor' }, { repositoryRoot: `${root}-sibling`, projectId: 'not-this-project' }] }),
        readWorktrees: () => [{ path: checkout, repositoryRoot: root }], readInUsePaths: () => ({ reliable: true, paths: [] }) });
    const values = (await catalog.discover()).filter(value => value.categoryId === 'worktrees');
    for (const path of [checkout, provisional]) expect(values.find(value => value.path === path))
        .toMatchObject({ projectIds: ['accepted-anchor', 'another-anchor'] });
});
it('uses current SCM facts and ordered Keep reasons, and never treats missing facts as deletable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-verdicts-')); roots.push(root);
    const names = ['main', 'in-use', 'dirty', 'ahead', 'draft', 'pr', 'missing', 'merged', 'gone', 'pushed', 'draft-unknown', 'pr-unknown'];
    const worktrees: StorageWorktree[] = names.map(name => ({ path: join(root, '.dev', 'worktree', name), repositoryRoot: root,
        isMain: name === 'main', facts: { path: join(root, '.dev', 'worktree', name), changeCount: name === 'dirty' ? 2 : 0,
            ahead: name === 'ahead' ? 1 : 0, upstream: 'origin/main', upstreamGone: name === 'gone', mergedIntoDefault: name === 'merged',
            headOid: '123456', isLocked: false }, pullRequestState: name === 'pr' ? 'open' : name === 'pr-unknown' ? undefined : null }));
    const missing = worktrees.find(w => w.path.endsWith('/missing'))!;
    const facts = worktrees.map(w => w === missing ? { ...w, facts: undefined } : w);
    for (const w of worktrees) await mkdir(w.path, { recursive: true });
    const catalog = createStorageCategoryCatalog({ happyHomeDir: join(root, 'home'), activeServerDir: join(root, 'home', 'server'), tempRoot: join(root, 'tmp'),
        readProjects: () => ({ status: 'ready', projects: [{ repositoryRoot: root }] }), readWorktrees: () => facts,
        readTrackedSessions: () => [{ sessionId: 'draft', cwd: worktrees[4]!.path, running: false }, { sessionId: 'unknown', cwd: worktrees[10]!.path, running: false }],
        readInUsePaths: () => ({ reliable: true, paths: [worktrees[1]!.path] }),
        readSessionDraftPresence: async sessionId => sessionId === 'draft' ? { status: 'present', updatedAt: 1 } : { status: 'unknown' } });
    const items = (await catalog.discover()).filter(i => i.categoryId === 'worktrees');
    const reasons = Object.fromEntries(items.map(i => [i.title, [i.verdict, i.reason.code]]));
    expect(reasons).toMatchObject({ main: ['keep', 'unsupported'], 'in-use': ['keep', 'in_use'], dirty: ['keep', 'changed_files'],
        ahead: ['keep', 'unpushed_commits'], draft: ['keep', 'unsaved_edits'], pr: ['keep', 'open_pr'], missing: ['check', 'facts_unavailable'],
        merged: ['safe', 'merged_clean'], gone: ['safe', 'branch_gone'], pushed: ['safe', 'clean_pushed'], 'draft-unknown': ['check', 'facts_unavailable'],
        'pr-unknown': ['check', 'facts_unavailable'] });
    expect(items.find(value => value.title === 'dirty')).toMatchObject({ reason: { code: 'changed_files', detail: { count: 2 } },
        loses: [{ code: 'changed_files', detail: { count: 2 } }] });
    expect(items.find(value => value.title === 'ahead')).toMatchObject({ reason: { code: 'unpushed_commits', detail: { count: 1 } },
        loses: [{ code: 'unpushed_commits', detail: { count: 1 } }] });
    expect(items.find(value => value.title === 'main')).toMatchObject({
        reason: { code: 'unsupported', detail: { cause: 'checkout_reference_owner_unavailable' } },
        loses: [{ code: 'main_checkout' }],
    });
});
it('does not turn an unknown nested checkout into confirmed collectable Keep or hide the main-checkout loss', async () => {
    const root = await mkdtemp(join(tmpdir(), 'happier-nested-verdicts-')); roots.push(root);
    const parent = join(root, '.dev', 'worktree', 'parent');
    const nested = join(parent, 'nested');
    await mkdir(nested, { recursive: true });
    const facts = { changeCount: 0, ahead: 0, upstream: 'origin/main', upstreamGone: false, mergedIntoDefault: true, headOid: '123456' };
    const catalog = createStorageCategoryCatalog({ happyHomeDir: join(root, 'home'), activeServerDir: join(root, 'server'), tempRoot: join(root, 'tmp'),
        readProjects: () => ({ status: 'ready', projects: [{ repositoryRoot: root }] }), readInUsePaths: () => ({ reliable: true, paths: [] }),
        readWorktrees: () => [{ path: root, repositoryRoot: root, isMain: true, facts: { path: root, ...facts }, pullRequestState: null },
            { path: parent, repositoryRoot: root, facts: { path: parent, ...facts }, pullRequestState: null },
            { path: nested, repositoryRoot: root }],
    });
    const values = (await catalog.discover()).filter(value => value.categoryId === 'worktrees');
    expect(values.find(value => value.path === root)).toMatchObject({ verdict: 'keep',
        reason: { code: 'unsupported', detail: { cause: 'checkout_reference_owner_unavailable' } },
        loses: expect.arrayContaining([expect.objectContaining({ code: 'main_checkout' })]) });
    expect(values.find(value => value.path === parent)).toMatchObject({ verdict: 'check', collectable: false, reason: { code: 'facts_unavailable' } });
    // The category and catalog must not independently fold the same child's
    // unknown fact into two losses; review/apply consume one descendant model.
    expect(values.find(value => value.path === parent)?.loses?.filter(reason => reason.code === 'facts_unavailable')).toHaveLength(1);
});
