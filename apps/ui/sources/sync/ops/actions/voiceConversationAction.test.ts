/** @vitest-environment jsdom */
import 'fake-indexeddb/auto';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const platformBoundary = vi.hoisted(() => ({ os: 'web', openSettings: vi.fn(async () => undefined) }));
const nativeCredentialValues = vi.hoisted(() => new Map<string, string>());
// Native credentials use the OS keychain, separate from the browser storage installed by the Home harness.
vi.mock('expo-secure-store', () => ({
    getItemAsync: async (key: string) => nativeCredentialValues.get(key) ?? null,
    setItemAsync: async (key: string, value: string) => { nativeCredentialValues.set(key, value); },
    deleteItemAsync: async (key: string) => { nativeCredentialValues.delete(key); },
}));

vi.mock('react-native', async () => {
    const { getVitestNodeBuiltin } = await import('@/dev/vitestNodeBuiltins');
    const { createRequire } = getVitestNodeBuiltin<Pick<typeof import('node:module'), 'createRequire'>>('node:module');
    // Use the real installed browser renderer; the package-name entry is a Node shim.
    const actual = await vi.importActual<typeof import('react-native')>(createRequire(import.meta.url).resolve('react-native-web'));
    return { ...actual, Platform: { ...actual.Platform, get OS() { return platformBoundary.os; } },
        Linking: { ...actual.Linking, openSettings: platformBoundary.openSettings } };
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('expo-router', async () => (await import('@/dev/testkit/mocks/router')).createExpoRouterMock().module);
vi.mock('@/components/ui/popover', async original =>
    (await import('@/dev/testkit/mocks/popover')).createInlinePopoverModuleMock(original));
vi.mock('react-native-reanimated', async () =>
    (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock({ settleTimingCallbacks: true }));

import { createVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleController';
import { publishCommittedAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { setVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleControllerStore';
import { getVoiceSessionAttemptId, getVoiceSessionPresentedAttemptId, resetVoiceSessionRuntimeStateForTests, setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import { registerVoiceAdapters } from '@/voice/session/voiceAdapterRegistry';
import { createVoiceCaptureAdmissionController } from '@/voice/runtime/input/VoiceCaptureAdmissionController';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { storage } from '@/sync/domains/state/storage';
import { createActionExecutor, createPlainSessionOwnerMetadataEnvelopeV1, createSessionOwnerMetadataV1, FeaturesResponseSchema,
    projectSessionSharedMetadataV1, VoiceConversationActionOutputSchemas } from '@happier-dev/protocol';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { primeServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { executeVoiceConversationAction } from './voiceConversationAction';
import { serveActionHomes } from '@/dev/testkit/harness/actionHomesHttpHarness';
import { createDeferred, createSessionFixture, createSessionListRenderableSessionFixture, pressTestInstanceAsync, renderScreen, standardCleanup, type RenderScreenResult } from '@/dev/testkit';
import { getFocusedSessionAddress, setFocusedSessionId } from '@/sync/domains/session/sessionSurfaceVisibility';
import { createSessionActionTarget } from '@/components/sessions/actions/sessionActionContext';
import { executeSessionAction } from '@/components/sessions/actions/sessionActionExecution';
import { installVoiceWebRtcBrowserBoundary } from '@/dev/testkit/harness/voiceWebRtcHarness';
import { answerVoiceRealtimePreparationHttpRequest } from '@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { createSessionReadBatchHttpBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createConnectedPurposeCatalogHttpBoundary } from '@/dev/testkit/harness/connectedAccountCatalogBoundary';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createRecipientContractDigestV1 } from '@happier-dev/protocol/plugins/recipientContractV1';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import { applyAccountVoiceCredentialSourceSelection, saveAndUseAccountVoiceCredential } from '@/voice/credentials/accountVoiceCredential';
import { createAccountVoiceOperationService } from '@/voice/credentials/accountVoiceOperationService';
import { createBundledConversationRuntimeHostLease, getCurrentBundledConversationRuntimeHost } from '@/voice/registry/bundledConversationRuntimeHost';
import { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } from '@/voice/registry/generatedBundledVoiceRuntimeEntries';
import { createExternalVoiceProviderActivationScope } from '@/voice/registry/externalVoiceProviderActivation.testkit';
import { getExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import { OPENAI_REALTIME_DEFAULT_SETTINGS } from '../../../../../../packages/plugins/openai/src/protocol/voice/settings';
import { writeVoiceProviderSettingsConfig } from '@/sync/domains/settings/voiceSettings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { buildVoiceTranscriptHistorySessionMetadata } from '@/voice/persistence/voiceTranscriptHistorySession';
import { resolveDeviceLocalSettingsSecretsKey } from '@/auth/storage/deviceLocalSecretKey';
import { assertNoUnsealedSettingsSecretValues, sealSecretsDeep } from '@/sync/encryption/secretSettings';
import { installLocalStorageMock, installWebLockManagerMock } from '@/auth/storage/tokenStorage.web.testHelpers';
import { createArtifactStoreBoundary } from '@/dev/testkit/harness/artifactStoreBoundary';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { ActionApprovalRequestCreatedResultSchema } from '@happier-dev/protocol/actions/actionExecutionResult';

vi.mock('socket.io-client', async original => (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(original));
vi.mock('expo-audio', () => ({ AudioModule: { setAudioModeAsync: vi.fn(async () => undefined) } }));
installDisconnectedServerSocketBoundary();
await loadSyncSingletonForTests();

// Supply only the human confirmation outcome; keep alert presentation real.
beforeEach(async () => { const { Modal } = await import('@/modal'); vi.spyOn(Modal, 'confirm').mockResolvedValue(true); });

const runtimeCleanup: Array<() => Promise<void>> = [];
let homeFixtureOrdinal = 0;
async function pressVoiceControl(screen: RenderScreenResult, testID: string) {
    // Use RN's public onPress port; the installed browser adapter's onClick expects a DOM event.
    await pressTestInstanceAsync(screen.findAllByTestId(testID).find(node => typeof node.props.onPress === 'function'), testID);
}
afterEach(async () => { await standardCleanup(); await resetVoiceSessionRuntimeStateForTests();
    platformBoundary.os = 'web';
    for (const cleanup of runtimeCleanup.splice(0).reverse()) await cleanup();
    resetServerFeaturesClientForTests(); vi.restoreAllMocks(); });

async function createHarness(start = true, featureEnabled = true, deferActivation = false) {
    // Account settings persistence outlives a mounted fixture. Distinct external
    // Home inputs keep each case's versioned bootstrap independent.
    const fixtureOrdinal = ++homeFixtureOrdinal;
    const previousState = storage.getState();
    const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(value => value.pluginId === 'happier.voice.openai');
    if (!entry) throw new Error('Missing generated OpenAI contribution');
    const recipientContract = createBundledVoiceRecipientContract({ pluginId: entry.pluginId, declaration: entry.declaration });
    if (!recipientContract) throw new Error('Missing generated OpenAI recipient contract');
    const purposes = createConnectedPurposeCatalogHttpBoundary();
    const artifacts = createArtifactStoreBoundary({ ownerAccountId: () => 'voice-action-account', encryptionMode: 'plain' });
    const browser = installVoiceWebRtcBrowserBoundary({ onCreatePeer(peer) {
        // Browser readiness belongs to each actual newly constructed SDK peer.
        peer.setRemoteDescription.mockImplementation(async () => { peer.channel.open(); });
    } });
    const browserLocks = installWebLockManagerMock();
    const deviceStorage = installLocalStorageMock();
    runtimeCleanup.push(async () => { deviceStorage.restore(); browserLocks.restore(); browser.restore(); storage.setState(previousState, true); });
    const contribution = { pluginId: entry.pluginId, localId: entry.declaration.id };
    const voice = writeVoiceProviderSettingsConfig(previousState.settings.voice, entry.providerId,
        { ...OPENAI_REALTIME_DEFAULT_SETTINGS, turnDetection: 'manual' });
    const saved = saveAndUseAccountVoiceCredential({ settings: { ...previousState.settings,
        voiceSettingsV1: { ...voice, providerId: entry.providerId }, voice: { ...voice, providerId: entry.providerId } },
        contribution, credentialSlotId: recipientContract.credentialSlot.id, expectedSettingsVersion: 1,
        currentDeclaration: entry.declaration, value: 'sk_action_boundary', generateId: () => 'voice-action-secret', now: 1,
        expectedSecretId: null, expectedSecretUpdatedAt: null, approvedRecipientContractDigest: createRecipientContractDigestV1(recipientContract) });
    const selected = applyAccountVoiceCredentialSourceSelection({ settings: saved.settings, connectedPurposes: purposes.value,
        currentDeclaration: entry.declaration, mutation: { contribution, credentialSlotId: recipientContract.credentialSlot.id,
            expectedSettingsVersion: 1, selection: { kind: 'savedSecret' } } });
    purposes.replace(selected.connectedPurposes);
    const features = FeaturesResponseSchema.parse({ features: { voice: { enabled: featureEnabled } }, capabilities: {} });
    let heldFeatureResponse: Readonly<{ entered: ReturnType<typeof createDeferred<void>>; released: ReturnType<typeof createDeferred<void>> }> | null = null;
    const sessionIdsByHome = { voice: ['session-original', 'bot-talk-session', 'other-session', 'voice-action-history'],
        explicit: ['explicit-session'], focused: ['default-session'], competing: ['competing-session'] };
    const sessionsByHome = new Map(Object.entries(sessionIdsByHome).map(([key, ids]) => [key,
        createSessionMetadataHttpBoundary(() => Object.fromEntries(Object.entries(storage.getState().sessions)
            .filter(([id]) => ids.includes(id))))] as const));
    // The plain Home stores clear Account secrets; the device cache seals them
    // with its own key after the real Account lifetime has initialized custody.
    const servedSettings = { ...selected.settings, secrets: selected.settings.secrets.filter(() => false) };
    const home = await serveActionHomes({ homes: [
        ...['explicit', 'focused', 'competing'].map(key => ({ key,
            serverUrl: `https://voice-action-${key}-${fixtureOrdinal}.example.test`, accountId: 'voice-action-account',
            currentAccount: true, settings: servedSettings })),
        { key: 'voice', serverUrl: `https://voice-action-runtime-${fixtureOrdinal}.example.test`,
            accountId: 'voice-action-account', currentAccount: true, settings: servedSettings },
    ], route: createSessionReadBatchHttpBoundary(async request => {
            const artifactResponse = artifacts.handle(request.path, { method: request.method,
                ...(request.body !== undefined ? { body: JSON.stringify(request.body) } : {}) });
            if (artifactResponse) return await artifactResponse;
            const sessions = sessionsByHome.get(request.home);
            if (request.path === '/v1/features') {
                const hold = request.home === 'voice' ? heldFeatureResponse : null;
                if (hold) { hold.entered.resolve(undefined); await hold.released.promise; }
                return Response.json(features);
            }
            if (/^\/v[123]\/sessions\/[^/]+\/messages$/.test(request.path) && request.method === 'GET')
                return Response.json({ messages: [], hasMore: false });
            if (request.path === '/v1/sessions' && request.method === 'POST' && sessions) return sessions.createSessionFromPost('voice-action-history',
                { method: request.method, body: JSON.stringify(request.body) });
            return await purposes.handle(request.url, { method: request.method, body: request.method === 'POST' ? JSON.stringify(request.body) : undefined })
                ?? sessions?.handle(request.url, { method: request.method, body: request.method === 'PATCH' ? JSON.stringify(request.body) : undefined })
                ?? answerVoiceRealtimePreparationHttpRequest(request.url, storage.getState().settings) ?? undefined;
        }).handle });
    runtimeCleanup.push(async () => { await home.dispose(); });
    const disconnect = await home.restoreActiveConnection();
    runtimeCleanup.push(async () => { await disconnect(); });
    const serverId = home.homes.voice!.id;
    const accountScope = { serverId, accountId: 'voice-action-account' };
    const deviceKey = await resolveDeviceLocalSettingsSecretsKey(accountScope);
    if (!deviceKey) throw new Error('Voice Action fixture could not initialize device-local secret custody');
    // This is a real post-bootstrap Settings transition, not a repeated v1 echo.
    for (const key of Object.keys(home.homes)) home.replaceAccountSettings(key, { settings: selected.settings, version: 2 });
    const sealedSettings = sealSecretsDeep(selected.settings, deviceKey);
    storage.getState().applySettingsForScope(accountScope, sealedSettings, 2);
    expect(storage.getState().settingsVersion).toBe(2);
    expect(storage.getState().settings.secrets.map(secret => secret.id)).toContain('voice-action-secret');
    expect(storage.getState().settings.secrets).toEqual(sealedSettings.secrets);
    assertNoUnsealedSettingsSecretValues(storage.getState().settings);
    for (const value of Object.values(home.homes)) primeServerFeaturesSnapshot({ serverId: value.id, snapshot: { status: 'ready', features } });
    storage.setState({ sessions: Object.fromEntries(Object.entries(sessionIdsByHome).flatMap(([key, ids]) => ids.map(id => [id, createSessionFixture({ id, serverId: home.homes[key]!.id,
            encryptionMode: 'plain', active: false, metadata: { path: '/voice', host: 'test',
                ...(id === 'voice-action-history' ? buildVoiceTranscriptHistorySessionMetadata() : {}) } })] as const))) });
    const metadata = storage.getState().sessions['voice-action-history']!.metadata;
    const owner = createSessionOwnerMetadataV1({ metadata });
    if (!owner.ok) throw new Error('Voice history fixture needs current owner metadata');
    sessionsByHome.get('voice')!.createSessionFromPost('voice-action-history', { method: 'POST', body: JSON.stringify({
        tag: 'system:voice-transcript-history:v1', metadataLayoutVersion: 1,
        sharedMetadata: { ciphertext: JSON.stringify(projectSessionSharedMetadataV1({ metadata, agentState: null })) },
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata),
        agentState: null, dataEncryptionKey: null, encryptionMode: 'plain',
    }) });
    await purposes.hydrate({ serverId, accountId: 'voice-action-account' });
    let mintStatus = 200;
    const providerFetch = vi.fn(async (url: URL | RequestInfo) => {
        if (String(url).endsWith('/v1/realtime/client_secrets')) return mintStatus === 200
            ? Response.json({ value: 'ek_action_boundary', expires_at: Math.floor(Date.now() / 1000) + 60,
                session: { type: 'realtime', object: 'realtime.session', id: 'voice-action-provider', model: OPENAI_REALTIME_DEFAULT_SETTINGS.model.id } })
            : new Response('{}', { status: mintStatus });
        if (String(url).endsWith('/v1/realtime/calls')) return new Response('v=0\r\na=action-answer\r\n', { status: 201 });
        throw new Error(`Unexpected provider request: ${String(url)}`);
    });
    vi.stubGlobal('fetch', providerFetch);
    const lease = createBundledConversationRuntimeHostLease();
    runtimeCleanup.push(async () => { lease.revoke(); });
    const host = Object.freeze({ ...lease.host, createMicSession: () => browser.micSession });
    const scope = createExternalVoiceProviderActivationScope({ pluginId: entry.pluginId, occurrenceId: 'voice-action-occurrence',
        declarations: [entry.declaration], hostPlatform: 'web', runtimeHost: host,
        isRuntimeHostCurrent: () => getCurrentBundledConversationRuntimeHost() === lease.host,
        hostBindingsByLocalId: { [entry.declaration.id]: { recipientContract, descriptor: 'bundled',
            createInvocationAccountOperations: (signal, _sessionId, isCurrent, phase) => createAccountVoiceOperationService({
                providerId: entry.providerId, contribution, declaration: entry.declaration, phase, recipientContract, signal, isCurrent, fetch: providerFetch }) } } });
    runtimeCleanup.push(async () => { await scope.unwind(); });
    const { loadBundledVoiceRuntimeActivate } = await import('@/dev/testkit/harness/builtinVoiceAdapters');
    const activationRelease = createDeferred<void>();
    const activationEntered = createDeferred<void>();
    if (!deferActivation) activationRelease.resolve(undefined);
    registerVoiceAdapters([]);
    const activation = (async () => {
        await activationRelease.promise;
        (await loadBundledVoiceRuntimeActivate(entry))(scope.api);
        await scope.commit();
        const adapter = getExternalVoiceProviderRegistration(entry.providerId)?.adapter;
        if (!adapter) throw new Error('Generated OpenAI adapter did not activate');
        registerVoiceAdapters([adapter]);
    })();
    if (!deferActivation) await activation;
    const unpublish = publishCommittedAppShellPluginUiProjection(() => null, undefined, undefined, undefined,
        providerId => {
            if (providerId !== entry.providerId) return null;
            activationEntered.resolve(undefined);
            return activation;
        });
    runtimeCleanup.push(async () => { activationRelease.resolve(undefined); await activation; unpublish(); });
    const lifecycle = createVoiceSessionLifecycleController({ captureAdmission: createVoiceCaptureAdmissionController() });
    setVoiceSessionLifecycleController(lifecycle);
    lifecycle.subscribe(() => setVoiceSessionSnapshot(lifecycle.getSnapshot()));
    lifecycle.setConfiguredProviderId(entry.providerId);
    if (start) {
        await lifecycle.toggle({ serverId, sessionId: 'session-original' });
        expect(lifecycle.getSnapshot()).toMatchObject({ adapterId: entry.providerId, sessionId: 'session-original', status: 'connected' });
    }
    const expectedAttempt = getVoiceSessionAttemptId()!;
    const invoke = (action: Parameters<typeof executeVoiceConversationAction>[0], input: unknown) => executeVoiceConversationAction(action, input, { navigate() {} });
    let event = 0;
    return { lifecycle, expectedAttempt, invoke, serverId, providerId: entry.providerId, artifacts, homeRequests: home.requests,
        releaseActivation: () => activationRelease.resolve(undefined),
        activationEntered: activationEntered.promise,
        explicitServerId: home.homes.explicit!.id, focusedServerId: home.homes.focused!.id, competingServerId: home.homes.competing!.id,
        micTrack: () => browser.micTrack,
        speaking() { browser.peer.channel.message(JSON.stringify({ type: 'output_audio_buffer.started', event_id: `action-${++event}` })); },
        acknowledgeOutputCleared() { browser.peer.channel.message(JSON.stringify({ type: 'output_audio_buffer.cleared', event_id: `action-${++event}` })); },
        fail() { browser.peer.channel.message(JSON.stringify({ type: 'error', event_id: `action-${++event}`, error: { code: 'session_expired' } })); },
        rejectCredentials() { mintStatus = 401; },
        holdFeatureResponse() {
            const hold = { entered: createDeferred<void>(), released: createDeferred<void>() };
            heldFeatureResponse = hold;
            const release = () => { if (heldFeatureResponse === hold) heldFeatureResponse = null; hold.released.resolve(undefined); };
            runtimeCleanup.push(async () => { release(); });
            resetServerFeaturesClientForTests();
            return { entered: hold.entered.promise, release };
        },
        sent: () => browser.peer.channel.sent.map(value => JSON.parse(value)),
    };
}

describe('generated OpenAI conversation Actions through the lifecycle owner', () => {
    it.each([
        { reason: 'usage_limit', message: 'Codex usage limit reached. Try another connected account or try again after your limit resets.', recovery: 'open_settings' },
        { reason: 'acp_turn_failed', message: 'Cannot connect to API. token=PRIVATE_TOKEN /home/alice/private/model', recovery: 'retry' },
    ])('keeps the sanitized $reason cause in public Voice status', async ({ reason, message, recovery }) => {
        const { lifecycle, invoke } = await createHarness(false);
        const { voiceConversationRuntimeMachine } = await import('@/voice/runtime/machine/VoiceConversationRuntimeMachine');
        const { createVoiceMachineError } = await import('@/voice/runtime/machine/voiceMachineError');
        const { deriveLocalVoiceSessionSnapshot } = await import('@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot');
        try {
            // Public reads also serve a retained failed attempt with no mounted runtime controller.
            setVoiceSessionLifecycleController(null);
            voiceConversationRuntimeMachine.setError({
                controlSessionId: 'session-original',
                error: createVoiceMachineError({ kind: 'provider_error', reason, cause: new Error(message) }),
            });
            const snapshot = deriveLocalVoiceSessionSnapshot('local_conversation', 'local', voiceConversationRuntimeMachine.getSnapshot());
            setVoiceSessionSnapshot(snapshot);
            const result = await invoke('ui.voice_global.get', {});
            expect(result).toMatchObject({ status: 'completed', voice: { presentation: {
                surfaceState: 'error', failureKind: 'provider_error',
                failureMessage: snapshot.errorProviderMessage, recovery: { action: recovery },
            } } });
            expect(result.voice.presentation?.failureMessage).toContain(message.split('.')[0]);
            expect(JSON.stringify(result)).not.toMatch(/PRIVATE_TOKEN|\/home\/alice/);
            expect(VoiceConversationActionOutputSchemas['ui.voice_global.get'].safeParse(result).success).toBe(true);
        } finally { await lifecycle.dispose(); }
    });

    it('cancels first Start during activation without opening the provider after it settles', async () => {
        const fixture = await createHarness(false, true, true);
        const starting = fixture.lifecycle.toggle({ serverId: fixture.serverId, sessionId: 'session-original' });
        expect(await Promise.race([starting.then(() => 'settled'), fixture.activationEntered.then(() => 'preparing')]))
            .toBe('preparing');
        expect(fixture.lifecycle.getSnapshot()).toMatchObject({ status: 'connecting', canStop: true });
        await fixture.lifecycle.stop('session-original');
        fixture.releaseActivation();
        await starting;
        expect(fixture.lifecycle.getSnapshot()).toMatchObject({ status: 'disconnected', canStop: false });
    });

    it.each(['action', 'lifecycle'] as const)('sequences first Start after real provider activation (%s)', async ingress => {
        const fixture = await createHarness(false, true, true);
        let settled = false;
        const start = (ingress === 'action'
            ? fixture.invoke('ui.voice_global.start', { target: { kind: 'session', sessionAddress: {
                serverId: fixture.serverId, sessionId: 'session-original',
            } }, expectedAttempt: null })
            : fixture.lifecycle.toggle({ serverId: fixture.serverId, sessionId: 'session-original' }))
            .then(result => { settled = true; return result; });
        expect(await Promise.race([start.then(() => 'settled'), fixture.activationEntered.then(() => 'preparing')]))
            .toBe('preparing');
        expect(settled).toBe(false);
        expect(fixture.lifecycle.getSnapshot().status).not.toBe('error');
        fixture.releaseActivation();
        const result = await start;
        if (ingress === 'action') expect(result).toMatchObject({ status: 'completed' });
        expect(fixture.lifecycle.getSnapshot()).toMatchObject({ status: 'connected', canStop: true });
    });

    it('exposes a sanitized public attempt projection without opening media', async () => {
        const { lifecycle, invoke } = await createHarness(false);
        try {
            const result = await invoke('ui.voice_global.get', {});
            expect(result.voice).toMatchObject({ presentation: { attemptId: null, surfaceState: 'idle',
                live: false, failureKind: null, failureMessage: null, recovery: null } });
            expect(lifecycle.getSnapshot().status).toBe('disconnected');
        } finally { await lifecycle.dispose(); }
    });
    it.each(['open', 'close'] as const)('applies exact glance policy to the top-bar %s control', async operation => {
        const { lifecycle } = await createHarness(false);
        const { VoiceTopBarPresence } = await import('@/components/voice/presence/VoiceTopBarPresence');
        const { buildVoicePresenceFixture } = await import('@/components/dev/voicePresence/voicePresenceFixtures');
        const { setVoiceGlanceOpen } = await import('@/components/voice/presence/voiceCompanionSectionReveal');
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const setDisabled = async (actionId: string | null) => act(async () => storage.setState(state => ({ settings: {
            ...state.settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: actionId
                ? { [actionId]: { disabledSurfaces: ['ui'] } } : {} }),
        } })));
        // Presentation input is the canonical specimen projection; no live audio is required to open a glance.
        const screen = await renderScreen(React.createElement(VoiceTopBarPresence, { voice: buildVoicePresenceFixture('listening') }));
        try {
            if (operation === 'open') {
                await setDisabled('ui.voice_global.glance.open');
                await pressVoiceControl(screen, 'voice-top-bar-label');
                expect(screen.findByTestId('voice-top-bar-label')?.props['aria-expanded']).toBe(false);
            }
            expect(await createDefaultActionExecutor().execute('ui.voice_global.get', {}, { surface: 'ui' })).toMatchObject({ ok: true });
            await setDisabled(null);
            await pressVoiceControl(screen, 'voice-top-bar-label');
            await vi.waitFor(() => expect(screen.findByTestId('voice-top-bar-label')?.props['aria-expanded']).toBe(true));
            await setDisabled('ui.voice_global.glance.close');
            const { VoiceGlanceOverlay } = await import('@/components/voice/presence/VoiceGlancePopover');
            await act(async () => screen.tree.root.findByType(VoiceGlanceOverlay).props.onRequestClose());
            expect(screen.findByTestId('voice-top-bar-label')?.props['aria-expanded']).toBe(true);
            await setDisabled(null);
            await act(async () => screen.tree.root.findByType(VoiceGlanceOverlay).props.onRequestClose());
            await vi.waitFor(() => expect(screen.findByTestId('voice-top-bar-label')?.props['aria-expanded']).toBe(false));
            expect(setVoiceGlanceOpen(false)).toBe(true);
        } finally { await screen.unmount(); await lifecycle.dispose(); }
    });
    it.each(['open', 'close', 'escape', 'microphone'] as const)('applies exact setup policy to the %s control', async operation => {
        const { lifecycle } = await createHarness(false);
        const { useVoiceSetupBlock } = await import('@/voice/settings/setup/VoiceSetupItem');
        const { SetupBlockGrid } = await import('@/components/ui/setupBlocks/SetupBlockGrid');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const setDisabled = async (actionId: string | null) => act(async () => storage.setState(state => ({ settings: {
            ...state.settings, actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: actionId
                ? { [actionId]: { disabledSurfaces: ['ui'] } } : {} }),
        } })));
        function Setup() {
            const item = useVoiceSetupBlock({ layout: 'card' });
            return React.createElement(SetupBlockGrid, { items: item ? [item] : [], testID: 'voice-setup-policy' });
        }
        const screen = await renderScreen(React.createElement(InjectedAuthProvider, { credentials: null, children: React.createElement(Setup) }));
        try {
            if (operation === 'open') {
                await setDisabled('ui.voice_global.setup.open');
                await pressVoiceControl(screen, 'hub-setup.voice.action');
                expect(screen.findByTestId('hub-setup.voice:setup')).toBeNull();
            }
            await setDisabled(null);
            await pressVoiceControl(screen, 'hub-setup.voice.action');
            await vi.waitFor(() => expect(screen.findByTestId('hub-setup.voice:setup.close')).not.toBeNull());
            if (operation === 'microphone') {
                const capture = vi.mocked(navigator.mediaDevices.getUserMedia);
                capture.mockClear();
                await setDisabled('ui.voice_global.setup.microphone.permission.request');
                await act(async () => screen.findAllByTestId('hub-setup.voice:setup').find(node => node.props.actions)!.props.actions.onAllowMicrophone());
                expect(capture).not.toHaveBeenCalled();
                await setDisabled(null);
                await act(async () => screen.findAllByTestId('hub-setup.voice:setup').find(node => node.props.actions)!.props.actions.onAllowMicrophone());
                await vi.waitFor(() => expect(capture).toHaveBeenCalledOnce());
            }
            await setDisabled('ui.voice_global.setup.close');
            if (operation === 'escape') {
                const { dispatchEscapeToLayerStack } = await import('@/keyboard/escape');
                await act(async () => { expect(dispatchEscapeToLayerStack({ key: 'Escape' })).toBe(true); });
            } else {
                await pressVoiceControl(screen, 'hub-setup.voice:setup.close');
            }
            expect(screen.findByTestId('hub-setup.voice:setup.close')).not.toBeNull();
            await setDisabled(null);
            await pressVoiceControl(screen, 'hub-setup.voice:setup.close');
            await vi.waitFor(() => expect(screen.findByTestId('hub-setup.voice:setup')).toBeNull());
        } finally { await screen.unmount(); await lifecycle.dispose(); }
    });
    it('admits setup microphone permission separately from opening setup and returns the observed platform state', async () => {
        const { lifecycle } = await createHarness(false);
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const { registerVoiceSetupPresentation } = await import('@/components/voice/presence/voiceCompanionSectionReveal');
        const open = vi.fn(() => true);
        const unregister = registerVoiceSetupPresentation(open);
        const capture = vi.mocked(navigator.mediaDevices.getUserMedia);
        capture.mockClear();
        const executor = createDefaultActionExecutor();
        try {
            storage.setState(state => ({ settings: { ...state.settings,
                actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {
                    'ui.voice_global.setup.microphone.permission.request': { disabledSurfaces: ['ui'] },
                } }),
            } }));
            expect(await executor.execute('ui.voice_global.setup.microphone.permission.request', {}, { surface: 'ui' }))
                .toMatchObject({ ok: false });
            expect(capture).not.toHaveBeenCalled();
            expect(await executor.execute('ui.voice_global.setup.open', {}, { surface: 'ui' })).toMatchObject({ ok: true });
            expect(open).toHaveBeenCalledWith(true);
            storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1: normalizeActionsSettingsV1({}) } }));
            const result = await executor.execute('ui.voice_global.setup.microphone.permission.request', {}, { surface: 'ui' });
            expect(result).toMatchObject({ ok: true, result: { status: 'completed', permission: 'granted' } });
            expect(capture).toHaveBeenCalledOnce();
            expect(VoiceConversationActionOutputSchemas['ui.voice_global.setup.microphone.permission.request'].safeParse(result.ok ? result.result : null).success).toBe(true);
            capture.mockRejectedValueOnce(Object.assign(new Error('No microphone'), { name: 'NotFoundError' }));
            const unavailable = await executor.execute('ui.voice_global.setup.microphone.permission.request', {}, { surface: 'ui' });
            expect(unavailable).toMatchObject({ ok: true, result: { status: 'unavailable', code: 'voice_microphone_unavailable', permission: 'unavailable' } });
            expect(VoiceConversationActionOutputSchemas['ui.voice_global.setup.microphone.permission.request'].safeParse(unavailable.ok ? unavailable.result : null).success).toBe(true);
        } finally { unregister(); await lifecycle.dispose(); }
    });
    it('applies exact setup policy to the system-settings link and refuses unavailable web settings', async () => {
        const { lifecycle, serverId } = await createHarness(false);
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const serverUrl = getActiveServerSnapshot().serverUrl;
        const credentials = await TokenStorage.getCredentialsForServerUrl(serverUrl, { serverId });
        if (!credentials) throw new Error('Expected the served Home credential');
        let nativeCredential: Awaited<ReturnType<typeof TokenStorage.setCredentialsForServerUrlWithRollback>> | null = null;
        const openSettings = platformBoundary.openSettings;
        openSettings.mockClear();
        const executor = createDefaultActionExecutor();
        try {
            platformBoundary.os = 'ios';
            nativeCredential = await TokenStorage.setCredentialsForServerUrlWithRollback(serverUrl, { serverId }, credentials);
            storage.setState(state => ({ settings: { ...state.settings,
                actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {
                    'ui.voice_global.setup.system_settings.open': { disabledSurfaces: ['ui'] },
                } }),
            } }));
            expect(await executor.execute('ui.voice_global.setup.system_settings.open', {}, { surface: 'ui' }))
                .toMatchObject({ ok: false });
            expect(openSettings).not.toHaveBeenCalled();
            storage.setState(state => ({ settings: { ...state.settings, actionsSettingsV1: normalizeActionsSettingsV1({}) } }));
            const opened = await executor.execute('ui.voice_global.setup.system_settings.open', {}, { surface: 'ui' });
            expect(opened).toMatchObject({ ok: true, result: { status: 'completed' } });
            expect(openSettings).toHaveBeenCalledOnce();
            platformBoundary.os = 'web';
            expect(await executor.execute('ui.voice_global.setup.system_settings.open', {}, { surface: 'ui' }))
                .toMatchObject({ ok: true, result: { status: 'unavailable', code: 'voice_system_settings_unavailable' } });
            expect(openSettings).toHaveBeenCalledOnce();
        } finally {
            platformBoundary.os = 'ios';
            await nativeCredential?.rollback();
            platformBoundary.os = 'web';
            await lifecycle.dispose();
        }
    });
    it('retains the Agent Ask floor before setup microphone permission can prompt', async () => {
        const { lifecycle, serverId, artifacts } = await createHarness(false);
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const capture = vi.mocked(navigator.mediaDevices.getUserMedia);
        capture.mockClear();
        const executor = createDefaultActionExecutor();
        const cancellation = new AbortController();
        const pending = executor.execute('ui.voice_global.setup.microphone.permission.request', {}, { surface: 'agent', serverId,
            defaultSessionId: 'session-original', actionRequestId: 'setup-microphone-request', signal: cancellation.signal,
            actionCaller: { kind: 'session', sessionId: 'session-original', starterDepth: 0, turnDepth: 0 } });
        try {
            await vi.waitFor(() => expect(artifacts.list()).toHaveLength(1));
            expect(capture).not.toHaveBeenCalled();
            expect(await executor.execute('approval.request.decide', { artifactId: artifacts.list()[0]!.id, decision: 'cancel' }, { surface: 'ui', serverId }))
                .toMatchObject({ ok: true });
            expect(await pending).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
            expect(capture).not.toHaveBeenCalled();
        } finally { cancellation.abort(); await pending; await lifecycle.dispose(); }
    });
    it('retains setup Done dismissal through a refused close and a later approved close', async () => {
        const { lifecycle, serverId, artifacts } = await createHarness(false);
        const { useVoiceSetupBlock } = await import('@/voice/settings/setup/VoiceSetupItem');
        const { SetupBlockGrid } = await import('@/components/ui/setupBlocks/SetupBlockGrid');
        const { InjectedAuthProvider } = await import('@/auth/context/AuthContext');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { getActiveServerSnapshot } = await import('@/sync/domains/server/serverRuntime');
        const { buildHomeHubArtifactIdV1, HomeHubLayoutV1Schema } = await import('@happier-dev/protocol/home');
        const { listHiddenHomeSetupSteps } = await import('@/components/hub/layout/homeHubLayout');
        const { decideApprovalAsInbox } = await import('@/dev/testkit/harness/approvalInbox');
        const credentials = await TokenStorage.getCredentialsForServerUrl(getActiveServerSnapshot().serverUrl, { serverId });
        if (!credentials) throw new Error('Expected the served Home credential');
        function Setup() {
            const item = useVoiceSetupBlock({ layout: 'card' });
            return React.createElement(SetupBlockGrid, { items: item ? [item] : [], testID: 'voice-setup-done' });
        }
        const screen = await renderScreen(React.createElement(InjectedAuthProvider, { credentials, children: React.createElement(Setup) }));
        const homeId = buildHomeHubArtifactIdV1('voice-action-account');
        const done = () => screen.findAllByTestId('hub-setup.voice:setup').find(node => node.props.actions)!.props.actions.onDone();
        try {
            await pressVoiceControl(screen, 'hub-setup.voice.action');
            await vi.waitFor(() => expect(screen.findByTestId('hub-setup.voice:setup.close')).not.toBeNull());
            await act(async () => storage.setState(state => ({ settings: { ...state.settings,
                actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {
                    'ui.voice_global.setup.close': { disabledSurfaces: ['ui'] },
                } }),
            } })));
            await act(async () => { done(); });
            expect(screen.findByTestId('hub-setup.voice:setup.close')).not.toBeNull();
            expect(artifacts.readPlainBody(homeId)).toBeNull();
            await act(async () => storage.setState(state => ({ settings: { ...state.settings,
                actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {
                    'ui.voice_global.setup.close': { approvalRequiredSurfaces: ['ui'] },
                } }),
            } })));
            await act(async () => { done(); });
            await vi.waitFor(() => expect(artifacts.list().some(row => JSON.parse(artifacts.readPlainBody(row.id) ?? '{}').status === 'open')).toBe(true));
            const request = artifacts.list().find(row => JSON.parse(artifacts.readPlainBody(row.id) ?? '{}').status === 'open')!;
            expect(screen.findByTestId('hub-setup.voice:setup.close')).not.toBeNull();
            expect(artifacts.readPlainBody(homeId)).toBeNull();
            expect(await decideApprovalAsInbox(serverId, request.id, 'approve')).toMatchObject({ ok: true });
            await vi.waitFor(() => {
                const body = artifacts.readPlainBody(homeId);
                expect(body).not.toBeNull();
                expect(listHiddenHomeSetupSteps(HomeHubLayoutV1Schema.parse(JSON.parse(body!)))).toContain('setup:voice');
                expect(screen.findByTestId('hub-setup.voice:setup')).toBeNull();
            });
        } finally {
            for (const row of artifacts.list()) {
                if (JSON.parse(artifacts.readPlainBody(row.id) ?? '{}').status === 'open') await decideApprovalAsInbox(serverId, row.id, 'cancel');
            }
            await screen.unmount(); await lifecycle.dispose();
        }
    });
    it('retains the Agent Start approval default and an explicit person Ask-first preference', async () => {
        const { lifecycle, serverId, artifacts } = await createHarness(false);
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const confirmation = vi.fn(async () => false);
        const executor = createDefaultActionExecutor({ presentUserActionConfirmation: confirmation });
        const input = { target: { kind: 'global' }, expectedAttempt: null };
        const person = { surface: 'ui' as const, authority: 'present_user' as const,
            actionCaller: { kind: 'host' as const }, serverId };
        const cancellation = new AbortController();
        const pending = executor.execute('ui.voice_global.start', input, { surface: 'agent', serverId,
            defaultSessionId: 'session-original', defaultSessionMachineId: 'unreachable-origin-machine',
            actionRequestId: 'voice-start-request', signal: cancellation.signal,
            actionCaller: { kind: 'session', sessionId: 'session-original', starterDepth: 0, turnDepth: 0 } });
        let settled: Awaited<typeof pending> | undefined;
        void pending.then(result => { settled = result; });
        try {
            await vi.waitFor(() => {
                expect(settled).toBeUndefined();
                expect(artifacts.list()).toHaveLength(1);
            });
            expect(lifecycle.getSnapshot().status).toBe('disconnected');
            const artifactId = artifacts.list()[0]!.id;
            expect(await executor.execute('approval.request.decide', { artifactId, decision: 'cancel' }, person))
                .toMatchObject({ ok: true });
            expect(await pending).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
            expect(confirmation).not.toHaveBeenCalled();
            storage.setState(state => ({ settings: { ...state.settings,
                actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: {
                    'ui.voice_global.start': { approvalRequiredSurfaces: ['ui'] },
                } }) } }));
            const asked = await executor.execute('ui.voice_global.start', input, person);
            const request = ActionApprovalRequestCreatedResultSchema.parse(asked.ok ? asked.result : null);
            expect(artifacts.list()).toHaveLength(2);
            expect(lifecycle.getSnapshot().status).toBe('disconnected');
            expect(await executor.execute('approval.request.decide', { artifactId: request.artifactId, decision: 'cancel' }, person))
                .toMatchObject({ ok: true });
            expect(confirmation).not.toHaveBeenCalled();
        } finally { cancellation.abort(); await pending; await lifecycle.dispose(); }
    });
    it('admits a composer hold through Action policy and cancels an early gesture without committing', async () => {
        const { lifecycle, sent } = await createHarness();
        const { useVoiceAttemptControl } = await import('@/components/voice/attempt/useVoiceAttemptControl');
        const { renderHook } = await import('@/dev/testkit');
        storage.setState(state => ({ localSettings: { ...state.localSettings, voiceHoldToTalkEnabled: true }, settings: { ...state.settings,
            actionsSettingsV1: normalizeActionsSettingsV1({ v: 1, actions: { ...state.settings.actionsSettingsV1?.actions,
                'ui.voice_global.hold_begin': { disabledSurfaces: ['ui'] } } }) } }));
        const hook = await renderHook(() => useVoiceAttemptControl({ kind: 'global' }));
        try {
            const denied = hook.getCurrent().beginHoldToTalk();
            expect(denied).not.toBeNull();
            expect(await denied!.ready).toBe(false);
            await denied!.cancel();
            await act(async () => storage.setState(state => ({ settings: { ...state.settings,
                actionsSettingsV1: normalizeActionsSettingsV1({}) } })));
            const before = sent().length;
            const early = hook.getCurrent().beginHoldToTalk();
            expect(early).not.toBeNull();
            await early!.cancel();
            expect(await early!.ready).toBe(false);
            expect(sent().slice(before).filter(value => value.type === 'input_audio_buffer.commit')).toEqual([]);
            const allowed = hook.getCurrent().beginHoldToTalk();
            expect(allowed).not.toBeNull();
            expect(await allowed!.ready).toBe(true);
            await allowed!.release();
            await allowed!.release();
            expect(sent().slice(before).filter(value => value.type === 'input_audio_buffer.commit')).toHaveLength(1);
        } finally { await hook.unmount(); await lifecycle.dispose(); }
    });
    it('replays one tapped unmute Ask in the approving client while model decisions and End leave custody intact', async () => {
        const { lifecycle, expectedAttempt, serverId, artifacts, homeRequests, micTrack } = await createHarness();
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const { captureActionAccountContext } = await import('./actionAccountContext');
        const { useApprovalDecisionHandler } = await import('@/components/tools/shell/approvals/useApprovalDecisionHandler');
        const executor = createDefaultActionExecutor();
        const agent = { surface: 'agent' as const, serverId, defaultSessionId: 'session-original',
            defaultSessionMachineId: 'unreachable-origin-machine', actionRequestId: 'voice-unmute-request',
            actionCaller: { kind: 'session' as const, sessionId: 'session-original', starterDepth: 0, turnDepth: 0 } };
        const account = await captureActionAccountContext(serverId);
        let unmountDecision = async () => {};
        try {
            expect(await executor.execute('ui.voice_global.set_muted', { expectedAttempt, muted: true }, agent))
                .toMatchObject({ ok: true, result: { status: 'completed' } });
            const pending = executor.execute('ui.voice_global.set_muted', { expectedAttempt, muted: false }, agent);
            await vi.waitFor(() => expect(artifacts.list()).toHaveLength(1));
            const artifactId = artifacts.list()[0]!.id;
            const artifact = await account.fetchArtifact(artifactId);
            if (!artifact || typeof artifact.body !== 'string') throw new Error('Expected durable Ask');
            const parsed = approvalArtifactBodyMatchesHeaderV1(artifact.header ?? {}, artifact.body);
            if (parsed?.family !== 'built_in') throw new Error('Expected strict built-in Ask');
            expect(parsed.request).toMatchObject({ status: 'open', actionArgs: { expectedAttempt, muted: false } });
            expect(micTrack().enabled).toBe(false);
            expect(await executor.execute('approval.request.decide', { artifactId, decision: 'approve' }, agent))
                .toMatchObject({ ok: false, errorCode: 'present_user_required' });
            expect(JSON.parse(artifacts.readPlainBody(artifactId)!)).toMatchObject({ status: 'open' });
            const { renderHook } = await import('@/dev/testkit');
            const hook = await renderHook(() => useApprovalDecisionHandler(artifact, parsed.request, 'session-original', serverId));
            unmountDecision = hook.unmount;
            expect(await hook.getCurrent()('approve')).toBe(true);
            expect(await pending).toMatchObject({ ok: true, result: { status: 'completed', voice: { muted: false } } });
            expect(micTrack().enabled).toBe(true);
            const settled = JSON.parse(artifacts.readPlainBody(artifactId)!);
            expect(approvalArtifactBodyMatchesHeaderV1((await account.fetchArtifact(artifactId))!.header ?? {}, JSON.stringify(settled)))
                .toMatchObject({ family: 'built_in', request: { status: 'executed', execution: { ok: true } } });
            // A repeated decision cannot reapply the effect to this live attempt.
            await executor.execute('ui.voice_global.set_muted', { expectedAttempt, muted: true }, agent);
            expect(await hook.getCurrent()('approve')).toBe(true);
            expect(micTrack().enabled).toBe(false);
            const next = executor.execute('ui.voice_global.set_muted', { expectedAttempt, muted: false },
                { ...agent, actionRequestId: 'voice-unmute-after-end' });
            await vi.waitFor(() => expect(artifacts.list()).toHaveLength(2));
            const nextId = artifacts.list()[1]!.id;
            await executor.execute('ui.voice_global.end', { expectedAttempt }, agent);
            expect(JSON.parse(artifacts.readPlainBody(nextId)!)).toMatchObject({ status: 'open' });
            await executor.execute('approval.request.decide', { artifactId: nextId, decision: 'cancel' }, { surface: 'ui', serverId });
            expect(await next).toMatchObject({ ok: false, errorCode: 'approval_canceled' });
            expect(homeRequests.filter(request => request.path.includes('/rpc'))).toEqual([]);
        } finally {
            for (const row of artifacts.list()) {
                if (JSON.parse(artifacts.readPlainBody(row.id)!).status === 'open') {
                    await executor.execute('approval.request.decide', { artifactId: row.id, decision: 'cancel' }, { surface: 'ui', serverId });
                }
            }
            await unmountDecision(); account.dispose(); await lifecycle.dispose();
        }
    });
    it('interrupts actual speaking through the surface handler and ignores an absent control Session', async () => {
        const { lifecycle, speaking, sent, acknowledgeOutputCleared } = await createHarness();
        const { createVoiceSurfaceActionHandlers } = await import('@/components/voice/surface/createVoiceSurfaceActionHandlers');
        try {
            expect(lifecycle.getSnapshot().status).toBe('connected');
            const quiescentMode = lifecycle.getSnapshot().mode;
            speaking();
            await vi.waitFor(() => expect(lifecycle.getSnapshot().mode).toBe('speaking'));
            const sentBeforeInterrupt = sent().length;
            await createVoiceSurfaceActionHandlers({ sessionId: 'session-original', snapSessionId: null }).onBargeIn();
            expect(lifecycle.getSnapshot().mode).toBe('speaking');
            expect(sent().slice(sentBeforeInterrupt)).toEqual([]);
            setVoiceSessionLifecycleController(null);
            await createVoiceSurfaceActionHandlers({ sessionId: 'session-original', snapSessionId: 'session-original' }).onBargeIn();
            await Promise.resolve();
            expect(lifecycle.getSnapshot().mode).toBe('speaking');
            expect(sent().slice(sentBeforeInterrupt)).toEqual([]);
            setVoiceSessionLifecycleController(lifecycle);
            await createVoiceSurfaceActionHandlers({ sessionId: 'session-original', snapSessionId: 'session-original' }).onBargeIn();
            await vi.waitFor(() => expect(sent().slice(sentBeforeInterrupt)).toEqual([
                { type: 'response.cancel' }, { type: 'output_audio_buffer.clear' },
            ]));
            expect(lifecycle.getSnapshot().mode).toBe('speaking');
            acknowledgeOutputCleared();
            await vi.waitFor(() => expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', mode: quiescentMode }));
        } finally { setVoiceSessionLifecycleController(lifecycle); await lifecycle.dispose(); }
    });
    it.each(['ended', 'history', 'recovery'] as const)('opens $0 through the real default Action and the mounted workspace', async scenario => {
        const { lifecycle, serverId, providerId, rejectCredentials } = await createHarness();
        const { createWorkspaceState, reduceWorkspaceState } = await import('@/components/appShell/workspace/workspaceState');
        const { createWorkspaceNavigationAdapter } = await import('@/components/appShell/workspace/workspaceNavigationAdapter');
        const { createWorkspaceActionAdapter } = await import('@/components/appShell/workspace/workspaceActions');
        const { registerMountedWorkspaceAction } = await import('@/components/appShell/workspace/workspaceActionRuntime');
        const { DestinationInstanceHost } = await import('@/components/appShell/workspace/DestinationInstanceHost');
        const { hrefForDestinationRef, resolveCompactAppDestinations } = await import('@/components/appShell/destinations/compactAppDestinationCatalog');
        const { Text } = await import('@/components/ui/text/Text');
        const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
        const { createRealAppRouteElement } = await import('@/dev/testkit/render/renderRealAppRoute');
        const { TokenStorage } = await import('@/auth/storage/tokenStorage');
        const { getServerProfileById } = await import('@/sync/domains/server/serverProfiles');
        const home = getServerProfileById(serverId);
        if (!home) throw new Error('Hosted Voice destination requires its admitted Home');
        const credentials = await TokenStorage.getCredentialsForServerUrl(home.serverUrl);
        if (!credentials) throw new Error('Hosted Voice destination requires its authenticated Account');
        const catalog = resolveCompactAppDestinations({ pages: [], builtins: { externalSessions: false, inbox: true, workflows: true, friends: false } });
        let workspace = createWorkspaceState({ id: 'voice-settings-tab', target: { kind: 'settings', params: { pageId: 'voice' } }, pinned: false, preview: false });
        const navigation = createWorkspaceNavigationAdapter({ getState: () => workspace, getCatalog: () => catalog,
            dispatch: action => { workspace = reduceWorkspaceState(workspace, action); }, transport: { commit() {} },
            createId: () => 'voice-opened-tab', onChange() {} });
        const workspaceAction = createWorkspaceActionAdapter({ getState: () => workspace, navigation,
            readCanvas: () => null, createId: () => 'voice-opened-tab' });
        const unregister = registerMountedWorkspaceAction(async ({ actionId, input }) => workspaceAction(actionId, input));
        const hosted = () => {
            const group = workspace.groups[workspace.focusedGroupId];
            const tab = workspace.tabs[group.activeTabId];
            const href = hrefForDestinationRef(catalog, tab.target) ?? '';
            return React.createElement(DestinationInstanceHost, { tabId: tab.id, ref: tab.target, pathname: href,
                focused: true, visible: true, navigation: { push() {}, replace() {}, back() {} },
                children: React.createElement(Text, { testID: 'voice-action-hosted-destination' }, href) });
        };
        const screen = await renderScreen(await createRealAppRouteElement(hosted, credentials));
        try {
            const accountScope = { serverId, accountId: 'voice-action-account' };
            setVoiceSessionSnapshot(lifecycle.getSnapshot(), { adapterId: providerId, controlSessionId: 'session-original',
                conversationSessionId: 'saved-conversation', conversationSessionAddress: { serverId, sessionId: 'saved-conversation' },
                targetSessionAddress: null, transcriptMode: 'synthetic', updatedAt: 1,
                ...(scenario === 'history' ? { lifetime: 'runtime_attempt' as const } : {}) },
                { accountScope, conversationScope: { kind: 'voice_home' } });
            if (scenario === 'recovery') {
                await lifecycle.stop('session-original');
                rejectCredentials();
                await lifecycle.toggle({ serverId, sessionId: 'session-original' });
                expect(lifecycle.getSnapshot()).toMatchObject({ status: 'error', errorRecoveryAction: 'review_credentials' });
            } else await lifecycle.stop('session-original');
            const expectedAttempt = getVoiceSessionPresentedAttemptId()!;
            useVoiceTargetStore.getState().setLastFocusedSessionAddress({ serverId: 'other-home', sessionId: 'visible-session' });
            const actionId = scenario === 'recovery' ? 'ui.voice_global.recover' as const : 'ui.voice_global.open_conversation' as const;
            const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId, expectedAccountId: accountScope.accountId,
                presentUserConfirmation: { actionId } };
            const result = await createDefaultActionExecutor().execute(actionId, { expectedAttempt }, context);
            expect(result, JSON.stringify(result)).toMatchObject({ ok: true, result: { status: 'completed' } });
            await screen.update(await createRealAppRouteElement(hosted, credentials));
            const destination = scenario === 'ended' ? `/session/saved-conversation?serverId=${serverId}`
                : scenario === 'history' ? '/settings/voice-history' : '/settings/voice/conversations?focus=provider';
            expect(screen.findByTestId('voice-action-hosted-destination')?.props.children).toBe(destination);
            const stale = await createDefaultActionExecutor().execute(actionId, { expectedAttempt: 'previous-attempt' }, context);
            expect(stale).toMatchObject({ ok: true, result: { status: 'unavailable', code: 'stale_voice_attempt' } });
            expect(hrefForDestinationRef(catalog, workspace.tabs[workspace.groups[workspace.focusedGroupId].activeTabId].target)).toBe(destination);
        } finally { await screen.unmount(); unregister(); await lifecycle.dispose(); }
    });
    it('admits safe mute but refuses microphone reopening when the captured Home disables Voice', async () => {
        const { lifecycle, expectedAttempt, serverId } = await createHarness(true, false);
        try {
            const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
            const executor = createDefaultActionExecutor();
            const context = { surface: 'ui' as const, authority: 'present_user' as const, serverId,
                expectedAccountId: 'voice-action-account', presentUserConfirmation: { actionId: 'ui.voice_global.set_muted' as const } };
            expect(await executor.execute('ui.voice_global.set_muted', { expectedAttempt, muted: true }, context))
                .toMatchObject({ ok: true, result: { status: 'completed' } });
            expect(lifecycle.getSnapshot().micMuted).toBe(true);
            expect(await executor.execute('ui.voice_global.set_muted', { expectedAttempt, muted: false }, context))
                .toMatchObject({ ok: false, errorCode: 'voice_unavailable' });
            expect(lifecycle.getSnapshot().micMuted).toBe(true);
        } finally { await lifecycle.dispose(); }
    });
    it.each([
        { lifetime: 'runtime_attempt' as const, target: null, destination: '/settings/voice-history' },
        { lifetime: 'runtime_attempt' as const, target: { serverId: 'ended-home', sessionId: 'coding-target' }, destination: '/session/coding-target?serverId=ended-home' },
        { lifetime: undefined, target: null, destination: '/session/saved-conversation?serverId=ended-home' },
    ])('opens the captured ended conversation destination $destination after focus changes', async ({ lifetime, target, destination }) => {
        const previousScope = storage.getState().profileScope;
        const accountScope = { serverId: 'ended-home', accountId: 'ended-account' };
        storage.setState({ profileScope: accountScope });
        const { lifecycle, providerId } = await createHarness();
        storage.setState({ profileScope: accountScope });
        try {
            const binding = {
                adapterId: providerId, controlSessionId: 'session-original', conversationSessionId: 'saved-conversation',
                conversationSessionAddress: { serverId: 'ended-home', sessionId: 'saved-conversation' },
                targetSessionAddress: target, lifetime, transcriptMode: 'synthetic' as const, updatedAt: 1,
            };
            setVoiceSessionSnapshot(lifecycle.getSnapshot(), binding, { accountScope, conversationScope: { kind: 'voice_home' } });
            const expectedAttempt = getVoiceSessionAttemptId()!;
            await lifecycle.stop('session-original');
            useVoiceTargetStore.getState().setLastFocusedSessionAddress({ serverId: 'other-home', sessionId: 'visible-session' });
            const destinations: unknown[] = [];
            expect(await executeVoiceConversationAction('ui.voice_global.open_conversation', { expectedAttempt }, {
                navigate: href => { destinations.push(href); },
            })).toMatchObject({ status: 'completed' });
            expect(destinations).toEqual([destination]);
            expect(await executeVoiceConversationAction('ui.voice_global.open_conversation', { expectedAttempt: 'replaced-attempt' }, {
                navigate: href => { destinations.push(href); },
            })).toMatchObject({ status: 'unavailable', code: 'stale_voice_attempt' });
            storage.setState({ profileScope: { ...accountScope, accountId: 'other-account' } });
            expect(await executeVoiceConversationAction('ui.voice_global.open_conversation', { expectedAttempt }, {
                navigate: href => { destinations.push(href); },
            })).toMatchObject({ status: 'unavailable', code: 'voice_conversation_navigation_unavailable' });
            expect(destinations).toHaveLength(1);
        } finally { await lifecycle.dispose(); storage.setState({ profileScope: previousScope }); }
    });
    it.each(['action', 'native'] as const)('starts Talk from a Bot SessionAction at its captured Home and surfaces a running attempt refusal through %s', async surface => {
        const { lifecycle, invoke, serverId } = await createHarness(false);
        // This UI workflow now asks before opening the mic. Supply the human
        // dialog outcome at its boundary, retaining the real approval policy.
        const { Modal } = await import('@/modal');
        vi.spyOn(Modal, 'confirm').mockResolvedValue(true);
        const target = createSessionActionTarget({ serverId, session: createSessionListRenderableSessionFixture({
            id: 'bot-talk-session', metadata: { path: '/project', name: 'Ada', bot: { kind: 'bot' } },
        }) });
        try {
            useVoiceTargetStore.getState().setLastFocusedSessionAddress({ serverId: 'other-home', sessionId: 'other-session' });
            await executeSessionAction({ actionId: 'ui.session.talk', target });
            expect((await invoke('ui.voice_global.get', {})).voice).toMatchObject({ status: 'connected',
                target: { kind: 'session', sessionAddress: { serverId, sessionId: 'bot-talk-session' } } });
            if (surface === 'action') {
                await expect(executeSessionAction({ actionId: 'ui.session.talk', target })).rejects.toMatchObject({ code: 'voice_start_unavailable' });
            } else {
                const { ModalProvider } = await import('@/modal');
                const { useSessionRowActionMenu } = await import('@/components/sessions/shell/row/actionMenu/useSessionRowActionMenu');
                const { createRoot } = await import('react-dom/client');
                const container = document.createElement('div');
                document.body.append(container);
                const root = createRoot(container);
                let menu: ReturnType<typeof useSessionRowActionMenu> | null = null;
                function MenuCapture() {
                    menu = useSessionRowActionMenu({ target, sessionName: 'Bot', hideInactiveSessions: false,
                        iconColor: '#000', activeTags: [], knownTags: [], tagsEnabled: false, touchPrimaryPointer: true,
                        setContextMenuOpen() {}, openTagsMenuFromContext() {} });
                    return null;
                }
                const readMenu = () => {
                    if (!menu) throw new Error('Session menu did not mount');
                    return menu;
                };
                try {
                    await React.act(async () => { root.render(React.createElement(ModalProvider, null, React.createElement(MenuCapture))); });
                    expect(readMenu().moreMenuItems.find(item => item.id === 'ui.session.talk')?.title).toContain('Ada');
                    await React.act(async () => { readMenu().handleContextMenuSelect('ui.session.talk'); });
                    // The real web OS renderer owns the modal's portal and message.
                    await vi.waitFor(() => expect(document.body.textContent).toContain('voice_start_unavailable'));
                } finally { await React.act(async () => { root.unmount(); }); container.remove(); }
            }
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', sessionId: 'bot-talk-session' });
        } finally { await lifecycle.dispose(); }
    });
});

