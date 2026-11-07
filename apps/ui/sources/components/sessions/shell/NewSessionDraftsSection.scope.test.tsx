import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol';
import {
    createSessionDraftPrivatePayloadV2, NewSessionDraftDocumentV2Schema,
    SESSION_DRAFT_V2_ROUTE_LIST, SESSION_DRAFT_V2_ROUTE_READ, SESSION_DRAFT_V2_ROUTE_MUTATE,
    SessionDraftMutateRequestV2Schema, SessionDraftReadRequestV2Schema,
    type SessionDraftRecordV2,
} from '@happier-dev/protocol/drafts/sessionDraftsV2';
import { SESSION_DRAFT_ROUTE_MUTATE } from '@happier-dev/protocol/drafts/sessionDrafts';
import { createDeferred, flushHookEffects, renderScreen, standardCleanup, type RenderScreenResult } from '@/dev/testkit';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { FocusReturnProvider } from '@/keyboard/focusReturn';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { settingsParse } from '@/sync/domains/settings/settings';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';

const navigation = vi.hoisted(() => ({ pushes: [] as unknown[] }));
vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('socket.io-client', async (importOriginal) => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
vi.mock('@/modal', async () => (await import('@/dev/testkit/mocks/modal')).createModalModuleMock({ confirmResult: true }).module);
vi.mock('@expo/vector-icons', async () => (await import('@/dev/testkit/mocks/icons')).createExpoVectorIconsMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock({ router: { push: (route: unknown) => navigation.pushes.push(route) } }).module);
vi.mock('@/sync/ops/actions/frontDoorRuntimeActionExecutor', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/ops/actions/frontDoorRuntimeActionExecutor')>();
    const { createFrontDoorActionExecuteForVitest } = await import('@/dev/testkit/harness/frontDoorActionExecutorBoundary');
    // Substitute the Metro module-loading boundary, not Action admission or execution.
    return { ...original, createFrontDoorActionExecute: createFrontDoorActionExecuteForVitest(original) };
});
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();
const { createSecretSettingsTestHarness } = await import('@/components/settings/secrets/secretSettingsTestHarness');
const { TokenStorage } = await import('@/auth/storage/tokenStorage');
const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
const { setActiveServer, upsertServerProfileOnly } = await import('@/sync/domains/server/serverRuntime');
const { disconnectActiveServerConnection, switchConnectionToActiveServer } = await import('@/sync/runtime/orchestration/connectionManager');
const { getSessionDraftPersistenceStorage } = await import('@/sync/ops/sessionDrafts/sessionDraftPersistenceStorage');
const { getSessionDraftSnapshot, resetSessionDraftRepositoryForTests, writeNewSessionDraft } = await import('@/sync/ops/sessionDrafts/sessionDraftRepository');
const { resolveServerCredentialAccountScope } = await import('@/sync/domains/scope/serverCredentialAccountScope');
const { resolveRuntimeFeatureDecisionOrThrow } = await import('@/sync/domains/features/featureDecisionInputs');
const { NewSessionDraftsSection, NewSessionDraftsSectionView, buildNewSessionDraftContinueRoute } = await import('./NewSessionDraftsSection');
const fixtureCleanups = new Set<() => Promise<void>>();
afterEach(async () => {
    standardCleanup();
    for (const dispose of fixtureCleanups) await dispose();
    resetSessionDraftRepositoryForTests(); navigation.pushes.length = 0;
});

const activeDraftId = '00000000-0000-4000-8000-000000000101';
const waitingDraftId = '00000000-0000-4000-8000-000000000102';
const ordinaryDraftId = '00000000-0000-4000-8000-000000000103';
const selectedDraftId = '00000000-0000-4000-8000-000000000104';

function remoteRecord(draftId: string, serverId: string, kind: 'ordinary' | 'selected' | 'waiting'): SessionDraftRecordV2 {
    const address = { kind: 'newSession' as const, draftId };
    const document = NewSessionDraftDocumentV2Schema.parse({
        v: 2, target: { kind: 'newSession', authoring: kind === 'ordinary' ? {} : {
            executionTarget: { mutationId: crypto.randomUUID(), value: { kind: 'temporary_computer', serverId,
                artifactTarget: 'linux-x64', workspace: { kind: 'choose_on_endpoint' } } },
            ...(kind === 'waiting' ? { temporaryComputerActivationRef: { mutationId: crypto.randomUUID(), value: {
                v: 1, activationId: '00000000-0000-4000-8000-000000000199', createdOnDeviceLabel: 'Test computer',
            } } } : {}),
        } }, composer: { text: { mutationId: crypto.randomUUID(), value: `Saved ${kind} draft` },
            mentions: { mutationId: crypto.randomUUID(), value: [] }, attachments: { mutationId: crypto.randomUUID(), value: [] } }, extensions: {},
    });
    return { address, revision: 1, content: { t: 'plain', v: createSessionDraftPrivatePayloadV2(address, document) }, createdAt: 1, updatedAt: 1 };
}

