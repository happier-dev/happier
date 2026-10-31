import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installPersistenceModuleMock } from '@/dev/testkit';
import { purchasesDefaults } from '@/sync/domains/purchases/purchases';
import { profileDefaults } from '@/sync/domains/profiles/profile';
import { localSettingsDefaults } from '@/sync/domains/settings/localSettings';

const storageStateRef = vi.hoisted(() => ({
    current: null as any,
}));

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    storageStateRef.current = null;
});

function mockSessionPersistenceBoundaries(): void {
    vi.doMock('../../domains/state/persistence', installPersistenceModuleMock({
        loadProfile: vi.fn(() => ({ ...profileDefaults, id: 'account_a' })),
        saveProfile: vi.fn(),
        loadSessionDrafts: vi.fn(() => ({})),
        loadSessionLastViewed: vi.fn(() => ({})),
        loadSessionModelModeUpdatedAts: vi.fn(() => ({})),
        loadSessionModelModes: vi.fn(() => ({})),
        loadSessionPermissionModeUpdatedAts: vi.fn(() => ({})),
        loadSessionPermissionModes: vi.fn(() => ({})),
        loadSessionActionDrafts: vi.fn(() => ({})),
        loadSessionReviewCommentsDrafts: vi.fn(() => ({})),
        loadWorkspaceReviewCommentsDrafts: vi.fn(() => ({})),
        saveSessionDrafts: vi.fn(),
        saveSessionLastViewed: vi.fn(),
        loadSettings: vi.fn(() => ({
            settings: {
                preferredLanguage: 'en',
            },
            version: null,
        })),
        loadLocalSettings: vi.fn(() => ({ ...localSettingsDefaults })),
        loadPurchases: vi.fn(() => ({ ...purchasesDefaults })),
        saveSessionModelModeUpdatedAts: vi.fn(),
        saveSessionModelModes: vi.fn(),
        saveSessionPermissionModeUpdatedAts: vi.fn(),
        saveSessionPermissionModes: vi.fn(),
        saveSessionActionDrafts: vi.fn(),
        saveSessionReviewCommentsDrafts: vi.fn(),
        saveWorkspaceReviewCommentsDrafts: vi.fn(),
        saveLocalSettings: vi.fn(),
        savePurchases: vi.fn(),
        saveSettings: vi.fn(),
    }));
    vi.doMock('../../domains/state/warmCachePersistence', () => ({
        resolveWarmCacheAccountScope: vi.fn((fallback: string | null | undefined) => fallback ?? null),
        saveSessionListWarmCacheEntries: vi.fn(),
        readPersistedSessionListWarmCacheEntries: vi.fn(() => undefined),
    }));
    vi.doMock('@/sync/domains/models/modelOptions', () => ({
        isModelSelectableForSession: vi.fn(() => true),
    }));
    vi.doMock('@/agents/catalog/catalog', () => ({
        AGENT_IDS: [],
        DEFAULT_AGENT_ID: 'openai',
        resolveAgentIdFromFlavor: vi.fn(() => null),
    }));
    vi.doMock('../../domains/state/storage', async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            storage: {
                getState: () => storageStateRef.current,
                getInitialState: () => storageStateRef.current,
                setState: () => undefined,
                subscribe: () => () => undefined,
                destroy: () => undefined,
            },
        } as any);
    });
}

function createHarness(createSessionsDomain: any, initialState: Record<string, any> = {}) {
    let state: any = {
        sessions: {},
        sessionListRenderables: {},
        sessionsData: null,
        sessionListViewData: null,
        sessionListViewDataByServerId: {},
        sessionScmStatus: {},
        sessionLastViewed: {},
        sessionRepositoryTreeExpandedPathsBySessionId: {},
        reviewCommentsDraftsBySessionId: {},
        reviewCommentsDraftsByWorkspaceCacheKey: {},
        actionDraftsBySessionId: {},
        isDataReady: false,
        machines: {},
        machineDisplayById: {},
        sessionMessages: {},
        profile: { id: 'account_a' },
        settings: { groupInactiveSessionsByProject: false },
        ...initialState,
    };
    storageStateRef.current = state;
    let setCount = 0;

    const get = () => state;
    const set = (updater: any) => {
        setCount += 1;
        const next = typeof updater === 'function' ? updater(state) : updater;
        state = { ...state, ...next };
        storageStateRef.current = state;
    };

    const domain = createSessionsDomain({ get, set } as any);
    return { get, domain, getSetCount: () => setCount };
}

function makeSession(id: string) {
    return {
        id,
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        archivedAt: null,
        metadata: { machineId: 'm1', host: 'h1', path: '/home/u/repo', homeDir: '/home/u' },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
    };
}