describe('Action projection of the generated OpenAI applied-selection producer', () => {
    it('projects the applied voice and retires it on End', async () => {
        const { lifecycle, expectedAttempt, invoke, providerId, serverId } = await createHarness();
        try {
            const current = await invoke('ui.voice_global.get', {});
            const inUseVoice = current.voice.inUseVoice;
            expect(inUseVoice).toMatchObject({ providerContributionId: providerId, settingFieldPath: 'voice',
                value: OPENAI_REALTIME_DEFAULT_SETTINGS.voice, displayName: expect.any(String) });
            expect(VoiceConversationActionOutputSchemas['ui.voice_global.get'].safeParse(current).success).toBe(true);
            // Changing the next-attempt preference cannot rewrite the already
            // accepted selection published by the real provider preparation.
            const settingsBeforePreference = storage.getState().settings;
            const nextVoice = writeVoiceProviderSettingsConfig(settingsBeforePreference.voice, providerId,
                { ...OPENAI_REALTIME_DEFAULT_SETTINGS, turnDetection: 'manual', voice: 'coral' });
            storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: nextVoice }, settingsBeforePreference));
            expect(storage.getState().settings.voiceSettingsV1.credentialBindings).toEqual(settingsBeforePreference.voiceSettingsV1.credentialBindings);
            expect((await invoke('ui.voice_global.get', {})).voice).toHaveProperty('inUseVoice', inUseVoice);
            useVoiceTargetStore.getState().setLastFocusedSessionAddress({ serverId: 'other-home', sessionId: 'other-session' });
            expect((await invoke('ui.voice_global.get', {})).voice).toHaveProperty('inUseVoice', inUseVoice);
            await invoke('ui.voice_global.end', { expectedAttempt });
            expect((await invoke('ui.voice_global.get', {})).voice).toHaveProperty('inUseVoice', null);
            await lifecycle.toggle({ serverId, sessionId: 'other-session' });
            expect((await invoke('ui.voice_global.get', {})).voice.inUseVoice).toMatchObject({
                providerContributionId: providerId, settingFieldPath: 'voice', value: 'coral', displayName: expect.any(String),
            });
        } finally { await lifecycle.dispose(); }
    });
});