async function createScopeFixture() {
    const persistence = getSessionDraftPersistenceStorage();
    if ('prepare' in persistence) await persistence.prepare();
    const features = createRootLayoutFeaturesResponse();
    if (!tryWriteServerEnabledBitInPlace(features, 'sessions.drafts', true)) throw new Error('Draft feature fixture unavailable');
    const account = await createSecretSettingsTestHarness({ features, settings: settingsParse({}) });
    const activeHome = getServerProfileById(account.scope.serverId)!;
    const otherHome = await upsertServerProfileOnly({ serverUrl: `https://draft-scope-${crypto.randomUUID()}.example.test`, name: 'Other Home' });
    const otherScope = { serverId: otherHome.id, accountId: 'account-b' };
    const otherCredentials = { token: `e30.${Buffer.from(JSON.stringify({ sub: otherScope.accountId })).toString('base64url')}.signature` };
    let otherSignedIn = true;
    const credentialBoundary = vi.spyOn(TokenStorage, 'getCredentialsForServerUrl').mockImplementation(async url => {
        const origin = new URL(url).origin;
        return origin === new URL(activeHome.serverUrl).origin ? account.credentials
            : origin === new URL(otherHome.serverUrl).origin && otherSignedIn ? otherCredentials : null;
    });
    const records = new Map<string, SessionDraftRecordV2>();
    const requests: Array<Readonly<{ origin: string; path: string; authorization: string | null; body?: unknown }>> = [];
    let listGate: Promise<void> | undefined;
    let deleteGate: Promise<void> | undefined;
    let rejectDelete = false;
    let endpointUnavailable = false;
    setRuntimeFetch(async (url, init) => {
        const parsed = new URL(String(url));
        const path = parsed.pathname;
        const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
        requests.push({ origin: parsed.origin, path, authorization: new Headers(init?.headers).get('Authorization'), body });
        if (parsed.origin === new URL(otherHome.serverUrl).origin && endpointUnavailable) return new Response('{}', { status: 503 });
        // Preserve the authenticated-carrier HTTP boundary installed by Account restoration.
        if (path === '/v1/auth/ping' || path === '/health') return new Response('{}', { status: 200 });
        if (parsed.origin !== new URL(otherHome.serverUrl).origin) return account.request(url, init);
        if (path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: otherScope.accountId }));
        if (path === SESSION_DRAFT_V2_ROUTE_LIST) {
            if (listGate) await listGate;
            return Response.json({ items: [...records.values()] });
        }
        if (path === SESSION_DRAFT_V2_ROUTE_READ) {
            const input = SessionDraftReadRequestV2Schema.parse(body);
            const record = input.address.kind === 'newSession' ? records.get(input.address.draftId) : undefined;
            return Response.json(record ? { status: record.content ? 'present' : 'deleted', record } : { status: 'absent' });
        }
        if (path === SESSION_DRAFT_V2_ROUTE_MUTATE || path === SESSION_DRAFT_ROUTE_MUTATE) {
            const input = SessionDraftMutateRequestV2Schema.parse(body);
            const current = input.address.kind === 'newSession' ? records.get(input.address.draftId) : undefined;
            if (deleteGate) await deleteGate;
            if (rejectDelete || input.expectedRevision !== current?.revision) return Response.json({ status: 'conflict', current: current ?? { status: 'absent' } });
            if (!current) return Response.json({ status: 'conflict', current: { status: 'absent' } });
            const record = { ...current, revision: current.revision + 1, content: input.content, updatedAt: current.updatedAt + 1 };
            records.set(input.address.kind === 'newSession' ? input.address.draftId : '', record);
            return Response.json({ status: 'updated', record });
        }
        return account.request(url, init);
    });
    writeNewSessionDraft({ scope: account.scope, draftId: activeDraftId, materializationIntent: 'userEdit', patch: { text: 'Active Home prompt' } });
    const dispose = async () => {
        fixtureCleanups.delete(dispose);
        standardCleanup(); credentialBoundary.mockRestore(); await account.dispose();
    };
    fixtureCleanups.add(dispose);
    expect(await resolveServerCredentialAccountScope(otherHome.id)).toMatchObject({ kind: 'bound', scope: otherScope });
    const draftFeature = await resolveRuntimeFeatureDecisionOrThrow({ featureId: 'sessions.drafts', serverId: otherHome.id, force: true });
    expect(draftFeature, JSON.stringify(draftFeature)).toMatchObject({ state: 'enabled' });
    return {
        account, activeHome, otherHome, otherScope, records, requests,
        add(kind: 'ordinary' | 'selected' | 'waiting', draftId = waitingDraftId) { records.set(draftId, remoteRecord(draftId, otherHome.id, kind)); },
        setOtherSignedIn(value: boolean) { otherSignedIn = value; },
        holdList(value: Promise<void>) { listGate = value; },
        holdDelete(value: Promise<void>) { deleteGate = value; },
        rejectDelete() { rejectDelete = true; },
        makeEndpointUnavailable() { endpointUnavailable = true; },
        async focusOtherHome() { otherSignedIn = true; await setActiveServer({ serverId: otherHome.id }); await switchConnectionToActiveServer(); },
        async mount() { return renderScreen(<FocusReturnProvider><NewSessionDraftsSection /></FocusReturnProvider>); },
        dispose,
    };
}

