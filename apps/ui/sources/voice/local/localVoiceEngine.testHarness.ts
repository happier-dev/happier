import { afterEach, beforeEach, vi } from 'vitest';
import type { AuthContextType } from '@/auth/context/AuthContext';
import { buildSystemSessionMetadataV1, SessionCurrentProjectionRecordV1Schema, SessionMetadataTuplePatchV1Schema, FeaturesResponseSchema, encodePlainMachineStoredContent, MACHINE_PLAIN_DATA_KEY_MARKER } from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { VOICE_CONVERSATION_SYSTEM_SESSION_KEY } from '@/voice/persistence/voiceConversationSystemSessionLookup';
import type {
    getMachineContributionRegistryProjectionRevision as getMachineContributionRegistryProjectionRevisionFn,
    machineContributionRegistryProjectionDescribe as machineContributionRegistryProjectionDescribeFn,
    machinePluginSettingsGet as machinePluginSettingsGetFn,
    machinePluginSettingsSet as machinePluginSettingsSetFn,
} from '@/sync/ops/machineContributionRegistryProjection';
import { VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS } from '@/voice/adapters/local/settings';
import { createTransferRecipientKeyPair } from '@/sync/domains/transfers/runtime/transferRuntime/plumbing/transferChunkEncryption';
import {
    createLiveStorageStoreMock,
    createStableStorageReader,
    createStorageModuleStub,
} from '@/dev/testkit/mocks/storage';
import { installDisconnectedServerSocketBoundary } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { normalizeVoiceSettingsLocalDelta } from '@/sync/domains/settings/voiceSettingsPersistence';

installDisconnectedServerSocketBoundary();

const platformOsState = vi.hoisted(() => ({ value: 'ios' as 'ios' | 'web' }));

// Permission alerts are an external UI boundary; keep the real voice owners
// without loading an unrelated application modal/composer tree.
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock().module;
});

type MachineContributionRegistryProjectionDescribeFn = typeof machineContributionRegistryProjectionDescribeFn;
type GetMachineContributionRegistryProjectionRevisionFn = typeof getMachineContributionRegistryProjectionRevisionFn;
type MachinePluginSettingsGetFn = typeof machinePluginSettingsGetFn;
type MachinePluginSettingsSetFn = typeof machinePluginSettingsSetFn;

export const sendMessage = vi.fn();
export const submitMessage = vi.fn();
export const enqueuePendingMessage = vi.fn(async (
    _sessionId: string,
    _text: string,
    _media: unknown,
    _replyTo: unknown,
    options?: Readonly<{ localId?: string }>,
) => ({
    localId: options?.localId ?? 'voice-test-pending-message',
    accepted: true,
    externalHandoffClaimed: true,
}));
export const blockPendingDelivery = vi.fn(async () => {});
export const markPendingDeliveryHandled = vi.fn(async () => {});
export const daemonVoiceAgentStart = vi.fn();
export const daemonVoiceAgentSendTurn = vi.fn();
export const daemonVoiceAgentWelcome = vi.fn();
export const daemonVoiceAgentStartTurnStream = vi.fn();
export const daemonVoiceAgentReadTurnStream = vi.fn();
export const daemonVoiceAgentCancelTurnStream = vi.fn();
export const daemonVoiceAgentCommit = vi.fn();
export const daemonVoiceAgentStop = vi.fn();
export const sessionExecutionRunStart = vi.fn();
export const sessionExecutionRunAction = vi.fn();
export const sessionExecutionRunList = vi.fn();
export const sessionExecutionRunGet = vi.fn();
export const sessionExecutionRunSend = vi.fn();
export const sessionExecutionRunStop = vi.fn();
export const sendSessionMessageWithServerScope = vi.fn();
export const sessionRpcWithServerScope = vi.fn();
export const machineRpcWithServerScope = vi.fn();
export const createdAudioPlayers: any[] = [];
export const fileDelete = vi.fn(async () => {});
export const expoSpeechSpeak = vi.fn();
export const expoSpeechStop = vi.fn();
export const patchSessionMetadataWithRetry = vi.fn(async (_sessionId: string, _patch: (metadata: any) => any) => {});
export const onSessionVisible = vi.fn((_sessionId: string) => {});
export const refreshSessions = vi.fn(async () => {});
export const applySettings = vi.fn();
export const speechRecStart = vi.fn();
export const speechRecStop = vi.fn();
export const speechRecAbort = vi.fn();
export const speechRecRequestPermissionsAsync = vi.fn(async () => ({ granted: true }));
export const audioStreamStart = vi.fn<(...args: any[]) => Promise<{ streamId: string }>>().mockResolvedValue({ streamId: 'audio-stream-1' });
export const audioStreamStop = vi.fn(async () => {});
export const audioSessionRelease = vi.fn(async () => {});
export const sherpaStreamingCreate = vi.fn(async () => {});
export const sherpaStreamingPushFrame = vi.fn<(...args: any[]) => Promise<{ text: string; isEndpoint: boolean }>>().mockResolvedValue({
  text: '',
  isEndpoint: false,
});
export const sherpaStreamingFinish = vi
  .fn<(...args: any[]) => Promise<{ status: 'finalized'; text: string } | { status: 'cancelled' } | { status: 'missing' }>>()
  .mockResolvedValue({ status: 'finalized', text: '' });
export const sherpaStreamingCancel = vi.fn(async () => {});
export const ensureModelPackInstalled = vi.fn(async () => ({
    packDirUri: 'file:///docs/happier/voice/modelPacks/dummy-pack',
    manifest: {
        packId: 'dummy-pack',
        kind: 'stt_sherpa',
        model: 'zipformer',
        version: '1.0.0',
        files: [{ path: 'tokens.txt', url: 'https://example.com/tokens.txt', sha256: 'a'.repeat(64), sizeBytes: 1 }],
    },
}));
export const resolveModelPackManifestUrl = vi.fn(() => 'https://example.com/manifest.json');
export const setActiveServerAndSwitch = vi.fn(async (_params?: any) => false);
export const refreshFromActiveServer = vi.fn(async () => {});
export const routerNavigate = vi.fn();
export const isRuntimeFeatureEnabled = vi.fn<(args: any) => Promise<boolean>>(async (_args) => true);
export const resolveRuntimeFeatureDecision = vi.fn(async (args: any) => ({
    featureId: args?.featureId,
    state: 'enabled',
    blockedBy: null,
    blockerCode: 'none',
    diagnostics: [],
    evaluatedAt: Date.now(),
    scope: {
        scopeKind: 'runtime',
        ...(args?.serverId ? { serverId: String(args.serverId) } : {}),
    },
}));
export const machineContributionRegistryProjectionDescribe = vi.fn<MachineContributionRegistryProjectionDescribeFn>(
    async (_machineId: string, _opts?: Readonly<{ serverId?: string | null; timeoutMs?: number | null }>) => ({
        supported: false,
        reason: 'not-supported',
    }),
);
export const getMachineContributionRegistryProjectionRevision = vi.fn<GetMachineContributionRegistryProjectionRevisionFn>(
    () => 0,
);
export const machinePluginSettingsGet = vi.fn<MachinePluginSettingsGetFn>(
    async () => ({ supported: false, reason: 'not-supported' }),
);
export const machinePluginSettingsSet = vi.fn<MachinePluginSettingsSetFn>(
    async () => ({ supported: false, reason: 'not-supported' }),
);

