import React from 'react';
import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { clearPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { Home } from './index';

// Expo is the navigation boundary: a retained root owns local params while
// global params can belong to a different machine/person/session destination.
const route = vi.hoisted(() => ({
    local: {} as Record<string, string>, global: {} as Record<string, string>,
    replace: vi.fn(),
}));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const boundary = createExpoRouterMock({ params: () => route.local, router: { replace: route.replace } });
    return { ...boundary.module, useGlobalSearchParams: () => route.global };
});
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => {
    await standardCleanup();
    clearPendingSetupIntent();
    home?.dispose(); home = undefined;
    resetSessionDraftRepositoryForTests();
    route.local = {}; route.global = {}; route.replace.mockReset();
});

async function renderRoot() {
    const url = 'https://root-route-params.test';
    const catalog = createPromptLibraryCatalogBoundary();
    home = await createPlainArtifactHomeFixture(url, { handleRequest: async (path, init) => {
        if (path === '/v1/kv/bulk' && init?.method === 'POST') return Response.json({ values: [] });
        return catalog.handle(path, init);
    } });
    await prepareSessionDraftPersistenceStorage();
    clearPendingSetupIntent();
    const credentials = await TokenStorage.getCredentialsForServerUrl(url);
    if (!credentials) throw new Error('Expected fixture Home credentials');
    return renderScreen(<InjectedAuthProvider credentials={credentials}>
        <MainAppTabStateProvider><Home /></MainAppTabStateProvider>
    </InjectedAuthProvider>);
}

it('does not reinterpret another destination global id as a root Session deep link', async () => {
    route.global = { id: 'machine-a', serverId: 'other-home' };
    await renderRoot();
    expect(route.replace).not.toHaveBeenCalled();
});

it('still follows the root own legacy Session/message link with its exact Home and child', async () => {
    route.local = { id: 'session-a', serverId: 'named-home', messageId: 'message-a', jumpChildId: 'child-a' };
    route.global = { ...route.local };
    await renderRoot();
    expect(route.replace).toHaveBeenCalledWith('/session/session-a/message/message-a?serverId=named-home&jumpChildId=child-a');
});
