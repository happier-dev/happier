import { afterEach, describe, expect, it, vi } from 'vitest';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { createDeferred } from '@/dev/testkit/hooks/createDeferred';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { openAskHappierDraft, openBlankAskHappierDraft } from './happierGuideDraft';
import { openNewBotDraft } from './newBotDraft';
import { CurrentUiContextProvider, useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { CurrentUiContextActionHost } from '@/components/appShell/currentUiContext/currentUiContextVoiceToolPort';
import { MainAppTabStateProvider } from '@/components/navigation/mobile/chrome/MainAppTabStateProvider';
import { AppPaneProvider } from '@/components/appShell/panes/AppPaneProvider';
import { useAskHappierOpener } from './useAskHappierOffer';
import { InjectedAuthProvider } from '@/auth/context/AuthContext';
import { TokenStorage } from '@/auth/storage/tokenStorage';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
const userConfirmation = vi.hoisted(() => vi.fn(async () => true));
const unavailableNotice = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: navigation.push } }).module;
});
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: { confirm: userConfirmation, alertAsync: unavailableNotice } }).module;
});
let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(async () => {
    standardCleanup();
    await home?.dispose(); home = undefined;
    resetSessionDraftRepositoryForTests();
    navigation.push.mockReset();
    userConfirmation.mockReset();
    userConfirmation.mockResolvedValue(true);
    unavailableNotice.mockClear();
});
async function prepare(handleRequest?: (path: string, init?: RequestInit) => Promise<Response | null>) {
    const catalog = createPromptLibraryCatalogBoundary();
    home = await createPlainArtifactHomeFixture('https://ask-happier.test', {
        handleRequest: async (path, init) => await handleRequest?.(path, init) ?? await catalog.handle(path, init)
            ?? (path === '/v2/account/settings' ? Response.json({ version: 1, content: { t: 'plain', v: {} } }) : null),
    });
    await home.hydrateAccountSettings();
    const lifetime = captureActiveServerAccountScopeLifetime();
    if (!lifetime) throw new Error('Expected admitted Account');
    const mounted = await renderHook(() => useMountedActionExecution(lifetime.scope));
    await expect.poll(() => mounted.getCurrent().ready).toBe(true);
    return { home, lifetime, mounted, executeAction: mounted.getCurrent().execute };
}

