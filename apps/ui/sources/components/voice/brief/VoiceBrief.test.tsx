import { CountedDisclosureItem } from '@/components/ui/lists/CountedDisclosureItem';
import { VoiceNeedsYouPrompts } from '@/components/voice/presence/VoiceNeedsYouPrompts';
import type { VoiceBriefItem } from '@/voice/context/buildVoiceBrief';
import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import { createEmptyAccountBootstrapHttpResponse } from '@/dev/testkit/fixtures/accountBootstrapHttpBoundary';
import { createAccountSettingsHttpBoundary, installRealActionExecutorModuleLoader } from '@/dev/testkit/harness/actionHomesHttpHarness';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { createPlainAccountEncryptionCurrentnessFixture, renderScreen, waitForTestEvent, type RenderScreenResult } from '@/dev/testkit';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { AuthProvider } from '@/auth/context/AuthContext';
import { InboxModelBoundary } from '@/hooks/inbox/useInboxModel';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { resetVoiceAdapterRegistryForTests } from '@/voice/session/voiceAdapterRegistry';
import type { VoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleController';
import { getVoiceSessionLifecycleController, resetVoiceSessionLifecycleControllerStoreForTests } from '@/voice/session/voiceSessionLifecycleControllerStore';
import { setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import { installVoiceWebRtcBrowserBoundary, TestVoiceWebRtcPeer } from '@/dev/testkit/harness/voiceWebRtcHarness';
import type { CreateMicSessionOptions } from '@/voice/runtime/mic/MicSession';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createConnectedPurposeCatalogHttpBoundary } from '@/dev/testkit/harness/connectedAccountCatalogBoundary';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { answerVoiceRealtimePreparationHttpRequest } from '@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary';
import { createSessionFixture } from '@/dev/testkit';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } from '@/voice/registry/generatedBundledVoiceRuntimeEntries';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import { saveAndUseAccountVoiceCredential, applyAccountVoiceCredentialSourceSelection } from '@/voice/credentials/accountVoiceCredential';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { OPENAI_REALTIME_DEFAULT_SETTINGS } from '../../../../../../packages/plugins/openai/src/protocol/voice/settings';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { buildVoiceTranscriptHistorySessionMetadata, VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG } from '@/voice/persistence/voiceTranscriptHistorySession';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { VoiceBriefBlock, VoiceBriefButton, VoiceBriefList } from './VoiceBrief';
import { createDefaultVoiceProviderRegistry } from '@/voice/registry/defaultRegistry';
import { buildVoiceBrief } from '@/voice/context/buildVoiceBrief';
import { t } from '@/text';
import { formatVoiceApprovalGuidance } from '@/voice/context/contextFormatters';
import { buildActivityOverviewSnapshot } from '@/activity/attention/buildActivityOverviewSnapshot';
import { buildInboxSessionPresentation } from '@/activity/presentation/buildInboxSessionPresentation';
import { EMPTY_WORKFLOW_ATTENTION_SOURCE } from '@/hooks/inbox/useWorkflowAttentionSource';
import { readInboxSessionTitle } from '@/components/inbox/sessionAttention/inboxSessionPrivacy';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { Item } from '@/components/ui/lists/Item';
import { executeVoiceBriefOperation } from './voiceBriefActionRuntime';
import { getVoiceSessionAttemptId, getVoiceSessionPresentedAttemptId, resetVoiceSessionStoreForTests } from '@/voice/session/voiceSessionStore';
import { useVoiceBriefHomeRequest, useVoiceBriefRequest } from './useVoiceBriefRequest';
import { VoiceTopBarPresence } from '@/components/voice/presence/VoiceTopBarPresence';
import { useVoiceAttemptControl, VOICE_ATTEMPT_IDLE_TARGET_GLOBAL } from '@/components/voice/attempt/useVoiceAttemptControl';
import { setVoiceGlanceOpen } from '@/components/voice/presence/voiceCompanionSectionReveal';
import { installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { captureActiveServerAccountScopeCurrentness, getActiveServerAccountScope, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { disconnectActiveServerConnectionIfCurrent } from '@/sync/runtime/orchestration/connectionManager';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

const navigation = vi.hoisted(() => ({ push: vi.fn() }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => '/', router: { push: navigation.push } }).module;
});
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('expo-audio', () => ({ AudioModule: { setAudioModeAsync: vi.fn(async () => undefined) } }));
// Node resolves the native platform entry. Select the canonical browser boundary's
// real WebMicSession, including capture, mute and teardown; only media ports are fake.
vi.mock('@/voice/runtime/mic/createRealtimeMicSession', () => ({
    createRealtimeMicSession: (options: CreateMicSessionOptions = {}) => browser.createMicSession(options),
}));
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});

const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(value => value.declaration.id === 'realtime-openai')!;
const historyId = 'brief-history';
// Compile the real Action graph before mounted interaction deadlines begin.
await loadSyncSingletonForTests();
const disposeActionLoader = await installRealActionExecutorModuleLoader();
afterAll(disposeActionLoader);
let browser: ReturnType<typeof installVoiceWebRtcBrowserBoundary>;
let observePeerCreated: (peer: TestVoiceWebRtcPeer) => void = () => {};

