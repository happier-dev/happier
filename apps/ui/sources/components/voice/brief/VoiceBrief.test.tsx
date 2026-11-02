import { createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';

import { createPlainAccountEncryptionCurrentnessFixture, renderScreen, waitForTestEvent, type RenderScreenResult } from '@/dev/testkit';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { AuthProvider } from '@/auth/context/AuthContext';
import { storage } from '@/sync/domains/state/storage';
import { settingsParse } from '@/sync/domains/settings/settings';
import { voiceSettingsParse } from '@/sync/domains/settings/voiceSettings';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { buildServerFeaturesResponse } from '@/hooks/server/serverFeaturesTestUtils';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { setRuntimeFetch } from '@/utils/system/runtimeFetch';
import { registerVoiceAdapters, resetVoiceAdapterRegistryForTests } from '@/voice/session/voiceAdapterRegistry';
import { createVoiceSessionLifecycleController, type VoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleController';
import { setVoiceSessionLifecycleController } from '@/voice/session/voiceSessionLifecycleControllerStore';
import { setVoiceSessionSnapshot } from '@/voice/session/voiceSessionStore';
import { installVoiceWebRtcBrowserBoundary, TestVoiceWebRtcPeer } from '@/dev/testkit/harness/voiceWebRtcHarness';
import { loadSyncSingletonForTests } from '@/dev/testkit/harness/syncSingletonLoader';
import { createConnectedPurposeCatalogHttpBoundary } from '@/dev/testkit/harness/connectedAccountCatalogBoundary';
import { createSessionMetadataHttpBoundary } from '@/dev/testkit/harness/sessionMetadataHttpBoundary';
import { answerVoiceRealtimePreparationHttpRequest } from '@/dev/testkit/harness/voiceRealtimePreparationHttpBoundary';
import { createSessionFixture } from '@/dev/testkit';
import { createBundledConversationRuntimeHostLease, getCurrentBundledConversationRuntimeHost } from '@/voice/registry/bundledConversationRuntimeHost';
import { createExternalVoiceProviderActivationScope } from '@/voice/registry/externalVoiceProviderActivation.testkit';
import { getExternalVoiceProviderRegistration } from '@/voice/registry/externalVoiceProviderRegistrations';
import { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } from '@/voice/registry/generatedBundledVoiceRuntimeEntries';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import { saveAndUseAccountVoiceCredential, applyAccountVoiceCredentialSourceSelection } from '@/voice/credentials/accountVoiceCredential';
import { createRecipientContractDigestV1, createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol';
import { SessionMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { OPENAI_REALTIME_DEFAULT_SETTINGS } from '../../../../../../packages/plugins/openai/src/protocol/voice/settings';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { buildVoiceTranscriptHistorySessionMetadata, VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG } from '@/voice/persistence/voiceTranscriptHistorySession';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import type { SessionAddress } from '@/sync/domains/session/sessionAddress';
import { VoiceBriefBlock, VoiceBriefButton, VoiceBriefList } from './VoiceBrief';
import { buildVoiceBrief } from '@/voice/context/buildVoiceBrief';
import { formatVoiceApprovalGuidance } from '@/voice/context/contextFormatters';
import { buildActivityOverviewSnapshot } from '@/activity/attention/buildActivityOverviewSnapshot';
import { buildInboxSessionPresentation } from '@/activity/presentation/buildInboxSessionPresentation';
import { EMPTY_WORKFLOW_ATTENTION_SOURCE } from '@/hooks/inbox/useWorkflowAttentionSource';
import { readInboxSessionTitle } from '@/components/inbox/sessionAttention/inboxSessionPrivacy';
import { sessionAddressKey } from '@/sync/domains/session/sessionAddress';
import { Item } from '@/components/ui/lists/Item';
import { executeVoiceBriefOperation } from './voiceBriefActionRuntime';
import { getVoiceSessionAttemptId, getVoiceSessionPresentedAttemptId, resetVoiceSessionStoreForTests } from '@/voice/session/voiceSessionStore';
import { useVoiceBriefHomeRequest } from './useVoiceBriefRequest';
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
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ confirmResult: true }).module;
});

const entry = BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES.find(value => value.declaration.id === 'realtime-openai')!;
const historyId = 'brief-history';
let browser: ReturnType<typeof installVoiceWebRtcBrowserBoundary>;
let disposeRuntime: (() => Promise<void>) | null = null;
let observePeerCreated: (peer: TestVoiceWebRtcPeer) => void = () => {};

