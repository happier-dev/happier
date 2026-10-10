import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit/hooks/renderHook';
import { standardCleanup } from '@/dev/testkit/cleanup/standardCleanup';
import { decideApprovalAsInbox } from '@/dev/testkit/harness/approvalInbox';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { createPlainArtifactHomeFixture } from '@/dev/testkit/harness/artifactStoreBoundary';
import { createPromptLibraryCatalogBoundary } from '@/dev/testkit/harness/promptLibraryCatalogBoundary';
import { readNewSessionDraftFromRepository, writeNewSessionDraftToRepository } from '@/components/sessions/composer/newSessionDraftRepositoryAdapter';
import { resetSessionDraftRepositoryForTests } from '@/sync/ops/sessionDrafts/sessionDraftRepository';
import { captureActiveServerAccountScopeLifetime, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { decodePlainArtifactStoredContent } from '@happier-dev/protocol/storage/artifactStoredContent';
import { openAskHappierDraft, openBlankAskHappierDraft } from './happierGuideDraft';
import { openNewBotDraft } from './newBotDraft';

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ router: { push: navigation.push } }).module;
});
vi.mock('@react-navigation/native', async () =>
    (await import('@/dev/testkit/mocks/reactNavigation')).createReactNavigationNativeMock());
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async importOriginal => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    return { ...original, createFrontDoorActionExecute:
        (await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary')).createFrontDoorActionExecuteForVitest(original) };
});
let home: Awaited<ReturnType<typeof createPlainArtifactHomeFixture>> | undefined;
afterEach(() => {
    standardCleanup();
    home?.dispose(); home = undefined;
    resetSessionDraftRepositoryForTests();
    navigation.push.mockReset();
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
    return { home, lifetime };
}

describe('Ask Happier ordinary authoring', () => {
    it('refuses authenticated authoring without its mounted approval custodian before creating a document or draft', async () => {
        const { home: f, lifetime } = await prepare();
        expect(await openAskHappierDraft({ lifetime })).toMatchObject({ kind: 'unavailable', reason: 'client_unavailable', guideRef: null });
        expect(await openNewBotDraft(lifetime)).toMatchObject({ kind: 'unavailable', reason: 'client_unavailable' });
        expect(await openBlankAskHappierDraft(lifetime)).toMatchObject({ kind: 'unavailable', reason: 'client_unavailable' });
        expect(f.boundary.list()).toEqual([]);
        expect(navigation.push).not.toHaveBeenCalled();
    });

    it('keeps the original guide invocation pending until its admitted approval creates the document, then opens the draft once', async () => {
        const { home: f, lifetime } = await prepare(async path => path === '/v2/account/settings'
            ? Response.json({ version: 1, content: { t: 'plain', v: { actionsSettingsV1: { v: 1,
                actions: { 'prompt_doc.create': { approvalRequiredSurfaces: ['ui'] } } } } } }) : null);
        const hook = await renderHook(() => useMountedActionExecution(lifetime.scope));
        await expect.poll(() => hook.getCurrent().ready).toBe(true);
        let settled = false;
        const pending = openAskHappierDraft({ lifetime, executeAction: hook.getCurrent().execute })
            .then(result => { settled = true; return result; });
        await expect.poll(() => f.boundary.list().length).toBe(1);
        const approval = f.boundary.list()[0]!;
        expect(decodePlainArtifactStoredContent(approval.header)).toMatchObject({ approvalStatus: 'open' });
        expect(settled).toBe(false);
        expect(navigation.push).not.toHaveBeenCalled();
        expect(await decideApprovalAsInbox(lifetime.scope.serverId, approval.id, 'approve')).toMatchObject({ ok: true });
        await act(async () => { await hook.getCurrent().approval.refresh(); });
        const result = await pending;
        expect(result.kind).toBe('opened');
        expect(result.guideRef?.artifactId).not.toBe(approval.id);
        expect(f.boundary.list()).toHaveLength(2);
        expect(navigation.push).toHaveBeenCalledTimes(1);
    });

    it.each(['session.authoring.open', 'prompt_doc.create'] as const)('retains custody when %s is disabled in the UI', async actionId => {
        const { home: f, lifetime } = await prepare(async path => path === '/v2/account/settings'
            ? Response.json({ version: 1, content: { t: 'plain', v: { actionsSettingsV1: { v: 1,
                actions: { [actionId]: { disabledSurfaces: ['ui'] } } } } } }) : null);
        const result = await openAskHappierDraft({ lifetime });
        expect(result.kind).not.toBe('opened');
        expect(navigation.push).not.toHaveBeenCalled();
        expect(f.boundary.list()).toHaveLength(actionId === 'prompt_doc.create' ? 0 : 1);
        if (actionId === 'session.authoring.open') expect(result.guideRef?.artifactId).toBe(f.boundary.list()[0]?.id);
        expect((await openNewBotDraft(lifetime)).kind).toBe(actionId === 'session.authoring.open' ? 'unavailable' : 'opened');
    });

    it('cancels mounted interest in a pending guide approval without creating a document or substituting a blank draft', async () => {
        const { home: f, lifetime } = await prepare(async path => path === '/v2/account/settings'
            ? Response.json({ version: 1, content: { t: 'plain', v: { actionsSettingsV1: { v: 1,
                actions: { 'prompt_doc.create': { approvalRequiredSurfaces: ['ui'] } } } } } }) : null);
        const hook = await renderHook(() => useMountedActionExecution(lifetime.scope));
        await expect.poll(() => hook.getCurrent().ready).toBe(true);
        const controller = new AbortController();
        const pending = openAskHappierDraft({ lifetime, signal: controller.signal, executeAction: hook.getCurrent().execute });
        await expect.poll(() => hook.getCurrent().approval.approvalPending).toBe(true);
        await act(async () => { controller.abort(); });
        expect(await pending).toMatchObject({ kind: 'unavailable', reason: 'aborted', guideRef: null });
        expect(f.boundary.list()).toHaveLength(1);
        expect(decodePlainArtifactStoredContent(f.boundary.list()[0]!.header)).toMatchObject({ approvalStatus: 'open' });
        expect(navigation.push).not.toHaveBeenCalled();
    });

    it('creates one editable built-in guide and binds captured update/context to a durable Bot draft before navigation', async () => {
        const { home: f, lifetime } = await prepare();
        const release = { id: 'selected', versionLabel: 'v1', date: '2026-10-09', markdown: 'Selected notes' };
        const currentUiContext = { navigation: { area: 'settings', screen: 'machines' }, commands: [] };
        expect(f.boundary.list()).toEqual([]);
        let atNavigation: ReturnType<typeof readNewSessionDraftFromRepository> = null;
        navigation.push.mockImplementation((route: { params: { draftId: string } }) => {
            atNavigation = readNewSessionDraftFromRepository({ scope: lifetime.scope, draftId: route.params.draftId });
        });
        const pending = openAskHappierDraft({ lifetime, context: { kind: 'release', release }, currentUiContext });
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
        expect(draft?.input).toContain('machines');
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
        const { home: f, lifetime } = await prepare();
        f.boundary.afterNextCreate(async () => retireActiveServerAccountScopeLifetime());
        const result = await openAskHappierDraft({ lifetime });
        expect(result.kind).toBe('stale');
        expect(f.boundary.list()).toHaveLength(1);
        expect(navigation.push).not.toHaveBeenCalled();
    });

    it('reports a guide failure and opens a document-free ordinary Bot only after the explicit blank choice', async () => {
        const { home: f, lifetime } = await prepare(async (path, init) => path === '/v1/artifacts' && init?.method === 'POST'
            ? Response.json({ error: 'unavailable' }, { status: 503 }) : null);
        expect(await openAskHappierDraft({ lifetime })).toMatchObject({ kind: 'documentUnavailable', guideRef: null });
        expect(navigation.push).not.toHaveBeenCalled();
        expect(f.boundary.list()).toEqual([]);
        const blank = await openBlankAskHappierDraft(lifetime);
        if (blank.kind !== 'opened') throw new Error('Expected explicit blank draft');
        expect(readNewSessionDraftFromRepository({ scope: lifetime.scope, draftId: blank.draftId })).toMatchObject({ input: '', sessionName: 'Happier' });
        expect(readNewSessionDraftFromRepository({ scope: lifetime.scope, draftId: blank.draftId })?.promptStack ?? []).toEqual([]);
        expect(f.boundary.list()).toEqual([]);
    });

    it('retains the created reference and canonical draft after navigation fails', async () => {
        const { home: f, lifetime } = await prepare();
        navigation.push.mockImplementation(() => { throw new Error('Router unavailable'); });
        const result = await openAskHappierDraft({ lifetime });
        expect(result).toMatchObject({ kind: 'unavailable', reason: 'navigation_unavailable', guideRef: { artifactId: f.boundary.list()[0]?.id } });
        const route = navigation.push.mock.calls[0]?.[0] as { params: { draftId: string } };
        expect(readNewSessionDraftFromRepository({ scope: lifetime.scope, draftId: route.params.draftId })).toMatchObject({ sessionName: 'Happier', promptStack: [{ ref: result.guideRef }] });
        expect(f.boundary.list()).toHaveLength(1);
        expect(navigation.push).toHaveBeenCalledTimes(1);
        if (!result.guideRef) throw new Error('Expected reusable acknowledged guide');
        navigation.push.mockReset();
        const retried = await openAskHappierDraft({ lifetime, guideRef: result.guideRef });
        expect(retried.kind).toBe('opened');
        expect(f.boundary.list()).toHaveLength(1);
        expect(navigation.push).toHaveBeenCalledTimes(1);
    });
});