function makeSnapshot(fetchedAt: number) {
    return {
        projectKey: 'm1:/home/u/repo',
        fetchedAt,
        repo: {
            isRepo: true,
            rootPath: '/home/u/repo',
            backendId: 'git',
            mode: '.git',
            worktrees: [{ path: '/home/u/repo', branch: 'main', isCurrent: true }],
        },
        capabilities: {
            writeInclude: true,
            writeExclude: true,
            worktreeCreate: true,
        },
        branch: {
            head: 'main',
            upstream: 'origin/main',
            ahead: 0,
            behind: 0,
            detached: false,
        },
        entries: [{
            path: 'src/a.ts',
            previousPath: null,
            kind: 'modified',
            includeStatus: 'unmodified',
            pendingStatus: 'modified',
            hasIncludedDelta: false,
            hasPendingDelta: true,
            stats: {
                includedAdded: 0,
                includedRemoved: 0,
                pendingAdded: 1,
                pendingRemoved: 0,
                isBinary: false,
            },
        }],
        hasConflicts: false,
        totals: {
            includedFiles: 0,
            pendingFiles: 1,
            untrackedFiles: 0,
            includedAdded: 0,
            includedRemoved: 0,
            pendingAdded: 1,
            pendingRemoved: 0,
        },
        stashCount: 0,
    };
}

function makeStatus(lastUpdatedAt: number) {
    return {
        branch: 'main',
        isDirty: true,
        modifiedCount: 1,
        untrackedCount: 0,
        includedCount: 0,
        lastUpdatedAt,
        includedLinesAdded: 0,
        includedLinesRemoved: 0,
        pendingLinesAdded: 1,
        pendingLinesRemoved: 0,
        linesAdded: 1,
        linesRemoved: 0,
        linesChanged: 1,
    };
}

