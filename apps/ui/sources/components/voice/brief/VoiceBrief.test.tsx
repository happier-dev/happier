import { CountedDisclosureItem } from '@/components/ui/lists/CountedDisclosureItem';
import { VoiceNeedsYouPrompts } from '@/components/voice/presence/VoiceNeedsYouPrompts';
import type { VoiceBriefItem } from '@/voice/context/buildVoiceBrief';
import { createCompactSessionListRowFixture, createSessionReadBatchFetchBoundary } from '@/dev/testkit/harness/sessionReadBatchHttpBoundary';
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
import { runtimeFetch, setRuntimeFetch } from '@/utils/system/runtimeFetch';
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
import { createPlainSessionByIdResponseFixture, createSessionOwnerViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture, createMachineReadBatchResponseFixture, createPlainMachineRowFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { BUNDLED_FIRST_PARTY_VOICE_CONVERSATION_RUNTIME_ENTRIES } from '@/voice/registry/generatedBundledVoiceRuntimeEntries';
import { createBundledVoiceRecipientContract } from '@/voice/credentials/voiceRecipientContract';
import { saveAndUseAccountVoiceCredential, applyAccountVoiceCredentialSourceSelection } from '@/voice/credentials/accountVoiceCredential';
import { createSessionOwnerMetadataV1, createPlainSessionOwnerMetadataEnvelopeV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { SessionMessagesPageV1Schema } from '@happier-dev/protocol/sessions/messages/sessionMessagesPageV1';
import { SessionCurrentProjectionRecordV1Schema } from '@happier-dev/protocol/sessions/listing/response';
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
import { buildInboxWorkGroups } from '@/activity/presentation/buildInboxWorkGroups';
import { buildInboxItems } from '@/components/inbox/inboxItems';
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
import { configureConnectedServerSocketBoundary, installDisconnectedServerSocketBoundary, restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { withPopoverWebGlobals } from '@/dev/testkit/harness/popoverHarness';
import { captureActiveServerAccountScopeCurrentness, getActiveServerAccountScope, retireActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { disconnectActiveServerConnectionIfCurrent } from '@/sync/runtime/orchestration/connectionManager';
import { normalizeActionsSettingsV1 } from '@happier-dev/protocol/actions/actionSettings';
import { decodeVoiceAssistantActions } from '@happier-dev/protocol/voice/actions';
import { createVoiceToolHandlers } from '@/voice/tools/handlers';
import { useInboxModel } from '@/hooks/inbox/useInboxModel';
import { createRenderCommitCounter, useRenderCommitCounter } from '@/dev/testkit/performance/counts';
import { ActivityPersonalSessionMembershipProvider, useActivityPersonalSessionMembership } from '@/activity/source/activityPersonalSessionMembership';
import { InboxSummaryProvider } from '@/hooks/inbox/useInboxSummary';
import { tryWriteServerEnabledBitInPlace } from '@happier-dev/protocol/features/serverEnabledBit';
import { computeVisibleSessionListIndex } from '@/sync/domains/session/listing/computeVisibleSessionListIndex';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { projectSessionListNeedsYou, retainSessionListPaneState, resetSessionListPaneRetentionForTests } from '@/components/sessions/shell/sessionListPaneRetention';
import { fetchAndApplySessionById } from '@/sync/engine/sessions/sessionById';
import { createCapturedServerReadTransport } from '@/sync/runtime/orchestration/serverScopedRpc/capturedServerReadTransport';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { buildActivityOverviewFromSource } from '@/activity/source/buildActivityOverviewFromSource';
import { areSessionValuesDeepEqual } from '@/sync/store/domains/areStoredSessionsEqual';

vi.mock('socket.io-client', async (importOriginal) => (
    await import('@/dev/testkit/harness/serverAccountConnectionHarness')
).createSocketIoClientBoundary(importOriginal));
installDisconnectedServerSocketBoundary();

const navigation = vi.hoisted(() => ({ push: vi.fn(), pathname: '/' }));
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock({ pathname: () => navigation.pathname, router: { push: navigation.push } }).module;
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
        get context() { return messages('system'); },
        get interrupted() { return peers.flatMap((peer, index) => peer.channel.sent.flatMap(value => JSON.parse(value).type === 'response.cancel' ? [starts[index]!.controlSessionId] : [])); },
        async waitForSpoken(count = 1) {
            const peer = await usablePeer();
            await peer.channel.controlSent(value => {
                const event = JSON.parse(value) as { type?: string; item?: { role?: string } };
                return event.type === 'conversation.item.create' && event.item?.role === 'user'
                    && messages('user').length >= count;
            });
            expect(messages('user')).toHaveLength(count);
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
let activityQueryRows: ReturnType<typeof createCompactSessionListRowFixture>[] = [];
let sessionHttp: ReturnType<typeof createSessionMetadataHttpBoundary>;
const SCALE_BRIEF_TEST = 'keeps projection-only Brief work local across a thousand admitted Sessions';
const SIDEBAR_BRIEF_TEST = 'sends the current sidebar ten through the real Home Brief entry with thirteen Account Sessions';
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
async function prepareBriefAccount(onlinePersonalQuery = false) {
    navigation.pathname = '/';
    resetSessionListPaneRetentionForTests();
    activityQueryRows = [];
    resetVoiceSessionStoreForTests();
    navigation.push.mockReset();
    resetServerFeaturesClientForTests();
    const features = buildServerFeaturesResponse({ voiceEnabled: true });
    if (onlinePersonalQuery) expect(tryWriteServerEnabledBitInPlace(features, 'sessions.filteredListing', true)).toBe(true);
    setRuntimeFetch(vi.fn(async () => new Response(JSON.stringify(features), {
        status: 200, headers: { 'content-type': 'application/json' },
    })));
    storage.setState({ ...initialState, settings: settingsParse({ voice: { providerId: 'off' } }) }, true);
    const purposes = createConnectedPurposeCatalogHttpBoundary();
    const sessions = sessionHttp = createSessionMetadataHttpBoundary(() => storage.getState().sessions);
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
        configureSocket: onlinePersonalQuery ? configureConnectedServerSocketBoundary : undefined,
        credentialScope: 'restored-home', request: createSessionReadBatchFetchBoundary(async (url, init) => {
        if (new URL(String(url)).origin === 'https://api.openai.com') return providerFetch(url, init);
        const path = new URL(String(url)).pathname;
        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(features);
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
        if (path === '/v2/sessions/query') {
            if (activityQueryRows.length > 0) console.info('Brief scale query response', JSON.stringify({ rows: activityQueryRows.length }));
            return Response.json({ sessions: activityQueryRows,
                hasNext: false, nextCursor: null, attentionHasNext: false, attentionNextCursor: null });
        }
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
}
beforeEach(({ task }) => prepareBriefAccount(task.name === SCALE_BRIEF_TEST || task.name === SIDEBAR_BRIEF_TEST
    || task.name.startsWith('delivers the Home needs-you facts from Settings')));
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
    resetSessionListPaneRetentionForTests();
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
    it('delivers the Home needs-you facts from Settings without a mounted Sessions sidebar', async () => {
        const serverId = account!.home.id;
        const session = createSessionFixture({ id: 'settings-brief-request', serverId,
            metadata: { path: '/project', host: 'test', summary: { text: 'Review deployment', updatedAt: 1 } },
            active: true, activeAt: Date.now(), pendingBlockedCount: 1, latestTurnStatus: 'completed' });
        activityQueryRows = [createCompactSessionListRowFixture({
            ...createPlainSessionByIdResponseFixture(session).session, viewer: createSessionOwnerViewerFixture(session),
        })];
        storage.getState().applySessions([{ ...session, viewer: createSessionOwnerViewerFixture(session) }]);
        const speech = await installTransport();
        await selectService();
        navigation.pathname = '/settings/voice';
        screen = await renderScreen(renderHome());
        await act(async () => { expect(executeVoiceBriefOperation('request').ok).toBe(true); });
        await speech.waitForStart();
        await act(async () => speech.connect());
        await speech.waitForSpoken();
        const context = speech.context.at(-1)?.match(/INBOX BRIEF\n\n(\{[^\n]+\})/);
        expect(context).not.toBeNull();
        const settingsBrief = JSON.parse(context![1]!);
        expect(settingsBrief.counts.needs_you).toBe(1);
        navigation.pathname = '/';
        await screen.unmount();
        screen = await renderScreen(renderHome());
        await act(async () => { expect(executeVoiceBriefOperation('request').ok).toBe(true); });
        await speech.waitForSpoken(2);
        const homeContext = speech.context.at(-1)?.match(/INBOX BRIEF\n\n(\{[^\n]+\})/);
        expect(JSON.parse(homeContext![1]!).counts.needs_you).toBe(settingsBrief.counts.needs_you);
    });
    it(SIDEBAR_BRIEF_TEST, async () => {
        const serverId = account!.home.id;
        const now = Date.now();
        const sessions = Array.from({ length: 13 }, (_, index) => {
            const session = createSessionFixture({ id: `sidebar-request-${index}`, serverId,
                metadata: { path: '/project', host: 'test', summary: { text: `Review deployment ${index}`, updatedAt: now } },
                active: true, activeAt: now, pendingBlockedCount: 1, latestTurnStatus: 'completed',
            });
            return { ...session, viewer: createSessionOwnerViewerFixture(session) };
        });
        activityQueryRows = sessions.map(session => createCompactSessionListRowFixture({
            ...createPlainSessionByIdResponseFixture(session).session, viewer: session.viewer,
        }));
        storage.getState().applySessions(sessions);
        const rows = new Map(sessions.map(session => [session.id, buildSessionListRenderableFromSession(session)]));
        const index = computeVisibleSessionListIndex({
            source: sessions.slice(0, 10).map(session => ({ type: 'session' as const, serverId, sessionId: session.id })),
            resolveSessionRow: (_serverId, id) => rows.get(id) ?? null,
            hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
            sessionListAttentionPlacementV1: 'both', attentionPlacement: { mode: 'global' },
            presentation: { enabled: false, presentation: 'grouped' }, nowMs: now,
        })!;
        const header = index.find(item => item.type === 'header' && item.headerKind === 'attention');
        expect(header?.type === 'header' ? header.eligibleCount : null).toBe(10);
        retainSessionListPaneState({ storageKind: 'all', pathname: '/', sourceScopeKey: 'brief-account-a',
            selectedServerIds: [serverId], queryMembershipActive: true, referenceCorpusActive: true,
            paneState: { summary: { sessionsReady: true, sessionCount: 10 }, visibleSessionListIndex: index,
                filterResult: { matchedCount: 10, coverage: 'complete' }, hasHiddenInactiveSessions: false,
                folderFeatureEnabledServerIds: [], showLoading: false, showEmptyState: false } });
        const speech = await installTransport();
        await selectService();
        screen = await renderScreen(<AuthProvider initialCredentials={account!.credentials}>
            <ActivityPersonalSessionMembershipProvider enabled><InboxSummaryProvider>
                <BriefHome available />
            </InboxSummaryProvider></ActivityPersonalSessionMembershipProvider>
        </AuthProvider>);
        // Home admits Brief before demand-mounting Inbox. Its sidebar total
        // does not wait for a separate Account census to hydrate.
        await act(async () => { expect(executeVoiceBriefOperation('request').ok).toBe(true); });
        await speech.waitForStart();
        await act(async () => speech.connect());
        await speech.waitForSpoken();
        const snapshot = speech.context.at(-1)?.match(/INBOX BRIEF\n\n(\{[^\n]+\})/);
        expect(snapshot).not.toBeNull();
        expect(JSON.parse(snapshot![1]!).counts.needs_you).toBe(10);
        expect(speech.spoken).toEqual([t('voiceMoments.briefMe')]);
        for (const excluded of sessions.slice(10)) {
            expect(screen.findByTestId(`voice-brief.item.${sessionAddressKey({ serverId, sessionId: excluded.id })}`)).toBeNull();
        }
    });
    it(SCALE_BRIEF_TEST, async () => {
        // Home's strict personal census is available only on an online, filtered-listing Home.
        expect(storage.getState().socketStatus).toBe('connected');
        const serverId = account!.home.id;
        const now = Date.now();
        const sessionCount = 1_000; // Existing Activity reference census, not a product limit.
        const sessions = Array.from({ length: sessionCount }, (_, index) => {
            const session = createSessionFixture({
            id: `brief-scale-${index}`, serverId, createdAt: now - 10_000, updatedAt: now - 1_000,
            activeAt: now - 1_000, lastViewedSessionSeq: 100,
            agentState: { requests: {}, completedRequests: {} },
            metadata: { path: `/repos/brief-scale-${index}`, host: 'test', machineId: 'brief-machine' },
            });
            return { ...session, viewer: createSessionOwnerViewerFixture(session) };
        });
        const records = sessions.map(session => SessionCurrentProjectionRecordV1Schema.parse({
            ...createPlainSessionByIdResponseFixture(session).session, viewer: session.viewer,
        }));
        for (const record of records) sessionHttp.replaceSession(record.id, record);
        activityQueryRows = records.map(createCompactSessionListRowFixture);
        // Current compact rows and full owner documents share one real HTTP tuple.
        // The by-ID owner opens/adopts that tuple; the fixture never fabricates admission.
        const readTransport = createCapturedServerReadTransport({ serverId,
            profile: { serverUrl: account!.home.serverUrl }, credentials: account!.credentials });
        let observePublications = (values: Parameters<Parameters<typeof fetchAndApplySessionById>[0]['applySessions']>[0]) => values;
        const applySessions: Parameters<typeof fetchAndApplySessionById>[0]['applySessions'] = values => storage.getState().applySessions(observePublications(values));
        const sessionDataKeys = new Map<string, Uint8Array>();
        const hydrate = (sessionId: string) => fetchAndApplySessionById({
            sessionId, serverId, credentials: account!.credentials,
            accountCurrentness: createPlainAccountEncryptionCurrentnessFixture(),
            encryption: { decryptEncryptionKey: async () => null, initializeSessions: async () => {}, getSessionEncryption: () => null },
            sessionDataKeys, includeTurnsProjection: false, readTransport,
            request: (path, init) => runtimeFetch(new URL(path, account!.home.serverUrl).href, init),
            applySessions, getExistingSession: id => storage.getState().sessions[id], log: { log() {} },
        });
        const hydration = await Promise.all(sessions.map(session => hydrate(session.id)));
        expect(hydration.every(result => result.ok)).toBe(true);
        const admitted = storage.getState().sessions;
        for (const row of activityQueryRows) {
            expect(admitted[row.id]?.metadataLayoutVersion).toBe(row.metadataLayoutVersion);
            expect(readSessionOwnerMetadataView(admitted[row.id]!)).not.toBeNull();
        }
        const firstId = sessions[0]!.id;
        const one = buildActivityOverviewFromSource({ nowMs: now, source: {
            isDataReady: true, sessionsById: { [firstId]: admitted[firstId]! },
            sessionListRowsByServerId: storage.getState().sessionListRowsByServerId,
            ordinarySessionListMembershipByServerId: { [serverId]: [firstId] },
            personalSessionListMembershipByServerId: { [serverId]: [firstId] },
            sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {}, activeServerId: serverId,
        } });
        expect(one.candidates).toHaveLength(1);

        const sidebarRows = new Map(sessions.map(session => [session.id, buildSessionListRenderableFromSession(session)]));
        const retainSidebar = () => retainSessionListPaneState({ storageKind: 'all', pathname: '/',
            sourceScopeKey: 'brief-scale', selectedServerIds: [serverId], queryMembershipActive: true,
            referenceCorpusActive: true, paneState: {
                summary: { sessionsReady: true, sessionCount },
                visibleSessionListIndex: computeVisibleSessionListIndex({
                    source: sessions.map(session => ({ type: 'session' as const, serverId, sessionId: session.id })),
                    resolveSessionRow: (_serverId, id) => sidebarRows.get(id) ?? null,
                    hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
                    sessionListAttentionPlacementV1: 'both', attentionPlacement: { mode: 'global' },
                    presentation: { enabled: false, presentation: 'grouped' }, nowMs: now,
                }),
                filterResult: { matchedCount: sessionCount, coverage: 'complete' },
                hasHiddenInactiveSessions: false, folderFeatureEnabledServerIds: [], showLoading: false, showEmptyState: false,
            } });
        retainSidebar();
        const previousStackLimit = Error.stackTraceLimit;
        Error.stackTraceLimit = 80;
        const overviewReads = new Set<string>();
        const metadataRowsRead = new Set<string>();
        let overviewMetadataPathReads = 0;
        let metadataPathReads = 0;
        // Observe reads of real input records; Activity, storage, Inbox and Brief remain real.
        const observeMetadata = (id: string, metadata: NonNullable<ReturnType<typeof readSessionOwnerMetadataView>>) => new Proxy(metadata, {
            get(target, key, receiver) {
                if (key === 'path') {
                    metadataPathReads += 1;
                    metadataRowsRead.add(id);
                }
                if (key === 'path' && /buildActivityOverviewFromSource\.tsx?:/.test(new Error().stack ?? '')) {
                    overviewReads.add(id);
                    overviewMetadataPathReads += 1;
                }
                return Reflect.get(target, key, receiver);
            },
        });
        const observedMetadata = new Map(sessions.map(seed => [seed.id,
            observeMetadata(seed.id, readSessionOwnerMetadataView(admitted[seed.id]!)!)]));
        // Keep the read census attached when the genuine HTTP owner publishes a new document.
        observePublications = values => values.map(session => {
            const metadata = readSessionOwnerMetadataView(session);
            return metadata && session.id.startsWith('brief-scale-')
                ? { ...session, ownerMetadataView: observeMetadata(session.id, metadata) } : session;
        });
        const state = storage.getState();
        storage.setState({
            sessions: Object.fromEntries(Object.entries(state.sessions).map(([id, session]) => [id,
                observedMetadata.has(id) ? { ...session, ownerMetadataView: observedMetadata.get(id)! } : session])),
            sessionListRowsByServerId: { ...state.sessionListRowsByServerId, [serverId]: Object.fromEntries(
                Object.entries(state.sessionListRowsByServerId[serverId] ?? {}).map(([id, row]) => [id,
                    observedMetadata.has(id) ? { ...row, metadata: observedMetadata.get(id)! } : row]),
            ) },
        });
        const commits = createRenderCommitCounter();
        let latestBrief: ReturnType<typeof useVoiceBriefRequest>['brief'] | undefined;
        let latestInbox: ReturnType<typeof useInboxModel> | undefined;
        let latestMembership: ReturnType<typeof useActivityPersonalSessionMembership> | undefined;
        let inboxPublications = 0;
        function InboxObserver() {
            const inbox = useInboxModel();
            const membership = useActivityPersonalSessionMembership();
            React.useLayoutEffect(() => { latestInbox = inbox; });
            React.useLayoutEffect(() => {
                latestMembership = membership;
                console.info('Brief scale admitted census', JSON.stringify({
                    personalMembership: membership.membershipByServerId[serverId]?.length ?? 0,
                    personalPhase: membership.statesByServerId[serverId]?.phase,
                    candidates: inbox.sessionCandidates.filter(candidate => candidate.sessionId.startsWith('brief-scale-')).length,
                }));
            }, [membership]);
            React.useLayoutEffect(() => { inboxPublications += 1; }, [inbox]);
            return null;
        }
        function Probe() {
            useRenderCommitCounter(commits);
            const { brief } = useVoiceBriefRequest();
            React.useLayoutEffect(() => { latestBrief = brief; });
            return <VoiceBriefList brief={brief} onOpen={() => {}} />;
        }
        let sessionPublications = 0;
        let rowPublications = 0;
        let messagePublications = 0;
        let storeNotifications = 0;
        const stop = storage.subscribe((next, previous) => {
            storeNotifications += 1;
            if (next.sessions !== previous.sessions) sessionPublications += 1;
            if (next.sessionListRowsByServerId !== previous.sessionListRowsByServerId) rowPublications += 1;
            if (next.sessionMessages !== previous.sessionMessages) messagePublications += 1;
        });
        const matrix: Record<string, unknown>[] = [];
        const capture = async (phase: string, update: () => void | Promise<unknown>) => {
            overviewReads.clear();
            overviewMetadataPathReads = 0;
            metadataPathReads = 0;
            metadataRowsRead.clear();
            commits.reset();
            sessionPublications = 0;
            rowPublications = 0;
            messagePublications = 0;
            storeNotifications = 0;
            inboxPublications = 0;
            const before = latestBrief;
            const beforeSession = storage.getState().sessions[sessions[42]!.id]!;
            const beforeSource = latestInbox!.source;
            const beforeRevision = storage.getState().sessionListRenderableDelta?.revision;
            const previousCandidates = new Map(latestInbox!.sessionCandidates.map(candidate => [candidate.sessionId, candidate]));
            await act(async () => { await update(); });
            const afterSession = storage.getState().sessions[beforeSession.id]!;
            const result = { phase, storeNotifications, sessionPublications, rowPublications, messagePublications,
                inboxPublications, ...commits.read(),
                changedSessionFields: [...new Set([...Reflect.ownKeys(beforeSession), ...Reflect.ownKeys(afterSession)])]
                    .filter(key => Object.hasOwn(beforeSession, key) !== Object.hasOwn(afterSession, key)
                        || !areSessionValuesDeepEqual(Reflect.get(beforeSession, key), Reflect.get(afterSession, key)))
                    .map(String),
                changedSourceFields: (Object.keys(latestInbox!.source) as Array<keyof typeof beforeSource>)
                    .filter(key => beforeSource[key] !== latestInbox!.source[key]),
                rowRevisionAdvanced: storage.getState().sessionListRenderableDelta?.revision !== beforeRevision,
                targetSessionSeq: afterSession.seq,
                targetCandidateSeq: latestInbox!.sessionCandidates.find(candidate => candidate.sessionId === beforeSession.id)?.session.seq,
                overviewRowsRead: overviewReads.size, overviewMetadataPathReads, briefValueRetained: latestBrief === before,
                replacedCandidates: latestInbox!.sessionCandidates.filter(candidate => candidate.sessionId.startsWith('brief-scale-')
                    && previousCandidates.get(candidate.sessionId) !== candidate).length,
                metadataPathReads,
                metadataRowsRead: metadataRowsRead.size,
                sourceCensus: Object.keys(latestInbox!.source.sessionsById).filter(id => id.startsWith('brief-scale-')).length,
                candidates: latestInbox!.sessionCandidates.filter(candidate => candidate.sessionId.startsWith('brief-scale-')).length,
                inboxNeedsYou: latestInbox!.sessionPresentation.sessionsNeedingAttention
                    .filter(entry => entry.candidate.sessionId.startsWith('brief-scale-')).length,
                targetAttentionReasons: storage.getState().sessions[beforeSession.id]?.viewer?.attention.reasons,
                needsYou: latestBrief!.items.filter(item => item.category === 'needs_you').length };
            matrix.push(result);
            console.info('Brief projection cost phase', JSON.stringify(result));
            return result;
        };
        try {
            screen = await renderScreen(<AuthProvider initialCredentials={account!.credentials}>
                <ActivityPersonalSessionMembershipProvider enabled><InboxSummaryProvider>
                    <InboxModelBoundary><InboxObserver /><Probe /></InboxModelBoundary>
                </InboxSummaryProvider></ActivityPersonalSessionMembershipProvider>
            </AuthProvider>);
            console.info('Brief scale mounted census', JSON.stringify({
                source: Object.keys(latestInbox?.source.sessionsById ?? {}).filter(id => id.startsWith('brief-scale-')).length,
                candidates: latestInbox?.sessionCandidates.filter(candidate => candidate.sessionId.startsWith('brief-scale-')).length ?? 0,
                queriedRows: activityQueryRows.length,
                personalMembership: latestMembership?.membershipByServerId[serverId]?.length ?? 0,
                personalPhase: latestMembership?.statesByServerId[serverId]?.phase,
            }));
            await waitForTestEvent(screen.subscribe, () => expect(latestInbox?.sessionCandidates
                .filter(candidate => candidate.sessionId.startsWith('brief-scale-'))).toHaveLength(sessionCount));
            await waitForTestEvent(screen.subscribe, () => expect(latestInbox?.isLoading).toBe(false));
            expect(latestInbox!.sessionCandidates.filter(candidate => candidate.sessionId.startsWith('brief-scale-'))).toHaveLength(sessionCount);
            console.info('Brief scale settled census', JSON.stringify({
                source: Object.keys(latestInbox!.source.sessionsById).filter(id => id.startsWith('brief-scale-')).length,
                candidates: sessionCount, overviewRowsRead: overviewReads.size, overviewMetadataPathReads,
                personalMembership: latestMembership?.membershipByServerId[serverId]?.length ?? 0,
            }));
            expect(overviewReads.size).toBe(sessionCount);
            expect(latestBrief!.items).toHaveLength(0);
            const targetId = sessions[42]!.id;
            await capture('direct normalized replay (diagnostic)', () => {
                storage.getState().applySessions([{ ...storage.getState().sessions[targetId]! }]);
            });
            // The HTTP owner receives the original server facts, never a client-normalized shell.
            await act(async () => { expect((await hydrate(targetId)).ok).toBe(true); });
            const identical = await capture('identical HTTP hydration', () => hydrate(targetId));
            const progress = await capture('sequence-only progress', () => {
                const target = storage.getState().sessions[targetId]!;
                storage.getState().applySessions([{ ...target, seq: target.seq + 1 }]);
            });
            const message = await capture('message-only progress', () => {
                const applied = storage.getState().applyMessages(targetId, [{ id: 'brief-scale-message', localId: null,
                    seq: storage.getState().sessions[targetId]!.seq + 1, createdAt: Date.now(),
                    isSidechain: false, role: 'user', content: { type: 'text', text: 'Fixture follow-up' } }]);
                expect(applied.changed.length).toBeGreaterThan(0);
            });
            expect(storage.getState().sessionMessages[targetId]?.messageIdsOldestFirst).toHaveLength(1);
            expect(latestInbox!.source.sessionMessagesById?.[targetId]).toBe(storage.getState().sessionMessages[targetId]);
            expect(message.messagePublications).toBeGreaterThan(0);
            const attention = await capture('new permission request', async () => {
                const target = storage.getState().sessions[targetId]!;
                const changed = { ...target, viewer: undefined, agentStateVersion: target.agentStateVersion + 1,
                    pendingPermissionRequestCount: 1, pendingVersion: (target.pendingVersion ?? 0) + 1,
                    updatedAt: Date.now(), agentState: { requests: {
                        req_1: { tool: 'Bash', kind: 'permission' as const, arguments: {}, createdAt: Date.now() },
                    }, completedRequests: {} } };
                const next = { ...changed, viewer: createSessionOwnerViewerFixture(changed) };
                const record = SessionCurrentProjectionRecordV1Schema.parse({ ...createPlainSessionByIdResponseFixture(next).session, viewer: next.viewer });
                sessionHttp.replaceSession(next.id, record);
                activityQueryRows = activityQueryRows.map(row => row.id === next.id ? createCompactSessionListRowFixture(record) : row);
                expect((await hydrate(next.id)).ok).toBe(true);
                sidebarRows.set(next.id, buildSessionListRenderableFromSession(storage.getState().sessions[next.id]!));
                retainSidebar();
            });
            console.info('Brief projection cost matrix', JSON.stringify(matrix));
            expect(identical).toMatchObject({ sessionPublications: 0, rowPublications: 0, inboxPublications: 0, commits: 0, overviewRowsRead: 0 });
            // The full Inbox carries raw sequence facts for current Actions and may publish them.
            // Its classification work and candidate replacement follow the changed address.
            expect(progress).toMatchObject({ sourceCensus: sessionCount, candidates: sessionCount, needsYou: 0 });
            expect(progress.overviewRowsRead).toBeLessThanOrEqual(1);
            expect(progress.metadataRowsRead).toBeLessThanOrEqual(1);
            expect(progress.replacedCandidates).toBeLessThanOrEqual(1);
            expect(progress.targetCandidateSeq).toBe(progress.targetSessionSeq);
            expect(message).toMatchObject({ sourceCensus: sessionCount, candidates: sessionCount, needsYou: 0 });
            expect(message.overviewRowsRead).toBeLessThanOrEqual(1);
            expect(message.metadataRowsRead).toBeLessThanOrEqual(1);
            expect(message.replacedCandidates).toBeLessThanOrEqual(1);
            expect(message.targetCandidateSeq).toBe(message.targetSessionSeq);
            expect(attention).toMatchObject({ sourceCensus: sessionCount, candidates: sessionCount, needsYou: 1 });
            expect(attention.overviewRowsRead).toBeLessThanOrEqual(1);
            expect(attention.metadataRowsRead).toBeLessThanOrEqual(1);
            expect(attention.replacedCandidates).toBeLessThanOrEqual(1);

            // A separate measurement: one public Home press through real admission,
            // Runtime startup and Brief delivery, at the same admitted census.
            await screen.unmount();
            screen = null;
            const speech = await installTransport();
            await selectService();
            const homeCounter = createRenderCommitCounter();
            let briefSubtreeCommits = 0;
            function MeasuredHome() {
                useRenderCommitCounter(homeCounter);
                const [open, setOpen] = React.useState(false);
                useVoiceBriefHomeRequest({ available: true, onOpen: () => setOpen(true) });
                return <><VoiceBriefButton open={open} />{open ? <React.Profiler id="scale-public-Brief"
                    onRender={() => { briefSubtreeCommits += 1; }}>
                    <InboxModelBoundary><InboxObserver /><VoiceBriefBlock onClose={() => setOpen(false)} /></InboxModelBoundary>
                </React.Profiler> : null}</>;
            }
            screen = await renderScreen(<AuthProvider initialCredentials={account!.credentials}>
                <ActivityPersonalSessionMembershipProvider enabled><InboxSummaryProvider>
                    <MeasuredHome />
                </InboxSummaryProvider></ActivityPersonalSessionMembershipProvider>
            </AuthProvider>);
            homeCounter.reset();
            sessionPublications = rowPublications = messagePublications = storeNotifications = inboxPublications = 0;
            overviewReads.clear();
            overviewMetadataPathReads = 0;
            await pressBriefControl('home-brief-me');
            await speech.waitForStarts(1);
            await act(async () => speech.connect());
            await speech.waitForSpoken();
            console.info('Brief public operation cost', JSON.stringify({
                phase: 'Home press through delivered Brief', sourceCensus: Object.keys(latestInbox!.source.sessionsById)
                    .filter(id => id.startsWith('brief-scale-')).length,
                candidates: latestInbox!.sessionCandidates.filter(candidate => candidate.sessionId.startsWith('brief-scale-')).length,
                storeNotifications, sessionPublications, rowPublications, messagePublications, inboxPublications,
                homeHost: homeCounter.read(), briefSubtreeCommits,
                overviewRowsRead: overviewReads.size, overviewMetadataPathReads,
                providerStarts: speech.starts.length, deliveredBriefs: speech.spoken.length,
            }));
            expect(latestInbox!.sessionCandidates.filter(candidate => candidate.sessionId.startsWith('brief-scale-'))).toHaveLength(sessionCount);
            expect(briefSubtreeCommits).toBeGreaterThan(0);
            expect(screen.findByTestId('voice-brief')).toBeTruthy();
            expect(speech.spoken).toEqual([t('voiceMoments.briefMe')]);
        } finally {
            stop();
            Error.stackTraceLimit = previousStackLimit;
        }
    });

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
            alwaysShowContextSize: !storage.getState().settings.alwaysShowContextSize,
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
        const sessionPresentation = buildInboxSessionPresentation({ overview: buildActivityOverviewSnapshot({ sessions, nowMs: 1000 }) });
        const workGroups = buildInboxWorkGroups({ sessionEntries: sessionPresentation.sessionsNeedingAttention,
            workflowRuns: [], automationRuns: [], automationServerId: null, openApprovals: [], stalledSessions: [], landings: [], snoozed: [],
            resolveSession: () => null, resolveOriginRunId: () => null });
        const rows = new Map(sessions.map(session => [session.id, buildSessionListRenderableFromSession(session)]));
        const needsYouShelf = projectSessionListNeedsYou({ showLoading: false,
            filterResult: { matchedCount: sessions.length, coverage: 'complete' },
            visibleSessionListIndex: computeVisibleSessionListIndex({
                source: sessions.map(session => ({ type: 'session' as const, serverId: account!.home.id, sessionId: session.id })),
                resolveSessionRow: (_serverId, id) => rows.get(id) ?? null,
                hideInactiveSessions: false, pinnedSessionKeysV1: [], sessionListGroupOrderV1: {},
                sessionListAttentionPlacementV1: 'both', attentionPlacement: { mode: 'global' },
                presentation: { enabled: false, presentation: 'grouped' }, nowMs: 1000,
            }),
        });
        const brief = buildVoiceBrief({ inbox: {
            sessionPresentation, workGroups, needsYouShelf,
            items: buildInboxItems({ sessionPresentation, workGroups, workflowServerId: account!.home.id, accountServerId: account!.home.id, notices: [] }),
            openApprovals: [], openUsageNotices: [], actionOperationEntries: [], friendRequests: [],
            automationAttentionItems: [], isLoading: false, showCaughtUp: false,
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
    it('keeps a real unavailable Brief reason in the public Action failure', async () => {
        const { ActionExecuteFailureSchema } = await import('@happier-dev/protocol/actions/actionExecutionResult');
        const outcome = executeVoiceBriefOperation('request');
        expect(outcome.ok).toBe(false);
        if (outcome.ok) throw new Error('Expected missing Brief host');
        const failure = ActionExecuteFailureSchema.parse({ ...outcome, error: outcome.errorCode });
        const { redactVoiceActionExecutionResultForProvider } = await import('@/voice/context/redactVoiceToolResult');
        expect(redactVoiceActionExecutionResultForProvider('requestVoiceBrief', failure, {
            shareFilePaths: false, shareSessionSummary: false, sharePermissionRequests: false,
        })).toMatchObject({ details: { retryable: false }, failureCause: { phase: 'ui.voice_global.brief.host' } });
        expect(failure).toMatchObject({ errorCode: 'voice_brief_unavailable', details: { retryable: false },
            failureCause: { phase: 'ui.voice_global.brief.host' } });
    });

    it('routes the admitted Voice Brief Action from outside Home to the existing Brief data producer', async () => {
        const speech = await installTransport();
        await selectService();
        const { router } = await import('expo-router');
        setActionPolicy({ v: 1, approvalWaivedSurfaces: { 'ui.voice_global.brief.request': ['voice'] } });
        const handlers = createVoiceToolHandlers({ resolveSessionId: () => null, currentServerId: account!.home.id });
        let showHome: (() => void) | undefined;
        function Route() {
            const [home, setHome] = React.useState(false);
            showHome = () => setHome(true);
            return home ? <BriefHome available /> : null;
        }
        vi.mocked(router.push).mockImplementation(() => showHome?.());
        screen = await renderScreen(<AuthProvider initialCredentials={account!.credentials}><Route /></AuthProvider>);
        await act(async () => {
            const result = JSON.parse(await handlers.requestVoiceBrief!({}, { turnOrigin: 'person' }));
            expect(result).toMatchObject({ ok: true });
        });
        expect(router.push).toHaveBeenCalledWith('/');
        await speech.waitForStart();
        await act(async () => speech.connect());
        await speech.waitForSpoken();
        expect(speech.context.at(-1)).toContain('INBOX BRIEF');
        expect(speech.spoken).toEqual([t('voiceMoments.briefMe')]);
        vi.mocked(router.push).mockReset();
    });

    it.each([false, true])('parks the spoken Brief before Home mounts and replays only for the same Account (switch=%s)', async (switchAccount) => {
        const speech = await installTransport();
        await selectService();
        const { router } = await import('expo-router');
        setActionPolicy({ v: 1, approvalWaivedSurfaces: { 'ui.voice_global.brief.request': ['voice'] } });
        const handlers = createVoiceToolHandlers({ resolveSessionId: () => null, currentServerId: account!.home.id });
        // Navigation completes before React mounts Home: this exercises the parked
        // request, rather than the already-mounted Home's Inbox retirement path.
        vi.mocked(router.push).mockImplementation(() => {});
        screen = await renderScreen(<AuthProvider initialCredentials={account!.credentials}>{null}</AuthProvider>);
        let replacement: Awaited<ReturnType<typeof restoreServerAccountForTest>> | null = null;
        try {
            await act(async () => {
                expect(JSON.parse(await handlers.requestVoiceBrief!({}, { turnOrigin: 'person' }))).toMatchObject({ ok: true });
            });
            expect(router.push).toHaveBeenCalledWith('/');
            expect(speech.starts).toHaveLength(0);
            if (switchAccount) {
                const settings = createAccountSettingsHttpBoundary({ serverUrl: account!.home.serverUrl,
                    initialAccounts: [{ accountId: 'account-b', snapshot: { version: 1,
                        content: { t: 'plain', v: { voice: { providerId: 'off' } } } } }] });
                replacement = await restoreServerAccountForTest({ serverUrl: account!.home.serverUrl,
                    accountId: 'account-b', activation: 'switch', credentialScope: 'restored-home',
                    additionalRequestOrigins: ['https://api.openai.com'], request: async (url, init) => {
                        const path = new URL(String(url)).pathname;
                        if (path === '/v1/account/profile') {
                            return Response.json(AccountProfileSchema.parse({ id: 'account-b' }));
                        }
                        if (path === '/v1/features' || path === '/v1/features/authenticated') return Response.json(buildServerFeaturesResponse({ voiceEnabled: true }));
                        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                        return settings.handle(url, init) ?? createEmptyAccountBootstrapHttpResponse(path, init);
                    } });
                await waitForTestEvent(storage.subscribe, () => expect(getActiveServerAccountScope()?.accountId).toBe('account-b'));
            }
            await screen.update(<AuthProvider initialCredentials={(replacement ?? account)!.credentials}><BriefHome available /></AuthProvider>);
            if (switchAccount) {
                // No presentation demand means B's Inbox cannot enter the Brief,
                // even if B's Voice configuration would independently refuse media.
                expect(screen.findByTestId('home-brief-me')).not.toBeNull();
                expect(screen.findByTestId('voice-brief')).toBeNull();
                expect(speech.starts).toHaveLength(0);
                expect(speech.spoken).toHaveLength(0);
            } else {
                await speech.waitForStart();
                await act(async () => speech.connect());
                await speech.waitForSpoken();
                expect(speech.context.at(-1)).toContain('INBOX BRIEF');
                expect(speech.spoken).toEqual([t('voiceMoments.briefMe')]);
            }
        } finally {
            await screen?.unmount(); screen = null;
            await replacement?.dispose();
            vi.mocked(router.push).mockReset();
        }
    });

    it('opens the demand-mounted Inbox from the Home Action and reports unavailable without a current Home', async () => {
        const speech = await installTransport();
        await selectService();
        expect(executeVoiceBriefOperation('request')).toMatchObject({ ok: false, errorCode: 'voice_brief_unavailable' });
        screen = await renderScreen(renderHome(false));
        expect(executeVoiceBriefOperation('request')).toMatchObject({ ok: false, errorCode: 'voice_brief_unavailable' });
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
        expectApprovalGuidance(speech.context.at(-1));
        await act(async () => { outcome = executeVoiceBriefOperation('close'); });
        expect(outcome).toEqual({ ok: true, result: { status: 'closed', attemptId: getVoiceSessionPresentedAttemptId() } });
        expect(screen.findByTestId('voice-brief')).toBeNull();
        expect(lifecycle?.getSnapshot().status).toBe('connected');
        expect(executeVoiceBriefOperation('close')).toMatchObject({ ok: false, errorCode: 'voice_brief_unavailable' });
        await act(async () => lifecycle?.stop(VOICE_AGENT_GLOBAL_SESSION_ID));
        await act(async () => { outcome = executeVoiceBriefOperation('request'); });
        await speech.waitForStarts(2);
        expect(speech.starts).toHaveLength(2);
        await pressBriefControl('voice-brief.close');
        await act(async () => speech.connect());
        expect(speech.spoken).toHaveLength(1);
        expect(lifecycle?.getSnapshot().status).toBe('connected');
        expect(executeVoiceBriefOperation('retry')).toMatchObject({ ok: false, errorCode: 'voice_brief_unavailable' });
    });
    it('lets the structured native Brief Action request the same connected Brief and stop its turn without ending the conversation', async () => {
        const speech = await installTransport();
        await selectService();
        setActionPolicy({ v: 1, approvalWaivedSurfaces: { 'ui.voice_global.brief.request': ['voice'] } });
        void lifecycle?.toggle(null);
        await speech.connect();
        screen = await renderScreen(render());
        const attemptId = getVoiceSessionAttemptId();
        await speech.waitForSpoken();
        let outcome;
        const decoded = decodeVoiceAssistantActions([{ t: 'requestVoiceBrief', args: { expectedAttemptId: attemptId! } }]);
        expect(decoded.invalidActionBlock).toBeUndefined();
        const action = decoded.actions[0];
        if (!action) throw new Error('The native Brief Action must be accepted');
        const handlers = createVoiceToolHandlers({ resolveSessionId: () => null, currentServerId: account!.home.id });
        await act(async () => { outcome = JSON.parse(await handlers[action.t]!(action.args, { turnOrigin: 'person' })); });
        expect(outcome, JSON.stringify(outcome)).toMatchObject({ ok: true, status: 'sent', attemptId });
        expect(speech.spoken).toHaveLength(2);
        expect(speech.spoken[1]).toBe(t('voiceMoments.briefMe'));
        expectApprovalGuidance(speech.context.at(-1));
        await act(async () => speech.startOutput());
        await act(async () => { outcome = executeVoiceBriefOperation('stop', { expectedAttemptId: attemptId! }); });
        expect(outcome).toEqual({ ok: true, result: { status: 'waiting', attemptId } });
        await speech.waitForInterrupted();
        expect(lifecycle?.getSnapshot().status).toBe('connected');
        expect(executeVoiceBriefOperation('retry')).toEqual({ ok: false, errorCode: 'voice_brief_not_retryable' });
        await screen.unmount(); screen = null;
        // Request now navigates to Home; non-request controls still require their mounted owner.
        expect(executeVoiceBriefOperation('stop', { expectedAttemptId: attemptId! }))
            .toMatchObject({ ok: false, errorCode: 'voice_brief_unavailable' });
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
        expect(executeVoiceBriefOperation('request')).toMatchObject({ ok: false, errorCode: 'voice_brief_unavailable' });
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
        expectApprovalGuidance(speech.context.at(-1), canApproveRequests);
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
        expectApprovalGuidance(speech.context.at(-1));
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
