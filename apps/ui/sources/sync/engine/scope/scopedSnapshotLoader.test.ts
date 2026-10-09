import { describe, expect, it, vi } from 'vitest';

import { createScopedSnapshotLoader } from './scopedSnapshotLoader';
import { publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';

type HomeCredentialMutationListener = (event: Readonly<{
    kind: 'credentials_set' | 'credentials_removed';
    serverId: string;
    serverUrl: string;
}>) => void;

const credentialBoundary = vi.hoisted(() => ({
    listener: null as HomeCredentialMutationListener | null,
    subscriptions: 0,
    releases: 0,
}));

/**
 * The suite resets `listener` to `null` before subscribing, which narrows every
 * later direct read to `null`. Emitting through this helper reads the field at
 * its declared type instead.
 */
function emitHomeCredentialMutation(event: Parameters<HomeCredentialMutationListener>[0]): void {
    credentialBoundary.listener?.(event);
}

vi.mock('@/auth/storage/tokenStorage', () => ({
    subscribeHomeCredentialMutations: vi.fn((listener: HomeCredentialMutationListener) => {
        credentialBoundary.listener = listener;
        credentialBoundary.subscriptions += 1;
        return () => {
            credentialBoundary.listener = null;
            credentialBoundary.releases += 1;
        };
    }),
}));

describe('createScopedSnapshotLoader', () => {
    it('uses the newly admitted context on the same target trailing read and subsequent wakes', async () => {
        type Target = Readonly<{ key: string; serverId: string; machineId: string | null }>;
        const reads: Array<string | null> = [];
        let releaseInitial!: () => void;
        const initialRead = new Promise<void>(resolve => { releaseInitial = resolve; });
        const loader = createScopedSnapshotLoader<Target>({
            load: async target => {
                reads.push(target.machineId);
                if (reads.length === 1) await initialRead;
            },
            shouldLoadOnObserve: () => true,
            invalidateServer: () => {},
            invalidateTarget: () => {},
        });
        const release = loader.observe({ key: 'home:account:purposes', serverId: 'home', machineId: null });
        try {
            await vi.waitFor(() => expect(reads).toEqual([null]));
            const admission = loader.invalidate({ key: 'home:account:purposes', serverId: 'home', machineId: 'selected' });
            expect(reads).toEqual([null]);
            releaseInitial();
            await admission;
            expect(reads).toEqual([null, 'selected']);
            publishHomeAccountChange('home');
            await vi.waitFor(() => expect(reads).toEqual([null, 'selected', 'selected']));
        } finally {
            releaseInitial();
            release();
            loader.resetForTests();
        }
    });
    it('does not suppress a published MCP read own retained-source maintenance', async () => {
        const { loadMcpServerCatalogV1 } = await import('@happier-dev/protocol/mcp/servers/serverCatalogV1');
        let publication: McpServerCatalogSnapshotV1 = { status: 'loading' };
        let historyCompleted = false;
        let reads = 0;
        let releaseCleanup!: () => void;
        const cleanupAdmission = new Promise<void>(resolve => { releaseCleanup = resolve; });
        const loader = createScopedSnapshotLoader({
            load: async (_target, context) => context.readWithMaintenance({
                read: ({ onReady, hasPendingCleanup }) => loadMcpServerCatalogV1({ mode: 'plain', material: null,
                    readRow: async () => {
                        reads += 1;
                        if (reads > 1) throw new Error('Unexpected HTTP read without external invalidation');
                        return { status: 'deleted', revision: 4 };
                    }, hasPendingCleanup,
                    onReadyBeforeCleanup: async snapshot => {
                        onReady(snapshot, () => true);
                        // The captured HTTP reader can resume after its own maintenance
                        // has been registered, not only in the publication microtask.
                        await cleanupAdmission;
                    },
                    transfer: {
                        readSourceSnapshot: async () => ({ raw: {}, version: 3 }),
                        initializeCatalog: async () => { throw new Error('Active row must not initialize'); },
                        replaceSource: async () => ({ status: 'applied', settingsVersion: 4 }),
                        normalizeHistory: async () => { historyCompleted = true; return { status: 'complete' }; },
                    },
                }),
                publish: value => { publication = value; },
                getPublication: () => publication,
            }),
            shouldLoadOnObserve: () => true,
            invalidateServer: () => {},
            invalidateTarget: () => {},
        });
        try {
            await loader.refresh({ key: 'mcp:home-account', serverId: 'home' });
            expect(publication).toMatchObject({ status: 'ready', authority: 'active', revision: 4 });
            releaseCleanup();
            await vi.waitFor(() => expect(publication).toMatchObject({ cleanup: { status: 'complete' } }));
            expect(historyCompleted).toBe(true);
            expect(reads).toBe(1);
        } finally {
            releaseCleanup();
            loader.resetForTests();
        }
    });
    it('shares one refcounted Account-change and credential observer across concurrent consumers', async () => {
        credentialBoundary.listener = null;
        credentialBoundary.subscriptions = 0;
        credentialBoundary.releases = 0;
        const load = vi.fn(async () => {});
        const onCredentialMutation = vi.fn(() => true);
        const loader = createScopedSnapshotLoader({
            load,
            shouldLoadOnObserve: () => false,
            invalidateServer: vi.fn(),
            invalidateTarget: vi.fn(),
            onCredentialMutation,
        });
        const siblingLoad = vi.fn(async () => {});
        const sibling = createScopedSnapshotLoader({
            load: siblingLoad,
            shouldLoadOnObserve: () => false,
            invalidateServer: vi.fn(),
            invalidateTarget: vi.fn(),
            onCredentialMutation: () => true,
        });
        const target = { key: 'home-a', serverId: 'home-a' };

        const releaseFirst = loader.observe(target);
        const releaseSecond = loader.observe(target);
        const releaseSibling = sibling.observe({ key: 'home-a:sibling', serverId: 'home-a' });
        expect(credentialBoundary.subscriptions).toBe(1);

        emitHomeCredentialMutation({
            kind: 'credentials_set',
            serverId: 'home-a',
            serverUrl: 'https://home-a.test',
        });
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(siblingLoad).toHaveBeenCalledTimes(1));
        expect(onCredentialMutation).toHaveBeenCalledTimes(1);

        releaseFirst();
        expect(credentialBoundary.releases).toBe(0);
        releaseSecond();
        expect(credentialBoundary.releases).toBe(0);
        releaseSibling();
        expect(credentialBoundary.releases).toBe(1);
    });

    it('revalidates after a zero-observer interval without reloading for concurrent observers', async () => {
        let hasSnapshot = false;
        const load = vi.fn(async () => {
            hasSnapshot = true;
        });
        const loader = createScopedSnapshotLoader({
            load,
            shouldLoadOnObserve: () => !hasSnapshot,
            invalidateServer: vi.fn(),
            invalidateTarget: vi.fn(),
        });
        const target = { key: 'home-a\u0000account-a', serverId: 'home-a' };

        const releaseFirst = loader.observe(target);
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));

        const releaseConcurrent = loader.observe(target);
        await Promise.resolve();
        expect(load).toHaveBeenCalledTimes(1);

        releaseConcurrent();
        releaseFirst();

        const releaseRemount = loader.observe(target);
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
        releaseRemount();
    });

    it('withdraws target currentness before revalidating after a zero-observer interval', async () => {
        let finishReload: (() => void) | null = null;
        const load = vi.fn()
            .mockResolvedValueOnce(undefined)
            .mockImplementationOnce(async () => {
                await new Promise<void>((resolve) => {
                    finishReload = resolve;
                });
            });
        const invalidateTarget = vi.fn();
        let hasSnapshot = false;
        const loader = createScopedSnapshotLoader({
            load,
            shouldLoadOnObserve: () => !hasSnapshot,
            invalidateServer: vi.fn(),
            invalidateTarget,
        });
        const target = { key: 'home-a:account-a', serverId: 'home-a' };

        const releaseFirst = loader.observe(target);
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
        hasSnapshot = true;
        releaseFirst();

        const releaseRemount = loader.observe(target);

        expect(invalidateTarget).toHaveBeenCalledWith(target);
        await vi.waitFor(() => expect(finishReload).not.toBeNull());
        finishReload!();
        releaseRemount();
    });

    it('does not let an in-flight answer restore currentness after the last observer leaves', async () => {
        let finishLoad: (() => void) | null = null;
        let loadFinished = false;
        const currentness: Array<() => boolean> = [];
        const load = vi.fn(async (_target, context) => {
            currentness.push(context.isCurrent);
            await new Promise<void>((resolve) => {
                finishLoad = resolve;
            });
            loadFinished = true;
        });
        const loader = createScopedSnapshotLoader({
            load,
            shouldLoadOnObserve: () => true,
            invalidateServer: vi.fn(),
            invalidateTarget: vi.fn(),
        });
        const target = { key: 'home-a:account-a', serverId: 'home-a' };

        const release = loader.observe(target);
        await vi.waitFor(() => expect(finishLoad).not.toBeNull());

        release();

        expect(currentness[0]?.()).toBe(false);
        finishLoad!();
        await vi.waitFor(() => expect(loadFinished).toBe(true));
        expect(load).toHaveBeenCalledTimes(1);
        loader.resetForTests();
    });

    it('keeps a pre-wake answer non-current until its queued trailing reload finishes', async () => {
        let finishFirst: (() => void) | null = null;
        let finishTrailing: (() => void) | null = null;
        const load = vi.fn()
            .mockImplementationOnce(async () => {
                await new Promise<void>((resolve) => {
                    finishFirst = resolve;
                });
            })
            .mockImplementationOnce(async () => {
                await new Promise<void>((resolve) => {
                    finishTrailing = resolve;
                });
            });
        const invalidateTarget = vi.fn();
        const loader = createScopedSnapshotLoader({
            load,
            shouldLoadOnObserve: () => true,
            invalidateServer: vi.fn(),
            invalidateTarget,
        });
        const target = { key: 'home-a:account-a', serverId: 'home-a' };

        const release = loader.observe(target);
        await vi.waitFor(() => expect(finishFirst).not.toBeNull());
        publishHomeAccountChange('home-a');
        finishFirst!();

        await vi.waitFor(() => expect(finishTrailing).not.toBeNull());
        expect(invalidateTarget).toHaveBeenCalledWith(target);

        finishTrailing!();
        release();
        loader.resetForTests();
    });

    it('replays an explicit invalidation received during a load and awaits the trailing answer', async () => {
        let finishFirst: (() => void) | null = null;
        let finishTrailing: (() => void) | null = null;
        const currentness: Array<() => boolean> = [];
        const load = vi.fn(async (_target, context) => {
            currentness.push(context.isCurrent);
            await new Promise<void>((resolve) => {
                if (currentness.length === 1) finishFirst = resolve;
                else finishTrailing = resolve;
            });
        });
        const invalidateTarget = vi.fn();
        const loader = createScopedSnapshotLoader({
            load,
            shouldLoadOnObserve: () => false,
            invalidateServer: vi.fn(),
            invalidateTarget,
        });
        const target = { key: 'home-a:account-a', serverId: 'home-a' };

        const first = loader.refresh(target);
        await vi.waitFor(() => expect(finishFirst).not.toBeNull());
        const invalidated = loader.invalidate(target);

        expect(currentness[0]?.()).toBe(false);
        expect(invalidateTarget).toHaveBeenCalledWith(target);
        finishFirst!();
        await vi.waitFor(() => expect(finishTrailing).not.toBeNull());
        expect(load).toHaveBeenCalledTimes(2);

        let invalidationSettled = false;
        void invalidated.then(() => { invalidationSettled = true; });
        await Promise.resolve();
        expect(invalidationSettled).toBe(false);

        finishTrailing!();
        await Promise.all([first, invalidated]);
        expect(currentness[1]?.()).toBe(true);
    });

    it('retires a synchronously failed single flight before a later retry', async () => {
        const load = vi.fn()
            .mockImplementationOnce(() => {
                throw new Error('first load failed');
            })
            .mockResolvedValueOnce(undefined);
        const loader = createScopedSnapshotLoader({
            load,
            shouldLoadOnObserve: () => false,
            invalidateServer: vi.fn(),
            invalidateTarget: vi.fn(),
        });
        const target = { key: 'home-a:account-a', serverId: 'home-a' };

        await expect(loader.refresh(target)).rejects.toThrow('first load failed');
        await expect(loader.refresh(target)).resolves.toBeUndefined();
        expect(load).toHaveBeenCalledTimes(2);
    });

    it('filters exact focused entities while retaining conservative content-free wakes', async () => {
        const load = vi.fn(async () => {});
        const invalidateServer = vi.fn();
        const loader = createScopedSnapshotLoader({
            load,
            shouldLoadOnObserve: () => true,
            invalidateServer,
            invalidateTarget: vi.fn(),
            matchesWake: (event) => event.entityIds === undefined || event.entityIds.includes('teams'),
        });
        const release = loader.observe({ key: 'target', serverId: 'home-a' });
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));

        publishHomeAccountChange('home-a', ['home-governance']);
        await Promise.resolve();
        expect(invalidateServer).not.toHaveBeenCalled();

        publishHomeAccountChange('home-a', ['teams']);
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
        expect(invalidateServer).toHaveBeenCalledWith('home-a');

        publishHomeAccountChange('home-a');
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(3));
        release();
        loader.resetForTests();
    });
});