// Only browser media/WebRTC and provider HTTP are synthetic. The shipped leaf,
// credentials, registration, mic, conversation controller and lifecycle are real.
function transport() {
    const peers = browser.peers;
    const starts: Array<{ requestedTargetSessionAddress: SessionAddress | null; controlSessionId: string }> = [];
    observePeerCreated = () => {
        const binding = voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID);
        if (!binding) throw new Error('WebRTC started before its Voice conversation was bound');
        starts.push({ requestedTargetSessionAddress: binding.targetSessionAddress, controlSessionId: binding.controlSessionId });
    };
    const messages = (role: string) => peers.flatMap(peer => peer.channel.sent.flatMap(value => {
        const event = JSON.parse(value) as { type: string; item?: { role: string; content: Array<{ text?: string }> } };
        return event.type === 'conversation.item.create' && event.item?.role === role
            ? event.item.content.flatMap(content => content.text ? [content.text] : []) : [];
    }));
    const usablePeer = () => browser.peerCreated(peers.at(-1)?.channel.readyState === 'closed'
        ? peers.length : Math.max(0, peers.length - 1));
    return { starts,
        get spoken() { return messages('user'); },
        get interrupted() { return peers.flatMap((peer, index) => peer.channel.sent.flatMap(value => JSON.parse(value).type === 'response.cancel' ? [starts[index]!.controlSessionId] : [])); },
        async waitForSpoken() {
            const peer = await usablePeer();
            await peer.channel.controlSent(value => {
                const event = JSON.parse(value) as { type?: string; item?: { role?: string } };
                return event.type === 'conversation.item.create' && event.item?.role === 'user';
            });
            expect(messages('user')).toHaveLength(1);
        },
        async waitForInterrupted() {
            const peer = await usablePeer();
            await peer.channel.controlSent(value => JSON.parse(value).type === 'response.cancel');
            expect(peers.flatMap((value, index) => value.channel.sent.flatMap(sent =>
                JSON.parse(sent).type === 'response.cancel' ? [starts[index]!.controlSessionId] : [])))
                .toEqual([VOICE_AGENT_GLOBAL_SESSION_ID]);
        },
        async connect() {
            const peer = await usablePeer();
            await peer.remoteDescriptionSet;
            expect(peer.setRemoteDescription).toHaveBeenCalled();
            expect(peer.channel.readyState).not.toBe('closed');
            peer.channel.open();
            await waitForTestEvent(lifecycle!.subscribe, lifecycle!.getSnapshot, value => value.status === 'connected');
            expect(lifecycle?.getSnapshot().status).toBe('connected');
        },
        async waitForStart() {
            const peer = await usablePeer();
            await peer.remoteDescriptionSet;
            expect(peer.setRemoteDescription).toHaveBeenCalled();
            expect(peer.channel.readyState).not.toBe('closed');
        },
        async waitForStarts(count: number) { await browser.peerCreated(count - 1); expect(starts).toHaveLength(count); },
        lateConnect() { peers.at(-1)!.channel.dispatchEvent(new Event('open')); },
        async fail() {
            await browser.peerCreated(Math.max(0, peers.length - 1));
            expect(peers.at(-1)).toBeDefined();
            if (lifecycle?.getSnapshot().status === 'connected') {
                peers.at(-1)!.channel.message(JSON.stringify({ type: 'error', event_id: 'brief-session-expired', error: { code: 'session_expired' } }));
            } else {
                peers.at(-1)!.connectionState = 'failed';
                peers.at(-1)!.dispatchEvent(new Event('connectionstatechange'));
            }
            await waitForTestEvent(lifecycle!.subscribe, lifecycle!.getSnapshot, value => value.status === 'error');
            expect(lifecycle?.getSnapshot().status).toBe('error');
        },
        async startOutput() {
            peers.at(-1)!.channel.message(JSON.stringify({ type: 'output_audio_buffer.started', event_id: 'brief-output-started', response_id: 'brief-response' }));
            await waitForTestEvent(lifecycle!.subscribe, lifecycle!.getSnapshot, value => value.mode === 'speaking');
            expect(lifecycle?.getSnapshot().mode).toBe('speaking');
        },
    };
}

