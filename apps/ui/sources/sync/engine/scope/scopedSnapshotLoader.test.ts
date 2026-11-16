import { describe, expect, it, vi } from 'vitest';

import { createScopedSnapshotLoader } from './scopedSnapshotLoader';
import { getHomeAccountChangeDemandedServerIds, publishHomeAccountChange } from '@/sync/runtime/orchestration/homeAccountChange';
import type { McpServerCatalogSnapshotV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { loadMcpServerCatalogV1 } from '@happier-dev/protocol/mcp/servers/serverCatalogV1';
import { normalizeAccountSettingsHistoryClientV1 } from '@happier-dev/protocol/account/settings/accountSettingsHistoryClientV1';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { AccountEncryptionCurrentnessResponseSchema } from '@happier-dev/protocol/account/encryptionMode';
import { PROFILE_TRANSFER_ROUTE_V1 } from '@happier-dev/protocol/profiles/profileTransferV1';
import { PROMPT_LIBRARY_ROWS_ROUTE_V1 } from '@happier-dev/protocol/prompts/library/promptLibraryRowsV1';
import { MCP_SERVER_CATALOG_ROWS_ROUTE_V1, McpServerCatalogRowReadResponseV1Schema } from '@happier-dev/protocol/mcp/servers/serverRowsV1';
import { NOTIFICATION_CHANNELS_ROUTE_V1 } from '@happier-dev/protocol/account/settings/notificationChannelRecordV1';
import { loadConnectedAccountCatalogV1, type ConnectedAccountCatalogSnapshotV1 } from '@happier-dev/protocol/connect/connectedAccountCatalogV1';

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
    it('joins a finite catalog acquisition when an observer arrives before its first publication', async () => {
        const target = { key: 'finite-then-observed', serverId: 'catalog-home' };
        const reply = createDeferred<void>();
        let reads = 0;
        let current = false;
        const loader = createScopedSnapshotLoader({
            subscribeRetainedInvalidation: () => () => {},
            load: async (_target, context) => {
                reads += 1;
                await reply.promise;
                current = context.isCurrent();
            },
            shouldLoadOnObserve: () => true,
            invalidateServer: () => {}, invalidateTarget: () => {},
        });
        const acquired = loader.refresh(target);
        let release = () => {};
        try {
            await vi.waitFor(() => expect(reads).toBe(1));
            release = loader.observe(target);
            reply.resolve();
            await acquired;
            expect(reads).toBe(1);
            expect(current).toBe(true);
        } finally { reply.resolve(); release(); loader.resetForTests(); }
    });

    it.each([false, true])('shares a pending refresh without another read and cancels only abandoned demand (live sibling: %s)', async sibling => {
        const target = { key: 'borrowed-catalog', serverId: 'borrowed-home' };
        const reply = createDeferred<string>();
        let requests = 0;
        let publication: string | null = null;
        let requestSignal: AbortSignal | undefined;
        const loader = createScopedSnapshotLoader({
            subscribeRetainedInvalidation: () => () => {},
            load: async (_target, context) => {
                requests += 1;
                requestSignal = context.signal;
                const value = await reply.promise;
                if (context.isCurrent()) publication = value;
            },
            shouldLoadOnObserve: () => true,
            invalidateServer: () => {}, invalidateTarget: () => {},
        });
        let release = () => {};
        try {
            release = loader.observe(target);
            await vi.waitFor(() => expect(requests).toBe(1));
            const cancelled = new AbortController();
            const first = loader.refresh(target, cancelled.signal);
            const refused = expect(first).rejects.toMatchObject({ name: 'AbortError' });
            const second = sibling ? loader.refresh(target) : undefined;
            release();
            cancelled.abort();
            await refused;
            expect(requestSignal?.aborted).toBe(!sibling);
            reply.resolve('current catalog');
            if (second) await second;
            else await new Promise<void>(resolve => setImmediate(resolve));
            expect(publication).toBe(sibling ? 'current catalog' : null);
            expect(requests).toBe(1);
        } finally { reply.resolve('released'); release(); loader.resetForTests(); }
    });

    it('retains catalog invalidation across navigation without background reads or repeated currentness checks', async () => {
        const target = { key: 'catalog-navigation', serverId: 'navigation-home' };
        let revision = 1;
        let reads = 0;
        let currentnessReads = 0;
        let withdrawAdmission = () => {};
        let retainedSubscriptions = 0;
        let snapshot: McpServerCatalogSnapshotV1 = { status: 'loading' };
        const loader = createScopedSnapshotLoader({
            subscribeRetainedInvalidation: (_target, { invalidate }) => {
                retainedSubscriptions++;
                withdrawAdmission = invalidate;
                return () => { retainedSubscriptions--; };
            },
            load: async (_target, context) => {
                // Substitute only HTTP; the protocol loader and publication stay real.
                const request = async (path: string) => {
                    if (path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1) {
                        reads++;
                        return Response.json({ status: 'deleted', revision });
                    }
                    currentnessReads++;
                    return Response.json({ mode: 'plain', version: 1, settingsVersion: 0, updatedAt: 0,
                        signingKeyFingerprint: null, contentKeyFingerprint: null,
                        recipientEnvelopeReadiness: { status: 'unavailable', reason: 'plain_account' } });
                };
                AccountEncryptionCurrentnessResponseSchema.parse(await (await request('/v1/account/encryption/currentness')).json());
                const catalog = await loadMcpServerCatalogV1({ mode: 'plain', material: null,
                    readRow: async () => McpServerCatalogRowReadResponseV1Schema.parse(await (await request(MCP_SERVER_CATALOG_ROWS_ROUTE_V1)).json()),
                });
                if (context.isCurrent()) snapshot = catalog;
            },
            shouldLoadOnObserve: () => snapshot.status !== 'ready',
            invalidateServer: () => { snapshot = { status: 'loading' }; },
            invalidateTarget: () => { snapshot = { status: 'loading' }; },
            matchesWake: event => event.entityIds === undefined || event.entityIds.includes('mcp-catalog'),
            onCredentialMutation: () => { snapshot = { status: 'unavailable', reason: 'unauthorized' }; return true; },
        });
        const settle = () => new Promise<void>(resolve => setImmediate(resolve));
        let release = loader.observe(target);
        try {
            await loader.refresh(target);
            await settle();
            expect(snapshot).toMatchObject({ status: 'ready', revision: 1 });
            const admitted = snapshot;
            for (let navigation = 0; navigation < 100; navigation++) {
                release();
                publishHomeAccountChange(target.serverId, ['unrelated-session'], { changeKinds: ['session'] });
                release = loader.observe(target);
                await settle();
            }
            expect(reads).toBe(1);
            expect(currentnessReads).toBe(1);
            expect(snapshot).toBe(admitted);
            release();
            expect(getHomeAccountChangeDemandedServerIds()).not.toContain(target.serverId);
            revision = 2;
            publishHomeAccountChange(target.serverId, ['mcp-catalog']);
            await settle();
            expect(reads).toBe(1); // Invalidation is not demand for a hidden catalog.
            release = loader.observe(target);
            await vi.waitFor(() => expect(snapshot).toMatchObject({ status: 'ready', revision: 2 }));
            expect(reads).toBe(2);
            expect(currentnessReads).toBe(2);
            publishHomeAccountChange(target.serverId, undefined, { source: 'connected' });
            await vi.waitFor(() => expect(reads).toBe(3));
            await settle();
            release();
            withdrawAdmission();
            expect(snapshot).toMatchObject({ status: 'loading' });
            release = loader.observe(target);
            await settle();
            expect(reads).toBe(4);
            release();
            await loader.refresh(target); // An explicit finite read still has a live invalidation listener.
            await settle();
            expect(reads).toBe(5);
            release = loader.observe(target);
            await settle();
            expect(reads).toBe(5);
            release();
            emitHomeCredentialMutation({ kind: 'credentials_removed', serverId: target.serverId, serverUrl: 'https://navigation-home.test' });
            expect(snapshot).toMatchObject({ status: 'unavailable', reason: 'unauthorized' });
            await settle();
            expect(reads).toBe(5);
            expect(retainedSubscriptions).toBe(0);
        } finally { release(); loader.resetForTests(); }
    });

    it('prunes a retired hidden catalog and releases its lifecycle subscriptions', async () => {
        const target = { key: 'retired-scope', serverId: 'retired-home' };
        let retire = () => {};
        let subscriptions = 0;
        let invalidations = 0;
        const loader = createScopedSnapshotLoader({
            subscribeRetainedInvalidation: (_target, handlers) => {
                subscriptions++;
                retire = handlers.retire;
                return () => { subscriptions--; };
            },
            load: async () => {}, shouldLoadOnObserve: () => false,
            invalidateServer: () => { invalidations++; }, invalidateTarget: () => { invalidations++; },
        });
        const release = loader.observe(target);
        try {
            release();
            expect(subscriptions).toBe(1);
            retire();
            expect(subscriptions).toBe(0);
            const retiredInvalidations = invalidations;
            publishHomeAccountChange(target.serverId);
            expect(invalidations).toBe(retiredInvalidations);
        } finally { release(); loader.resetForTests(); }
    });

    it.each(['direct', 'maintenance'] as const)('serializes a replacement behind an abandoned %s publisher', async publicationKind => {
        const target = { key: 'reopened-catalog', serverId: 'reopened-home' };
        let releaseOld!: () => void;
        const oldResponse = new Promise<string>(resolve => { releaseOld = () => resolve('retired'); });
        let requests = 0;
        let publication: string | null = null;
        // HTTP can finish after its caller detached (for example an adapter without native cancellation).
        const request = async () => ++requests === 1 ? oldResponse : 'current';
        const loader = createScopedSnapshotLoader({
            load: async (_target, context) => publicationKind === 'direct' ? void (publication = await request()) : context.readWithMaintenance<string>({
                read: async ({ onReady }) => {
                    const value = await request();
                    onReady(value, () => true);
                    return value;
                },
                publish: value => { publication = value; },
                getPublication: () => publication,
            }),
            shouldLoadOnObserve: () => true,
            invalidateServer: () => {}, invalidateTarget: () => {},
        });
        const releaseFirst = loader.observe(target);
        let releaseNext: (() => void) | undefined;
        try {
            await vi.waitFor(() => expect(requests).toBe(1));
            releaseFirst();
            releaseNext = loader.observe(target);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(requests).toBe(1);
            releaseOld();
            await vi.waitFor(() => expect(publication).toBe('current'));
            expect(requests).toBe(2);
            releaseOld();
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(publication).toBe('current');
        } finally {
            releaseOld(); releaseFirst(); releaseNext?.();
            await loader.refresh(target); loader.resetForTests();
        }
    });

    it('reopens a retained catalog without joining an abandoned transport or starting its cleanup', async () => {
        const target = { key: 'retained-recovery', serverId: 'recovery-home' };
        let finishOld!: () => void;
        const oldResponse = new Promise<string>(resolve => { finishOld = () => resolve('obsolete'); });
        let requests = 0;
        let cleanups = 0;
        let publication: string | null = null;
        const loader = createScopedSnapshotLoader({
            subscribeRetainedInvalidation: () => () => {},
            load: async (_target, context) => context.readWithMaintenance<string>({
                read: async ({ onReady, hasPendingCleanup }) => {
                    const value = ++requests === 1 ? await oldResponse : 'current';
                    onReady(value, () => true);
                    if (!hasPendingCleanup()) cleanups++;
                    return value;
                },
                publish: value => { publication = value; }, getPublication: () => publication,
            }),
            shouldLoadOnObserve: () => true, invalidateServer: () => {}, invalidateTarget: () => {},
        });
        const first = loader.observe(target);
        let next = () => {};
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            first();
            next = loader.observe(target);
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(requests).toBe(2);
            expect(publication).toBe('current');
            finishOld();
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(publication).toBe('current');
            expect(cleanups).toBe(1);
        } finally { finishOld(); first(); next(); loader.resetForTests(); }
    });

    it.each(['before-release', 'after-release'] as const)('answers a finite refresh borrowed %s', async borrowAt => {
        const target = { key: 'finite-borrower', serverId: 'borrower-home' };
        let finish!: () => void;
        const response = new Promise<void>(resolve => { finish = resolve; });
        let publication: string | null = null;
        let signal: AbortSignal | undefined;
        const loader = createScopedSnapshotLoader({
            load: async (_target, context) => {
                signal = context.signal;
                return context.readWithMaintenance<string>({
                    read: async () => { await response; return 'answer'; },
                    publish: value => { publication = value; }, getPublication: () => publication,
                });
            },
            shouldLoadOnObserve: () => publication === null,
            invalidateServer: () => {}, invalidateTarget: () => {},
        });
        const release = loader.observe(target);
        let completed = false;
        let borrowed = Promise.resolve();
        try {
            await new Promise<void>(resolve => setImmediate(resolve));
            if (borrowAt === 'before-release') borrowed = loader.refresh(target).then(() => { completed = true; });
            release();
            if (borrowAt === 'after-release') borrowed = loader.refresh(target).then(() => { completed = true; });
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(signal?.aborted).toBe(borrowAt === 'after-release');
            expect(completed).toBe(false);
            finish();
            await borrowed;
            expect(publication).toBe('answer');
        } finally { finish(); release(); await borrowed; loader.resetForTests(); }
    });

    it('cancels a demanded read only when its final observer leaves', async () => {
        const target = { key: 'read-lifetime', serverId: 'read-home' };
        let signal: AbortSignal | undefined;
        let finish!: () => void;
        const held = new Promise<void>(resolve => { finish = resolve; });
        const loader = createScopedSnapshotLoader({
            load: async (_target, context) => {
                const candidate = 'signal' in context ? context.signal : undefined;
                signal = candidate instanceof AbortSignal ? candidate : undefined;
                await held;
            },
            shouldLoadOnObserve: () => true,
            invalidateServer: () => {},
            invalidateTarget: () => {},
        });
        const first = loader.observe(target);
        const second = loader.observe(target);
        try {
            await Promise.resolve();
            expect(signal).toBeInstanceOf(AbortSignal);
            first();
            expect(signal?.aborted).toBe(false);
            second();
            expect(signal?.aborted).toBe(true);
        } finally { first(); second(); finish(); await loader.refresh(target); loader.resetForTests(); }
    });

    it('does not turn completed maintenance into new Account-currentness demand on a settled page', async () => {
        type Identity = Pick<ReturnType<typeof AccountEncryptionCurrentnessResponseSchema.parse>, 'version' | 'mode' | 'contentKeyFingerprint'>;
        const target = { key: 'catalog:settled-maintenance', serverId: 'settled-home' };
        let releaseInitial!: () => void;
        const initialCleanup = new Promise<void>(resolve => { releaseInitial = resolve; });
        let releaseSecondReady!: () => void;
        const secondReady = new Promise<void>(resolve => { releaseSecondReady = resolve; });
        let releaseFinalProofs!: () => void;
        const finalProofs = new Promise<void>(resolve => { releaseFinalProofs = resolve; });
        let joinedInitial = false;
        let loads = 0;
        let maximumLoads = 3;
        let currentnessGets = 0;
        let version = 1;
        let mode: 'plain' | 'e2ee' = 'plain';
        let contentKeyFingerprint: string | null = null;
        let publication: Identity | null = null;
        // The HTTP port is the only substituted system boundary. Both initial
        // and final reads parse an actual currentness response; no witness is cached.
        const request = async (path: string, init: RequestInit) => {
            expect(path).toBe('/v1/account/encryption/currentness');
            expect(init.method).toBe('GET');
            currentnessGets++;
            if (loads > maximumLoads) throw new Error('Unrequested currentness GET');
            return Response.json({ mode, version, settingsVersion: 7, updatedAt: version,
                signingKeyFingerprint: null, contentKeyFingerprint,
                recipientEnvelopeReadiness: mode === 'plain' ? { status: 'unavailable', reason: 'plain_account' }
                    : { status: 'available' } });
        };
        const readCurrentness = async () => AccountEncryptionCurrentnessResponseSchema.parse(
            await (await request('/v1/account/encryption/currentness', { method: 'GET' })).json());
        const loader = createScopedSnapshotLoader({
            load: async (_target, context) => context.readWithMaintenance<Identity>({
                read: async ({ onReady, hasPendingCleanup }) => {
                    const pass = ++loads;
                    const initial = await readCurrentness();
                    const joined = hasPendingCleanup();
                    if (pass === 2) {
                        joinedInitial = joined;
                        await secondReady;
                    }
                    const result = { version: initial.version, mode: initial.mode, contentKeyFingerprint: initial.contentKeyFingerprint };
                    onReady(result, () => true);
                    if (pass === 1) await initialCleanup;
                    else await finalProofs;
                    await readCurrentness();
                    return result;
                },
                publish: result => { publication = result; },
                getPublication: () => publication,
            }),
            shouldLoadOnObserve: () => publication === null,
            matchesWake: event => event.entityIds === undefined || event.entityIds.includes('self'),
            invalidateServer: () => {},
            invalidateTarget: () => {},
        });
        const release = loader.observe(target);
        try {
            await loader.refresh(target);
            publishHomeAccountChange(target.serverId, ['self']);
            await vi.waitFor(() => expect(joinedInitial).toBe(true));
            releaseInitial();
            await new Promise<void>(resolve => setImmediate(resolve));
            releaseSecondReady();
            await loader.refresh(target);
            await new Promise<void>(resolve => setImmediate(resolve));
            // The joined foreground pass is still proving its Account. Do not
            // start another read that can only join that same unfinished work.
            expect(loads).toBe(2);
            releaseFinalProofs();
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(currentnessGets).toBe(6);
            expect(loads).toBe(3);
            const settledGets = currentnessGets;
            vi.useFakeTimers();
            for (let index = 0; index < 1_000; index++) {
                publishHomeAccountChange(target.serverId, [`machine-${index}`], { changeKinds: ['machine'] });
            }
            await vi.advanceTimersByTimeAsync(300_000);
            expect(currentnessGets - settledGets).toBe(0);
            vi.useRealTimers();

            // Mode and subsequent key changes each obtain new entry and final witnesses.
            for (const key of ['first-content-key', 'replacement-content-key']) {
                maximumLoads++;
                version++;
                mode = 'e2ee';
                contentKeyFingerprint = key;
                const beforeChange = currentnessGets;
                publishHomeAccountChange(target.serverId, ['self']);
                await loader.refresh(target);
                await new Promise<void>(resolve => setImmediate(resolve));
                expect(publication).toEqual({ version, mode, contentKeyFingerprint });
                expect(currentnessGets - beforeChange).toBe(2);
            }
        } finally {
            vi.useRealTimers();
            releaseInitial(); releaseSecondReady(); releaseFinalProofs();
            release();
            loader.resetForTests();
        }
    });
    it.each([false, true])('settles finite Connected Account maintenance after first observation (wake during reread: %s)', async wakeDuringReread => {
        const target = { key: 'connected-account:finite-maintenance', serverId: 'finite-home' };
        let revision = 4;
        let reads = 0;
        let publication: ConnectedAccountCatalogSnapshotV1 = { status: 'loading' };
        let releaseInitialCleanup!: () => void;
        const initialCleanup = new Promise<void>(resolve => { releaseInitialCleanup = resolve; });
        let releaseReread!: () => void;
        const reread = new Promise<void>(resolve => { releaseReread = resolve; });
        let sourceReads = 0;
        const expectedReads = wakeDuringReread ? 3 : 2;
        const loader = createScopedSnapshotLoader({
            load: async (_target, context) => context.readWithMaintenance<ConnectedAccountCatalogSnapshotV1>({
                read: ({ onReady }) => loadConnectedAccountCatalogV1({ key: 'purposes', mode: 'plain', material: null,
                    readRow: async () => {
                        reads += 1;
                        // Stop an unexpected self-trigger at the HTTP boundary so RED
                        // reports the extra read rather than starving the test runner.
                        if (reads > expectedReads) throw new Error('Unrequested catalog reread');
                        const capturedRevision = revision;
                        if (reads === 2) await reread;
                        return { status: 'deleted', revision: capturedRevision };
                    },
                    onReadyBeforeCleanup: async value => { onReady(value, () => true); },
                    transfer: {
                        readSourceSnapshot: async () => {
                            if (++sourceReads === 1) await initialCleanup;
                            return { raw: {}, version: 1 };
                        },
                        initializeRecord: async () => { throw new Error('Deleted row already owns authority'); },
                        replaceSource: async () => { throw new Error('No source to replace'); },
                        normalizeHistory: async () => ({ status: 'complete' }),
                    },
                }),
                publish: (value, current) => { if (current) publication = value; },
                getPublication: () => publication,
            }),
            shouldLoadOnObserve: () => publication.status !== 'ready',
            invalidateServer: () => {},
            invalidateTarget: () => {},
        });
        let release: (() => void) | undefined;
        try {
            await loader.refresh(target);
            expect(publication).toMatchObject({ status: 'ready', revision: 4 });
            revision = 5;
            release = loader.observe(target);
            await vi.waitFor(() => expect(reads).toBe(2));
            if (wakeDuringReread) {
                revision = 6;
                publishHomeAccountChange(target.serverId);
            }
            const finishedRead = loader.refresh(target);
            releaseInitialCleanup();
            releaseReread();
            await finishedRead;
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(reads).toBe(expectedReads);
            expect(publication).toMatchObject({ status: 'ready', revision: wakeDuringReread ? 6 : 5,
                cleanup: { status: 'complete' } });
        } finally {
            releaseInitialCleanup();
            releaseReread();
            release?.();
            loader.resetForTests();
        }
    });
    it.each(['settled', 'in-flight'] as const)('revalidates an unobserved finite read when its first consumer arrives (%s)', async phase => {
        const target = { key: 'mcp:finite-observation', serverId: 'finite-home' };
        let revision = 4;
        let reads = 0;
        let stale = true;
        let publication: McpServerCatalogSnapshotV1 = { status: 'loading' };
        let releaseInitial!: () => void;
        const initialResponse = new Promise<void>(resolve => { releaseInitial = resolve; });
        const loader = createScopedSnapshotLoader({
            load: async (_target, context) => context.readWithMaintenance<McpServerCatalogSnapshotV1>({
                read: () => loadMcpServerCatalogV1({ mode: 'plain', material: null,
                    // The remote row is captured when HTTP starts, before an unobserved write.
                    readRow: async () => {
                        const capturedRevision = revision;
                        reads += 1;
                        if (reads === 1) await initialResponse;
                        return { status: 'deleted', revision: capturedRevision };
                    },
                }),
                publish: (value, current) => { if (current) { publication = value; stale = false; } },
                getPublication: () => publication,
            }),
            shouldLoadOnObserve: () => stale,
            invalidateServer: () => { stale = true; },
            invalidateTarget: () => { stale = true; },
        });
        let release: (() => void) | undefined;
        try {
            const finite = loader.refresh(target);
            await vi.waitFor(() => expect(reads).toBe(1));
            if (phase === 'settled') {
                releaseInitial();
                await finite;
                expect(publication).toMatchObject({ status: 'ready', revision: 4 });
                expect(stale).toBe(false);
            }
            revision = 5;
            publishHomeAccountChange(target.serverId);
            release = loader.observe(target);
            expect(stale).toBe(true);
            const observedRead = loader.refresh(target);
            releaseInitial();
            await Promise.all([finite, observedRead]);
            expect(publication).toMatchObject({ status: 'ready', revision: 5 });
            expect(stale).toBe(false);
            expect(reads).toBe(2);
        } finally {
            releaseInitial();
            release?.();
            loader.resetForTests();
        }
    });

    it.each(['refresh', 'invalidate', 'wake', 'early-wake', 'early-wake-fast-cleanup', 'observer-gap', 'retired'] as const)(
        'only repeats MCP history maintenance for a changed demand (%s)', async demand => {
            const target = { key: 'mcp:home-account', serverId: 'home' };
            let accountCurrent = true;
            let revision = 4;
            let publication: McpServerCatalogSnapshotV1 = { status: 'loading' };
            const detailRequests: string[] = [];
            const completedPasses: string[] = [];
            let earlyWakeSent = false;
            let releaseDetail!: () => void;
            const heldDetail = new Promise<void>(resolve => { releaseDetail = resolve; });
            const loader = createScopedSnapshotLoader({
                load: async (_target, context) => context.readWithMaintenance<McpServerCatalogSnapshotV1>({
                    read: ({ onReady, hasPendingCleanup }) => loadMcpServerCatalogV1({ mode: 'plain', material: null,
                        readRow: async () => ({ status: 'deleted', revision }), hasPendingCleanup,
                        onReadyBeforeCleanup: async snapshot => {
                            if (demand.startsWith('early-wake') && !earlyWakeSent) {
                                earlyWakeSent = true;
                                revision = 5;
                                publishHomeAccountChange(target.serverId);
                            }
                            onReady(snapshot, () => accountCurrent);
                        },
                        transfer: {
                            readSourceSnapshot: async () => ({ raw: {}, version: 503 }),
                            initializeCatalog: async () => { throw new Error('Active MCP authority must not initialize'); },
                            replaceSource: async () => { throw new Error('No retained source needs rewriting'); },
                            normalizeHistory: async destinationAuthority => {
                                // The catalog and history owners stay real; only the captured
                                // Home HTTP transport holds/fails this retained detail response.
                                const result = await normalizeAccountSettingsHistoryClientV1({ destinationAuthority, ports: {
                                    isCurrent: () => accountCurrent,
                                    readCurrentness: async () => AccountEncryptionCurrentnessResponseSchema.parse({
                                        mode: 'plain', version: 1, settingsVersion: 503, updatedAt: 1,
                                        signingKeyFingerprint: null, contentKeyFingerprint: null,
                                    }),
                                    resolveTransferMaterial: () => null,
                                    openSnapshot: () => { throw new Error('The failed detail cannot be opened'); },
                                    resealSnapshot: () => { throw new Error('The failed detail cannot be rewritten'); },
                                    unavailable: (_status, message): never => { throw new Error(message); },
                                    request: async path => {
                                        if (path === PROFILE_TRANSFER_ROUTE_V1) return { status: 200, data: { status: 'absent' } };
                                        if (path === PROMPT_LIBRARY_ROWS_ROUTE_V1) return { status: 200, data: { status: 'listed', rows: [] } };
                                        if (path === MCP_SERVER_CATALOG_ROWS_ROUTE_V1) return { status: 200, data: { status: 'deleted', revision } };
                                        if (path.startsWith('/v1/account/entity-rows/') || path === NOTIFICATION_CHANNELS_ROUTE_V1) return { status: 404, data: { error: 'not_found' } };
                                        if (path === '/v2/account/settings/history') return { status: 200, data: { snapshots: [{
                                            version: 502, createdAt: '2026-01-01T00:00:00.000Z', contentKind: 'plain', byteLength: 20,
                                        }] } };
                                        if (path === '/v2/account/settings/history/502') {
                                            detailRequests.push(path);
                                            if (demand !== 'early-wake-fast-cleanup') await heldDetail;
                                            return { status: 503, data: { error: 'unavailable' } };
                                        }
                                        throw new Error(`Unexpected Home request: ${path}`);
                                    },
                                } });
                                completedPasses.push(result.status);
                                return result;
                            },
                        },
                    }),
                    publish: value => { publication = value; },
                    getPublication: () => publication,
                }),
                shouldLoadOnObserve: () => true,
                invalidateServer: () => {},
                invalidateTarget: () => {},
            });
            let release = loader.observe(target);
            try {
                await loader.refresh(target);
                if (demand !== 'early-wake-fast-cleanup') await vi.waitFor(() => expect(detailRequests).toHaveLength(1));
                expect(publication).toMatchObject({ status: 'ready', revision: demand.startsWith('early-wake') ? 5 : 4, authority: 'active' });
                if (demand === 'refresh') await loader.refresh(target);
                else if (demand === 'wake') {
                    revision = 5;
                    publishHomeAccountChange(target.serverId);
                    await loader.refresh(target);
                } else if (demand === 'observer-gap') {
                    release();
                    revision = 5;
                    release = loader.observe(target);
                    await loader.refresh(target);
                } else if (!demand.startsWith('early-wake')) {
                    revision = 5;
                    await loader.invalidate(target);
                    if (demand === 'retired') accountCurrent = false;
                }
                releaseDetail();
                // Drain transport/normalizer/loader continuations, including an automatic
                // follow-up if one was queued. No additional caller demand is introduced.
                await new Promise<void>(resolve => setImmediate(resolve));
                const expectedPasses = demand === 'refresh' || demand === 'retired' ? 1 : 2;
                expect(detailRequests).toHaveLength(expectedPasses);
                if (demand !== 'retired') {
                    expect(completedPasses).toEqual(Array(expectedPasses).fill('cleanup-pending'));
                    expect(publication).toMatchObject({ status: 'ready', revision: demand === 'refresh' ? 4 : 5, authority: 'active' });
                }
                if (demand === 'refresh') {
                    // Incomplete privacy maintenance remains retryable on a later
                    // deliberate demand; no completion cache suppresses it.
                    await loader.refresh(target);
                    await new Promise<void>(resolve => setImmediate(resolve));
                    expect(detailRequests).toHaveLength(2);
                    expect(completedPasses).toEqual(['cleanup-pending', 'cleanup-pending']);
                    expect(publication).toMatchObject({ cleanup: { status: 'cleanup-pending', reason: 'history-incomplete' } });
                }
            } finally {
                releaseDetail();
                release();
                loader.resetForTests();
            }
        },
    );
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
    it('does not replay a wake after a finite foreground pass already served it during retained maintenance', async () => {
        let releaseCleanup!: () => void;
        const cleanup = new Promise<void>(resolve => { releaseCleanup = resolve; });
        let reads = 0;
        let publication = 0;
        let cleanupDone = false;
        const target = { key: 'finite-foreground', serverId: 'home' };
        const loader = createScopedSnapshotLoader({
            load: async (_target, context) => {
                reads += 1;
                if (reads > 1) { publication = 2; return; }
                return context.readWithMaintenance<number>({
                    read: async ({ onReady }) => {
                        onReady(1, () => true);
                        await cleanup;
                        cleanupDone = true;
                        return 1;
                    },
                    publish: value => { publication = value; },
                    getPublication: () => publication,
                });
            },
            shouldLoadOnObserve: () => true,
            invalidateServer: () => {}, invalidateTarget: () => {},
        });
        const release = loader.observe(target);
        try {
            await loader.refresh(target);
            publishHomeAccountChange('home');
            await loader.refresh(target);
            expect(publication).toBe(2);
            releaseCleanup();
            await vi.waitFor(() => expect(cleanupDone).toBe(true));
            await new Promise<void>(resolve => setImmediate(resolve));
            expect(reads).toBe(2);
        } finally { releaseCleanup(); release(); loader.resetForTests(); }
    });
    it('does not suppress a published MCP read own retained-source maintenance', async () => {
        const { loadMcpServerCatalogV1 } = await import('@happier-dev/protocol/mcp/servers/serverCatalogV1');
        let publication: McpServerCatalogSnapshotV1 = { status: 'loading' };
        let historyCompleted = false;
        let reads = 0;
        let releaseCleanup!: () => void;
        const cleanupAdmission = new Promise<void>(resolve => { releaseCleanup = resolve; });
        const loader = createScopedSnapshotLoader({
            load: async (_target, context) => context.readWithMaintenance<McpServerCatalogSnapshotV1>({
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
    it('shares credential mutation delivery while releasing each consumer at its own demand boundary', async () => {
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
        // Home Account change owns one persistent underlying credential watcher.
        // Earlier cases may already have installed it; preserve that real listener.
        expect(credentialBoundary.listener).not.toBeNull();

        emitHomeCredentialMutation({
            kind: 'credentials_set',
            serverId: 'home-a',
            serverUrl: 'https://home-a.test',
        });
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1));
        await vi.waitFor(() => expect(siblingLoad).toHaveBeenCalledTimes(1));
        expect(onCredentialMutation).toHaveBeenCalledTimes(1);

        releaseFirst();
        emitHomeCredentialMutation({ kind: 'credentials_set', serverId: 'home-a', serverUrl: 'https://home-a.test' });
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(2));
        await vi.waitFor(() => expect(siblingLoad).toHaveBeenCalledTimes(2));
        releaseSecond();
        emitHomeCredentialMutation({ kind: 'credentials_set', serverId: 'home-a', serverUrl: 'https://home-a.test' });
        await vi.waitFor(() => expect(siblingLoad).toHaveBeenCalledTimes(3));
        expect(load).toHaveBeenCalledTimes(2);
        expect(onCredentialMutation).toHaveBeenCalledTimes(2);
        releaseSibling();
        emitHomeCredentialMutation({ kind: 'credentials_set', serverId: 'home-a', serverUrl: 'https://home-a.test' });
        await Promise.resolve();
        expect(load).toHaveBeenCalledTimes(2);
        expect(siblingLoad).toHaveBeenCalledTimes(3);
        expect(onCredentialMutation).toHaveBeenCalledTimes(2);
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

        expect(invalidateTarget).toHaveBeenCalledWith(target, 'observer-gap');
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
        expect(invalidateTarget).toHaveBeenCalledWith(target, 'reload');

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
        expect(invalidateTarget).toHaveBeenCalledWith(target, 'explicit');
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

    it('re-reads on a primary-Home reconnect only the catalogs whose read is not current', async () => {
        // The reconnect's changes catch-up publishes what changed while away; a socket gap changes no rows.
        const current = { key: 'current-catalog', serverId: 'reconnect-home' };
        const failed = { key: 'failed-catalog', serverId: 'reconnect-home' };
        const reads: string[] = [];
        const readCurrent = new Set<string>();
        let failNext = true;
        const loader = createScopedSnapshotLoader({
            subscribeRetainedInvalidation: () => () => {},
            load: async (target) => {
                reads.push(target.key);
                if (target.key === failed.key && failNext) { failNext = false; throw new Error('read failed during the outage'); }
                readCurrent.add(target.key);
            },
            shouldLoadOnObserve: target => !readCurrent.has(target.key),
            invalidateServer: () => {}, invalidateTarget: () => {},
        });
        const settle = () => new Promise<void>(resolve => setImmediate(resolve));
        const releases = [loader.observe(current), loader.observe(failed)];
        try {
            await vi.waitFor(() => expect(reads).toHaveLength(2));
            await settle();
            reads.length = 0;
            publishHomeAccountChange(current.serverId, undefined, { source: 'connected', changesCatchUp: true });
            await settle();
            expect(reads).toEqual([failed.key]);
            reads.length = 0;
            publishHomeAccountChange(current.serverId, undefined, { source: 'connected', changesCatchUp: true });
            await settle();
            expect(reads).toEqual([]);
            // A secondary-Home transport wake (no catch-up) stays conservative.
            publishHomeAccountChange(current.serverId, undefined, { source: 'connected' });
            await vi.waitFor(() => expect(reads.sort()).toEqual([current.key, failed.key].sort()));
        } finally { for (const release of releases) release(); loader.resetForTests(); }
    });
});
