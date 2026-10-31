import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
    SCM_OPERATION_ERROR_CODES,
    type ScmBackendId,
    type ScmRepoMode,
    type ScmStatusEntriesResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';

import type { ScmBackend } from '@/scm/types';
import { createScmBackendRegistry, type ScmBackendRegistry } from '@/scm/registry';
import { createTestRpcManager, runGit as git } from './testRpcHarness';

const tempDirectories: string[] = [];

function createGitWorkspaceWithUntrackedTree(untrackedFileCount: number): string {
    const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-status-entries-'));
    tempDirectories.push(workspace);
    git(workspace, ['init']);
    git(workspace, ['config', 'user.email', 'test@example.com']);
    git(workspace, ['config', 'user.name', 'Test User']);
    writeFileSync(join(workspace, 'README.md'), 'base\n');
    git(workspace, ['add', 'README.md']);
    git(workspace, ['commit', '-m', 'base']);
    // A staged file so the 'included' area filter has a real discriminator.
    writeFileSync(join(workspace, 'b-staged.txt'), 'staged\n');
    git(workspace, ['add', 'b-staged.txt']);
    // One fully-untracked directory holding the bulk untracked tree, plus a
    // loose root file. Zero-padded names keep the expected code-point order
    // unambiguous.
    mkdirSync(join(workspace, 'D'), { recursive: true });
    for (let index = 0; index < untrackedFileCount; index += 1) {
        writeFileSync(join(workspace, 'D', `d-${String(index).padStart(4, '0')}.txt`), `${index}\n`);
    }
    writeFileSync(join(workspace, 'z-loose.txt'), 'loose\n');
    return workspace;
}

const BACKEND_METHODS_REQUIRING_STUBS = [
    'getCapabilities',
    'describeBackend',
    'statusSnapshot',
    'worktreesEnrichment',
    'diffFile',
    'diffCommit',
    'changeInclude',
    'changeExclude',
    'changeDiscard',
    'commitCreate',
    'commitBackout',
    'logList',
    'branchList',
    'branchCreate',
    'branchCheckout',
    'branchMerge',
    'branchRebase',
    'branchOperationContinue',
    'branchOperationAbort',
    'worktreeCreate',
    'worktreeRemove',
    'worktreePrune',
    'remoteAdd',
    'remoteSetUrl',
    'remoteRemove',
    'remoteFetch',
    'remotePull',
    'remotePush',
    'remotePublish',
    'stashList',
    'stashDrop',
    'stashPop',
    'stashApply',
    'stashShow',
] as const;

/**
 * Detect-only backend WITHOUT the optional `statusEntries` capability — the
 * deterministic stand-in for sapling (whose paging support is deferred), so
 * the FEATURE_UNSUPPORTED gate is verifiable on machines without `sl`.
 */
function buildCapabilityLessBackend(detected: { isRepo: boolean; mode: ScmRepoMode | null; rootPath: string | null }): ScmBackend {
    const backend = {
        id: 'git' satisfies ScmBackendId,
        selection: { modeSelectionScores: { '.git': 200 } },
        detectRepo: async () => detected,
        // Detect-only stub: every non-detection method throws if ever called;
        // the route must answer FEATURE_UNSUPPORTED before any of them runs.
    } as unknown as ScmBackend;
    for (const method of BACKEND_METHODS_REQUIRING_STUBS) {
        (backend as unknown as Record<string, unknown>)[method] = () => {
            throw new Error(`not needed in this test: ${method}`);
        };
    }
    return backend;
}

function buildCapabilityLessRegistry(detected: { isRepo: boolean; mode: ScmRepoMode | null; rootPath: string | null }): ScmBackendRegistry {
    return createScmBackendRegistry([buildCapabilityLessBackend(detected)]);
}