let screen: RenderScreenResult | null = null;
let runtimeScreen: RenderScreenResult | null = null;
let lifecycle: VoiceSessionLifecycleController | null = null;
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
let accountSettingsHttp: ReturnType<typeof createAccountSettingsHttpBoundary>;
let accountSettingsVersion = 1;
let restorePopoverGlobals: (() => void) | null = null;
const initialState = storage.getState();
function setActionPolicy(value: Parameters<typeof normalizeActionsSettingsV1>[0]) {
    storage.setState({ settings: { ...storage.getState().settings, actionsSettingsV1: normalizeActionsSettingsV1(value) } });
}
async function pressBriefControl(testID: string) {
    await waitForTestEvent(screen!.subscribe, () => {
        const control = screen?.findByTestId(testID);
        expect(control).toBeTruthy();
        expect(control?.props.disabled).not.toBe(true);
    });
    await screen?.pressByTestIdAsync(testID);
}
beforeEach(async () => {
    resetVoiceSessionStoreForTests();
    navigation.push.mockReset();
    resetServerFeaturesClientForTests();
    setRuntimeFetch(vi.fn(async () => new Response(JSON.stringify(buildServerFeaturesResponse({ voiceEnabled: true })), {
        status: 200, headers: { 'content-type': 'application/json' },
    })));
    storage.setState({ ...initialState, settings: settingsParse({ voice: { providerId: 'off' } }) }, true);
    const purposes = createConnectedPurposeCatalogHttpBoundary();
    const sessions = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
    accountSettingsVersion = 1;
    accountSettingsHttp = createAccountSettingsHttpBoundary({ serverUrl: 'https://brief-account.example.test',
        initialAccounts: [{ accountId: 'account-a', snapshot: { version: accountSettingsVersion,
            content: { t: 'plain', v: { voice: { providerId: 'off' } } } } }],
    });
    const machine = createMachineFixture({ id: 'brief-machine', activeAt: Date.now() });
    const machineRow = createPlainMachineRowFixture({ id: machine.id, accountId: 'account-a', machine });
    const providerFetch = vi.fn<typeof fetch>(async (url) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/realtime/client_secrets') return Response.json({ value: 'ek_brief', expires_at: Math.floor(Date.now() / 1000) + 60,
            session: { type: 'realtime', object: 'realtime.session', id: 'brief-provider', model: OPENAI_REALTIME_DEFAULT_SETTINGS.model.id } });
        if (path === '/v1/realtime/calls') return new Response('v=0\r\na=brief-answer\r\n', { status: 201 });
        throw new Error(`Unexpected provider HTTP request: ${path}`);
    });
    account = await restoreServerAccountForTest({ serverUrl: 'https://brief-account.example.test', additionalRequestOrigins: ['https://api.openai.com'],
        credentialScope: 'restored-home', request: createSessionReadBatchFetchBoundary(async (url, init) => {
        if (new URL(String(url)).origin === 'https://api.openai.com') return providerFetch(url, init);
        const path = new URL(String(url)).pathname;
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(buildServerFeaturesResponse({ voiceEnabled: true }));
        if (path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: 'account-a' }));
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v1/machines') return Response.json([machineRow]);
        if (path === '/v1/machines/read-batch' && init?.method === 'POST') {
            return createMachineReadBatchResponseFixture(init.body, id => id === machine.id ? machineRow : null);
        }
        if (path === `/v1/machines/${machine.id}`) return Response.json({ machine: machineRow });
        if (path === `/v1/machines/${machine.id}/access`) {
            return Response.json({ machineId: machine.id, custodian: machineRow.access!.custodian,
                access: machineRow.access, canManage: true, grants: [], ownDirectGrant: false, ownAccessSources: [] });
        }
        const settingsResponse = accountSettingsHttp.handle(url, init);
        if (settingsResponse) return settingsResponse;
        if (path.endsWith('/messages') && init?.method !== 'POST') return Response.json(SessionMessagesPageV1Schema.parse({ messages: [], hasMore: false }));
        const purposeResponse = await purposes.handle(url, init);
        if (purposeResponse) return purposeResponse;
        const preparation = answerVoiceRealtimePreparationHttpRequest(url, storage.getState().settings);
        if (preparation) return preparation;
        if (path === '/v1/sessions' && init?.method === 'POST') return sessions.createSessionFromPost(historyId, init);
        const sessionResponse = sessions.handle(url, init);
        if (sessionResponse) return sessionResponse;
        if (path === '/health') return Response.json({ status: 'ok' });
        const bootstrap = createEmptyAccountBootstrapHttpResponse(path, init);
        if (bootstrap) return bootstrap;
        return new Response('{}', { status: 404 });
    }) });
    // Cold restore starts Profile sync asynchronously; observe its real publication,
    // including after the preceding test deliberately retires the Account lifetime.
    await waitForTestEvent(storage.subscribe, getActiveServerAccountScope, scope => scope !== null);
    expect(getActiveServerAccountScope()).not.toBeNull();
    const scope = getActiveServerAccountScope();
    if (!scope) throw new Error('Brief Account was not restored');
    await purposes.hydrate(scope);
    const { sync } = await import('@/sync/sync');
    await sync.resumeSync('manual');
    await waitForTestEvent(storage.subscribe, storage.getState, state => state.isDataReady
        && state.settingsVersion !== null && state.settingsScope?.serverId === scope.serverId
        && state.settingsScope.accountId === scope.accountId);
    observePeerCreated = () => {};
    browser = installVoiceWebRtcBrowserBoundary({ onCreatePeer: peer => observePeerCreated(peer) });
    // Account credential minting uses runtimeFetch; WebRTC uses global fetch.
    // Both external HTTP ports reach the same provider boundary.
    vi.stubGlobal('fetch', providerFetch);
    const metadata = { path: '/voice-history', host: 'test', ...buildVoiceTranscriptHistorySessionMetadata() };
    const owner = createSessionOwnerMetadataV1({ metadata });
    if (!owner.ok) throw new Error('Voice History owner metadata was not admitted');
    sessions.createSessionFromPost(historyId, { method: 'POST', body: JSON.stringify({ tag: VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG, metadataLayoutVersion: 1,
        sharedMetadata: { ciphertext: JSON.stringify(projectSessionSharedMetadataV1({ metadata, agentState: null })) },
        ownerMetadata: createPlainSessionOwnerMetadataEnvelopeV1(owner.ownerMetadata), agentState: null, dataEncryptionKey: null, encryptionMode: 'plain' }) });
    storage.setState({ sessions: { [historyId]: createSessionFixture({ id: historyId, serverId: account.home.id, encryptionMode: 'plain', active: false, metadata }) } });
    voiceSessionBindingStore.getState().bind({ adapterId: entry.providerId, controlSessionId: VOICE_AGENT_GLOBAL_SESSION_ID, conversationSessionId: historyId,
        conversationSessionAddress: { serverId: account.home.id, sessionId: historyId }, targetSessionAddress: null, lifetime: 'runtime_attempt', transcriptMode: 'synthetic', updatedAt: 1 });
    voiceConversationRuntimeMachine.reset();
    setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
});
afterEach(async () => {
    await screen?.unmount(); screen = null;
    restorePopoverGlobals?.(); restorePopoverGlobals = null;
    await runtimeScreen?.unmount(); runtimeScreen = null;
    await lifecycle?.dispose(); lifecycle = null;
    resetVoiceSessionLifecycleControllerStoreForTests();
    resetVoiceAdapterRegistryForTests();
    setVoiceSessionSnapshot({ adapterId: null, sessionId: null, status: 'disconnected', mode: 'idle', canStop: false });
    // The retirement test renews this same Home's Account lifetime. Its old
    // disposer correctly cannot retire the successor; close our current fixture
    // connection through the scoped owner before rolling back its credentials.
    if (account) await disconnectActiveServerConnectionIfCurrent({ serverId: account.home.id, serverUrl: account.home.serverUrl });
    await account?.dispose(); account = null;
    browser?.restore();
});