function sectionForOtherHome(screen: RenderScreenResult, serverId: string) {
    const section = screen.findAllByType(NewSessionDraftsSectionView).find(node => node.props.rowScope?.serverId === serverId);
    if (!section) throw new Error('Inactive Home draft section missing');
    return section;
}
const rowId = (draftId: string) => `session-draft-row:new-session:${draftId}`;
const draftMutations = (fixture: Awaited<ReturnType<typeof createScopeFixture>>) => fixture.requests.filter(request =>
    request.path === SESSION_DRAFT_V2_ROUTE_MUTATE || request.path === SESSION_DRAFT_ROUTE_MUTATE);

it('subscribes only to the focused Home and replaces its rows when focus moves', async () => {
    const fixture = await createScopeFixture();
    fixture.setOtherSignedIn(false);
    writeNewSessionDraft({ scope: fixture.otherScope, draftId: ordinaryDraftId, materializationIntent: 'userEdit', patch: { text: 'Other Home prompt' } });
    try {
        const screen = await fixture.mount();
        expect(screen.findByTestId(rowId(activeDraftId))).not.toBeNull();
        expect(screen.findByTestId(rowId(ordinaryDraftId))).toBeNull();
        // Focused Sync hydrates its own drafts independently of this section.
        // A signed-out inactive Home must not acquire a draft-list request.
        expect(fixture.requests.some(request => request.path === SESSION_DRAFT_V2_ROUTE_LIST
            && request.origin === new URL(fixture.otherHome.serverUrl).origin)).toBe(false);
        await act(async () => { await fixture.focusOtherHome(); });
        await vi.waitFor(() => expect(screen.findByTestId(rowId(ordinaryDraftId))).not.toBeNull());
        expect(screen.findByTestId(rowId(activeDraftId))).toBeNull();
    } finally { await fixture.dispose(); }
});

it('keeps another Home’s waiting Temporary-computer request discoverable and exactly scoped', async () => {
    const fixture = await createScopeFixture();
    fixture.add('ordinary', ordinaryDraftId); fixture.add('selected', selectedDraftId); fixture.add('waiting');
    try {
        const screen = await fixture.mount();
        await vi.waitFor(() => expect(screen.findByTestId(rowId(waitingDraftId))).not.toBeNull());
        expect(screen.findByTestId(rowId(ordinaryDraftId))).toBeNull();
        expect(screen.findByTestId(rowId(selectedDraftId))).toBeNull();
        expect(screen.findByTestId(`session-drafts-waiting-section:${fixture.otherScope.serverId}:${fixture.otherScope.accountId}`)).not.toBeNull();
        const reads = fixture.requests.filter(request => request.path === SESSION_DRAFT_V2_ROUTE_LIST
            && request.origin === new URL(fixture.otherHome.serverUrl).origin);
        expect(reads.length).toBeGreaterThan(0);
        expect(reads.every(request =>
            request.authorization === `Bearer e30.${Buffer.from(JSON.stringify({ sub: 'account-b' })).toString('base64url')}.signature`)).toBe(true);
    } finally { await fixture.dispose(); }
});

it('binds a cross-Home waiting row’s continue and delete to that row’s exact scope', async () => {
    const fixture = await createScopeFixture(); fixture.add('waiting');
    try {
        const screen = await fixture.mount();
        await vi.waitFor(() => expect(screen.findByTestId(rowId(waitingDraftId))).not.toBeNull());
        await act(async () => screen.findByTestId(rowId(waitingDraftId))!.props.onPress());
        await vi.waitFor(() => expect(navigation.pushes).toEqual([buildNewSessionDraftContinueRoute(waitingDraftId, fixture.otherScope)]));
    } finally { await fixture.dispose(); }
});