// Only browser media/WebRTC and provider HTTP are synthetic. The shipped leaf,
// credentials, registration, mic, conversation controller and lifecycle are real.
async function transport() {
    const peers = browser.peers;
    const starts: Array<{ requestedTargetSessionAddress: SessionAddress | null; controlSessionId: string }> = [];
    observePeerCreated = () => {
        const binding = voiceSessionBindingStore.getState().getByControlSessionId(VOICE_AGENT_GLOBAL_SESSION_ID);
        if (!binding) throw new Error('WebRTC started before its Voice conversation was bound');
        starts.push({ requestedTargetSessionAddress: binding.targetSessionAddress, controlSessionId: binding.controlSessionId });
    };
    const hostLease = createBundledConversationRuntimeHostLease();
    const scope = createExternalVoiceProviderActivationScope({
        pluginId: entry.pluginId, occurrenceId: 'brief-openai', declarations: [entry.declaration], hostPlatform: 'web',
        runtimeHost: {
            ...hostLease.host,
            createMicSession: () => browser.micSession,
        },
        isRuntimeHostCurrent: () => getCurrentBundledConversationRuntimeHost() === hostLease.host,
        hostBindingsByLocalId: { [entry.declaration.id]: { recipientContract: createBundledVoiceRecipientContract({ pluginId: entry.pluginId, declaration: entry.declaration }), descriptor: 'bundled' } },
    });
    const { loadBundledVoiceRuntimeActivate } = await import('@/dev/testkit/harness/builtinVoiceAdapters');
    (await loadBundledVoiceRuntimeActivate(entry))(scope.api);
    await scope.commit();
    const adapter = getExternalVoiceProviderRegistration(entry.providerId)?.adapter;
    if (!adapter) throw new Error('OpenAI Voice adapter was not activated');
    disposeRuntime = async () => { await scope.unwind(); hostLease.revoke(); };
    const messages = (role: string) => peers.flatMap(peer => peer.channel.sent.flatMap(value => {
        const event = JSON.parse(value) as { type: string; item?: { role: string; content: Array<{ text?: string }> } };
        return event.type === 'conversation.item.create' && event.item?.role === role
            ? event.item.content.flatMap(content => content.text ? [content.text] : []) : [];
    }));
    const usablePeer = () => browser.peerCreated(peers.at(-1)?.channel.readyState === 'closed'
        ? peers.length : Math.max(0, peers.length - 1));
    return { adapter, starts,
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
let lifecycle: VoiceSessionLifecycleController | null = null;
let unsubscribe: (() => void) | null = null;
let account: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
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
    await loadSyncSingletonForTests();
    resetVoiceSessionStoreForTests();
    navigation.push.mockReset();
    resetServerFeaturesClientForTests();
    setRuntimeFetch(vi.fn(async () => new Response(JSON.stringify(buildServerFeaturesResponse({ voiceEnabled: true })), {
        status: 200, headers: { 'content-type': 'application/json' },
    })));
    storage.setState({ ...initialState, settings: settingsParse({ voice: { providerId: 'off' } }) }, true);
    const purposes = createConnectedPurposeCatalogHttpBoundary();
    const sessions = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
    account = await restoreServerAccountForTest({ serverUrl: 'https://brief-account.example.test', credentialScope: 'restored-home', request: createSessionReadBatchFetchBoundary(async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(buildServerFeaturesResponse({ voiceEnabled: true }));
        if (path === '/v1/account/profile') return Response.json(AccountProfileSchema.parse({ id: 'account-a' }));
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v2/account/settings') return Response.json({ version: 1, content: { t: 'plain', v: { voice: { providerId: 'off' } } } });
        if (path.endsWith('/messages') && init?.method !== 'POST') return Response.json(SessionMessagesPageV1Schema.parse({ messages: [], hasMore: false }));
        const purposeResponse = await purposes.handle(url, init);
        if (purposeResponse) return purposeResponse;
        const preparation = answerVoiceRealtimePreparationHttpRequest(url, storage.getState().settings);
        if (preparation) return preparation;
        if (path === '/v1/sessions' && init?.method === 'POST') return sessions.createSessionFromPost(historyId, init);
        const sessionResponse = sessions.handle(url, init);
        if (sessionResponse) return sessionResponse;
        if (path === '/health') return Response.json({ status: 'ok' });
        return new Response('{}', { status: 404 });
    }) });
    // Cold restore starts Profile sync asynchronously; observe its real publication,
    // including after the preceding test deliberately retires the Account lifetime.
    await waitForTestEvent(storage.subscribe, getActiveServerAccountScope, scope => scope !== null);
    expect(getActiveServerAccountScope()).not.toBeNull();
    const scope = getActiveServerAccountScope();
    if (!scope) throw new Error('Brief Account was not restored');
    await purposes.hydrate(scope);
    observePeerCreated = () => {};
    browser = installVoiceWebRtcBrowserBoundary({ onCreatePeer: peer => observePeerCreated(peer) });
    vi.stubGlobal('fetch', vi.fn(async (url: string | URL | Request) => {
        const path = new URL(String(url)).pathname;
        if (path === '/v1/realtime/client_secrets') return Response.json({ value: 'ek_brief', expires_at: Math.floor(Date.now() / 1000) + 60,
            session: { type: 'realtime', object: 'realtime.session', id: 'brief-provider', model: OPENAI_REALTIME_DEFAULT_SETTINGS.model.id } });
        if (path === '/v1/realtime/calls') return new Response('v=0\r\na=brief-answer\r\n', { status: 201 });
        throw new Error(`Unexpected provider HTTP request: ${path}`);
    }));
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
    unsubscribe?.(); unsubscribe = null;
    await lifecycle?.dispose(); lifecycle = null;
    await disposeRuntime?.(); disposeRuntime = null;
    setVoiceSessionLifecycleController(null);
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
    const speech = await transport();
    registerVoiceAdapters([speech.adapter]);
    lifecycle = createVoiceSessionLifecycleController();
    setVoiceSessionLifecycleController(lifecycle);
    lifecycle.setConfiguredProviderId(entry.providerId);
    const controller = lifecycle;
    unsubscribe = controller.subscribe(() => setVoiceSessionSnapshot(controller.getSnapshot()));
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
    const recipient = createBundledVoiceRecipientContract({ pluginId: entry.pluginId, declaration: entry.declaration });
    if (!recipient) throw new Error('OpenAI recipient contract is missing');
    const voice = voiceSettingsParse({ providerId: entry.providerId, canApproveRequests, welcome: { enabled: false }, providers: { [entry.providerId]: { schemaVersion: 1, config: OPENAI_REALTIME_DEFAULT_SETTINGS } } });
    const saved = saveAndUseAccountVoiceCredential({ settings: settingsParse({ ...storage.getState().settings, voiceSettingsV1: voice }),
        contribution: { pluginId: entry.pluginId, localId: entry.declaration.id }, credentialSlotId: recipient.credentialSlot.id,
        expectedSettingsVersion: 1, currentDeclaration: entry.declaration, value: 'sk_brief', generateId: () => 'brief-secret', now: 1,
        expectedSecretId: null, expectedSecretUpdatedAt: null, approvedRecipientContractDigest: createRecipientContractDigestV1(recipient) });
    const selected = applyAccountVoiceCredentialSourceSelection({ settings: saved.settings, connectedPurposes: { v: 1, bindings: [] }, currentDeclaration: entry.declaration,
        mutation: { contribution: { pluginId: entry.pluginId, localId: entry.declaration.id }, credentialSlotId: recipient.credentialSlot.id, expectedSettingsVersion: 1, selection: { kind: 'savedSecret' } } });
    await act(async () => storage.setState({ settings: { ...selected.settings, voice: { ...voice, credentialBindings: selected.settings.voice.credentialBindings } } }));
    expect(storage.getState().settings.voice.providerId).toBe(entry.providerId);
}

function expectApprovalGuidance(message: string | undefined, canApproveRequests = true) {
    // Assert the complete canonical field, including its Native Codex exception,
    // without copying the formatter's policy prose into this composed test.
    const expected = JSON.stringify({ approval: formatVoiceApprovalGuidance(canApproveRequests) });
    expect(message).toContain(expected.slice(1, -1));
}

describe('mounted Voice Brief request', () => {
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
            await screen.pressByTestIdAsync(testID);
            expect(opened.mock.lastCall?.[0].destination).toEqual({ kind: 'session', address });
        }
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
        const attemptId = getVoiceSessionAttemptId();
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