async function installTransport() {
    const speech = transport();
    // The mounted Runtime owns readiness, provider activation and publication.
    const { VoiceSessionRuntime } = await import('@/voice/session/VoiceSessionRuntime');
    runtimeScreen = await renderScreen(<VoiceSessionRuntime />);
    lifecycle = getVoiceSessionLifecycleController();
    if (!lifecycle) throw new Error('Mounted Voice lifecycle unavailable');
    return speech;
}
const render = () => <React.StrictMode><AuthProvider initialCredentials={account!.credentials}>
    <VoiceBriefBlock onClose={() => {}} />
</AuthProvider></React.StrictMode>;
function BriefHome(props: Readonly<{ available: boolean; mountBrief?: boolean }>) {
    const [open, setOpen] = React.useState(false);
    useVoiceBriefHomeRequest({ available: props.available, onOpen: () => setOpen(true) });
    return <>
        <VoiceBriefButton open={open} />
        {open && props.mountBrief !== false ? <VoiceBriefBlock onClose={() => setOpen(false)} /> : null}
    </>;
}
const renderHome = (available = true, mountBrief = true) => <React.StrictMode><AuthProvider initialCredentials={account!.credentials}>
    <BriefHome available={available} mountBrief={mountBrief} />
</AuthProvider></React.StrictMode>;
function Presentation() {
    const voice = useVoiceAttemptControl(VOICE_ATTEMPT_IDLE_TARGET_GLOBAL);
    return <VoiceTopBarPresence voice={voice} />;
}
async function selectService(canApproveRequests = true) {
    const expectedSettingsVersion = storage.getState().settingsVersion;
    if (expectedSettingsVersion === null) throw new Error('Brief Account Settings were not hydrated');
    const recipient = createBundledVoiceRecipientContract({ pluginId: entry.pluginId, declaration: entry.declaration });
    if (!recipient) throw new Error('OpenAI recipient contract is missing');
    const voice = voiceSettingsParse({ providerId: entry.providerId, canApproveRequests, welcome: { enabled: false }, providers: { [entry.providerId]: { schemaVersion: 1, config: OPENAI_REALTIME_DEFAULT_SETTINGS } } });
    const currentSettings = storage.getState().settings;
    const saved = saveAndUseAccountVoiceCredential({ settings: settingsParse({ ...currentSettings,
        ...normalizeVoiceSettingsLocalDelta({ voice }, currentSettings) }),
        contribution: { pluginId: entry.pluginId, localId: entry.declaration.id }, credentialSlotId: recipient.credentialSlot.id,
        expectedSettingsVersion, currentDeclaration: entry.declaration, value: 'sk_brief', generateId: () => 'brief-secret', now: 1,
        expectedSecretId: null, expectedSecretUpdatedAt: null });
    const selected = applyAccountVoiceCredentialSourceSelection({ settings: saved.settings, connectedPurposes: { v: 1, bindings: [] }, currentDeclaration: entry.declaration,
        mutation: { contribution: { pluginId: entry.pluginId, localId: entry.declaration.id }, credentialSlotId: recipient.credentialSlot.id, expectedSettingsVersion, selection: { kind: 'savedSecret' } } });
    accountSettingsVersion = expectedSettingsVersion + 1;
    accountSettingsHttp.replaceAccountSettings('account-a', { version: accountSettingsVersion,
        content: { t: 'plain', v: selected.settings } });
    await act(async () => {
        const { sync } = await import('@/sync/sync');
        await sync.refreshAccountSettingsFromServer(accountSettingsVersion, storage.getState().settingsScope);
    });
    expect(storage.getState().settings.voice.providerId).toBe(entry.providerId);
}

function expectApprovalGuidance(message: string | undefined, canApproveRequests = true) {
    // Assert the complete canonical field, including its Native Codex exception,
    // without copying the formatter's policy prose into this composed test.
    const expected = JSON.stringify({ approval: formatVoiceApprovalGuidance(canApproveRequests) });
    expect(message).toContain(expected.slice(1, -1));
}