let nextRecorderPrepareError: Error | null = null;
let recorderUri: string | null = 'file:///tmp/rec.m4a';
let speechRecRecognitionAvailable = true;
let sherpaNativeModuleAvailable = true;

const EXPO_SPEECH_STATE_KEY = Symbol.for('happier.vitest.expoSpeechStub.state');
const EXPO_SPEECH_REC_STATE_KEY = Symbol.for('happier.vitest.expoSpeechRecognitionStub.state');
const AUDIO_STREAM_STATE_KEY = Symbol.for('happier.vitest.audioStreamStub.state');

function setExpoSpeechStubState(next: { speakImpl: ((text: string, options?: any) => void) | null; stopImpl: (() => void) | null }) {
    (globalThis as any)[EXPO_SPEECH_STATE_KEY] = next;
}

function setExpoSpeechRecognitionStubState(next: {
    recognitionAvailable: boolean;
    listeners: Map<string, Set<(event: any) => void>>;
    startImpl: ((params: any) => void) | null;
    stopImpl: (() => void) | null;
    abortImpl: (() => void) | null;
    requestPermissionsImpl: (() => Promise<{ granted: boolean }>) | null;
}) {
    (globalThis as any)[EXPO_SPEECH_REC_STATE_KEY] = next;
}

export function setSpeechRecRecognitionAvailable(next: boolean) {
    speechRecRecognitionAvailable = next;
    const state = (globalThis as any)[EXPO_SPEECH_REC_STATE_KEY];
    if (state && typeof state === 'object') {
        state.recognitionAvailable = next;
    }
}

export function setSherpaNativeModuleAvailable(next: boolean) {
    sherpaNativeModuleAvailable = next;
}

export function emitSpeechRecEvent(eventName: string, event: any = {}) {
    const state = (globalThis as any)[EXPO_SPEECH_REC_STATE_KEY];
    const set: Set<(event: any) => void> | undefined = state?.listeners?.get?.(eventName);
    if (!set) return;
    for (const cb of set) cb(event);
}

export function emitAudioStreamEvent(eventName: string, event: any = {}) {
    const state = (globalThis as any)[AUDIO_STREAM_STATE_KEY];
    const set: Set<(event: any) => void> | undefined = state?.listeners?.get?.(eventName);
    if (!set) return;
    for (const cb of set) cb(event);
}

export const BASE_SETTINGS = {
    lastUsedAgent: 'codex',
    recentMachinePaths: [
        {
            machineId: 'machine-1',
            path: '/Users/test/.happier',
        },
    ],
    voice: {
        providerId: 'local_conversation',
        assistantLanguage: null,
        welcome: { enabled: false, mode: 'immediate', templateId: null },
        executionMachine: { mode: 'auto', machineId: null, autoMachineId: null },
        privacy: {
            shareSessionSummary: true,
            shareRecentMessages: true,
            recentMessagesCount: 3,
            shareToolNames: true,
            sharePermissionRequests: true,
            shareDeviceInventory: true,
            shareFilePaths: false,
            shareToolArgs: false,
        },
        providers: {
            'happier.voice.elevenlabs/realtime-elevenlabs': { schemaVersion: 2, config: {
                billingMode: 'happier',
                byo: { agentId: null },
            } },
	            local_direct: { schemaVersion: 1, config: {
                stt: {
                    provider: 'happier.voice.openai-compat/stt',
                    localNeural: {
                        assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
                        language: null,
                        execution: 'auto',
                    },
                },
                tts: {
                    autoSpeakReplies: false,
                    bargeInEnabled: true,
                    provider: 'happier.voice.openai-compat/tts',
                    localNeural: {
                        model: 'kokoro',
                        assetId: null,
                        voiceId: null,
                        speed: null,
                        execution: 'auto',
                    },
                },
                networkTimeoutMs: 15_000,
	                handsFree: {
	                    enabled: false,
	                    endpointing: {
	                        silenceMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs,
	                        minSpeechMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs,
	                    },
	                },
	            } },
            local_conversation: { schemaVersion: 1, config: {
                conversationMode: 'direct_session',
                stt: {
                    provider: 'happier.voice.openai-compat/stt',
                    localNeural: {
                        assetId: 'sherpa-onnx-streaming-zipformer-en-20M-2023-02-17',
                        language: null,
                        execution: 'auto',
                    },
                },
                tts: {
                    autoSpeakReplies: false,
                    bargeInEnabled: true,
                    provider: 'happier.voice.openai-compat/tts',
                    localNeural: {
                        model: 'kokoro',
                        assetId: null,
                        voiceId: null,
                        speed: null,
                        execution: 'auto',
                    },
                },
                networkTimeoutMs: 15_000,
	                handsFree: {
	                    enabled: false,
	                    endpointing: {
	                        silenceMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.silenceMs,
	                        minSpeechMs: VOICE_HANDS_FREE_ENDPOINTING_DEFAULTS.minSpeechMs,
	                    },
	                },
	                agent: {
                    agentSource: 'session',
                    agentId: 'claude',
                    permissionIntent: 'read-only',
                    idleTtlSeconds: 300,
                    chatModelSource: 'custom',
                    chatModelId: 'default',
                    commitModelSource: 'chat',
                    commitModelId: 'default',
                    providerChat: null,
                    verbosity: 'short',
                },
                streaming: {
                    enabled: false,
                    ttsEnabled: false,
                    ttsChunkChars: 200,
                },
            } },
            'happier.voice.openai-compat/stt': { schemaVersion: 2, config: {
                baseUrl: 'http://localhost:8000',
                insecureLocalOriginConsent: 'http://localhost:8000',
                insecureLocalConsentMachineId: 'machine-1',
                model: 'whisper-1',
                language: '',
            } },
            'happier.voice.openai-compat/tts': { schemaVersion: 2, config: {
                baseUrl: 'http://localhost:8001',
                insecureLocalOriginConsent: 'http://localhost:8001',
                insecureLocalConsentMachineId: 'machine-1',
                model: 'tts-1',
                voiceName: 'alloy',
                format: 'mp3',
            } },
        },
    },
} as const;

export function setPlatformOs(next: 'ios' | 'web') {
    platformOsState.value = next;
}

export function setNextRecorderPrepareError(next: Error | null) {
    nextRecorderPrepareError = next;
}

export function setRecorderUri(next: string | null) {
    recorderUri = next;
}

// The named Account's HTTP settings fixture follows its intended local writes,
// so a later real Sync refresh cannot replace the case with an empty document.
let localVoiceAccountSettings: object | null = null;

