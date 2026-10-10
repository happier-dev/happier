import 'fake-indexeddb/auto';
import * as React from 'react';
import { AccountProfileSchema, CurrentCursorResponseSchema, FeaturesResponseSchema } from '@happier-dev/protocol';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
import { beforeEach, afterEach, vi } from 'vitest';
import { standardCleanup, createSessionFixture } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { storage } from '@/sync/domains/state/storageStore';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import type { Socket } from 'socket.io-client';
import { resolveServerProfileScopeId } from '@/sync/domains/server/serverProfiles';
import { createAuthoringMemoryHttpBoundary } from '@/dev/testkit/mocks/authoringMemoryHttp';
import { createPlainProjectAccountRowListFixture } from '@/dev/testkit/fixtures/projectAccountRows';

installDisconnectedServerSocketBoundary();
// The connected Account lifecycle must use the real store beneath transport fixtures.
vi.doUnmock('@/sync/domains/state/storage');

/** A real scoped Session and pane reducer; only Home HTTP/Socket transport is replaced. */
export function installSessionPaneRuntimeTestHarness(params: Readonly<{
    sessionId?: string;
    scopeId?: string | ((scope: Readonly<{ sessionId: string; serverId: string }>) => string);
    features?: () => ReturnType<typeof createRootLayoutFeaturesResponse>;
    accountCurrentness?: () => ReturnType<typeof createPlainAccountEncryptionCurrentnessFixture>;
    /** Current signed provenance when a journey exercises the ordinary Home Action front door. */
    credentials?: AuthCredentials;
    request?: (...args: Parameters<RuntimeFetch>) => Promise<Response | null>;
    configureSocket?: (socket: Socket) => void;
}> = {}) {
    const sessionId = params.sessionId ?? 's1';
    const serverIdentityId = 'srv_session_pane';
    const accountId = 'account-a';
    let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
    let previous: ReturnType<typeof storage.getState>;
    let pane: AppPaneScopeApi;
    let AppPaneProvider: typeof import('@/components/appShell/panes/AppPaneProvider')['AppPaneProvider'];
    let InjectedAuthProvider: typeof import('@/auth/context/AuthContext')['InjectedAuthProvider'];
    let useAppPaneScope: typeof import('@/components/appShell/panes/hooks/useAppPaneScope')['useAppPaneScope'];
    beforeEach(async () => {
        installDisconnectedServerSocketBoundary(params.configureSocket);
        const { prepareSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
        await prepareSessionDraftPersistenceStorage();
        await loadSyncSingletonForTests();
        ({ AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider'));
        ({ InjectedAuthProvider } = await import('@/auth/context/AuthContext'));
        ({ useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope'));
        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();
        previous = storage.getState();
        const authoringMemory = createAuthoringMemoryHttpBoundary();
        account = await restoreServerAccountForTest({
            serverUrl: 'https://session-pane.test',
            serverIdentityId,
            accountId,
            ...(params.credentials ? { credentials: params.credentials } : {}),
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                const json = (value: unknown) => Response.json(value);
                if (path === '/v1/features' || path === '/v1/features/authenticated') {
                    const features = params.features?.() ?? createRootLayoutFeaturesResponse();
                    return json(FeaturesResponseSchema.parse({ ...features, capabilities: {
                        ...features.capabilities, serverIdentity: { serverIdentityId },
                    } }));
                }
                if ((init?.method ?? 'GET') === 'GET' && path === '/v2/cursor') return json(CurrentCursorResponseSchema.parse({ cursor: 0, changesFloor: 0 }));
                if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return json(params.accountCurrentness?.() ?? createPlainAccountEncryptionCurrentnessFixture());
                if (path === '/v1/account/profile') return json(AccountProfileSchema.parse({ id: accountId }));
                const response = await params.request?.(url, init);
                if (response) return response;
                const memoryResponse = await authoringMemory.handle(url, init);
                if (memoryResponse) return memoryResponse;
                if (path === '/v1/account/project-rows/list') return json(createPlainProjectAccountRowListFixture());
                if (path === '/v2/account/settings') return json({ content: { t: 'plain', v: {} }, version: 0 });
                if ((init?.method ?? 'GET') === 'GET' && path === `/v2/sessions/${sessionId}`) {
                    const session = storage.getState().sessions[sessionId];
                    if (!session) return Response.json({ error: 'Session not found' }, { status: 404 });
                    return json({ session: SessionCurrentProjectionRecordV1Schema.parse({
                        id: session.id, seq: session.seq, createdAt: session.createdAt, updatedAt: session.updatedAt,
                        active: session.active, activeAt: session.activeAt, encryptionMode: 'plain', dataEncryptionKey: null,
                        metadata: JSON.stringify(session.metadata), metadataVersion: session.metadataVersion, metadataLayoutVersion: 0,
                        agentState: session.agentState ? JSON.stringify(session.agentState) : null, agentStateVersion: session.agentStateVersion,
                        pendingVersion: session.pendingVersion, pendingActivationAuthorization: session.pendingActivationAuthorization ?? undefined,
                        responsibleAccountId: session.responsibleAccountId ?? null,
                        responsibleAccount: session.responsibleAccount ?? null,
                        share: null, effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], audienceContext: null,
                            capabilities: session.access?.capabilities },
                    }) });
                }
                if ((init?.method ?? 'GET') === 'GET' && path === `/v2/sessions/${sessionId}/pending`) return json({ pending: [] });
                if ((init?.method ?? 'GET') === 'GET' && path === `/v1/sessions/${sessionId}/messages`) return json({ messages: [], hasMore: false, nextBeforeSeq: null });
                return new Response('{}', { status: 404 });
            },
        });
        storage.getState().applySessions([createSessionFixture({ id: sessionId, serverId: resolveServerProfileScopeId(account.home), seq: 0 })]);
        storage.setState({ localSettings: { ...storage.getState().localSettings, appPaneScopesV1: {} } });
    });
    afterEach(async () => {
        await standardCleanup();
        const { scmStatusSync } = await import('@/scm/scmStatusSync');
        scmStatusSync.stop(sessionId, account ? resolveServerProfileScopeId(account.home) : undefined);
        await account?.dispose();
        storage.setState(previous, true);
    });
    function Probe() {
        const scopeId = typeof params.scopeId === 'function'
            ? params.scopeId({ sessionId, serverId: resolveServerProfileScopeId(account.home) })
            : params.scopeId ?? `session:${sessionId}`;
        pane = useAppPaneScope(scopeId);
        return null;
    }
    function Wrapper({ children }: React.PropsWithChildren) {
        return <InjectedAuthProvider credentials={account.credentials}><AppPaneProvider>
            <Probe />{children}
        </AppPaneProvider></InjectedAuthProvider>;
    }
    return {
        Wrapper,
        get pane() { return pane; },
        get serverId() { return resolveServerProfileScopeId(account.home); },
        get serverIdentityId() {
            const identity = account.home.serverIdentityId;
            if (!identity) throw new Error('Test Home has no advertised server identity');
            return identity;
        },
    };
}