describe('mounted Voice Brief request', () => {
    it('keeps the Brief projection stable on unrelated settings and refreshes consumed Voice preferences', async () => {
        const projections: Array<ReturnType<typeof useVoiceBriefRequest>['brief']> = [];
        function Probe() {
            const { brief } = useVoiceBriefRequest();
            React.useLayoutEffect(() => { projections.push(brief); });
            return null;
        }
        screen = await renderScreen(<AuthProvider initialCredentials={account!.credentials}><InboxModelBoundary><Probe /></InboxModelBoundary></AuthProvider>);
        const before = projections.at(-1)!;
        await act(async () => storage.getState().applySettingsLocal({
            terminalFontSize: storage.getState().settings.terminalFontSize + 1,
        }));
        expect(projections.at(-1)).toBe(before);
        const approvalBefore = storage.getState().settings.voice.canApproveRequests;
        await act(async () => storage.getState().applySettingsLocal(normalizeVoiceSettingsLocalDelta({ voice: {
            ...storage.getState().settings.voice,
            canApproveRequests: !approvalBefore,
        } }, storage.getState().settings)));
        expect(storage.getState().settings.voice.canApproveRequests).toBe(!approvalBefore);
        expect(projections.at(-1)?.context).not.toBe(before.context);
    });

    it('admits Home Brief me through the Action before mounting Inbox or opening the microphone', async () => {
        const speech = await installTransport();
        await selectService();
        setActionPolicy({ v: 1, actions: {
            'ui.voice_global.brief.request': { disabledSurfaces: ['ui'] },
        } });
        screen = await renderScreen(renderHome());
        await pressBriefControl('home-brief-me');
        expect(screen.findByTestId('voice-brief')).toBeNull();
        expect(speech.starts).toHaveLength(0);
        await act(async () => setActionPolicy({}));
        await pressBriefControl('home-brief-me');
        await waitForTestEvent(screen!.subscribe, () => expect(screen?.findByTestId('voice-brief')).toBeTruthy());
        await speech.waitForStarts(1);
        await act(async () => speech.connect());
        expect(speech.spoken).toHaveLength(1);
    });

    it('offers Set up Voice as the Home entry while Voice is not set up, and never opens a silent Brief from it', async () => {
        const speech = await installTransport();
        screen = await renderScreen(renderHome());
        const entry = screen.findByTestId('home-brief-me');
        expect(entry?.props.accessibilityLabel).toBe(t('voicePresence.setUp'));
        await pressBriefControl('home-brief-me');
        expect(screen.findByTestId('voice-brief')).toBeNull();
        expect(speech.starts).toHaveLength(0);
        await selectService();
        expect(screen.findByTestId('home-brief-me')?.props.accessibilityLabel).toBe(t('voiceMoments.briefMeA11y'));
    });

    it('keeps Home on setup when a declared Grok provider has no credential after hydration', async () => {
        await installTransport();
        const providerId = 'happier.voice.xai/realtime-grok';
        const grok = createDefaultVoiceProviderRegistry().get(providerId);
        if (!grok?.providerSettings) throw new Error('Grok declaration unavailable');
        const current = storage.getState().settings;
        const voice = voiceSettingsParse({ providerId, providers: { [providerId]: {
            schemaVersion: grok.providerSettings.schemaVersion, config: grok.providerSettings.defaultConfig,
        } } });
        await act(async () => storage.setState({ settings: settingsParse({ ...current,
            ...normalizeVoiceSettingsLocalDelta({ voice }, current) }) }));
        screen = await renderScreen(renderHome());
        expect(screen.findByTestId('home-brief-me')?.props.accessibilityLabel).toBe(t('voicePresence.setUp'));
        expect(screen.findByTestId('voice-brief')).toBeNull();
    });

    it('admits the initial request and Retry through the real UI Action policy before starting audio', async () => {
        const speech = await installTransport();
        await selectService();
        setActionPolicy({ v: 1, actions: {
            'ui.voice_global.brief.request': { disabledSurfaces: ['ui'] },
            'ui.voice_global.brief.retry': { disabledSurfaces: ['ui'] },
        } });
        screen = await renderScreen(render());
        await waitForTestEvent(screen!.subscribe, () => expect(screen?.findByTestId('voice-brief.retry')).toBeTruthy());
        expect(speech.starts).toHaveLength(0);
        await pressBriefControl('voice-brief.retry');
        expect(speech.starts).toHaveLength(0);
        await act(async () => setActionPolicy({ v: 1, actions: {
            'ui.voice_global.start': { disabledSurfaces: ['ui'] },
        } }));
        await pressBriefControl('voice-brief.retry');
        await waitForTestEvent(screen!.subscribe, () => expect(screen?.findByTestId('voice-brief.retry')).toBeTruthy());
        expect(speech.starts).toHaveLength(0);
        await act(async () => setActionPolicy({}));
        await pressBriefControl('voice-brief.retry');
        await speech.waitForStarts(1);
        await act(async () => speech.connect());
        expect(speech.spoken).toHaveLength(1);
    });

    it('keeps the live Brief and reply when UI Stop or Close is disabled by Action policy', async () => {
        const speech = await installTransport();
        await selectService();
        void lifecycle?.toggle(null);
        await speech.connect();
        screen = await renderScreen(renderHome());
        await act(async () => { executeVoiceBriefOperation('request'); });
        await speech.waitForSpoken();
        await act(async () => speech.startOutput());
        setActionPolicy({ v: 1, actions: {
            'ui.voice_global.brief.stop': { disabledSurfaces: ['ui'] },
            'ui.voice_global.brief.close': { disabledSurfaces: ['ui'] },
        } });
        await pressBriefControl('voice-brief.stop');
        expect(speech.interrupted).toHaveLength(0);
        await pressBriefControl('voice-brief.close');
        expect(screen.findByTestId('voice-brief')).toBeTruthy();
        await act(async () => setActionPolicy({}));
        await pressBriefControl('voice-brief.stop');
        await speech.waitForInterrupted();
        expect(lifecycle?.getSnapshot().status).toBe('connected');
        await pressBriefControl('voice-brief.close');
        await waitForTestEvent(screen!.subscribe, () => expect(screen?.findByTestId('voice-brief')).toBeNull());
        expect(lifecycle?.getSnapshot().status).toBe('connected');
    });

    it('renders real Inbox identities through the Brief projection and opens their exact Home destinations', async () => {
        const sessions = (['permission_required', 'failed', 'ready_after_read'] as const).map((reason, index) => createSessionFixture({
            id: `work-${index}`, serverId: account!.home.id, metadata: { path: '/repo', host: 'test', summary: { text: `Release captain ${index}`, updatedAt: 1 } },
            active: true, activeAt: 1_000,
            agentState: reason === 'permission_required' ? { controlledByUser: false, requests: {
                root: { tool: 'Bash', arguments: { command: 'ls' }, createdAt: 1 },
            } } : null,
            latestTurnStatus: 'completed', viewer: {
                latestFailureSeq: null,
                readState: { state: 'tracking', lastViewedSessionSeq: 0, unreadSince: null },
                relevance: { relevant: true, reasons: ['owned_by_me'] },
                follow: { follows: false, notificationLevel: null, includeInVoice: true },
                notification: { level: 'important', source: 'owner' },
                attention: { needsAttention: true, reasons: [reason], primary: reason, presentation: 'status_only' },
            },
        }));
        const brief = buildVoiceBrief({ inbox: {
            sessionPresentation: buildInboxSessionPresentation({ overview: buildActivityOverviewSnapshot({ sessions, nowMs: 1000 }) }),
            workGroups: [], automationAttentionItems: [], isLoading: false, showCaughtUp: false,
            workflowAttention: EMPTY_WORKFLOW_ATTENTION_SOURCE, automationAttention: EMPTY_WORKFLOW_ATTENTION_SOURCE,
            source: { isDataReady: true, personalSessionListCoverageComplete: true, sessionListHomeObservationByServerId: {} },
        }, settings: {} });
        const opened = vi.fn();
        screen = await renderScreen(<VoiceBriefList brief={brief} onOpen={opened} />);
        expect(screen.findAllByType(Item)).toHaveLength(3);
        for (const session of sessions) {
            const address = { serverId: account!.home.id, sessionId: session.id };
            const testID = `voice-brief.item.${sessionAddressKey(address)}`;
            const row = screen.findAllByType(Item).find(item => item.props.testID === testID);
            expect(row?.props.title).toBe(readInboxSessionTitle(session, address.serverId));
            if (session.viewer?.attention.primary === 'permission_required') {
                expect(row?.props.subtitle).toContain(t('voiceMoments.briefWantsTo', {
                    action: t('voiceMoments.briefRunCommand', { command: 'ls' }),
                }));
                expect(screen.getTextContent()).toContain(row?.props.subtitle);
            }
            await screen.pressByTestIdAsync(testID);
            expect(opened.mock.lastCall?.[0].destination).toEqual({ kind: 'session', address });
        }
    });
    it('shows repeated occurrences once until expanded, retaining every exact destination', async () => {
        const items: VoiceBriefItem[] = Array.from({ length: 300 }, (_, index) => ({
            key: `run-${index}`, category: 'needs_you', title: 'Do an action',
            subtitle: 'Choose a deployment target', destination: { kind: 'workflow', runId: `run-${index}` },
        }));
        const opened = vi.fn();
        const screen = await renderScreen(<VoiceBriefList brief={{ items, incomplete: false, caughtUp: false }} onOpen={opened} />);
        const disclosure = screen.findAllByType(CountedDisclosureItem);
        expect(disclosure).toHaveLength(1);
        expect(disclosure[0].props.count).toBe(300);
        expect(screen.findByTestId('voice-brief.item.run-299')).toBeNull();
        const header = screen.findAllByTestId('voice-brief.occurrences.run-0.header')
            .find(node => typeof node.type === 'string' && typeof node.props.onPress === 'function')!;
        await screen.pressByTestIdAsync(header.props.testID);
        await screen.pressByTestIdAsync('voice-brief.item.run-299');
        expect(opened).toHaveBeenLastCalledWith(items[299]);
        await screen.unmount();
    });

    it('keeps different reasons separate even when their action titles match', async () => {
        const items: VoiceBriefItem[] = ['Choose a region', 'Choose an account'].flatMap((subtitle, group) =>
            Array.from({ length: 2 }, (_, index) => ({ key: `${group}-${index}`, category: 'needs_you' as const,
                title: 'Do an action', subtitle, destination: { kind: 'workflow' as const, runId: `${group}-${index}` } })));
        const screen = await renderScreen(<VoiceBriefList brief={{ items, incomplete: false, caughtUp: false }} onOpen={() => {}} />);
        expect(screen.findAllByType(CountedDisclosureItem).map(node => node.props.subtitle)).toEqual(['Choose a region', 'Choose an account']);
        await screen.unmount();
    });

    it('does not mount request controllers for rows without an answerable request', async () => {
        const item: VoiceBriefItem = { key: 'inactive', category: 'needs_you', title: 'Review the changes',
            destination: { kind: 'session', address: { serverId: 'home-a', sessionId: 'inactive' } } };
        const screen = await renderScreen(<VoiceBriefList brief={{ items: [item], incomplete: false, caughtUp: false }} onOpen={() => {}} />);
        expect(screen.findAllByType(VoiceNeedsYouPrompts)).toHaveLength(0);
        expect(screen.findByTestId('voice-brief.item.inactive')).toBeTruthy();
        await screen.unmount();
    });

    it('opens and closes the mounted glance explicitly without changing its live conversation', async () => {
        const speech = await installTransport();
        await selectService();
        void lifecycle?.toggle(null);
        await speech.connect();
        expect(setVoiceGlanceOpen(true)).toBe(false);
        // Browser event APIs are the boundary; the mounted Glance/Popover stay real.
        restorePopoverGlobals = withPopoverWebGlobals();
        screen = await renderScreen(<AuthProvider initialCredentials={account!.credentials}><Presentation /></AuthProvider>);
        await act(async () => { expect(setVoiceGlanceOpen(true)).toBe(true); });
        expect(screen.findByTestId('voice-top-bar-label')?.props['aria-expanded']).toBe(true);
        await act(async () => { expect(setVoiceGlanceOpen(true)).toBe(true); });
        expect(screen.findByTestId('voice-top-bar-label')?.props['aria-expanded']).toBe(true);
        await act(async () => { expect(setVoiceGlanceOpen(false)).toBe(true); });
        expect(screen.findByTestId('voice-top-bar-label')?.props['aria-expanded']).toBe(false);
        expect(lifecycle?.getSnapshot().status).toBe('connected');
        expect(speech.starts).toHaveLength(1);
        await screen.unmount(); screen = null;
        expect(setVoiceGlanceOpen(true)).toBe(false);
    });
    it('opens the demand-mounted Inbox from the Home Action and reports unavailable without a current Home', async () => {
        const speech = await installTransport();
        await selectService();
        expect(executeVoiceBriefOperation('request')).toEqual({ ok: false, errorCode: 'voice_brief_unavailable' });
        screen = await renderScreen(renderHome(false));
        expect(executeVoiceBriefOperation('request')).toEqual({ ok: false, errorCode: 'voice_brief_unavailable' });
        await screen.update(renderHome());
        expect(speech.starts).toHaveLength(0);
        expect(screen.findAllByTestId('voice-brief')).toHaveLength(0);
        let outcome;
        await act(async () => { outcome = executeVoiceBriefOperation('request'); });
        expect(outcome).toEqual({ ok: true, result: { status: 'waiting', attemptId: null } });
        expect(screen.findByTestId('voice-brief')).toBeTruthy();
        await speech.waitForStart();
        expect(speech.starts).toHaveLength(1);
        await act(async () => speech.connect());
        expect(speech.spoken).toHaveLength(1);
        expectApprovalGuidance(speech.spoken[0]);
        await act(async () => { outcome = executeVoiceBriefOperation('close'); });
        expect(outcome).toEqual({ ok: true, result: { status: 'closed', attemptId: getVoiceSessionPresentedAttemptId() } });
        expect(screen.findByTestId('voice-brief')).toBeNull();
        expect(lifecycle?.getSnapshot().status).toBe('connected');
        expect(executeVoiceBriefOperation('close')).toEqual({ ok: false, errorCode: 'voice_brief_unavailable' });
        await act(async () => lifecycle?.stop(VOICE_AGENT_GLOBAL_SESSION_ID));
        await act(async () => { outcome = executeVoiceBriefOperation('request'); });
        await speech.waitForStarts(2);
        expect(speech.starts).toHaveLength(2);
        await pressBriefControl('voice-brief.close');
        await act(async () => speech.connect());
        expect(speech.spoken).toHaveLength(1);
        expect(lifecycle?.getSnapshot().status).toBe('connected');
        expect(executeVoiceBriefOperation('retry')).toEqual({ ok: false, errorCode: 'voice_brief_unavailable' });
    });
    it('lets Actions request the same connected Brief and stop its turn without ending the conversation', async () => {
        const speech = await installTransport();
        await selectService();
        void lifecycle?.toggle(null);
        await speech.connect();
        screen = await renderScreen(render());
        const attemptId = getVoiceSessionAttemptId();
        await speech.waitForSpoken();
        let outcome;
        await act(async () => { outcome = executeVoiceBriefOperation('request', { expectedAttemptId: attemptId! }); });
        expect(outcome).toEqual({ ok: true, result: { status: 'sent', attemptId } });
        expect(speech.spoken).toHaveLength(2);
        expectApprovalGuidance(speech.spoken[1]);
        await act(async () => speech.startOutput());
        await act(async () => { outcome = executeVoiceBriefOperation('stop', { expectedAttemptId: attemptId! }); });
        expect(outcome).toEqual({ ok: true, result: { status: 'waiting', attemptId } });
        await speech.waitForInterrupted();
        expect(lifecycle?.getSnapshot().status).toBe('connected');
        expect(executeVoiceBriefOperation('retry')).toEqual({ ok: false, errorCode: 'voice_brief_not_retryable' });
        await screen.unmount(); screen = null;
        expect(executeVoiceBriefOperation('request')).toEqual({ ok: false, errorCode: 'voice_brief_unavailable' });
        expect(speech.spoken).toHaveLength(2);
    });

    it('rejects stale Actions and refuses a pending Brief when a different attempt connects', async () => {
        const speech = await installTransport();
        await selectService();
        screen = await renderScreen(render());
        await speech.waitForStart();
        const attemptId = getVoiceSessionAttemptId();
        expect(attemptId).not.toBeNull();
        expect(executeVoiceBriefOperation('stop', { expectedAttemptId: 'previous-attempt' })).toEqual({ ok: false, errorCode: 'stale_voice_attempt' });
        await act(async () => {
            await lifecycle?.stop(VOICE_AGENT_GLOBAL_SESSION_ID);
            void lifecycle?.toggle(null);
            await speech.connect();
        });
        expect(getVoiceSessionAttemptId()).not.toBe(attemptId);
        expect(speech.spoken).toHaveLength(0);
        expect(screen.findByTestId('voice-brief')).toBeTruthy();
    });

    it('refuses the old Inbox request after the canonical Account lifetime retires even when the same Account is renewed', async () => {
        const speech = await installTransport();
        await selectService();
        screen = await renderScreen(renderHome());
        const scope = getActiveServerAccountScope();
        expect(scope).not.toBeNull();
        let outcome;
        await act(async () => { outcome = executeVoiceBriefOperation('request'); });
        expect(outcome).toEqual({ ok: true, result: { status: 'waiting', attemptId: null } });
        expect(screen.findByTestId('voice-brief')).toBeTruthy();
        await speech.waitForStart();
        expect(speech.starts).toHaveLength(1);
        // Sync's reset owner calls this exact retirement hook. Renew without a
        // render so the old pending Inbox cannot rely on equal Account ids.
        retireActiveServerAccountScopeLifetime();
        expect(captureActiveServerAccountScopeCurrentness().isCurrent()).toBe(true);
        expect(getActiveServerAccountScope()).toEqual(scope);
        expect(executeVoiceBriefOperation('request')).toEqual({ ok: false, errorCode: 'voice_brief_unavailable' });
        await act(async () => speech.lateConnect());
        expect(speech.spoken).toHaveLength(0);
    });

    it('retires the admitted Home request if its Account lifetime changes before the Inbox mounts', async () => {
        const speech = await installTransport();
        await selectService();
        screen = await renderScreen(renderHome(true, false));
        await act(async () => {
            expect(executeVoiceBriefOperation('request')).toEqual({ ok: true, result: { status: 'waiting', attemptId: null } });
        });
        expect(screen.findByTestId('voice-brief')).toBeNull();
        expect(speech.starts).toHaveLength(0);
        retireActiveServerAccountScopeLifetime();
        expect(captureActiveServerAccountScopeCurrentness().isCurrent()).toBe(true);
        await screen.update(renderHome());
        await waitForTestEvent(screen!.subscribe, () => expect(screen?.findByTestId('voice-brief.retry')).toBeTruthy());
        expect(speech.starts).toHaveLength(0);
        expect(speech.spoken).toHaveLength(0);
    });

    it('retries through the mounted recovery owner and never starts on a settings repair alone', async () => {
        const speech = await installTransport();
        screen = await renderScreen(render());
        await act(async () => { expect(executeVoiceBriefOperation('request').ok).toBe(true); });
        await selectService();
        expect(speech.starts).toHaveLength(0);
        await act(async () => {
            expect(executeVoiceBriefOperation('retry').ok).toBe(true);
        });
        await speech.waitForStarts(1);
        expect(speech.starts).toHaveLength(1);
        await act(async () => speech.fail());
        await act(async () => {
            expect(executeVoiceBriefOperation('retry', { expectedAttemptId: getVoiceSessionPresentedAttemptId()! }).ok).toBe(true);
        });
        await speech.waitForStarts(2);
        expect(speech.starts).toHaveLength(2);
        expect(speech.starts[1]?.requestedTargetSessionAddress).toBeNull();
        await act(async () => speech.connect());
        expect(speech.spoken).toHaveLength(1);
        await act(async () => speech.fail());
        await act(async () => {
            expect(executeVoiceBriefOperation('retry').ok).toBe(true);
        });
        await speech.waitForStarts(3);
        expect(speech.starts).toHaveLength(3);
        await act(async () => speech.connect());
        expect(speech.spoken).toHaveLength(2);
    });
    it.each([true, false])('keeps Retry after a pending start ends without an error and delivers the retried Brief once (Voice approvals=%s)', async (canApproveRequests) => {
        const speech = await installTransport();
        await selectService(canApproveRequests);
        screen = await renderScreen(render());
        await speech.waitForStarts(1);
        await act(async () => lifecycle?.stop(VOICE_AGENT_GLOBAL_SESSION_ID));
        expect(lifecycle?.getSnapshot().status).toBe('disconnected');
        expect(speech.spoken).toHaveLength(0);
        expect(screen.findByTestId('voice-brief.retry')).toBeTruthy();
        await pressBriefControl('voice-brief.retry');
        await speech.waitForStarts(2);
        await act(async () => speech.connect());
        expect(speech.spoken).toHaveLength(1);
        expectApprovalGuidance(speech.spoken[0], canApproveRequests);
    });

    it('keeps the list with setup recovery, then explicitly retries one global start and delivers once on connect', async () => {
        const speech = await installTransport();
        screen = await renderScreen(render());
        expect(screen.findByTestId('voice-brief')).toBeTruthy();
        expect(screen.findByTestId('voice-brief.unavailable')).toBeTruthy();
        const recover = screen.findByTestId('voice-brief.recover');
        expect(recover).toBeTruthy();
        if (!recover) throw new Error('Voice recovery control missing');
        // The hint belongs to the button for assistive technology; it is never also body copy.
        expect(recover.props.accessibilityHint).toBeTruthy();
        expect(screen.getTextContent()).not.toContain(recover.props.accessibilityHint);
        expect(speech.starts).toHaveLength(0);
        await pressBriefControl('voice-brief.recover');
        expect(navigation.push).toHaveBeenCalled();
        await selectService();
        expect(speech.starts).toHaveLength(0);
        await pressBriefControl('voice-brief.retry');
        await speech.waitForStarts(1);
        expect(speech.starts).toHaveLength(1);
        expect(speech.starts[0]?.requestedTargetSessionAddress).toBeNull();
        expect(speech.spoken).toHaveLength(0);
        await act(async () => speech.connect());
        await act(async () => screen?.update(render()));
        await act(async () => speech.connect());
        expect(speech.spoken).toHaveLength(1);
        expectApprovalGuidance(speech.spoken[0]);
    });

    it('offers terminal failure recovery on the same global target and delivers once on reconnect', async () => {
        const speech = await installTransport();
        await selectService();
        void lifecycle?.toggle(null);
        await speech.connect();
        await speech.fail();
        screen = await renderScreen(render());
        expect(screen.findByTestId('voice-brief.unavailable')).toBeTruthy();
        await pressBriefControl('voice-brief.recover');
        await speech.waitForStarts(2);
        // The lifecycle owns terminal recovery: it restarts the retained global
        // binding, rather than asking a detached transport to retry itself.
        expect(speech.starts).toHaveLength(2);
        expect(speech.starts[1]?.requestedTargetSessionAddress).toBeNull();
        await act(async () => speech.connect());
        await act(async () => screen?.update(render()));
        expect(speech.spoken).toHaveLength(1);
    });

    it('resolves a brief on an existing conversation without starting another after End', async () => {
        const speech = await installTransport();
        await selectService();
        void lifecycle?.toggle(null);
        await speech.connect();
        screen = await renderScreen(render());
        await speech.waitForSpoken();
        await act(async () => lifecycle?.stop(VOICE_AGENT_GLOBAL_SESSION_ID));
        expect(speech.starts).toHaveLength(1);
        expect(speech.spoken).toHaveLength(1);
    });
});