export async function getStorage() {
    const { storage } = await import('@/sync/domains/state/storage');
    if ('__setState' in storage) return storage as any;
    // Legacy engine fixtures are completed by the package testkit, then written
    // to the real store. The facade does not replace any production reader.
    return Object.assign({}, storage, {
        __setState: (patch: Record<string, unknown>) => {
            const normalized = { ...patch };
            const settings = patch.settings;
            if (settings && typeof settings === 'object' && !Array.isArray(settings) && 'voice' in settings) {
                const current = storage.getState().settings;
                // These legacy fixture calls represent a current local settings
                // write, not a predecessor whole-object Account write. Keep both
                // roots aligned through the production writer, including explicit
                // canonical-root replacements and retained credential bindings.
                const voiceDelta = 'voiceSettingsV1' in settings && settings.voiceSettingsV1 !== current.voiceSettingsV1
                    ? { voice: settings.voice, voiceSettingsV1: settings.voiceSettingsV1 }
                    : { voice: settings.voice };
                const normalizedSettings = { ...settings, ...normalizeVoiceSettingsLocalDelta(voiceDelta, current) };
                normalized.settings = normalizedSettings;
                if (localVoiceAccountSettings !== null) localVoiceAccountSettings = normalizedSettings;
            }
            if (patch.sessions && typeof patch.sessions === 'object') {
                normalized.sessions = Object.fromEntries(Object.entries(patch.sessions).map(([id, raw]) => {
                    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [id, raw];
                    const session = createSessionFixture(raw);
                    const metadata = { host: 'test', machineId: 'machine-1', path: `/Users/test/.happier/worktree/${id}`,
                        agentRuntimeCapabilitiesV1: { localControl: { supported: true } },
                        ...(session.metadataLayoutVersion === 1 ? session.ownerMetadataView : session.metadata),
                    };
                    return [id, createSessionFixture({ ...session, id, serverId: session.serverId ?? localVoiceHomeId,
                        ...(session.metadataLayoutVersion === 1 ? { ownerMetadataView: metadata } : { metadata }),
                    })];
                }));
            }
            const completed = createLiveStorageStoreMock(() => ({ ...storage.getState(), ...normalized })).getState();
            storage.setState(completed);
        },
        __notify: () => storage.setState({}),
    });
}

async function createVoiceConversationSessionFixture(args: any) {
    const machineId = typeof args?.machineId === 'string' ? args.machineId : 'machine-1';
    const directory = typeof args?.directory === 'string' ? args.directory : '/Users/test/.happier/voice-agent';
    const agentTarget = args?.agentTarget ?? args?.backendTarget;
    const spawnedAgentId = agentTarget?.kind === 'builtInAgent'
        && typeof agentTarget.agentId === 'string'
        ? agentTarget.agentId
        : 'claude';
    const sessionId = 'voice-home-session';
    const storage = await getStorage();
    const current: any = storage.getState();
    if (typeof (storage as any).__setState === 'function') {
        const existing = current.sessions?.[sessionId];
        (storage as any).__setState({
            ...current,
            sessions: {
                ...(current.sessions ?? {}),
                [sessionId]: existing ?? {
                    id: sessionId,
                    serverId: typeof args?.serverId === 'string' ? args.serverId : 'server-a',
                    active: true,
                    updatedAt: Date.now(),
                    metadata: {
                        ...buildSystemSessionMetadataV1({ key: VOICE_CONVERSATION_SYSTEM_SESSION_KEY, hidden: true }),
                        flavor: spawnedAgentId,
                        agentRuntimeCapabilitiesV1: {
                            localControl: { supported: true },
                        },
                        machineId,
                        path: directory,
                        host: 'test',
                    },
                },
            },
        });
    }
    return {
        type: 'success' as const,
        disposition: 'created' as const,
        sessionId,
        executionTarget: {
            serverId: typeof args?.serverId === 'string' ? args.serverId : 'server-a',
            machineId,
        },
        organizationPlacement: { folderId: null, tagIds: [] },
        initialInput: { status: 'notRequested' as const },
    };
}

export async function flushMicrotasks(turns: number = 1) {
    for (let i = 0; i < turns; i++) {
        await Promise.resolve();
    }
}

export type LocalVoiceEngineCompatState = Readonly<{
    status: string;
    sessionId: string | null;
    error: string | null;
}>;

export async function loadLocalVoiceEngineWithCompatState(): Promise<
    typeof import('./localVoiceEngine') & Readonly<{ getLocalVoiceState: () => LocalVoiceEngineCompatState }>
> {
    const localVoiceEngine = await import('./localVoiceEngine');
    // Mirror VoiceSessionRuntime startup with the real local-conversation
    // adapter. Import the engine first so per-test boundary overrides can still
    // be installed before this helper assembles the production adapter.
    const [{ createLocalConversationVoiceAdapter }, { registerVoiceAdapters }] = await Promise.all([
        import('@/voice/adapters/localConversation/localConversationAdapter'),
        import('@/voice/session/voiceAdapterRegistry'),
    ]);
    registerVoiceAdapters([createLocalConversationVoiceAdapter()]);
    const { deriveLocalVoiceRuntimeProjection } = await import('@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot');
    const { getVoiceConversationRuntimeSnapshot } = await import('@/voice/runtime/machine/voiceConversationRuntimeStore');

    return {
        ...localVoiceEngine,
        getLocalVoiceState: () => {
            const snapshot = getVoiceConversationRuntimeSnapshot();
            const projection = deriveLocalVoiceRuntimeProjection(snapshot);
            return {
                status: projection.compatStatus,
                sessionId: snapshot.controlSessionId,
                error: snapshot.error?.reason ?? null,
            };
        },
    };
}

/** Prime the real graph outside individual assertion budgets. */
export async function warmLocalVoiceEngineHarnessGraph() {
    const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
    const restore = await installRealActionExecutorModuleLoader();
    await loadLocalVoiceEngineWithCompatState();
    return restore;
}

export let localVoiceHomeId = '';
export const localVoicePendingEnqueue = vi.fn<(request: Readonly<{ sessionId: string; body: Record<string, unknown> }>) => Promise<Response>>();