describe('scm.status.entries paged delivery', () => {
    it('pages ~1,200 untracked entries without dupes or misses in code-point order', async () => {
        const workspace = createGitWorkspaceWithUntrackedTree(1_200);
        const { call } = createTestRpcManager({ workingDirectory: workspace });

        const allPages: ScmStatusEntriesResponse['entries'] = [];
        let afterPath: string | undefined;
        let pages = 0;
        for (;;) {
            const page = await call<ScmStatusEntriesResponse, { cwd?: string; afterPath?: string; limit?: number }>(
                RPC_METHODS.SCM_STATUS_ENTRIES,
                { cwd: '.', limit: 500, ...(afterPath !== undefined ? { afterPath } : {}) },
            );
            expect(page.success).toBe(true);
            allPages.push(...page.entries);
            pages += 1;
            if (page.hasMore) {
                expect(page.nextCursor).toBe(page.entries[page.entries.length - 1]?.path);
                afterPath = page.nextCursor;
            } else {
                expect(page.nextCursor).toBeUndefined();
                break;
            }
        }
        expect(pages).toBe(3);
        // 1,200 untracked files + z-loose.txt + the staged b-staged.txt.
        expect(allPages).toHaveLength(1_202);

        // Code-point order across and within pages; exactly the full set.
        const expectedOrder = [...allPages]
            .map((entry) => entry.path)
            .sort((left, right) => (left === right ? 0 : left < right ? -1 : 1));
        expect(allPages.map((entry) => entry.path)).toEqual(expectedOrder);
        expect(new Set(allPages.map((entry) => entry.path)).size).toBe(1_202);
        expect(allPages.filter((entry) => entry.path.startsWith('D/'))).toHaveLength(1_200);
        expect(allPages.some((entry) => entry.path === 'z-loose.txt')).toBe(true);
    });

    it('resumes the cursor exactly at afterPath (exclusive)', async () => {
        const workspace = createGitWorkspaceWithUntrackedTree(1_200);
        const { call } = createTestRpcManager({ workingDirectory: workspace });

        const firstPage = await call<ScmStatusEntriesResponse, { cwd?: string; limit?: number }>(
            RPC_METHODS.SCM_STATUS_ENTRIES,
            { cwd: '.', limit: 500 },
        );
        const cursor = firstPage.nextCursor!;
        expect(cursor).toBeDefined();

        const secondPage = await call<ScmStatusEntriesResponse, { cwd?: string; afterPath?: string; limit?: number }>(
            RPC_METHODS.SCM_STATUS_ENTRIES,
            { cwd: '.', limit: 500, afterPath: cursor },
        );
        expect(secondPage.success).toBe(true);
        expect(secondPage.entries.length).toBeGreaterThan(0);
        // Exclusive: the cursor path itself never reappears.
        expect(secondPage.entries.some((entry) => entry.path === cursor)).toBe(false);
        // Resumes exactly at the next code-point path after the cursor.
        const firstResumed = secondPage.entries[0]!.path;
        expect(firstResumed > cursor).toBe(true);

        // A page starting at an interior path contains exactly the tail after it.
        const allPaths: string[] = [];
        let after: string | undefined;
        for (;;) {
            const page = await call<ScmStatusEntriesResponse, { cwd?: string; afterPath?: string; limit?: number }>(
                RPC_METHODS.SCM_STATUS_ENTRIES,
                { cwd: '.', limit: 500, ...(after !== undefined ? { afterPath: after } : {}) },
            );
            allPaths.push(...page.entries.map((entry) => entry.path));
            if (!page.hasMore) break;
            after = page.nextCursor;
        }
        const tailAfterCursor = allPaths.filter((path) => path > cursor);
        expect(secondPage.entries.map((entry) => entry.path)).toEqual(tailAfterCursor.slice(0, 500));
    });

    it('returns the files under one collapsed directory via expandPath', async () => {
        const workspace = createGitWorkspaceWithUntrackedTree(1_200);
        const { call } = createTestRpcManager({ workingDirectory: workspace });

        const expanded = await call<ScmStatusEntriesResponse, { cwd?: string; expandPath?: string; limit?: number }>(
            RPC_METHODS.SCM_STATUS_ENTRIES,
            { cwd: '.', expandPath: 'D', limit: 500 },
        );
        expect(expanded.success).toBe(true);
        expect(expanded.entries).toHaveLength(500);
        expect(expanded.entries.every((entry) => entry.path.startsWith('D/'))).toBe(true);
        expect(expanded.hasMore).toBe(true);

        // Expanding a path that holds no untracked files is an honest empty page.
        const empty = await call<ScmStatusEntriesResponse, { cwd?: string; expandPath?: string }>(
            RPC_METHODS.SCM_STATUS_ENTRIES,
            { cwd: '.', expandPath: 'README.md' },
        );
        expect(empty.success).toBe(true);
        expect(empty.entries).toEqual([]);
        expect(empty.hasMore).toBe(false);
    });

    it('filters entries by area', async () => {
        const workspace = createGitWorkspaceWithUntrackedTree(1_200);
        const { call } = createTestRpcManager({ workingDirectory: workspace });

        const included = await call<ScmStatusEntriesResponse, { cwd?: string; area?: 'all' | 'included' | 'pending' }>(
            RPC_METHODS.SCM_STATUS_ENTRIES,
            { cwd: '.', area: 'included' },
        );
        expect(included.success).toBe(true);
        expect(included.entries.map((entry) => entry.path)).toEqual(['b-staged.txt']);
        expect(included.hasMore).toBe(false);

        const pending = await call<ScmStatusEntriesResponse, { cwd?: string; area?: 'all' | 'included' | 'pending'; limit?: number }>(
            RPC_METHODS.SCM_STATUS_ENTRIES,
            { cwd: '.', area: 'pending', limit: 500 },
        );
        expect(pending.success).toBe(true);
        // Every untracked entry plus nothing staged-pending in this fixture.
        expect(pending.entries.every((entry) => entry.hasPendingDelta)).toBe(true);
        expect(pending.entries.some((entry) => entry.path === 'b-staged.txt')).toBe(false);
    });

    it('returns FEATURE_UNSUPPORTED when the selected backend lacks the statusEntries capability', async () => {
        const workspace = createGitWorkspaceWithUntrackedTree(1);
        const detected = { isRepo: true, mode: '.git' as ScmRepoMode, rootPath: workspace };
        const { call } = createTestRpcManager({
            workingDirectory: workspace,
            registry: buildCapabilityLessRegistry(detected),
        });

        const response = await call<ScmStatusEntriesResponse, { cwd?: string }>(
            RPC_METHODS.SCM_STATUS_ENTRIES,
            { cwd: '.' },
        );
        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED);
        expect(response.entries).toEqual([]);
        expect(response.hasMore).toBe(false);
    });
});