describe('Ask Happier ordinary authoring', () => {
    it('explains a New Bot refusal from the real mounted Action without opening a draft', async () => {
        const { lifetime, executeAction } = await prepare(async path => path === '/v2/account/settings'
            ? Response.json({ version: 1, content: { t: 'plain', v: { actionsSettingsV1: {
                v: 1, actions: { 'session.authoring.open': { enabled: false } },
            } } } }) : null);
        expect(await openNewBotDraft(lifetime, executeAction)).toMatchObject({ kind: 'refused', errorCode: expect.any(String) });
        // The authoring owner shows the typed refusal once; the Bot entry adds no second alert.
        const { readPresentationNotice } = await import('@/components/sessions/presentation/presentationNotices');
        expect(readPresentationNotice()).toMatchObject({ severity: 'error' });
        expect(unavailableNotice).not.toHaveBeenCalled();
        expect(navigation.push).not.toHaveBeenCalled();
    });
    it('captures the mounted screen for an Ask opener reparented outside its React provider', async () => {
        const { home: fixture, lifetime } = await prepare();
        const credentials = await TokenStorage.getCredentialsForServerUrl(fixture.home.serverUrl);
        const host = await renderHook(() => useOptionalCurrentUiContextReader(), {
            wrapper: ({ children }) => React.createElement(InjectedAuthProvider, { credentials, children: React.createElement(MainAppTabStateProvider, null,
                React.createElement(AppPaneProvider, null, React.createElement(CurrentUiContextProvider, null,
                    React.createElement(CurrentUiContextActionHost), children))) }),
        });
        const captured = host.getCurrent()?.readCurrentUiContext();
        expect(captured).toBeTruthy();
        const opener = await renderHook(() => useAskHappierOpener());
        const result = await opener.getCurrent()();
        expect(result.kind).toBe('opened');
        if (result.kind !== 'opened') throw new Error('Expected the ordinary Ask draft');
        const draft = readNewSessionDraftFromRepository({ scope: lifetime.scope, draftId: result.draftId });
        expect(draft?.input).toBe('');
        expect(draft?.composerAttachmentSeeds?.[0]?.value.value).toEqual(captured);
        await host.unmount();
    });
    it('refuses authenticated authoring without its mounted approval custodian before creating a document or draft', async () => {
        const { home: f, lifetime } = await prepare();
        expect(await openAskHappierDraft({ lifetime })).toMatchObject({ kind: 'unavailable', reason: 'client_unavailable', guideRef: null });
        expect(await openNewBotDraft(lifetime)).toMatchObject({ kind: 'unavailable', reason: 'client_unavailable' });
        expect(await openBlankAskHappierDraft(lifetime)).toMatchObject({ kind: 'unavailable', reason: 'client_unavailable' });
        expect(f.boundary.list()).toEqual([]);
        expect(navigation.push).not.toHaveBeenCalled();
    });

    it('waits for native guide confirmation, then creates one document and opens the draft', async () => {
        const { home: f, lifetime, executeAction } = await prepare(async path => path === '/v2/account/settings'
            ? Response.json({ version: 1, content: { t: 'plain', v: { actionsSettingsV1: { v: 1,
                actions: { 'prompt_doc.create': { approvalRequiredSurfaces: ['ui'] } } } } } }) : null);
        const confirmation = createDeferred<boolean>();
        userConfirmation.mockReturnValueOnce(confirmation.promise);
        const pending = openAskHappierDraft({ lifetime, executeAction });
        await expect.poll(() => userConfirmation.mock.calls.length).toBe(1);
        expect(f.boundary.list()).toEqual([]);
        expect(navigation.push).not.toHaveBeenCalled();

        await act(async () => { confirmation.resolve(true); });
        const result = await pending;
        const rows = f.boundary.list();
        expect(result.kind).toBe('opened');
        expect(rows.map(row => row.id)).toEqual([result.guideRef?.artifactId]);
        expect(decodePlainArtifactStoredContent(rows[0]!.header)).toMatchObject({ kind: 'prompt_doc.v2' });
        expect(navigation.push).toHaveBeenCalledTimes(1);
    });

    it.each(['session.authoring.open', 'prompt_doc.create'] as const)('retains custody when %s is disabled in the UI', async actionId => {
        const { home: f, lifetime, executeAction } = await prepare(async path => path === '/v2/account/settings'
            ? Response.json({ version: 1, content: { t: 'plain', v: { actionsSettingsV1: { v: 1,
                actions: { [actionId]: { disabledSurfaces: ['ui'] } } } } } }) : null);
        const result = await openAskHappierDraft({ lifetime, executeAction });
        expect(result.kind).not.toBe('opened');
        expect(navigation.push).not.toHaveBeenCalled();
        expect(f.boundary.list()).toHaveLength(actionId === 'prompt_doc.create' ? 0 : 1);
        if (actionId === 'session.authoring.open') expect(result.guideRef?.artifactId).toBe(f.boundary.list()[0]?.id);
        expect((await openNewBotDraft(lifetime, executeAction)).kind).toBe(actionId === 'session.authoring.open' ? 'refused' : 'opened');
    });

    it('cancels mounted interest during native guide confirmation without creating a document or draft', async () => {
        const { home: f, lifetime, executeAction } = await prepare(async path => path === '/v2/account/settings'
            ? Response.json({ version: 1, content: { t: 'plain', v: { actionsSettingsV1: { v: 1,
                actions: { 'prompt_doc.create': { approvalRequiredSurfaces: ['ui'] } } } } } }) : null);
        const confirmation = createDeferred<boolean>();
        userConfirmation.mockReturnValueOnce(confirmation.promise);
        const controller = new AbortController();
        const pending = openAskHappierDraft({ lifetime, signal: controller.signal, executeAction });
        await expect.poll(() => userConfirmation.mock.calls.length).toBe(1);
        await act(async () => { controller.abort(); confirmation.resolve(true); });
        expect(await pending).toMatchObject({ kind: 'unavailable', reason: 'aborted', guideRef: null });
        expect(f.boundary.list()).toEqual([]);
        expect(navigation.push).not.toHaveBeenCalled();
    });

    it('creates one editable built-in guide and binds captured update/context to a durable Bot draft before navigation', async () => {
        const { home: f, lifetime, executeAction } = await prepare();
        const release = { id: 'selected', versionLabel: 'v1', date: '2026-10-09', markdown: 'Selected notes' };
        const currentUiContext = { navigation: { area: 'settings', screen: 'machines' }, commands: [] };
        expect(f.boundary.list()).toEqual([]);
        let atNavigation: ReturnType<typeof readNewSessionDraftFromRepository> = null;
        navigation.push.mockImplementation((route: { params: { draftId: string } }) => {
            atNavigation = readNewSessionDraftFromRepository({ scope: lifetime.scope, draftId: route.params.draftId });
        });
        const pending = openAskHappierDraft({ lifetime, executeAction, context: { kind: 'release', release }, currentUiContext });
        release.markdown = 'Later notes';
        currentUiContext.navigation.screen = 'later';
        const result = await pending;
        expect(result.kind).toBe('opened');
        if (result.kind !== 'opened') throw new Error('Expected ordinary draft');
        const rows = f.boundary.list();
        expect(rows).toHaveLength(1);
        expect(decodePlainArtifactStoredContent(rows[0]!.header)).toMatchObject({ kind: 'prompt_doc.v2', origin: 'built_in' });
        expect(atNavigation).toMatchObject({ sessionName: 'Happier', initialSessionFacts: { bot: { kind: 'bot' }, createdAsBot: true },
            promptStack: [{ id: 'session.instructions', ref: { kind: 'doc', artifactId: rows[0]!.id, serverId: lifetime.scope.serverId }, required: true }] });
        const draft = readNewSessionDraftFromRepository({ scope: lifetime.scope, draftId: result.draftId });
        expect(draft?.input).toContain('Selected notes');
        expect(draft?.input).not.toContain('Current Happier screen');
        expect(draft?.input).not.toContain('"navigation"');
        expect(draft?.composerAttachmentSeeds).toHaveLength(1);
        expect(draft?.composerAttachmentSeeds?.[0]).toMatchObject({
            pluginId: 'happier.app-context', attachmentLocalId: 'current-screen',
            value: { value: { navigation: { area: 'settings', screen: 'machines' }, commands: [] } },
        });
        expect(draft?.input).not.toContain('Later notes');
        expect(draft?.input).not.toContain('"screen":"later"');
        if (!draft) throw new Error('Expected persisted draft');
        writeNewSessionDraftToRepository({ scope: lifetime.scope, draftId: result.draftId, draft: { ...draft, sessionName: 'My Happier', input: 'My question' } });
        resetSessionDraftRepositoryForTests();
        expect(readNewSessionDraftFromRepository({ scope: lifetime.scope, draftId: result.draftId })).toMatchObject({ sessionName: 'My Happier', input: 'My question' });
        expect(f.boundary.list()).toHaveLength(1);
        expect(navigation.push).toHaveBeenCalledTimes(1);
        expect(f.requests.some(request => request.path.includes('/sessions') && request.method === 'POST')).toBe(false);
    });

    it('keeps a successfully stored guide but cannot seed or navigate after its Account retires', async () => {
        const { home: f, lifetime, executeAction } = await prepare();
        f.boundary.afterNextCreate(async () => retireActiveServerAccountScopeLifetime());
        const result = await openAskHappierDraft({ lifetime, executeAction });
        expect(result.kind).toBe('stale');
        expect(f.boundary.list()).toHaveLength(1);
        expect(navigation.push).not.toHaveBeenCalled();
    });

    it('reports a guide failure and opens a document-free ordinary Bot only after the explicit blank choice', async () => {
        const { home: f, lifetime, executeAction } = await prepare(async (path, init) => path === '/v1/artifacts' && init?.method === 'POST'
            ? Response.json({ error: 'unavailable' }, { status: 503 }) : null);
        expect(await openAskHappierDraft({ lifetime, executeAction })).toMatchObject({ kind: 'documentUnavailable', guideRef: null });
        expect(navigation.push).not.toHaveBeenCalled();
        expect(f.boundary.list()).toEqual([]);
        const blank = await openBlankAskHappierDraft(lifetime, executeAction);
        if (blank.kind !== 'opened') throw new Error('Expected explicit blank draft');
        expect(readNewSessionDraftFromRepository({ scope: lifetime.scope, draftId: blank.draftId })).toMatchObject({ input: '', sessionName: 'Happier' });
        expect(readNewSessionDraftFromRepository({ scope: lifetime.scope, draftId: blank.draftId })?.promptStack ?? []).toEqual([]);
        expect(f.boundary.list()).toEqual([]);
    });

    it('retains the created reference and canonical draft after navigation fails', async () => {
        const { home: f, lifetime, executeAction } = await prepare();
        navigation.push.mockImplementation(() => { throw new Error('Router unavailable'); });
        const result = await openAskHappierDraft({ lifetime, executeAction });
        expect(result).toMatchObject({ kind: 'unavailable', reason: 'navigation_unavailable', guideRef: { artifactId: expect.any(String) } });
        const route = navigation.push.mock.calls[0]?.[0] as { params: { draftId: string } };
        expect(readNewSessionDraftFromRepository({ scope: lifetime.scope, draftId: route.params.draftId })).toMatchObject({ sessionName: 'Happier', promptStack: [{ ref: result.guideRef }] });
        expect(f.boundary.list()).toHaveLength(1);
        expect(navigation.push).toHaveBeenCalledTimes(1);
        if (!result.guideRef) throw new Error('Expected reusable acknowledged guide');
        expect(decodePlainArtifactStoredContent(f.boundary.read(result.guideRef.artifactId)!.header)).toMatchObject({ kind: 'prompt_doc.v2' });
        navigation.push.mockReset();
        const retried = await openAskHappierDraft({ lifetime, executeAction, guideRef: result.guideRef });
        expect(retried.kind).toBe('opened');
        expect(retried.guideRef).toEqual(result.guideRef);
        expect(f.boundary.list()).toHaveLength(1);
        expect(navigation.push).toHaveBeenCalledTimes(1);
    });
});