describe('generated OpenAI conversation Action admission and turn controls', () => {
    it('starts explicit global/session and default intents through the existing idle-target policy', async () => {
        const { lifecycle, invoke, serverId, explicitServerId, focusedServerId, competingServerId, holdFeatureResponse } = await createHarness(false);
        const previousFocus = getFocusedSessionAddress();
        storage.setState(state => ({ settings: { ...state.settings,
            voice: { ...state.settings.voice, ui: { ...state.settings.voice.ui, scopeDefault: 'session' } },
            voiceSettingsV1: { ...state.settings.voiceSettingsV1, ui: { ...state.settings.voiceSettingsV1.ui, scopeDefault: 'session' } } } }));
        // This fixture omits unrelated host ports: any accidental non-Voice dispatch fails loudly.
        const executor = createActionExecutor(createActionExecutorBoundaryFixture({
            isActionApprovalRequired: () => false,
            voiceConversationAction: ({ actionId, input }) => executeVoiceConversationAction(actionId, input, { navigate() {} }),
        }));
        const actionContext = { surface: 'ui' as const, authority: 'present_user' as const, actionCaller: { kind: 'host' as const } };
        try {
            useVoiceTargetStore.getState().setLastFocusedSessionAddress({ serverId: focusedServerId, sessionId: 'default-session' });
            for (const [target, expectedTarget] of [
                [{ kind: 'session', sessionAddress: { serverId: explicitServerId, sessionId: 'explicit-session' } }, { kind: 'session', sessionAddress: { serverId: explicitServerId, sessionId: 'explicit-session' } }],
                [{ kind: 'default' }, { kind: 'session', sessionAddress: { serverId: focusedServerId, sessionId: 'default-session' } }],
                [{ kind: 'global' }, { kind: 'global' }],
            ] as const) {
                // Each vector starts from an actual focused surface. Explicit
                // Start legitimately updates last-focused at the binding owner.
                setFocusedSessionId('default-session', focusedServerId);
                const startResult = await executor.execute('ui.voice_global.start', { target, expectedAttempt: null }, actionContext);
                expect(startResult.ok, JSON.stringify(startResult)).toBe(true);
                if (!startResult.ok) throw new Error(startResult.errorCode);
                const started = VoiceConversationActionOutputSchemas['ui.voice_global.start'].parse(startResult.result);
                expect(started.status, JSON.stringify(started)).toBe('completed');
                expect(started.voice).toMatchObject({ status: 'connected', canStop: true, target: expectedTarget });
                const currentToken = started.voice.attemptId!;
                expect((await invoke('ui.voice_global.start', { target, expectedAttempt: null })).status).toBe('unavailable');
                const endResult = await executor.execute('ui.voice_global.end', { expectedAttempt: currentToken }, actionContext);
                expect(endResult.ok).toBe(true);
                if (!endResult.ok) throw new Error(endResult.errorCode);
                expect(VoiceConversationActionOutputSchemas['ui.voice_global.end'].parse(endResult.result))
                    .toMatchObject({ status: 'completed', voice: { status: 'disconnected', canDismissEnded: true } });
            }
            const hold = holdFeatureResponse();
            const { createDefaultActionExecutor } = await import('./defaultActionExecutor');
            let settled = false;
            const pendingStart = createDefaultActionExecutor().execute('ui.voice_global.start', {
                target: { kind: 'global' }, expectedAttempt: null,
            }, { ...actionContext, serverId, expectedAccountId: 'voice-action-account',
                presentUserConfirmation: { actionId: 'ui.voice_global.start' } }).finally(() => { settled = true; });
            try {
                // Readiness is held at the actual Home HTTP boundary, not in a
                // side-effectful replacement of the caller's currentness guard.
                await hold.entered;
                expect(settled).toBe(false);
                await lifecycle.toggle({ serverId: competingServerId, sessionId: 'competing-session' });
                expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', sessionId: 'competing-session' });
                const acceptedAttempt = getVoiceSessionAttemptId();
                expect(acceptedAttempt).not.toBeNull();
                expect(settled).toBe(false);
                hold.release();
                const racedStart = await pendingStart;
                expect(racedStart).toMatchObject({ ok: true, result: { status: 'unavailable', code: 'voice_start_unavailable' } });
                expect(getVoiceSessionAttemptId()).toBe(acceptedAttempt);
                expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', sessionId: 'competing-session', canStop: true });
                expect(lifecycle.getAttemptTargetSessionAddress()).toEqual({ serverId: competingServerId, sessionId: 'competing-session' });
            } finally { hold.release(); await pendingStart; }
        } finally {
            await lifecycle.dispose();
            setFocusedSessionId(previousFocus?.sessionId ?? null, previousFocus?.serverId);
        }
    });
    it('reads and settles the actual attempt after navigation changes, with Mute separate from End', async () => {
        const { lifecycle, expectedAttempt, invoke, speaking, serverId, sent, micTrack, acknowledgeOutputCleared } = await createHarness();
        try {
            const quiescentMode = lifecycle.getSnapshot().mode;
            useVoiceTargetStore.getState().setLastFocusedSessionAddress({ serverId: 'other-home', sessionId: 'other-session' });
            const read = await invoke('ui.voice_global.get', {});
            expect(read.voice).toMatchObject({ attemptId: expectedAttempt, sessionId: 'session-original', canStop: true });
            expect(read.voice.target).toEqual({ kind: 'session', sessionAddress: { serverId, sessionId: 'session-original' } });
            expect((await invoke('ui.voice_global.set_muted', { expectedAttempt, muted: true })).status).toBe('completed');
            expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', micMuted: true });
            expect(micTrack().enabled).toBe(false);
            expect(await invoke('ui.voice_global.set_muted', { expectedAttempt: 'previous-attempt', muted: false }))
                .toMatchObject({ status: 'unavailable', code: 'stale_voice_attempt' });
            expect(lifecycle.getSnapshot().micMuted).toBe(true);
            expect((await invoke('ui.voice_global.set_muted', { expectedAttempt, muted: false })).status).toBe('completed');
            expect(lifecycle.getSnapshot().status).toBe('connected');
            expect((await invoke('ui.voice_global.get', {})).voice.muted).toBe(false);
            expect(micTrack().enabled).toBe(true);
            const sentBeforeCommit = sent().length;
            expect((await invoke('ui.voice_global.turn_control', { expectedAttempt, control: 'commit_input' })).status).toBe('completed');
            expect(sent().slice(sentBeforeCommit)).toEqual([{ type: 'input_audio_buffer.commit' }, { type: 'response.create' }]);
            expect(lifecycle.getSnapshot().status).toBe('connected');
            // The commit requests generation; only the genuine provider output
            // edge admits cancelling that generated response.
            speaking();
            await vi.waitFor(() => expect(lifecycle.getSnapshot().mode).toBe('speaking'));
            const sentBeforeCancel = sent().length;
            expect((await invoke('ui.voice_global.turn_control', { expectedAttempt, control: 'cancel' })).status).toBe('completed');
            expect(sent().slice(sentBeforeCancel)).toEqual([{ type: 'response.cancel' }, { type: 'output_audio_buffer.clear' }]);
            acknowledgeOutputCleared();
            await vi.waitFor(() => expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', mode: quiescentMode }));
            expect(micTrack().enabled).toBe(true);
            speaking();
            await vi.waitFor(() => expect(lifecycle.getSnapshot().mode).toBe('speaking'));
            const sentBeforeInterrupt = sent().length;
            expect((await invoke('ui.voice_global.turn_control', { expectedAttempt, control: 'interrupt' })).status).toBe('completed');
            expect(sent().slice(sentBeforeInterrupt)).toEqual([{ type: 'response.cancel' }, { type: 'output_audio_buffer.clear' }]);
            expect(lifecycle.getSnapshot().mode).toBe('speaking');
            acknowledgeOutputCleared();
            await vi.waitFor(() => expect(lifecycle.getSnapshot()).toMatchObject({ status: 'connected', mode: quiescentMode }));
            expect((await invoke('ui.voice_global.end', { expectedAttempt })).status).toBe('completed');
            expect(lifecycle.getSnapshot().status).toBe('disconnected');
            const ended = await invoke('ui.voice_global.get', {});
            expect(ended.voice).toMatchObject({ attemptId: expectedAttempt, canDismissEnded: true });
            expect((await invoke('ui.voice_global.dismiss', { expectedAttempt, kind: 'ended' })).status).toBe('completed');
            expect((await invoke('ui.voice_global.get', {})).voice.canDismissEnded).toBe(false);
        } finally { await lifecycle.dispose(); }
    });

    it('refuses dispatch when the invoking Account retired during preparation', async () => {
        const { lifecycle, expectedAttempt } = await createHarness();
        try {
            expect(await executeVoiceConversationAction('ui.voice_global.end', { expectedAttempt }, { navigate() {}, isCurrent: () => false }))
                .toMatchObject({ status: 'unavailable', code: 'voice_action_account_changed' });
            expect(lifecycle.getSnapshot().status).toBe('connected');
        } finally { await lifecycle.dispose(); }
    });

    it('rejects a stale token after a replacement reuses the same session', async () => {
        const { lifecycle, expectedAttempt, invoke, serverId, micTrack } = await createHarness();
        try {
            await lifecycle.stop('session-original');
            await lifecycle.toggle({ serverId, sessionId: 'session-original' });
            expect(getVoiceSessionAttemptId()).not.toBe(expectedAttempt);
            const replacementTrack = micTrack();
            expect(replacementTrack.readyState).toBe('live');
            expect(await invoke('ui.voice_global.end', { expectedAttempt })).toMatchObject({ status: 'unavailable', code: 'stale_voice_attempt' });
            expect(await invoke('ui.voice_global.set_muted', { expectedAttempt, muted: true })).toMatchObject({ status: 'unavailable', code: 'stale_voice_attempt' });
            expect(lifecycle.getSnapshot().status).toBe('connected');
            expect((await invoke('ui.voice_global.get', {})).voice.muted).toBe(false);
            expect(micTrack()).toBe(replacementTrack);
            expect(micTrack().enabled).toBe(true);
        } finally { await lifecycle.dispose(); }
    });

    it('retries the failed attempt at its captured target and acknowledges failure without a clean End', async () => {
        const { lifecycle, expectedAttempt, invoke, fail } = await createHarness();
        try {
            fail();
            await vi.waitFor(() => expect(lifecycle.getSnapshot().errorRecoveryAction).toBe('retry'));
            useVoiceTargetStore.getState().setLastFocusedSessionAddress({ serverId: 'other-home', sessionId: 'other-session' });
            const failedVoice = (await invoke('ui.voice_global.get', {})).voice;
            expect(failedVoice).toMatchObject({ attemptId: expectedAttempt, canDismissFailedAttempt: true,
                presentation: { surfaceState: 'error', failureKind: 'provider_error', failureMessage: expect.any(String),
                    recovery: { action: 'retry', label: expect.any(String), icon: 'arrow-clockwise' } } });
            expect((await invoke('ui.voice_global.recover', { expectedAttempt })).status).toBe('completed');
            expect(lifecycle.getSnapshot()).toMatchObject({ sessionId: 'session-original', status: 'connected' });
            const replacement = getVoiceSessionAttemptId()!;
            fail();
            await vi.waitFor(() => expect(lifecycle.getSnapshot().errorRecoveryAction).toBe('retry'));
            expect((await invoke('ui.voice_global.dismiss', { expectedAttempt: replacement, kind: 'failed' })).status).toBe('completed');
            expect((await invoke('ui.voice_global.get', {})).voice).toMatchObject({ canDismissFailedAttempt: false, canDismissEnded: false });
        } finally { await lifecycle.dispose(); }
    });
});