/** Load real Account/store owners before any native Agent consumes them. */
export async function installLocalVoiceAccountHarness() {
    vi.doUnmock('@/sync/sync');
    vi.doUnmock('@/sync/runtime/getSyncSingleton');
    vi.doUnmock('@/sync/domains/state/storage');
    vi.doUnmock('@/sync/domains/server/serverRuntime');
    vi.resetModules();
    const { loadSyncSingletonForTests } = await import('@/dev/testkit/harness/syncSingletonLoader');
    await loadSyncSingletonForTests();
    const { upsertAndActivateServer } = await import('@/sync/domains/server/serverRuntime');
    localVoiceHomeId = (await upsertAndActivateServer({ serverUrl: 'https://local-voice-actions.example.test' })).id;
    let connection: Awaited<ReturnType<typeof import('@/dev/testkit/harness/serverAccountConnectionHarness')['restoreServerAccountForTest']>> | null = null;
    const records = new Map<string, ReturnType<typeof SessionCurrentProjectionRecordV1Schema.parse>>();
    const wireRecord = (session: ReturnType<typeof createSessionFixture>) => SessionCurrentProjectionRecordV1Schema.parse({
        id: session.id, seq: session.seq ?? 1, createdAt: session.createdAt ?? 1,
        updatedAt: session.updatedAt, active: session.active, activeAt: Date.now(), archivedAt: null,
        encryptionMode: 'plain', metadataLayoutVersion: 0,
        metadata: JSON.stringify(session.metadata), metadataVersion: session.metadataVersion ?? 1,
        effectiveAccess: { v: 1, level: 'owner', sources: [{ kind: 'owner' }], capabilities: createSessionFixture().access!.capabilities },
        responsibleAccountId: null, responsibleAccount: null, share: null,
        agentState: session.agentState ? JSON.stringify(session.agentState) : null,
        agentStateVersion: session.agentStateVersion ?? 0, pendingCount: 0, pendingVersion: 0, dataEncryptionKey: null,
    });
    return {
        async setup() {
            await connection?.dispose();
            records.clear();
            localVoiceAccountSettings = normalizeVoiceSettingsLocalDelta(BASE_SETTINGS);
            const { restoreServerAccountForTest } = await import('@/dev/testkit/harness/serverAccountConnectionHarness');
            const { createPlainAccountEncryptionCurrentnessFixture } = await import('@/dev/testkit/fixtures/accountEncryptionCurrentness');
            connection = await restoreServerAccountForTest({
                serverUrl: 'https://local-voice-actions.example.test',
                request: async (input, init) => {
                    const path = new URL(String(input)).pathname;
                    if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 0 });
                    if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
                    if (path === '/v1/features') return Response.json(FeaturesResponseSchema.parse({ features: {}, capabilities: { session: { pendingInput: { protocolVersion: 1 } } } }));
                    if (path === '/v2/account/settings') return Response.json({ content: { t: 'plain', v: localVoiceAccountSettings }, version: 1 });
                    const storage = await getStorage();
                    const state = storage.getState();
                    if (path === '/v1/machines') return Response.json((Object.values(state.machines) as Array<Parameters<typeof createMachineFixture>[0]>).map((value) => {
                        const machine = createMachineFixture(value);
                        return { ...machine, metadata: machine.metadata ? encodePlainMachineStoredContent(machine.metadata) : null, daemonState: null, dataEncryptionKey: MACHINE_PLAIN_DATA_KEY_MARKER };
                    }));
                    for (const session of Object.values(state.sessions) as Array<ReturnType<typeof createSessionFixture>>) {
                        if (!records.has(session.id)) records.set(session.id, wireRecord(session));
                    }
                    if (path === '/v2/sessions' || path === '/v2/sessions/active' || path === '/v1/sessions') return Response.json({ sessions: [...records.values()], hasNext: false, nextCursor: null });
                    const detail = /^\/v2\/sessions\/([^/]+)$/.exec(path);
                    if (detail) {
                        const current = records.get(decodeURIComponent(detail[1]));
                        if (!current) return Response.json({}, { status: 404 });
                        if (init?.method === 'PATCH') {
                            const patch = SessionMetadataTuplePatchV1Schema.parse(JSON.parse(String(init.body)));
                            if (patch.mode !== 'owner_migration' && patch.mode !== 'owner') throw new Error('Expected owner metadata mutation');
                            const target = patch.mode === 'owner_migration' ? patch.target : patch;
                            const committed = SessionCurrentProjectionRecordV1Schema.parse({ ...current, metadataLayoutVersion: 1,
                                metadata: target.sharedMetadata.ciphertext, metadataVersion: current.metadataVersion + 1,
                                ownerMetadata: target.ownerMetadata, agentState: target.agentState.ciphertext,
                                agentStateVersion: (current.agentStateVersion ?? 0) + 1 });
                            records.set(current.id, committed);
                            return Response.json({ success: true, metadataLayoutVersion: 1, sharedMetadata: { version: committed.metadataVersion }, agentState: { version: committed.agentStateVersion } });
                        }
                        return Response.json({ session: current });
                    }
                    const pending = /^\/v2\/sessions\/([^/]+)\/pending$/.exec(path);
                    if (pending && init?.method === 'POST') return localVoicePendingEnqueue({ sessionId: decodeURIComponent(pending[1]), body: JSON.parse(String(init.body)) });
                    if (pending) return Response.json({ pending: [], discarded: [], pendingVersion: 0 });
                    // Durable streamed turns settle their claimed input before
                    // reading daemon output; acknowledge that actual HTTP write.
                    if (/^\/v2\/sessions\/[^/]+\/pending\/[^/]+\/delivery\/handled$/.test(path) && init?.method === 'POST') return Response.json({});
                    if (/^\/v1\/sessions\/[^/]+\/messages$/.test(path)) return Response.json({ messages: [], hasMore: false });
                    return new Response('{}', { status: 404 });
                },
            });
            localVoiceHomeId = connection.home.id;
            const storage = await getStorage();
            const state = storage.getState();
            storage.__setState({
                settings: { ...state.settings, ...BASE_SETTINGS },
                machineListByServerId: { [localVoiceHomeId]: Object.values(state.machines) },
            });
        },
        async dispose() { await connection?.dispose(); connection = null; localVoiceAccountSettings = null; },
    };
}

/** Real named Home/Account and Action owners; only credentials and HTTP are replaced. */
export async function installLocalVoiceActionHomeForTests() {
    vi.doUnmock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage');
    const account = await installLocalVoiceAccountHarness();
    const { installRealActionExecutorModuleLoader } = await import('@/dev/testkit/harness/actionHomesHttpHarness');
    const restoreLoader = await installRealActionExecutorModuleLoader();
    return {
        homes: { voice: { id: localVoiceHomeId } },
        restore: () => account.setup(),
        dispose: async () => { await account.dispose(); restoreLoader(); },
    };
}

