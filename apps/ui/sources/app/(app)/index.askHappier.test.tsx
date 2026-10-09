import React from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { readNewSessionDraftFromRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { captureActiveServerAccountScopeLifetime, getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { storage } from '@/sync/domains/state/storage';
import { clearPendingSetupIntent, getPendingSetupIntent } from '@/sync/domains/pending/pendingSetupIntent';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { prepareSessionDraftPersistenceStorage } from '@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage';
import { openAskHappierDraft } from '@/components/sessions/bots/happierGuideDraft';
import { Home } from './index';

const navigation = vi.hoisted(() => ({ push: vi.fn(), replace: vi.fn() }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: navigation }).module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => {
    await standardCleanup();
    clearPendingSetupIntent();
    home?.dispose(); home = undefined;
    resetSessionDraftRepositoryForTests();
    navigation.push.mockReset(); navigation.replace.mockReset();
});

it('continues an explicit pre-auth Ask Happier Start through the authenticated root into its ordinary draft, never machine setup', async () => {
    const catalog = createPromptLibraryCatalogBoundary();
    home = await createPlainArtifactHomeFixture('https://ask-happier-auth.test', { handleRequest: async (path, init) => {
        // MainView loads the Account's tab through the real KV reader; an empty Home is valid.
        if (path === '/v1/kv/bulk' && init?.method === 'POST') return Response.json({ values: [] });
        return await catalog.handle(path, init);
    } });
    // Route consumers require prepared large browser records. This mounted-Web fixture
    // uses the real preparation owner with IndexedDB mocked only at its database boundary.
    await prepareSessionDraftPersistenceStorage();
    clearPendingSetupIntent();
    const admittedScope = getActiveServerAccountScope();
    if (!admittedScope) throw new Error('Expected fixture Account');
    storage.getState().clearProfileScope();
    storage.getState().clearSettingsScope();
    const started = await openAskHappierDraft({ lifetime: null,
        context: { kind: 'release', release: { id: 'selected', versionLabel: 'v1', date: '2026-10-09', markdown: 'Selected update' } },
        currentUiContext: { navigation: { area: 'settings', screen: 'machines' }, commands: [] },
    });
    expect(started).toMatchObject({ kind: 'authenticationRequired', guideRef: null });
    expect(getPendingSetupIntent()).toMatchObject({ branch: 'askHappier', phase: 'awaiting_auth' });
    expect(home.boundary.list()).toEqual([]);
    navigation.push.mockClear(); navigation.replace.mockClear();
    const credentials = await TokenStorage.getCredentialsForServerUrl('https://ask-happier-auth.test');
    if (!credentials) throw new Error('Expected fixture credentials');
    storage.getState().activateProfileScope(admittedScope);
    await storage.getState().activateSettingsScope(admittedScope);
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected admitted Account lifetime');
    const openedDraft = new Promise<Readonly<{ pathname: '/new'; params: Readonly<{ draftId: string }> }>>(resolve => {
        // Router arrival is this operation's completion boundary. The runner owns the test budget.
        navigation.push.mockImplementation((value: unknown) => {
            if (!value || typeof value !== 'object' || !('pathname' in value) || value.pathname !== '/new'
                || !('params' in value) || !value.params || typeof value.params !== 'object'
                || !('draftId' in value.params) || typeof value.params.draftId !== 'string') return;
            resolve({ pathname: '/new', params: { draftId: value.params.draftId } });
        });
    });
    await renderScreen(<InjectedAuthProvider credentials={credentials}><MainAppTabStateProvider><Home /></MainAppTabStateProvider></InjectedAuthProvider>);
    const route = await openedDraft;
    expect(home.boundary.list()).toHaveLength(1);
    expect(lifetime.isCurrent(), 'The authenticated Home must remain admitted while its guide draft opens').toBe(true);
    expect(route.pathname).toBe('/new');
    const scope = getActiveServerAccountScope();
    if (!scope) throw new Error('Expected admitted Account');
    expect(readNewSessionDraftFromRepository({ scope, draftId: route.params.draftId })).toMatchObject({ sessionName: 'Happier', initialSessionFacts: { bot: { kind: 'bot' } } });
    expect(getPendingSetupIntent()).toBeNull();
    expect(navigation.replace).not.toHaveBeenCalled();
    expect(home.requests.some(request => request.path.includes('/sessions') && request.method === 'POST')).toBe(false);
});
