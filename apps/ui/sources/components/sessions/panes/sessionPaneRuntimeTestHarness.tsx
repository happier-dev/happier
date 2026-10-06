import * as React from 'react';
import { beforeEach, afterEach } from 'vitest';
import { standardCleanup, createSessionFixture } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import type { AppPaneScopeApi } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { storage } from '@/sync/domains/state/storageStore';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import type { RuntimeFetch } from '@/utils/system/runtimeFetch';
import type { Socket } from 'socket.io-client';

installDisconnectedServerSocketBoundary();

/** A real scoped Session and pane reducer; only Home HTTP/Socket transport is replaced. */
export function installSessionPaneRuntimeTestHarness(params: Readonly<{
    sessionId?: string;
    scopeId?: string | ((scope: Readonly<{ sessionId: string; serverId: string }>) => string);
    features?: () => ReturnType<typeof createRootLayoutFeaturesResponse>;
    request?: (...args: Parameters<RuntimeFetch>) => Promise<Response | null>;
    configureSocket?: (socket: Socket) => void;
}> = {}) {
    const sessionId = params.sessionId ?? 's1';
    let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
    let previous: ReturnType<typeof storage.getState>;
    let pane: AppPaneScopeApi;
    let AppPaneProvider: typeof import('@/components/appShell/panes/AppPaneProvider')['AppPaneProvider'];
    let InjectedAuthProvider: typeof import('@/auth/context/AuthContext')['InjectedAuthProvider'];
    let useAppPaneScope: typeof import('@/components/appShell/panes/hooks/useAppPaneScope')['useAppPaneScope'];
    beforeEach(async () => {
        installDisconnectedServerSocketBoundary(params.configureSocket);
        await loadSyncSingletonForTests();
        ({ AppPaneProvider } = await import('@/components/appShell/panes/AppPaneProvider'));
        ({ InjectedAuthProvider } = await import('@/auth/context/AuthContext'));
        ({ useAppPaneScope } = await import('@/components/appShell/panes/hooks/useAppPaneScope'));
        const { resetServerFeaturesClientForTests } = await import('@/sync/api/capabilities/serverFeaturesClient');
        resetServerFeaturesClientForTests();
        previous = storage.getState();
        account = await restoreServerAccountForTest({
            serverUrl: 'https://session-pane.test',
            request: async (url, init) => {
                const path = new URL(String(url)).pathname;
                const json = (value: unknown) => new Response(JSON.stringify(value));
                if (path === '/v1/features' || path === '/v1/features/authenticated') return json(params.features?.() ?? createRootLayoutFeaturesResponse());
                if (path === '/v1/account/encryption') return json({ mode: 'plain', updatedAt: 1 });
                if (path === '/v1/account/encryption/currentness') return json(createPlainAccountEncryptionCurrentnessFixture());
                const response = await params.request?.(url, init);
                if (response) return response;
                if ((init?.method ?? 'GET') === 'GET' && path === `/v2/sessions/${sessionId}/pending`) return json({ pending: [] });
                if ((init?.method ?? 'GET') === 'GET' && path === `/v1/sessions/${sessionId}/messages`) return json({ messages: [], hasMore: false, nextBeforeSeq: null });
                return new Response('{}', { status: 404 });
            },
        });
        storage.getState().applySessions([createSessionFixture({ id: sessionId, serverId: account.home.id })]);
        storage.setState({ localSettings: { ...storage.getState().localSettings, appPaneScopesV1: {} } });
    });
    afterEach(async () => {
        await standardCleanup();
        const { scmStatusSync } = await import('@/scm/scmStatusSync');
        scmStatusSync.stop(sessionId, account?.home.id);
        await account?.dispose();
        storage.setState(previous, true);
    });
    function Probe() {
        const scopeId = typeof params.scopeId === 'function'
            ? params.scopeId({ sessionId, serverId: account.home.id })
            : params.scopeId ?? `session:${sessionId}`;
        pane = useAppPaneScope(scopeId);
        return null;
    }
    function Wrapper({ children }: React.PropsWithChildren) {
        return <InjectedAuthProvider credentials={account.credentials}><AppPaneProvider>
            <Probe />{children}
        </AppPaneProvider></InjectedAuthProvider>;
    }
    return { Wrapper, get pane() { return pane; }, get serverId() { return account.home.id; } };
}