vi.mock('@/sync/sync', () => ({
    sync: {
        sendMessage,
        submitMessage,
        enqueuePendingMessage,
        blockPendingDelivery,
        markPendingDeliveryHandled,
        ensureSessionVisibleForMessageRoute: vi.fn(async () => {}),
        refreshSessionMessages: vi.fn(async () => {}),
        refreshSessions: (...args: any[]) => (refreshSessions as any)(...args),
        applySettings: (...args: any[]) => (applySettings as any)(...args),
        patchSessionMetadataWithRetry: async (sessionId: string, patch: (metadata: any) => any) => {
            (patchSessionMetadataWithRetry as any)(sessionId, patch);
            const { storage } = await import('@/sync/domains/state/storage');
            const state: any = storage.getState();
            const session: any = state.sessions?.[sessionId] ?? null;
            const writesOwnerView = session?.metadataLayoutVersion === 1;
            const nextMeta = patch(
                writesOwnerView ? session?.ownerMetadataView ?? {} : session?.metadata ?? {},
            );
            if (typeof (storage as any).__setState === 'function') {
                (storage as any).__setState({
                    ...state,
                    sessions: {
                        ...state.sessions,
                        [sessionId]: session
                            ? {
                                ...session,
                                ...(writesOwnerView
                                    ? { ownerMetadataView: nextMeta }
                                    : { metadata: nextMeta }),
                            }
                            : { id: sessionId, metadata: nextMeta },
                    },
                });
            }
        },
        onSessionVisible,
        encryption: {
            getSessionEncryption: vi.fn(() => ({})),
        },
    },
}));

// The lazy sync accessor is a bundler-only `require`, so it never sees the `@/sync/sync`
// mock above and would load a second, unaliased copy of the real sync module under Node.
// Route it to the same mocked surface so both accessors return one object.
vi.mock('@/sync/runtime/getSyncSingleton', async () => {
    const { sync } = await import('@/sync/sync');
    return { getSyncSingleton: () => sync };
});

vi.mock('@/sync/ops/sessionExecutionRuns', () => ({
    sessionExecutionRunStart: (sessionId: string, request: any) => sessionExecutionRunStart(sessionId, request),
    sessionExecutionRunAction: (sessionId: string, request: any) => sessionExecutionRunAction(sessionId, request),
    sessionExecutionRunList: (sessionId: string, request: any) => sessionExecutionRunList(sessionId, request),
    sessionExecutionRunGet: (sessionId: string, request: any) => sessionExecutionRunGet(sessionId, request),
    sessionExecutionRunSend: (sessionId: string, request: any) => sessionExecutionRunSend(sessionId, request),
    sessionExecutionRunStop: (sessionId: string, request: any) => sessionExecutionRunStop(sessionId, request),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc', () => ({
    sessionRpcWithServerScope: (args: any) => sessionRpcWithServerScope(args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionSendMessage', () => ({
    sendSessionMessageWithServerScope: (args: any) => sendSessionMessageWithServerScope(args),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc', () => ({
    machineRpcWithServerScope: (request: any) => machineRpcWithServerScope(request),
}));

vi.mock('@/sync/domains/server/activeServerSwitch', () => ({
    setActiveServerAndSwitch: (params: any) => setActiveServerAndSwitch(params),
}));

vi.mock('@/sync/domains/server/serverRuntime', () => ({
    getActiveServerSnapshot: () => ({ serverId: 'server-a' }),
    subscribeActiveServer: () => () => {},
}));

vi.mock('@/sync/ops/machines', () => ({
    completePendingMachineSpawnAttemptCustodyForSession: async () => null,
}));

vi.mock('@/sync/ops/machineContributionRegistryProjection', () => ({
    getMachineContributionRegistryProjectionRevision: (
        scope: Parameters<GetMachineContributionRegistryProjectionRevisionFn>[0],
    ) => getMachineContributionRegistryProjectionRevision(scope),
    machineContributionRegistryProjectionDescribe: (
        machineId: Parameters<MachineContributionRegistryProjectionDescribeFn>[0],
        opts?: Parameters<MachineContributionRegistryProjectionDescribeFn>[1],
    ) => machineContributionRegistryProjectionDescribe(machineId, opts),
    machinePluginSettingsGet: (...args: Parameters<MachinePluginSettingsGetFn>) =>
        machinePluginSettingsGet(...args),
    machinePluginSettingsSet: (...args: Parameters<MachinePluginSettingsSetFn>) =>
        machinePluginSettingsSet(...args),
    // This harness does not exercise plugin-secret custody, but the current
    // Settings runtime imports the three boundary functions at module load.
    // Keep the untouched external boundary fail-closed.
    machinePluginSecretStatus: async () => ({ supported: false as const, reason: 'not-supported' as const }),
    machinePluginSecretSet: async () => ({ supported: false as const, reason: 'not-supported' as const }),
    machinePluginSecretDelete: async () => ({ supported: false as const, reason: 'not-supported' as const }),
}));

const authFixture = {
    isAuthenticated: true,
    credentials: { token: 'account-token' },
    credentialAuthorityKind: 'account',
    login: async () => ({ kind: 'completed' as const }),
    loginWithCredentials: async () => ({ kind: 'completed' as const }),
    logout: async () => ({ kind: 'completed' as const }),
    refreshFromActiveServer,
} satisfies AuthContextType;

vi.mock('@/sync/domains/features/featureDecisionInputs', () => ({
    isRuntimeFeatureEnabled: (args: any) => isRuntimeFeatureEnabled(args),
    resolveRuntimeFeatureDecision: (args: any) => resolveRuntimeFeatureDecision(args),
}));

vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    const expoRouterMock = createExpoRouterMock({
        router: { navigate: (...args: any[]) => routerNavigate(...args) },
    });
    return expoRouterMock.module;
});

vi.mock('@/voice/agent/daemonVoiceAgentClient', () => ({
    DaemonVoiceAgentClient: class {
        async start(args: any) {
            return (daemonVoiceAgentStart as any)(args);
        }
        async sendTurn(args: any) {
            return (daemonVoiceAgentSendTurn as any)(args);
        }
        async welcome(args: any) {
            return (daemonVoiceAgentWelcome as any)(args);
        }
        async startTurnStream(args: any) {
            return (daemonVoiceAgentStartTurnStream as any)(args);
        }
        async readTurnStream(args: any) {
            return (daemonVoiceAgentReadTurnStream as any)(args);
        }
        async cancelTurnStream(args: any) {
            return (daemonVoiceAgentCancelTurnStream as any)(args);
        }
        async commit(args: any) {
            return (daemonVoiceAgentCommit as any)(args);
        }
        async stop(args: any) {
            return (daemonVoiceAgentStop as any)(args);
        }
    },
}));

vi.mock('@/utils/platform/microphonePermissions', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/utils/platform/microphonePermissions')>(),
    requestMicrophonePermission: vi.fn(async () => ({ granted: true, canAskAgain: true })),
    showMicrophonePermissionDeniedAlert: vi.fn(),
}));

vi.mock('@/voice/modelPacks/installer.native', () => ({
    ensureModelPackInstalled: (params: any, overrides?: any) => (ensureModelPackInstalled as any)(params, overrides),
}));

vi.mock('@/voice/modelPacks/manifests', () => ({
    resolveModelPackManifestUrl: (params: any) => (resolveModelPackManifestUrl as any)(params),
}));

