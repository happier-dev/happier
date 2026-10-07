import { afterEach, describe, expect, it, vi } from 'vitest';
import { CurrentCursorResponseSchema, SessionCurrentProjectionRecordV1Schema, SessionMetadataTuplePatchV1Schema, SessionMetadataTuplePatchSuccessV1Schema } from '@happier-dev/protocol';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
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
            request: async (input, init) => {
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
                return new Response('{}', { status: 404 });
            },
        });
        try {
            const { sync } = await import('@/sync/sync');
            const { getActiveServerAccountScope } = await import('@/sync/domains/scope/activeServerAccountScope');
            expect(getActiveServerAccountScope()).toMatchObject({ accountId: 'account-a' });
            const serverId = connection.home.id;
            // Two real callers share the canonical in-flight hydration. The first
            // caller transitions the mounted Account before the presentation resumes.
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