it('removes only the acknowledged inactive-Home draft through that row scope', async () => {
    const fixture = await createScopeFixture(); fixture.add('waiting');
    try {
        const screen = await fixture.mount();
        await vi.waitFor(() => expect(screen.findByTestId(rowId(waitingDraftId))).not.toBeNull());
        await act(async () => { expect(await sectionForOtherHome(screen, fixture.otherHome.id).props.onDelete(waitingDraftId, fixture.otherScope)).toBe(true); });
        expect(screen.findByTestId(rowId(waitingDraftId))).toBeNull();
        expect(screen.findByTestId(rowId(activeDraftId))).not.toBeNull();
        expect(draftMutations(fixture).map(request => [request.origin, request.body])).toEqual([[new URL(fixture.otherHome.serverUrl).origin,
            { address: { kind: 'newSession', draftId: waitingDraftId }, expectedRevision: 1, content: null }]]);
    } finally { await fixture.dispose(); }
});

it('keeps the inactive-Home waiting row when its authoritative delete is rejected', async () => {
    const fixture = await createScopeFixture(); fixture.add('waiting'); fixture.rejectDelete();
    try {
        const screen = await fixture.mount();
        await vi.waitFor(() => expect(screen.findByTestId(rowId(waitingDraftId))).not.toBeNull());
        await act(async () => { expect(await sectionForOtherHome(screen, fixture.otherHome.id).props.onDelete(waitingDraftId, fixture.otherScope)).toBe(false); });
        expect(screen.findByTestId(rowId(waitingDraftId))).not.toBeNull();
        expect(getSessionDraftSnapshot(fixture.otherScope, { kind: 'newSession', draftId: waitingDraftId })).not.toBeNull();
    } finally { await fixture.dispose(); }
});

it('never falls back to the active repository when an inactive Home endpoint is unavailable', async () => {
    const fixture = await createScopeFixture(); fixture.add('waiting');
    try {
        const screen = await fixture.mount();
        await vi.waitFor(() => expect(screen.findByTestId(rowId(waitingDraftId))).not.toBeNull());
        fixture.makeEndpointUnavailable();
        fixture.requests.length = 0;
        const { Modal } = await import('@/modal');
        const alert = vi.spyOn(Modal, 'alert');
        const deletion: Promise<unknown> = sectionForOtherHome(screen, fixture.otherHome.id).props.onDelete(waitingDraftId, fixture.otherScope);
        await vi.waitFor(() => expect(fixture.requests.some(request => request.origin === new URL(fixture.otherHome.serverUrl).origin)).toBe(true));
        expect(screen.findByTestId(rowId(waitingDraftId))).not.toBeNull();
        expect(draftMutations(fixture).every(request => request.origin === new URL(fixture.otherHome.serverUrl).origin)).toBe(true);
        expect(getSessionDraftSnapshot(fixture.account.scope, { kind: 'newSession', draftId: activeDraftId })).not.toBeNull();
        // The genuine Account-mode HTTP failure is told to the person once (D13), not rewritten to
        // a successful delete or retried against the focused Home.
        expect(await deletion).toBe(false);
        expect(alert).toHaveBeenCalledTimes(1);
    } finally { await fixture.dispose(); }
});

it('publishes and removes nothing after the inactive-Home section retires', async () => {
    const fixture = await createScopeFixture(); fixture.add('waiting');
    const gate = createDeferred<void>(); fixture.holdList(gate.promise);
    try {
        const screen = await fixture.mount();
        await vi.waitFor(() => expect(fixture.requests.some(request => request.path === SESSION_DRAFT_V2_ROUTE_LIST)).toBe(true));
        await screen.unmount(); gate.resolve(); await flushHookEffects();
        expect(getSessionDraftSnapshot(fixture.otherScope, { kind: 'newSession', draftId: waitingDraftId })).toBeNull();
        expect(draftMutations(fixture)).toEqual([]);
    } finally { gate.resolve(); await fixture.dispose(); }
});

it('does not remove a waiting row when the section retires before delete responds', async () => {
    const fixture = await createScopeFixture(); fixture.add('waiting');
    const gate = createDeferred<void>(); fixture.holdDelete(gate.promise);
    try {
        const screen = await fixture.mount();
        await vi.waitFor(() => expect(screen.findByTestId(rowId(waitingDraftId))).not.toBeNull());
        const deletion: Promise<boolean> = sectionForOtherHome(screen, fixture.otherHome.id).props.onDelete(waitingDraftId, fixture.otherScope);
        await vi.waitFor(() => expect(draftMutations(fixture)).toHaveLength(1));
        await screen.unmount(); gate.resolve();
        expect(await deletion).toBe(false);
        expect(getSessionDraftSnapshot(fixture.otherScope, { kind: 'newSession', draftId: waitingDraftId })).not.toBeNull();
    } finally { gate.resolve(); await fixture.dispose(); }
});

it('renders nothing until a focused Home Account scope exists', async () => {
    const fixture = await createScopeFixture();
    try {
        await disconnectActiveServerConnection();
        const screen = await fixture.mount();
        expect(screen.findByTestId('session-drafts-section')).toBeNull();
    } finally { await fixture.dispose(); }
});