// The production binary speech tunnel is a network boundary. Local-engine unit
// suites exercise the deterministic JSON-RPC compatibility path beneath it.
vi.mock('@/voice/runtime/daemonInference/DaemonSpeechStreamProductionTunnelTransport', () => ({
    createProductionDaemonSpeechStreamingSttTransport: vi.fn(async () => null),
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    View: 'View',
                    Text: 'Text',
                    Dimensions: {
                        get: () => ({ width: 800, height: 600, scale: 2, fontScale: 1 }),
                    },
                    Platform: {
                        get OS() {
                                    return platformOsState.value;
                                },
                        select: (spec: any) => (spec && (spec.ios ?? spec.default)) ?? undefined,
                    },
                }
    );
});

vi.mock('expo-audio', () => ({
    RecordingPresets: { HIGH_QUALITY: { extension: '.m4a' } },
    AudioModule: {
        setAudioModeAsync: vi.fn(async () => {}),
        AudioRecorder: class {
            get uri(): string | null {
                return recorderUri;
            }
            async prepareToRecordAsync() {
                if (nextRecorderPrepareError) {
                    const error = nextRecorderPrepareError;
                    nextRecorderPrepareError = null;
                    throw error;
                }
            }
            record() { }
            async stop() { }
        },
    },
    createAudioPlayer: (source?: any) => {
        const listeners = new Map<string, (arg: any) => void>();
        const player = {
            source,
            addListener: (event: string, cb: (arg: any) => void) => {
                listeners.set(event, cb);
                return { remove: () => listeners.delete(event) };
            },
            play: () => { },
            remove: () => { },
            __emit: (event: string, arg: any) => listeners.get(event)?.(arg),
            __hasListener: (event: string) => listeners.has(event),
        };
        createdAudioPlayers.push(player);
        return player;
    },
}));

vi.mock('expo-file-system', () => ({
    Paths: { cache: 'file:///tmp/' },
    File: class {
        uri: string;
        size = 3;
        constructor(...uris: any[]) {
            const [base, name] = uris;
            this.uri = `${String(base)}${String(name ?? '')}`;
        }
        open() {
            let offset = 0;
            return {
                size: this.size,
                get offset() { return offset; },
                set offset(next: number) { offset = next; },
                readBytes: (length: number) => new Uint8Array([1, 2, 3]).slice(offset, offset + length),
                close: () => {},
            };
        }
        write(_content: any) { }
        delete = fileDelete;
    },
    deleteAsync: () => {
        throw new Error('deprecated_deleteAsync_called');
    },
}));

vi.mock(
    '@happier-dev/audio-stream-native',
    () => {
        const listeners = new Map<string, Set<(event: any) => void>>();
        (globalThis as any)[AUDIO_STREAM_STATE_KEY] = { listeners };

        const addListener = (eventName: string, cb: (event: any) => void) => {
            const set = listeners.get(eventName) ?? new Set();
            set.add(cb);
            listeners.set(eventName, set);
            return { remove: () => set.delete(cb) };
        };

        return {
            createVoiceFileRecording: () => ({
                start: async () => {
                    if (nextRecorderPrepareError) {
                        const error = nextRecorderPrepareError;
                        nextRecorderPrepareError = null;
                        throw error;
                    }
                },
                setMuted: async () => {},
                stop: async () => recorderUri,
            }),
            getSharedVoicePcmCapture: () => ({
                acquire: async (request: any) => {
                    const subscription = addListener('audioFrame', (event: any) => {
                        if (request.shouldDeliver?.() === false) return;
                        void Promise.resolve(request.onFrame(event)).catch((error) => request.onError?.(error));
                    });
                    await (audioStreamStart as any)({
                        sampleRate: request.format.sampleRate,
                        channels: request.format.channels,
                        frameMs: request.format.frameMs,
                    });
                    let released = false;
                    const releaseCapture = async () => {
                        if (released) return;
                        released = true;
                        subscription.remove();
                        await (audioStreamStop as any)();
                    };
                    return {
                        id: `test-pcm-capture:${String(request.ownerId)}`,
                        release: releaseCapture,
                        finish: releaseCapture,
                        waitForDrain: async () => {},
                    };
                },
            }),
            getSharedVoiceAudioSessionCoordinator: () => ({
                acquire: async () => ({
                    id: 'test-audio-session-lease',
                    capabilities: { aecAvailable: false, aecActive: false, route: 'test' },
                    release: () => audioSessionRelease(),
                }),
                subscribe: () => ({ remove: () => {} }),
                getSnapshot: () => ({ generation: 0, leaseCount: 0, configuration: null, capabilities: null }),
                dispose: async () => {},
            }),
        };
    },
);

vi.mock('@happier-dev/sherpa-native', () => ({
    getOptionalHappierSherpaNativeModule: () => sherpaNativeModuleAvailable
        ? {
            createStreamingRecognizer: (...args: any[]) => (sherpaStreamingCreate as any)(...args),
            pushAudioFrame: (...args: any[]) => (sherpaStreamingPushFrame as any)(...args),
            finishStreaming: (...args: any[]) => (sherpaStreamingFinish as any)(...args),
            cancel: (...args: any[]) => (sherpaStreamingCancel as any)(...args),
        }
        : null,
}));

vi.mock('@/sync/domains/state/storage', () => {
    const subscribers = new Set<() => void>();
    let throwNextGetState: unknown = null;
    const state: any = {
        settings: {
            ...BASE_SETTINGS,
        },
        sessions: {},
        sessionMessages: {},
    };

    const liveStorage = createLiveStorageStoreMock(() => state);
    const readLiveStorageState = liveStorage.getState;
    const storage = Object.assign(liveStorage, {
        // Canonical testkits write through setState. Keep it on the same live
        // fixture carrier as the compatibility writers used by these suites.
        setState: (patch: Parameters<typeof liveStorage.setState>[0]) => {
            Object.assign(state, typeof patch === 'function' ? patch(readLiveStorageState()) : patch);
            subscribers.forEach((fn) => fn());
        },
        getState: () => {
            if (throwNextGetState) {
                const error = throwNextGetState;
                throwNextGetState = null;
                throw error;
            }
            return readLiveStorageState();
        },
        subscribe: (fn: () => void) => {
            subscribers.add(fn);
            return () => subscribers.delete(fn);
        },
        __setState: (patch: any) => {
            const normalizedPatch = { ...patch };
            if (patch?.sessions && typeof patch.sessions === 'object') {
                const normalizedSessions: Record<string, any> = {};
                for (const [id, session] of Object.entries(patch.sessions)) {
                    if (!session || typeof session !== 'object') {
                        normalizedSessions[id] = session;
                        continue;
                    }
                    const metadata = (session as any).metadata && typeof (session as any).metadata === 'object'
                        ? (session as any).metadata
                        : {};
                    const ownerMetadataView =
                        (session as any).ownerMetadataView && typeof (session as any).ownerMetadataView === 'object'
                            ? (session as any).ownerMetadataView
                            : {};
                    const executionMetadata = {
                        host: 'test',
                        machineId: 'machine-1',
                        path: `/Users/test/.happier/worktree/${String(id)}`,
                        agentRuntimeCapabilitiesV1: {
                            localControl: { supported: true },
                        },
                        ...((session as any).metadataLayoutVersion === 1 ? ownerMetadataView : metadata),
                    };
                    normalizedSessions[id] = {
                        ...session,
                        // Voice runtime paths often need these for session-root target resolution.
                        ...((session as any).metadataLayoutVersion === 1
                            ? { metadata, ownerMetadataView: executionMetadata }
                            : { metadata: executionMetadata }),
                    };
                }
                normalizedPatch.sessions = normalizedSessions;
            }
            Object.assign(state, normalizedPatch);
        },
        __notify: () => subscribers.forEach((fn) => fn()),
        __throwGetStateOnce: (err: unknown) => {
            throwNextGetState = err;
        },
    });

    return createStorageModuleStub({
        storage,
        useSetting: createStableStorageReader((key: string) => state.settings?.[key] ?? null),
        useProfile: createStableStorageReader(() => state.profile ?? null),
        useActiveServerAccountScope: createStableStorageReader(() => state.profileScope ?? null),
    });
});

