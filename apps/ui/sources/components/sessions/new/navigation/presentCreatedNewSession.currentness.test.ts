import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { CurrentCursorResponseSchema, SessionCurrentProjectionRecordV1Schema, SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol';
import { createSessionFixture, createPlainSessionCurrentProjectionRecordFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { installTerminalRouteCommonModuleMocks, initializeTerminalRouteRuntimeForTests } from '../../../../__tests__/routes/(app)/terminal/terminalRouteTestHelpers';

installTerminalRouteCommonModuleMocks();
installDisconnectedServerSocketBoundary((socket) => {
    vi.mocked(socket.connect).mockImplementation(() => {
        socket.connected = true;
        for (const listener of socket.listeners('connect')) listener();
        return socket;
    });
    vi.spyOn(socket, 'emit').mockReturnValue(socket);
    vi.spyOn(socket, 'disconnect').mockImplementation(() => {
        socket.connected = false;
        for (const listener of socket.listeners('disconnect')) listener('io client disconnect');
        return socket;
    });
});
await initializeTerminalRouteRuntimeForTests();

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
afterEach(async () => { await connection?.dispose(); });

describe('presentCreatedNewSession currentness', () => {
    it.each(['published', 'forbidden'] as const)('presents fresh publication or preserves its typed refusal: %s', async mode => {
        const { storage } = await import('@/sync/domains/state/storage');
        const initialState = storage.getState();
        const session = createSessionFixture({ id: 'freshly-published-session' });
        const wireSession = createPlainSessionCurrentProjectionRecordFixture({ id: session.id, metadata: session.metadata });
        let published = false;
        let snapshotReads = 0;
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://freshly-published-session.example.test', accountId: 'account-a',
            request: createSessionReadBatchFetchBoundary(async input => {
                const path = new URL(String(input)).pathname;
                if (path === '/health') return Response.json({ status: 'ok' });
                if (path === '/v2/cursor') return Response.json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: { encryption: { plaintextStorage: { enabled: true } }, e2ee: { keylessAccounts: { enabled: true } } } }));
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path.endsWith('/messages')) return Response.json({ messages: [], hasMore: false });
                if (path.endsWith('/turns')) return Response.json({ turns: [], hasMore: false });
                if (path === `/v2/sessions/${session.id}`) {
                    snapshotReads++;
                    if (mode === 'forbidden') return Response.json({ error: 'forbidden' }, { status: 403 });
                    return published ? Response.json({ error: 'stale_response' }, { status: 409 }) : Response.json({ session: wireSession });
                }
                return Response.json({ error: 'not_found' }, { status: 404 });
            }),
        });
        try {
            const { sync } = await import('@/sync/sync');
            const { presentCreatedNewSession } = await import('./presentCreatedNewSession');
            const { createCreatedNewSessionCompletion } = await import('./completeCreatedNewSession');
            const serverId = connection.home.id;
            if (mode === 'forbidden') {
                await expect(presentCreatedNewSession({ sessionId: session.id, serverId, accountId: 'account-a',
                    requestId: 'forbidden-request', router: { replace: vi.fn() } })).rejects.toMatchObject({
                        name: 'HappyError', code: 'forbidden', canTryAgain: false,
                        details: { kind: 'missing', cause: 'forbidden' },
                    });
                expect(storage.getState().sessions[session.id]).toBeUndefined();
                expect(snapshotReads).toBe(1);
                return;
            }
            expect(await sync.ensureSessionVisibleForMessageRoute(session.id, { serverId, hydrateMessages: false })).toMatchObject({ kind: 'available' });
            expect(storage.getState().sessions[session.id]).toBeDefined();
            published = true;
            const router = { replace: vi.fn() };
            await expect(presentCreatedNewSession({ sessionId: session.id, serverId, accountId: 'account-a',
                requestId: 'freshly-published-request', router })).resolves.toBe('opened');
            expect(router.replace).toHaveBeenCalledOnce();
            expect(snapshotReads).toBe(1);
            const { HappyError } = await import('@/utils/errors/errors');
            const originalError = new HappyError('Destination could not open', true, { code: 'destination_unavailable' });
            const completion = createCreatedNewSessionCompletion({ present: () => presentCreatedNewSession({
                sessionId: session.id, serverId, accountId: 'account-a', requestId: 'failed-presentation-request',
                router: { replace() { throw originalError; } },
            }) });
            await expect(completion.present()).rejects.toMatchObject({
                name: 'CreatedNewSessionCompletionError', stage: 'presentation', originalError, message: originalError.message,
            });
        } finally {
            storage.setState(initialState, true);
        }
    });

    it('does not navigate or prepare the destination when the Account changes after shared route hydration resolves', async () => {
        const { storage } = await import('@/sync/domains/state/storage');
        const initialState = storage.getState();
        const session = createSessionFixture({ id: 'session-a' });
        let wireSession = SessionCurrentProjectionRecordV1Schema.parse({
            ...session, metadataLayoutVersion: 0, metadata: JSON.stringify(session.metadata),
            effectiveAccess: { v: 1, level: session.access!.level, sources: [{ kind: 'owner' }], capabilities: session.access!.capabilities },
            responsibleAccountId: null, responsibleAccount: null, share: null,
            archivedAt: null, agentState: null, dataEncryptionKey: null, pendingCount: 0, pendingVersion: 0,
        });
        let releaseSession!: () => void;
        const sessionResponse = new Promise<void>((resolve) => { releaseSession = resolve; });
        let observedSession!: () => void;
        const sessionRequested = new Promise<void>((resolve) => { observedSession = resolve; });
        connection = await restoreServerAccountForTest({
            serverUrl: 'https://session-currentness.example.test',
            accountId: 'account-a',
            request: createSessionReadBatchFetchBoundary(async (input, init) => {
                const path = new URL(String(input)).pathname;
                if (path === '/health') return Response.json({ status: 'ok' });
                if (path === '/v2/cursor') return Response.json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
                if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: { encryption: { plaintextStorage: { enabled: true } }, e2ee: { keylessAccounts: { enabled: true } } } }));
                if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                if (path.endsWith('/messages')) return Response.json({ messages: [], hasMore: false });
                if (path === '/v2/sessions/session-a') {
                    if (init?.method === 'PATCH') {
                        const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(String(init.body)));
                        if (patch.mode === 'shared_editor') throw new Error('Owner fixture received shared-editor metadata');
                        const target = patch.mode === 'owner_migration' ? patch.target : patch;
                        wireSession = SessionCurrentProjectionRecordV1Schema.parse({ ...wireSession, metadataLayoutVersion: 1,
                            metadata: target.sharedMetadata.ciphertext, ownerMetadata: target.ownerMetadata,
                            agentState: target.agentState.ciphertext, metadataVersion: wireSession.metadataVersion + 1,
                            agentStateVersion: (wireSession.agentStateVersion ?? 0) + 1 });
                        return Response.json(SessionMetadataTuplePatchSuccessV1Schema.parse({ success: true, metadataLayoutVersion: 1,
                            sharedMetadata: { version: wireSession.metadataVersion }, agentState: { version: wireSession.agentStateVersion } }));
                    }
                    observedSession();
                    await sessionResponse;
                    return Response.json({ session: wireSession });
                }
                return Response.json({ error: 'not_found' }, { status: 404 });
            }),
        });
        try {
            const { sync } = await import('@/sync/sync');
            const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
            expect(getActiveServerAccountScope()).toMatchObject({ accountId: 'account-a' });
            const serverId = connection.home.id;
            // Two real callers share the canonical in-flight hydration. The first
            // caller transitions the mounted Account before the presentation resumes.
            const { [session.id]: _retainedSession, ...otherSessions } = storage.getState().sessions;
            storage.setState({ sessions: otherSessions });
            const hydrating = sync.ensureSessionVisibleForMessageRoute(session.id, { serverId, forceRefresh: true, hydrateMessages: false });
            const switchingAccount = hydrating.then((result) => {
                expect(result.kind).toBe('available');
                storage.setState({ profileScope: { serverId, accountId: 'account-b' } });
            });
            await sessionRequested;
            const { presentCreatedNewSession } = await import('./presentCreatedNewSession');
            const router = { replace: vi.fn() };
            const prepareDestination = vi.fn();
            const presenting = presentCreatedNewSession({ sessionId: session.id, serverId, accountId: 'account-a',
                requestId: 'request-a', router, prepareDestination, isStillActive: () => true });
            releaseSession();
            await switchingAccount;
            await expect(presenting).resolves.toBe('inactive');
            expect(router.replace).not.toHaveBeenCalled();
            expect(prepareDestination).not.toHaveBeenCalled();
        } finally {
            releaseSession();
            storage.setState(initialState, true);
        }
    });
});