describe('sessions domain: batched project SCM snapshot publish', () => {
    it('publishes snapshots to multiple sessions with a single store notification', async () => {
        mockSessionPersistenceBoundaries();
        const { projectManager } = await import('../../runtime/orchestration/projectManager');
        projectManager.clear();

        const { createSessionsDomain } = await import('./sessions');
        const { get, domain, getSetCount } = createHarness(createSessionsDomain, {
            sessions: { s1: makeSession('s1'), s2: makeSession('s2'), s3: makeSession('s3') },
            machines: { m1: { id: 'm1', metadata: { homeDir: '/home/u' } } },
        });

        // A stale touched path that the publish prune must drop.
        domain.markSessionProjectScmTouchedPaths('s1', ['gone.ts', 'src/a.ts']);
        const setCountBeforePublish = getSetCount();

        const snapshot = makeSnapshot(100);
        const status = makeStatus(100);
        domain.publishSessionProjectScmSnapshots([
            { sessionId: 's1', snapshot: snapshot as any, status: status as any },
            { sessionId: 's2', snapshot: snapshot as any, status: status as any },
            { sessionId: 's3', snapshot: snapshot as any, status: status as any },
        ]);

        expect(getSetCount() - setCountBeforePublish).toBe(1);
        expect(get().sessionScmStatus.s1).toBe(status);
        expect(get().sessionScmStatus.s2).toBe(status);
        expect(get().sessionScmStatus.s3).toBe(status);
        expect(domain.getSessionProjectScmSnapshot('s1')).toBe(snapshot);
        expect(domain.getSessionProjectScmSnapshot('s3')).toBe(snapshot);
        expect(domain.getSessionProjectScmTouchedPaths('s1')).toEqual(['src/a.ts']);
    });

    it('keeps the equivalent-snapshot identity when only fetchedAt changes and still notifies once', async () => {
        mockSessionPersistenceBoundaries();
        const { projectManager } = await import('../../runtime/orchestration/projectManager');
        projectManager.clear();

        const { createSessionsDomain } = await import('./sessions');
        const { domain, getSetCount } = createHarness(createSessionsDomain, {
            sessions: { s1: makeSession('s1') },
            machines: { m1: { id: 'm1', metadata: { homeDir: '/home/u' } } },
        });

        const first = makeSnapshot(100);
        domain.publishSessionProjectScmSnapshots([
            { sessionId: 's1', snapshot: first as any, status: makeStatus(100) as any },
        ]);
        const setCountAfterFirst = getSetCount();

        const refreshedOnly = makeSnapshot(200);
        domain.publishSessionProjectScmSnapshots([
            { sessionId: 's1', snapshot: refreshedOnly as any, status: makeStatus(200) as any },
        ]);

        // Snapshot equivalence (ignoring fetchedAt) must keep the previous object identity.
        expect(domain.getSessionProjectScmSnapshot('s1')).toBe(first);
        expect(getSetCount() - setCountAfterFirst).toBe(1);
    });

    it('clears a previously recorded snapshot error as part of the same publish', async () => {
        mockSessionPersistenceBoundaries();
        const { projectManager } = await import('../../runtime/orchestration/projectManager');
        projectManager.clear();

        const { createSessionsDomain } = await import('./sessions');
        const { domain } = createHarness(createSessionsDomain, {
            sessions: { s1: makeSession('s1') },
            machines: { m1: { id: 'm1', metadata: { homeDir: '/home/u' } } },
        });

        domain.updateSessionProjectScmSnapshotError('s1', { kind: 'daemon_unreachable', message: 'x', occurredAt: 1 } as any);
        expect(domain.getSessionProjectScmSnapshotError('s1')).not.toBeNull();

        domain.publishSessionProjectScmSnapshots([
            { sessionId: 's1', snapshot: makeSnapshot(100) as any, status: makeStatus(100) as any },
        ]);

        expect(domain.getSessionProjectScmSnapshotError('s1')).toBeNull();
    });

    it('keeps touched and commit-selection paths when the snapshot omits entries', async () => {
        mockSessionPersistenceBoundaries();
        const { projectManager } = await import('../../runtime/orchestration/projectManager');
        projectManager.clear();

        const { createSessionsDomain } = await import('./sessions');
        const { domain, get } = createHarness(createSessionsDomain, {
            sessions: { s1: makeSession('s1') },
            machines: { m1: { id: 'm1', metadata: { homeDir: '/home/u' } } },
        });

        domain.markSessionProjectScmTouchedPaths('s1', ['src/a.ts', 'gone.ts']);
        domain.markSessionProjectScmCommitSelectionPaths('s1', ['src/a.ts', 'selected-but-kept.ts']);

        const summary = makeSnapshot(100);
        (summary as any).entries = [];
        (summary as any).entriesPresentation = 'omitted';
        domain.publishSessionProjectScmSnapshots([
            { sessionId: 's1', snapshot: summary as any, status: makeStatus(100) as any },
        ]);

        // Evidence of absence is not absence of evidence: an omitted entries
        // array must never prune touched-path or commit-selection state.
        expect([...domain.getSessionProjectScmTouchedPaths('s1')].sort()).toEqual(['gone.ts', 'src/a.ts']);
        expect([...domain.getSessionProjectScmCommitSelectionPaths('s1')].sort()).toEqual(['selected-but-kept.ts', 'src/a.ts']);
        expect(domain.getSessionProjectScmSnapshot('s1')).toBe(summary);
    });

    it('keeps touched and commit-selection paths when the snapshot entries are truncated', async () => {
        mockSessionPersistenceBoundaries();
        const { projectManager } = await import('../../runtime/orchestration/projectManager');
        projectManager.clear();

        const { createSessionsDomain } = await import('./sessions');
        const { domain, get } = createHarness(createSessionsDomain, {
            sessions: { s1: makeSession('s1') },
            machines: { m1: { id: 'm1', metadata: { homeDir: '/home/u' } } },
        });

        domain.markSessionProjectScmTouchedPaths('s1', ['zz-late.ts', 'src/a.ts']);
        domain.markSessionProjectScmCommitSelectionPaths('s1', ['zz-late.ts']);

        const truncated = makeSnapshot(100);
        (truncated as any).entriesPresentation = 'truncated';
        // Only a prefix shipped: 'zz-late.ts' sits beyond the truncation point.
        (truncated as any).entries = [(truncated as any).entries[0]];
        domain.publishSessionProjectScmSnapshots([
            { sessionId: 's1', snapshot: truncated as any, status: makeStatus(100) as any },
        ]);

        expect([...domain.getSessionProjectScmTouchedPaths('s1')].sort()).toEqual(['src/a.ts', 'zz-late.ts']);
        expect(domain.getSessionProjectScmCommitSelectionPaths('s1')).toEqual(['zz-late.ts']);
    });

    it('prunes touched and commit-selection paths when the snapshot carries the complete entry set', async () => {
        mockSessionPersistenceBoundaries();
        const { projectManager } = await import('../../runtime/orchestration/projectManager');
        projectManager.clear();

        const { createSessionsDomain } = await import('./sessions');
        const { domain, get } = createHarness(createSessionsDomain, {
            sessions: { s1: makeSession('s1') },
            machines: { m1: { id: 'm1', metadata: { homeDir: '/home/u' } } },
        });

        domain.markSessionProjectScmTouchedPaths('s1', ['gone.ts', 'src/a.ts']);
        domain.markSessionProjectScmCommitSelectionPaths('s1', ['gone.ts', 'src/a.ts']);

        const complete = makeSnapshot(100);
        (complete as any).entriesPresentation = 'complete';
        domain.publishSessionProjectScmSnapshots([
            { sessionId: 's1', snapshot: complete as any, status: makeStatus(100) as any },
        ]);

        expect([...domain.getSessionProjectScmTouchedPaths('s1')].sort()).toEqual(['src/a.ts']);
        expect([...domain.getSessionProjectScmCommitSelectionPaths('s1')].sort()).toEqual(['src/a.ts']);
    });
});