export function registerLocalVoiceEngineHarnessHooks(options?: Readonly<{
    resetModulesBetweenTests?: boolean;
}>) {
    const originalFetch = globalThis.fetch;
    const originalConsoleError = console.error;
    const originalCreateObjectURL = (globalThis as any)?.URL?.createObjectURL;
    const originalRevokeObjectURL = (globalThis as any)?.URL?.revokeObjectURL;
    const originalAudioCtor = (globalThis as any)?.Audio;
    let authBridge: typeof import('@/auth/context/currentAuth');
    let previousAuth: AuthContextType | null;

    beforeEach(async () => {
        if (options?.resetModulesBetweenTests === true) {
            vi.resetModules();
        }
        // Load after reset so the fixture and consumer use the same real bridge.
        authBridge = await import('@/auth/context/currentAuth');
        previousAuth = authBridge.getCurrentAuth();
        authBridge.setCurrentAuth(authFixture);
        vi.doUnmock('@/voice/runtime/input/LocalVoiceCaptureOwner');
        vi.doUnmock('@/voice/input/DeviceSttController');
        vi.doUnmock('@/voice/input/SherpaStreamingSttController');
        vi.doUnmock('@/voice/runtime/mic/NativeMicSession');
        console.error = (() => {}) as any;
        sendMessage.mockReset();
        submitMessage.mockReset();
        submitMessage.mockResolvedValue(undefined);
        enqueuePendingMessage.mockClear();
        blockPendingDelivery.mockReset();
        blockPendingDelivery.mockResolvedValue(undefined);
        markPendingDeliveryHandled.mockReset();
        markPendingDeliveryHandled.mockResolvedValue(undefined);
        daemonVoiceAgentStart.mockReset();
        daemonVoiceAgentSendTurn.mockReset();
        daemonVoiceAgentStartTurnStream.mockReset();
        daemonVoiceAgentReadTurnStream.mockReset();
        daemonVoiceAgentCancelTurnStream.mockReset();
        daemonVoiceAgentCommit.mockReset();
        daemonVoiceAgentStop.mockReset();
        sessionExecutionRunList.mockReset();
        sessionExecutionRunList.mockResolvedValue({ runs: [] });
        sessionExecutionRunGet.mockReset();
        sessionExecutionRunGet.mockResolvedValue({ error: 'not-found' });
        sendSessionMessageWithServerScope.mockReset();
        localVoicePendingEnqueue.mockReset();
        localVoicePendingEnqueue.mockImplementation(async ({ body }) => Response.json({
            requestedAction: body.requestedAction,
            pending: { localId: body.localId, deliveryStatus: {
                status: body.deliveryMode === 'external_handoff' ? 'external_handoff' : 'queued',
            } },
        }));
        sessionRpcWithServerScope.mockReset();
        machineRpcWithServerScope.mockReset();
        platformOsState.value = 'ios';
        createdAudioPlayers.length = 0;
        nextRecorderPrepareError = null;
        recorderUri = 'file:///tmp/rec.m4a';
        fileDelete.mockReset();
        expoSpeechSpeak.mockReset();
        expoSpeechStop.mockReset();
        speechRecStart.mockReset();
        speechRecStop.mockReset();
        speechRecAbort.mockReset();
        speechRecRequestPermissionsAsync.mockReset();
        audioStreamStart.mockReset();
        audioStreamStop.mockReset();
        audioSessionRelease.mockReset();
        sherpaStreamingCreate.mockReset();
        sherpaStreamingPushFrame.mockReset();
        sherpaStreamingFinish.mockReset();
        sherpaStreamingCancel.mockReset();
        ensureModelPackInstalled.mockReset();
        resolveModelPackManifestUrl.mockReset();
        audioStreamStart.mockResolvedValue({ streamId: 'audio-stream-1' });
        audioStreamStop.mockResolvedValue(undefined);
        audioSessionRelease.mockResolvedValue(undefined);
        sherpaStreamingPushFrame.mockResolvedValue({ text: '', isEndpoint: false });
        sherpaStreamingFinish.mockResolvedValue({ status: 'finalized', text: '' });
        sherpaStreamingCreate.mockResolvedValue(undefined);
        sherpaStreamingCancel.mockResolvedValue(undefined);
        ensureModelPackInstalled.mockResolvedValue({
            packDirUri: 'file:///docs/happier/voice/modelPacks/dummy-pack',
            manifest: {
                packId: 'dummy-pack',
                kind: 'stt_sherpa',
                model: 'zipformer',
                version: '1.0.0',
                files: [{ path: 'tokens.txt', url: 'https://example.com/tokens.txt', sha256: 'a'.repeat(64), sizeBytes: 1 }],
            },
        });
        resolveModelPackManifestUrl.mockReturnValue('https://example.com/manifest.json');
        isRuntimeFeatureEnabled.mockReset();
        isRuntimeFeatureEnabled.mockResolvedValue(true);
        speechRecRecognitionAvailable = true;
        sherpaNativeModuleAvailable = true;
        setExpoSpeechStubState({
            speakImpl: (...args: any[]) => (expoSpeechSpeak as any)(...args),
            stopImpl: (...args: any[]) => (expoSpeechStop as any)(...args),
        });
        setExpoSpeechRecognitionStubState({
            recognitionAvailable: true,
            listeners: new Map(),
            startImpl: (...args: any[]) => (speechRecStart as any)(...args),
            stopImpl: (...args: any[]) => (speechRecStop as any)(...args),
            abortImpl: (...args: any[]) => (speechRecAbort as any)(...args),
            requestPermissionsImpl: (...args: any[]) => (speechRecRequestPermissionsAsync as any)(...args),
        });
        globalThis.fetch = vi.fn() as any;
        machineRpcWithServerScope.mockImplementation(async (request: any) => {
            switch (request?.method) {
                case RPC_METHODS.SESSION_SPAWN_NEW:
                    return await createVoiceConversationSessionFixture({
                        ...request?.payload,
                        serverId: request?.serverId,
                        machineId: request?.machineId,
                    });
                case RPC_METHODS.SPAWN_HAPPY_SESSION:
                case RPC_METHODS.SPAWN_HAPPY_SESSION_PROVIDER_SAFE:
                    return { type: 'success', sessionId: request.payload.sessionId };
                case RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_INIT: {
                    const recipient = createTransferRecipientKeyPair();
                    return {
                        success: true,
                        uploadId: 'local-engine-test-upload',
                        chunkSizeBytes: 64 * 1024,
                        recipientPublicKeyBase64: recipient.recipientPublicKeyBase64,
                    };
                }
                case RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_CHUNK:
                    return { success: true };
                case RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE_UPLOAD_FINALIZE:
                    return {
                        success: true,
                        uploadId: 'local-engine-test-upload',
                        sizeBytes: 3,
                        sha256: 'a'.repeat(64),
                    };
                case RPC_METHODS.DAEMON_VOICE_SPEECH_TRANSCRIBE: {
                    // These legacy engine-behavior suites use fetch queues only as
                    // deterministic third-party response fixtures. Production UI
                    // still crosses the machine-scoped daemon RPC boundary above.
                    const response = await (globalThis.fetch as any)('http://localhost:8000/v1/audio/transcriptions', {
                        method: 'POST',
                        body: request?.payload ?? null,
                        signal: request?.signal,
                    });
                    const body = await response.json();
                    return {
                        ok: true,
                        requestId: String(request?.payload?.requestId ?? ''),
                        text: String(body?.text ?? ''),
                    };
                }
                default:
                    throw new Error(`unexpected local voice engine machine RPC: ${String(request?.method)}`);
            }
        });
        // Node's URL implementation does not always provide these (browser-only) APIs.
        // The web voice runtime uses them for in-memory audio playback.
        (globalThis as any).URL.createObjectURL = vi.fn(() => 'blob:happier-test');
        (globalThis as any).URL.revokeObjectURL = vi.fn(() => {});
        // Provide a minimal `Audio` implementation so web playback fallback code paths
        // are testable under node/Vitest.
        (globalThis as any).Audio = class FakeAudio {
            src: string;
            onended: (() => void) | null = null;
            onerror: (() => void) | null = null;
            constructor(src: string) {
                this.src = src;
                createdAudioPlayers.push(this);
            }
            play() {
                return Promise.resolve();
            }
            pause() {}
            __emit(eventName: string, payload?: any) {
                if (eventName === 'playbackStatusUpdate' && payload?.didJustFinish) {
                    this.onended?.();
                    return;
                }
                if (eventName === 'ended') {
                    this.onended?.();
                    return;
                }
                if (eventName === 'error') {
                    this.onerror?.();
                }
            }
        };
        daemonVoiceAgentSendTurn.mockResolvedValue({ assistantText: 'Daemon reply' });
        daemonVoiceAgentStartTurnStream.mockResolvedValue({ streamId: 'stream-1' });
        daemonVoiceAgentReadTurnStream.mockResolvedValue({
            streamId: 'stream-1',
            events: [
                { t: 'delta', textDelta: 'Daemon ' },
                { t: 'done', assistantText: 'Daemon reply' },
            ],
            nextCursor: 2,
            done: true,
        });
        daemonVoiceAgentCancelTurnStream.mockResolvedValue({ ok: true });
        daemonVoiceAgentCommit.mockResolvedValue({ commitText: 'Daemon commit' });
        daemonVoiceAgentStop.mockResolvedValue({ ok: true });
        sessionExecutionRunStop.mockReset();
        sessionExecutionRunStop.mockResolvedValue({ ok: true });
        machineContributionRegistryProjectionDescribe.mockReset();
        machineContributionRegistryProjectionDescribe.mockResolvedValue({ supported: false, reason: 'not-supported' });
        getMachineContributionRegistryProjectionRevision.mockReset();
        getMachineContributionRegistryProjectionRevision.mockReturnValue(0);
        machinePluginSettingsGet.mockReset();
        machinePluginSettingsGet.mockResolvedValue({ supported: false, reason: 'not-supported' });
        machinePluginSettingsSet.mockReset();
        machinePluginSettingsSet.mockResolvedValue({ supported: false, reason: 'not-supported' });
        const storage = await getStorage();
        const machine = {
            id: 'machine-1',
            active: true,
            createdAt: Date.now(),
            activeAt: Date.now(),
            metadata: {
                host: 'test',
                happyHomeDir: '/Users/test/.happier',
            },
        };
        storage.__setState({
            settings: { ...BASE_SETTINGS },
            sessions: {},
            sessionMessages: {},
            machines: {
                'machine-1': machine,
            },
            machineListByServerId: {
                'server-a': [machine],
            },
        });

    });

    afterEach(async () => {
        authBridge.setCurrentAuth(previousAuth);
        const [engine, { voiceConversationRuntimeMachine }, { voiceSessionBindingStore },
            { resetVoiceSessionRuntimeStateForTests }, { registerVoiceAdapters }, { useVoiceTargetStore },
            { __resetVoiceTurnInterruptions }] = await Promise.all([
            import('./localVoiceEngine'),
            import('@/voice/runtime/machine/VoiceConversationRuntimeMachine'),
            import('@/voice/binding/voiceConversationBindingStore'),
            import('@/voice/session/voiceSessionStore'),
            import('@/voice/session/voiceAdapterRegistry'),
            import('@/voice/runtime/voiceTargetStore'),
            import('@/voice/transcript/voiceTurnInterruption'),
        ]);
        await engine.stopLocalVoiceSession();
        await resetVoiceSessionRuntimeStateForTests();
        voiceConversationRuntimeMachine.reset();
        for (const binding of voiceSessionBindingStore.getState().list()) {
            voiceSessionBindingStore.getState().unbind(binding.conversationSessionId);
        }
        voiceSessionBindingStore.getState().replacePersistedBindings([]);
        registerVoiceAdapters([]);
        useVoiceTargetStore.getState().setScope('global');
        useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
        useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
        useVoiceTargetStore.getState().setLastFocusedSessionAddress(null);
        __resetVoiceTurnInterruptions();
        globalThis.fetch = originalFetch;
        console.error = originalConsoleError;
        const urlAny = (globalThis as any).URL as any;
        if (typeof originalCreateObjectURL === 'function') {
            urlAny.createObjectURL = originalCreateObjectURL;
        } else {
            Reflect.deleteProperty(urlAny, 'createObjectURL');
        }
        if (typeof originalRevokeObjectURL === 'function') {
            urlAny.revokeObjectURL = originalRevokeObjectURL;
        } else {
            Reflect.deleteProperty(urlAny, 'revokeObjectURL');
        }

        const audioAny = globalThis as any;
        if (typeof originalAudioCtor === 'function') {
            audioAny.Audio = originalAudioCtor;
        } else {
            Reflect.deleteProperty(audioAny, 'Audio');
        }
    });
}
