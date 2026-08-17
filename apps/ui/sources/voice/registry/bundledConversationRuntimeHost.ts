import { Platform } from 'react-native';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { randomUUID } from '@/platform/randomUUID';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type {
  BundledAdmittedCanonicalTranscriptPersistenceEvent,
  BundledDirectMediaBindingOwnership,
  BundledRealtimeProviderRuntimeHost,
  BundledRetiringDirectMediaTranscriptDrain,
} from './bundledConversationRuntimeContract';
import {
  AgentSessionRealtimeInspectResultV1Schema,
  describeActionForVoiceTool,
  SessionLookupByTagsResponseV2Schema,
  VoiceRealtimeJsonValueSchema,
  zodSchemaToJsonSchemaObject,
  type ConnectedServiceBindingsV1,
  type VoiceRealtimeJsonValue,
} from '@happier-dev/protocol';
import type { VoiceHostedConversationService } from '@happier-dev/plugin-sdk/voice/client';
import { realtimeReadOnlyClientTools } from '@/realtime/realtimeClientTools';
import { fetchHappierVoiceToken, completeHappierVoiceSession, releaseHappierVoiceSession } from '@/sync/api/voice/apiVoice';
import { apiSocket } from '@/sync/api/session/apiSocket';
import {
  requireCurrentAccountStoredContentServerCompatibility,
} from '@/sync/api/capabilities/accountStoredContentCompatibility';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { readVoicePrivacySettings } from '@/sync/domains/settings/readVoicePrivacySettings';
import { storage } from '@/sync/domains/state/storage';
import {
  readLocalConversationVoiceSettings,
  readVoiceSettingsInput,
  readVoiceProviderSettingsConfig,
  voiceSettingsParse,
} from '@/sync/domains/settings/voiceSettings';
import { sync } from '@/sync/sync';
import { t } from '@/text';
import { sessionRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedSessionRpc';
import {
  captureSessionRequestAuthorityForServerAccountScope,
} from '@/sync/runtime/orchestration/serverScopedRpc/createSessionRequestWithServerScope';
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { applyVoiceSessionTargetSelection } from '@/voice/binding/applyVoiceSessionTargetSelection';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { voiceSessionBindingManager } from '@/voice/binding/voiceConversationBindingRuntime';
import {
  bindVoiceRuntimeAttemptBinding,
  createVoiceRuntimeAttemptBindingOwner,
  unbindVoiceRuntimeAttemptBindingIfOwned,
  voiceSessionBindingStore,
} from '@/voice/binding/voiceConversationBindingStore';
import { redactVoiceToolResultForProvider } from '@/voice/context/redactVoiceToolResult';
import { voiceHooks } from '@/voice/context/voiceHooks';
import {
  createSdkHandleConnection,
  createWebSocketPcmConnection,
} from '@/voice/runtime/connection/VoiceRealtimeConnection';
import {
  createHostWebRtcConnection,
} from '@/voice/runtime/connection/createHostWebRtcConnection';
import { createWebSocketPcmMedia } from '@/voice/runtime/connection/WebSocketPcmMedia';
import { createVoiceConversationController } from '@/voice/runtime/controller/VoiceConversationController';
import { createVoiceMachineError } from '@/voice/runtime/machine/voiceMachineError';
import { voiceConversationRuntimeMachine } from '@/voice/runtime/machine/VoiceConversationRuntimeMachine';
import { deriveLocalVoiceSessionSnapshot } from '@/voice/runtime/machine/deriveLocalVoiceSessionSnapshot';
import {
  getVoiceConversationRuntimeSnapshot,
  useVoiceConversationRuntimeStore,
} from '@/voice/runtime/machine/voiceConversationRuntimeStore';
import { createRealtimeMicSession } from '@/voice/runtime/mic/createRealtimeMicSession';
import { createRealtimeInboundWatchdog } from '@/voice/runtime/realtime/realtimeInboundWatchdog';
import { voiceRuntimeLevelStore } from '@/voice/runtime/levels/voiceRuntimeLevelStore';
import { voiceOutputStatusStore } from '@/voice/runtime/outputStatus/voiceOutputStatusStore';
import {
  presentVoiceProviderAttemptDiagnostic,
} from '@/voice/runtime/outputStatus/presentVoiceProviderAttemptDiagnostic';
import {
  acquireVoiceBackgroundCallAudioMode,
} from '@/voice/runtime/voiceAudioMode';
import {
  admitCanonicalVoiceTranscriptPersistenceEvent,
  beginCanonicalVoiceTranscriptAttempt,
  appendVoiceConversationNoteText,
  commitAdmittedCanonicalVoiceTranscriptPersistenceEvent,
  deriveCanonicalVoiceTranscriptEntryId,
  projectCanonicalVoiceTranscriptEvent,
  releaseAdmittedCanonicalVoiceTranscriptPersistenceEvent,
  releaseCanonicalVoiceTranscriptConversation,
  settleAdmittedCanonicalVoiceTranscriptPersistence,
} from '@/voice/transcript/voiceConversationTranscript';
import { acquireBundledConversationRuntimeGeneration } from './bundledConversationRuntimeGeneration';
import { createDefaultRealtimeToolBarrier } from '@/voice/tools/defaultRealtimeToolBarrier';
import { resolveEnabledVoiceSdkSafeToolActionSpecsFromState } from '@/voice/tools/resolveDisabledVoiceActionIds';
import {
  readVoiceProviderConversationMetadata,
  writeVoiceProviderConversationMetadata,
} from '@/voice/persistence/voiceProviderConversationMetadata';
import {
  buildVoiceTranscriptHistorySessionMetadata,
  isVoiceTranscriptHistorySession,
  resolveDirectMediaTranscriptSession,
  runVoiceTranscriptHistoryCarrierOperation,
  VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
} from '@/voice/persistence/voiceTranscriptHistorySession';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import {
  ensureVoiceConversationSessionForVoiceHome,
  resolveQualifiedAgentBackendTargetForMachine,
} from '@/voice/persistence/voiceConversationSession';
import {
  readSessionOwnerMetadataView,
  resolveSessionOwnerMetadataViewRead,
} from '@/sync/domains/session/readSessionOwnerMetadataView';
import { discoverVoiceHistorySession } from '@/voice/history/voiceHistorySessionDiscovery';
import { getProviderConversationServiceFactory } from './providerConversationService';

function formatHostedLeaseDuration(ms: number): string {
  const bounded = Math.max(0, Math.floor(ms));
  return bounded < 90_000
    ? `${Math.max(1, Math.ceil(bounded / 1000))}s`
    : `${Math.max(1, Math.ceil(bounded / 60_000))}m`;
}
import { createAgentSessionRealtimeService } from '@/voice/runtime/agentRealtime/createAgentSessionRealtimeService';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import {
  resolveAgentRealtimeVoiceConversationBinding,
  type AgentRealtimeSessionAvailability,
  type AgentRealtimeVoiceBindingDeclineCode,
} from './resolveAgentRealtimeVoiceConversationBinding';
import { startHostedConversationWithPaywall } from './startHostedConversationWithPaywall';

type ContributionRef = Readonly<{ pluginId: string; localId: string }>;

function hostedConversationUnavailable(code: string): Error {
  return Object.assign(new Error(code), { code });
}

/**
 * Narrow public projection of the existing hosted Voice authority.
 *
 * The caller must already have been admitted by the generated bundled
 * contribution owner. This factory adds attempt cancellation and current Voice
 * generation fencing, while the existing token/completion APIs remain the only
 * lease, quota, subscription, verification, usage, and billing owners.
 */
export function createBundledHostedConversationService(input: Readonly<{
  signal: AbortSignal;
  isCurrent(): boolean;
}>): VoiceHostedConversationService {
  const controller = new AbortController();
  let state: 'idle' | 'starting' | 'started' | 'terminal' = 'idle';
  let leaseId: string | null = null;
  let upstreamAbortAttached = false;

  const onUpstreamAbort = (): void => {
    controller.abort();
  };
  const attachUpstreamAbort = (): void => {
    if (upstreamAbortAttached) return;
    upstreamAbortAttached = true;
    if (input.signal.aborted) controller.abort();
    else input.signal.addEventListener('abort', onUpstreamAbort, { once: true });
  };
  const detachUpstreamAbort = (): void => {
    if (!upstreamAbortAttached) return;
    upstreamAbortAttached = false;
    input.signal.removeEventListener('abort', onUpstreamAbort);
  };
  const assertCurrent = (): void => {
    if (!input.isCurrent()) throw hostedConversationUnavailable('hosted_conversation_generation_revoked');
  };

  return Object.freeze({
    async start(request) {
      assertCurrent();
      if (state !== 'idle') {
        throw hostedConversationUnavailable('hosted_conversation_start_already_attempted');
      }
      if (input.signal.aborted) {
        throw hostedConversationUnavailable('hosted_conversation_attempt_aborted');
      }
      state = 'starting';
      attachUpstreamAbort();
      try {
        const credentials = await TokenStorage.getCredentials();
        assertCurrent();
        if (controller.signal.aborted) {
          throw hostedConversationUnavailable('hosted_conversation_attempt_aborted');
        }
        if (!credentials) {
          state = 'idle';
          return Object.freeze({ allowed: false as const, reason: 'authentication_required' });
        }
        const response = await startHostedConversationWithPaywall({
          signal: controller.signal,
          start: async () => {
            assertCurrent();
            if (controller.signal.aborted) {
              throw hostedConversationUnavailable('hosted_conversation_attempt_aborted');
            }
            return await fetchHappierVoiceToken(credentials, {
              sessionId: request.sessionId,
              signal: controller.signal,
            });
          },
          presentPaywall: async () => {
            assertCurrent();
            const result = await sync.presentPaywall();
            assertCurrent();
            return Object.freeze({ purchased: result.purchased === true });
          },
        });
        assertCurrent();
        if (controller.signal.aborted) {
          throw hostedConversationUnavailable('hosted_conversation_attempt_aborted');
        }
        if (!response.allowed) {
          state = 'idle';
          return response;
        }
        leaseId = response.leaseId;
        state = 'started';
        return Object.freeze({
          allowed: true as const,
          token: response.token,
          leaseId: response.leaseId,
          bindingNonce: response.bindingNonce,
          expiresAtMs: response.expiresAtMs,
        });
      } catch (error) {
        if (state === 'starting') state = 'idle';
        throw error;
      }
    },
    async complete(request) {
      assertCurrent();
      if (state === 'terminal') return;
      if (state !== 'started' || !leaseId) {
        throw hostedConversationUnavailable('hosted_conversation_not_started');
      }
      const completingLeaseId = leaseId;
      state = 'terminal';
      leaseId = null;
      detachUpstreamAbort();
      const credentials = await TokenStorage.getCredentials();
      assertCurrent();
      if (!credentials) {
        throw hostedConversationUnavailable('hosted_conversation_authentication_required');
      }
      await completeHappierVoiceSession(credentials, {
        leaseId: completingLeaseId,
        providerConversationId: request.providerConversationId,
      });
    },
    async abort() {
      if (state === 'terminal') return;
      const releasingLeaseId = leaseId;
      state = 'terminal';
      leaseId = null;
      controller.abort();
      detachUpstreamAbort();
      if (!releasingLeaseId) return;
      const credentials = await TokenStorage.getCredentials();
      if (!credentials) return;
      await releaseHappierVoiceSession(credentials, { leaseId: releasingLeaseId });
    },
  });
}

type CandidateAgentSessionBasis = Readonly<{
  machineId: string | null;
  backendId: string;
}>;

/**
 * Local candidate prefilter for an Agent-realtime conversation.
 *
 * Every refusal here is decided entirely on device, before any daemon request,
 * and each one has a different remedy: a session that is not live (the common
 * `Inactive (resumable)` target) is `session_unavailable`, while a live session
 * that simply is not this Agent's does not offer the feature at all. Reducing
 * them to one boolean is what used to make both indistinguishable from a
 * transport fault.
 *
 * `code: null` is the counterweight: a refusal whose cause is transient has no
 * typed remedy to name and must stay on the retryable generic fallback, so
 * naming a cause is only correct when the remedy really is durable.
 */
type CandidateAgentSessionReading =
  | Readonly<{ candidate: true; basis: CandidateAgentSessionBasis }>
  | Readonly<{ candidate: false; code: AgentRealtimeVoiceBindingDeclineCode | null }>;

function readCandidateAgentSessionBasis(sessionId: string): CandidateAgentSessionReading {
  const session = storage.getState().sessions[sessionId];
  if (!session || session.active !== true) {
    return Object.freeze({ candidate: false as const, code: 'session_unavailable' as const });
  }
  const metadataRead = resolveSessionOwnerMetadataViewRead(session);
  if (metadataRead.kind !== 'available') {
    // A layout this build cannot read is a durable client-version fault, so it
    // names the update remedy. An owner projection that simply has not landed
    // or decrypted yet is transient: it stays on the untyped retryable fallback
    // (`code: null`) rather than becoming a never-retryable terminal refusal
    // for a session a moment's hydration would have made usable.
    return Object.freeze({
      candidate: false as const,
      code: metadataRead.kind === 'unsupported_layout_version'
        ? 'update_required' as const
        : null,
    });
  }
  const metadata = metadataRead.metadata;
  const target = metadata.backendTarget;
  const targetRecord = target !== null
    && typeof target === 'object'
    && !Array.isArray(target)
      ? target as Readonly<Record<string, unknown>>
      : null;
  const backendId = targetRecord?.kind === 'backend'
    && typeof targetRecord.backendId === 'string'
      ? targetRecord.backendId
      : target === undefined
        ? (
            typeof metadata.agentType === 'string'
              ? metadata.agentType
              : resolveAgentIdFromSessionMetadata(metadata)
          )
        : null;
  if (!backendId) {
    return Object.freeze({ candidate: false as const, code: 'feature_unavailable' as const });
  }
  const machineId = typeof metadata.machineId === 'string'
    ? metadata.machineId.trim() || null
    : null;
  return Object.freeze({
    candidate: true as const,
    basis: Object.freeze({ machineId, backendId }),
  });
}

const AGENT_REALTIME_SESSION_AVAILABLE = Object.freeze({ available: true as const });

async function readAgentRealtimeSessionCandidacy(
  sessionId: string,
  agent: ContributionRef,
): Promise<AgentRealtimeSessionAvailability> {
  const reading = readCandidateAgentSessionBasis(sessionId);
  if (!reading.candidate) return Object.freeze({ available: false as const, code: reading.code });
  const expectedTarget = await resolveQualifiedAgentBackendTargetForMachine({
    machineId: reading.basis.machineId,
    agent,
  });
  const live = readCandidateAgentSessionBasis(sessionId);
  if (!live.candidate) return Object.freeze({ available: false as const, code: live.code });
  if (
    live.basis.machineId !== reading.basis.machineId
    || live.basis.backendId !== reading.basis.backendId
  ) {
    // The session was retargeted while its Agent ref was being resolved, so the
    // session this attempt was about no longer exists in that form.
    return Object.freeze({ available: false as const, code: 'session_unavailable' as const });
  }
  return expectedTarget?.backendId === live.basis.backendId
    ? AGENT_REALTIME_SESSION_AVAILABLE
    : Object.freeze({ available: false as const, code: 'feature_unavailable' as const });
}

async function isCandidateAgentSession(sessionId: string, agent: ContributionRef): Promise<boolean> {
  return (await readAgentRealtimeSessionCandidacy(sessionId, agent)).available;
}

async function inspectAgentRealtimeSession(input: Readonly<{
  sessionId: string;
  provider: ContributionRef;
  agent: ContributionRef;
}>): Promise<AgentRealtimeSessionAvailability> {
  // Local metadata is only a candidate prefilter. The session-scoped inspect RPC
  // below proves the exact qualified Agent ref through the daemon's normalized projection.
  const candidacy = await readAgentRealtimeSessionCandidacy(input.sessionId, input.agent);
  if (!candidacy.available) return candidacy;
  try {
    const raw = await sessionRpcWithServerScope({
      sessionId: input.sessionId,
      method: SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT,
      payload: { v: 1, provider: input.provider },
    });
    const parsed = AgentSessionRealtimeInspectResultV1Schema.safeParse(raw);
    if (!parsed.success) return Object.freeze({ available: false as const, code: null });
    if (parsed.data.ok) return AGENT_REALTIME_SESSION_AVAILABLE;
    // The daemon's `reason` is the one typed answer it publishes; its `code` and
    // `message` are provider-shaped diagnostics and stay out of the projection.
    // An unclassified refusal has no typed reason to carry, and inventing one
    // here would be worse than the honest unknown-failure fallback.
    return Object.freeze({ available: false as const, code: parsed.data.reason ?? null });
  } catch {
    return Object.freeze({ available: false as const, code: null });
  }
}

function createRealtimeClientToolParameters(
  inputSchema: Parameters<typeof zodSchemaToJsonSchemaObject>[0],
): Readonly<Record<string, VoiceRealtimeJsonValue>> {
  const value = VoiceRealtimeJsonValueSchema.parse(zodSchemaToJsonSchemaObject(inputSchema));
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('voice_client_tool_parameters_invalid');
  }
  return value as Readonly<Record<string, VoiceRealtimeJsonValue>>;
}

/**
 * Provider-neutral host capabilities offered only to generated bundled
 * first-party conversation factories. The package owns provider decisions;
 * this module owns app state, UI, auth, audio, and machine integration.
 */
let currentRuntimeHost: Readonly<{
  host: BundledRealtimeProviderRuntimeHost;
  isCurrent(): boolean;
}> | null = null;

/** The existing VoiceSessionRuntime lease is the sole host/currentness owner. */
export function getCurrentBundledConversationRuntimeHost(): BundledRealtimeProviderRuntimeHost | null {
  return currentRuntimeHost?.isCurrent() === true ? currentRuntimeHost.host : null;
}

export function createBundledConversationRuntimeHostLease() {
  const generation = acquireBundledConversationRuntimeGeneration();
  // This is intentionally not another transcript owner or queue. A permit is
  // minted synchronously only while this host is current, then remains valid
  // only for the exact direct-media tail which already crossed provider input
  // admission. The canonical projector still owns attempt identity, ordering,
  // persistence, and release.
  const retiringDirectMediaTranscriptDrains = new WeakSet<object>();
  const admittedCanonicalTranscriptPersistenceEvents = new WeakMap<
    BundledAdmittedCanonicalTranscriptPersistenceEvent,
    NonNullable<ReturnType<typeof admitCanonicalVoiceTranscriptPersistenceEvent>>
  >();
  const hasRetiringDirectMediaTranscriptDrain = (
    drain: BundledRetiringDirectMediaTranscriptDrain | undefined,
  ): boolean => (
    drain !== undefined
    && retiringDirectMediaTranscriptDrains.has(drain as object)
  );
  const bindCurrentDirectMediaConversation = (input: Readonly<{
    adapterId: string;
    controlSessionId: string;
    conversationSessionId: string;
    targetSessionId: string | null;
  }>) => {
    if (!generation.isCurrent()) {
      return Object.freeze({ conversationSessionId: input.conversationSessionId });
    }
    const bindingOwnership =
      createVoiceRuntimeAttemptBindingOwner() as BundledDirectMediaBindingOwnership;
    bindVoiceRuntimeAttemptBinding({
      owner: bindingOwnership,
      binding: {
        adapterId: input.adapterId,
        controlSessionId: input.controlSessionId,
        conversationSessionId: input.conversationSessionId,
        lifetime: 'runtime_attempt',
        transcriptMode: 'synthetic',
        targetSessionId: input.targetSessionId,
        updatedAt: Date.now(),
      },
    });
    const conversation = {
      conversationSessionId: input.conversationSessionId,
    } as Readonly<{
      conversationSessionId: string;
      bindingOwnership?: BundledDirectMediaBindingOwnership;
    }>;
    // Keep the ownership closure out of the observable direct-media result
    // shape. Runtime composition can read it, while consumers see the same
    // stable carrier contract and it cannot leak into persistence/telemetry.
    Object.defineProperty(conversation, 'bindingOwnership', {
      configurable: false,
      enumerable: false,
      value: bindingOwnership,
      writable: false,
    });
    return Object.freeze(conversation);
  };
  const canPersistProviderConversationState = (input: Readonly<{
    providerId: string;
    conversationSessionId: string;
  }>): boolean => {
    const binding = voiceSessionBindingStore.getState().getByConversationSessionId(
      input.conversationSessionId,
    );
    return binding?.adapterId === input.providerId
      && storage.getState().sessions[input.conversationSessionId] !== undefined;
  };
  const host: BundledRealtimeProviderRuntimeHost = Object.freeze({
    globalVoiceSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
    isCurrentGeneration: () => generation.isCurrent(),
    runCurrentGenerationEffect(callback) {
      let ran = false;
      generation.runIfCurrent(() => {
        ran = true;
        callback();
      });
      return ran;
    },
    getSettings: () => storage.getState().settings,
    projectVoiceSettings(settings: unknown, providerId: string) {
      const rawVoice = readVoiceSettingsInput(settings);
      if (!rawVoice || typeof rawVoice !== 'object' || Array.isArray(rawVoice)) return null;
      const voice = voiceSettingsParse(rawVoice);
      return Object.freeze({
        providerId: voice.providerId,
        assistantLanguage: voice.assistantLanguage,
        welcome: voice.welcome,
        providerConfig: readVoiceProviderSettingsConfig(voice, providerId),
      });
    },
    getRealtimeClientToolDefinitions() {
      return Object.freeze(resolveEnabledVoiceSdkSafeToolActionSpecsFromState(storage.getState()).flatMap((spec) => {
        const name = String(spec.bindings?.voiceClientToolName ?? '').trim();
        const handler = realtimeReadOnlyClientTools[name];
        if (!name || typeof handler !== 'function') return [];
        return [Object.freeze({
          name,
          description: describeActionForVoiceTool(spec),
          parameters: createRealtimeClientToolParameters(spec.inputSchema),
          async execute(parameters: VoiceRealtimeJsonValue): Promise<VoiceRealtimeJsonValue> {
            if (!generation.isCurrent()) throw new Error('voice_runtime_generation_revoked');
            const raw = await handler(parameters);
            if (!generation.isCurrent()) throw new Error('voice_runtime_generation_revoked');
            let value: unknown = raw;
            try {
              value = JSON.parse(raw);
            } catch {
              // A legacy handler may return a plain string. It remains a valid
              // JSON scalar after the host privacy boundary below.
            }
            const privacy = readVoicePrivacySettings(storage.getState().settings);
            return VoiceRealtimeJsonValueSchema.parse(redactVoiceToolResultForProvider(
              name,
              value,
              {
                shareFilePaths: privacy.shareFilePaths,
                shareSessionSummary: privacy.shareSessionSummary,
                sharePermissionRequests: privacy.sharePermissionRequests,
                shareDeviceInventory: privacy.shareDeviceInventory,
                shareRecentMessages: privacy.shareRecentMessages,
              },
            ));
          },
        })];
      }));
    },
    createMachineError: createVoiceMachineError,
    machine: Object.freeze({
      transitionToAcquiringMic: (controlSessionId: string, adapterId: string, attemptId?: number) =>
        generation.runIfCurrent(() => voiceConversationRuntimeMachine.transitionToAcquiringMic({ controlSessionId, adapterId, attemptId })),
      transitionToConnecting: (controlSessionId: string, adapterId: string, attemptId?: number) =>
        generation.runIfCurrent(() => voiceConversationRuntimeMachine.transitionToConnecting({ controlSessionId, adapterId, attemptId })),
      setReconnecting: (controlSessionId: string, adapterId: string, reconnecting: boolean, attemptId?: number) =>
        generation.runIfCurrent(() => voiceConversationRuntimeMachine.setReconnecting({
          controlSessionId,
          adapterId,
          attemptId,
          reconnecting,
        })),
      transitionToConnected: (controlSessionId: string, adapterId: string, attemptId?: number) =>
        generation.runIfCurrent(() => voiceConversationRuntimeMachine.transitionToConnected({ controlSessionId, adapterId, attemptId })),
      transitionToSpeaking: (controlSessionId: string, adapterId: string, attemptId?: number) =>
        generation.runIfCurrent(() => voiceConversationRuntimeMachine.transitionToSpeaking({ controlSessionId, adapterId, attemptId })),
      transitionToEnding: (controlSessionId: string, adapterId: string, attemptId?: number) =>
        generation.runIfCurrent(() => voiceConversationRuntimeMachine.transitionToEnding({ controlSessionId, adapterId, attemptId })),
      transitionToDisconnected: (controlSessionId: string, adapterId: string, error: unknown | null, attemptId?: number) =>
        generation.runIfCurrent(() => voiceConversationRuntimeMachine.transitionToDisconnected({
          controlSessionId,
          adapterId,
          attemptId,
          error: error as Parameters<typeof voiceConversationRuntimeMachine.transitionToDisconnected>[0]['error'],
        })),
      setError: (controlSessionId: string, adapterId: string, error: unknown, attemptId?: number) =>
        generation.runIfCurrent(() => voiceConversationRuntimeMachine.setError({
          controlSessionId,
          adapterId,
          attemptId,
          error: error as Parameters<typeof voiceConversationRuntimeMachine.setError>[0]['error'],
        })),
      setMuted: (controlSessionId: string, adapterId: string, attemptId: number, muted: boolean) =>
        generation.runIfCurrent(() => voiceConversationRuntimeMachine.setMuted({
          controlSessionId,
          adapterId,
          attemptId,
          micMuted: muted,
        })),
      getSnapshot: getVoiceConversationRuntimeSnapshot,
      projectSnapshot: (adapterId: string, snapshot: unknown) =>
        deriveLocalVoiceSessionSnapshot(
          adapterId,
          'realtime',
          snapshot as Parameters<typeof deriveLocalVoiceSessionSnapshot>[2],
        ),
      subscribe: (listener: () => void) => useVoiceConversationRuntimeStore.subscribe(() => {
        generation.runIfCurrent(listener);
      }),
    }),
    createConversationController: (input: Parameters<typeof createVoiceConversationController>[0]) =>
      createVoiceConversationController(input),
    createSdkHandleConnection,
    createWebRtcConnection: createHostWebRtcConnection,
    createWebSocketPcmConnection,
    createWebSocketPcmMedia,
    createToolBarrier: createDefaultRealtimeToolBarrier,
    getPlatform: () => {
      if (Platform.OS === 'ios' || Platform.OS === 'android') return Platform.OS;
      return 'web';
    },
    createMicSession: createRealtimeMicSession,
    openLevelWriter: (input: Parameters<typeof voiceRuntimeLevelStore.open>[0]) => voiceRuntimeLevelStore.open(input),
    ensureBound: (input: Readonly<{ adapterId: string; controlSessionId: string; requestedTargetSessionId: string | null }>) => {
      if (!generation.isCurrent()) throw new Error('voice_runtime_generation_revoked');
      return voiceSessionBindingManager.ensureBound(input);
    },
    async acquireDirectMediaConversation(input: Readonly<{
      adapterId: string;
      controlSessionId: string;
      requestedTargetSessionId: string | null;
      retiringTranscriptDrain?: BundledRetiringDirectMediaTranscriptDrain;
    }>) {
      if (
        !generation.isCurrent()
        && !hasRetiringDirectMediaTranscriptDrain(input.retiringTranscriptDrain)
      ) {
        throw new Error('voice_runtime_generation_revoked');
      }
      const requestedTargetSessionId =
        typeof input.requestedTargetSessionId === 'string'
        && input.requestedTargetSessionId.trim()
          ? input.requestedTargetSessionId.trim()
          : null;
      const acquire = async () => {
        const existing = voiceSessionBindingStore.getState().getByControlSessionId(
          input.controlSessionId,
        );
        const existingConversation = existing
          ? storage.getState().sessions[existing.conversationSessionId] ?? null
          : null;
        const existingOwnsRequestedCarrier = requestedTargetSessionId
          ? existing?.conversationSessionId === requestedTargetSessionId
          : isVoiceTranscriptHistorySession(existingConversation
            ? {
                active: existingConversation.active,
                metadata: readVoiceSessionOwnerMetadataFromState(
                  storage.getState(),
                  existingConversation.id,
                ),
              }
            : null);
        const existingCarrierNeedsHydration = requestedTargetSessionId !== null
          || (
            existingConversation?.encryptionMode !== 'plain'
            && existing !== null
            && sync.encryption?.getSessionEncryption(existing.conversationSessionId) == null
          );
        if (
          existing?.adapterId === input.adapterId
          && existing.lifetime === 'runtime_attempt'
          && existing.targetSessionId === requestedTargetSessionId
          && existingOwnsRequestedCarrier
        ) {
          if (!existingCarrierNeedsHydration) {
            return bindCurrentDirectMediaConversation({
              adapterId: input.adapterId,
              controlSessionId: input.controlSessionId,
              conversationSessionId: existing.conversationSessionId,
              targetSessionId: requestedTargetSessionId,
            });
          }
          const existingConversationSessionId = existing.conversationSessionId;
          const hydrated = await sync.ensureSessionVisibleForMessageRoute(
            existingConversationSessionId,
            { forceRefresh: true },
          );
          if (
            hydrated.kind === 'available'
            && hydrated.sessionId === existingConversationSessionId
          ) {
            const hydratedConversation =
              storage.getState().sessions[existingConversationSessionId] ?? null;
            const hydratedOwnsRequestedCarrier = requestedTargetSessionId
              ? existingConversationSessionId === requestedTargetSessionId
              : isVoiceTranscriptHistorySession(hydratedConversation
                ? {
                    active: hydratedConversation.active,
                    metadata: readVoiceSessionOwnerMetadataFromState(
                      storage.getState(),
                      existingConversationSessionId,
                    ),
                  }
                : null);
            if (hydratedOwnsRequestedCarrier) {
              return bindCurrentDirectMediaConversation({
                adapterId: input.adapterId,
                controlSessionId: input.controlSessionId,
                conversationSessionId: existingConversationSessionId,
                targetSessionId: requestedTargetSessionId,
              });
            }
          }
          if (requestedTargetSessionId) {
            throw new Error(
              `Voice transcript target session ${requestedTargetSessionId} could not be hydrated`,
            );
          }
        }
        const conversationSessionId = await resolveDirectMediaTranscriptSession({
          ensureTargetSession: async (sessionId) => {
            const hydrated = await sync.ensureSessionVisibleForMessageRoute(sessionId, {
              forceRefresh: true,
            });
            if (hydrated.kind !== 'available' || hydrated.sessionId !== sessionId) {
              throw new Error(`Voice transcript target session ${sessionId} could not be hydrated`);
            }
          },
          ensureHistorySession: async () => {
            const resolved = await sync.ensureHostedSystemSession({
              tag: VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
              metadata: buildVoiceTranscriptHistorySessionMetadata(),
            });
            const session = storage.getState().sessions[resolved.sessionId] ?? null;
            if (!session || !isVoiceTranscriptHistorySession({
              active: session.active,
              metadata: readVoiceSessionOwnerMetadataFromState(
                storage.getState(),
                resolved.sessionId,
              ),
            })) {
              throw new Error('Voice transcript history session identity mismatch');
            }
            return resolved.sessionId;
          },
        }, { requestedTargetSessionId });
        const isRetiringDirectMediaDrain = hasRetiringDirectMediaTranscriptDrain(
          input.retiringTranscriptDrain,
        );
        if (!generation.isCurrent() && !isRetiringDirectMediaDrain) {
          throw new Error('voice_runtime_generation_revoked');
        }
        // The replacement generation may already own this control slot. Its
        // binding and live UI/machine state are authoritative, so the retired
        // tail may use the resolved carrier only for canonical projection and
        // must never publish a new runtime binding.
        if (!generation.isCurrent()) {
          return Object.freeze({ conversationSessionId });
        }
        return bindCurrentDirectMediaConversation({
          adapterId: input.adapterId,
          controlSessionId: input.controlSessionId,
          conversationSessionId,
          targetSessionId: requestedTargetSessionId,
        });
      };
      return requestedTargetSessionId
        ? await acquire()
        : await runVoiceTranscriptHistoryCarrierOperation(acquire);
    },
    captureRetiringDirectMediaTranscriptDrain() {
      if (!generation.isCurrent()) return null;
      const drain = Object.freeze({}) as unknown as BundledRetiringDirectMediaTranscriptDrain;
      retiringDirectMediaTranscriptDrains.add(drain as object);
      return drain;
    },
    releaseRetiringDirectMediaTranscriptDrain(
      drain: BundledRetiringDirectMediaTranscriptDrain,
    ) {
      retiringDirectMediaTranscriptDrains.delete(drain as object);
    },
    async releaseDirectMediaConversation(input: Readonly<{
      adapterId: string;
      controlSessionId: string;
      conversationSessionId: string;
      transcriptAttemptIdentity: string;
      retiringTranscriptDrain?: BundledRetiringDirectMediaTranscriptDrain;
      bindingOwnership?: BundledDirectMediaBindingOwnership;
    }>) {
      const isRetiringDirectMediaDrain = hasRetiringDirectMediaTranscriptDrain(
        input.retiringTranscriptDrain,
      );
      let released = false;
      try {
        released = await releaseCanonicalVoiceTranscriptConversation({
          conversationSessionId: input.conversationSessionId,
          attemptIdentity: input.transcriptAttemptIdentity,
        });
      } finally {
        if (isRetiringDirectMediaDrain && input.retiringTranscriptDrain) {
          retiringDirectMediaTranscriptDrains.delete(input.retiringTranscriptDrain as object);
        }
      }
      if (!released) return;
      // Canonical transcript release may complete after a replacement binds
      // the exact same carrier. This is an owner compare-and-unbind, never a
      // field/timestamp comparison: only the precise binding this attempt
      // installed may be removed, regardless of generation timing.
      if (!input.bindingOwnership) return;
      unbindVoiceRuntimeAttemptBindingIfOwned({
        conversationSessionId: input.conversationSessionId,
        owner: input.bindingOwnership,
      });
    },
    resolveConversationSessionId(controlSessionId: string, adapterId: string) {
      const binding = voiceConversationBindingResolver.resolveByControlSessionId({
        controlSessionId,
        adapterId,
      });
      if (!binding) return null;
      if (
        binding.lifetime === 'runtime_attempt'
        && binding.targetSessionId === null
      ) {
        const session = storage.getState().sessions[binding.conversationSessionId] ?? null;
        if (!isVoiceTranscriptHistorySession(session
          ? {
              active: session.active,
              metadata: readVoiceSessionOwnerMetadataFromState(
                storage.getState(),
                binding.conversationSessionId,
              ),
            }
          : null)) {
          return null;
        }
      }
      return binding.conversationSessionId;
    },
    canPersistProviderConversationState,
    async createAgentSessionRealtimeService(input: Readonly<{
      provider: ContributionRef;
      agent: ContributionRef;
      adapterId: string;
      controlSessionId: string;
      applicationAttemptId: string;
      signal: AbortSignal;
      onTerminal: Parameters<typeof createAgentSessionRealtimeService>[0]['onTerminal'];
    }>) {
      if (!generation.isCurrent()) return null;
      const conversationSessionId =
        voiceConversationBindingResolver.resolveByControlSessionId({
          controlSessionId: input.controlSessionId,
          adapterId: input.adapterId,
        })?.conversationSessionId ?? null;
      if (!conversationSessionId) return null;
      const isCandidate = await isCandidateAgentSession(conversationSessionId, input.agent);
      const liveConversationSessionId =
        voiceConversationBindingResolver.resolveByControlSessionId({
          controlSessionId: input.controlSessionId,
          adapterId: input.adapterId,
        })?.conversationSessionId ?? null;
      if (
        !isCandidate
        || !generation.isCurrent()
        || input.signal.aborted
        || liveConversationSessionId !== conversationSessionId
      ) return null;
      const boundApplicationAttemptId =
        `${input.applicationAttemptId}:${randomUUID()}`;
      return createAgentSessionRealtimeService({
        provider: input.provider,
        conversationSessionId,
        applicationAttemptId: boundApplicationAttemptId,
        signal: input.signal,
        onTerminal: input.onTerminal,
        sessionRpc: async ({ sessionId, method, payload, signal }) => {
          const isRetiredBoundCleanup =
            method === SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_STOP
            && input.signal.aborted;
          if (
            signal.aborted
            || (!generation.isCurrent() && !isRetiredBoundCleanup)
          ) {
            throw new Error('agent_realtime_request_aborted');
          }
          return await sessionRpcWithServerScope({
            sessionId,
            method,
            payload,
            ...(method === SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_WATCH
              ? { timeoutMs: null }
              : {}),
          });
        },
      });
    },
    async resolveAgentRealtimeVoiceConversationBinding(input: Readonly<{
      provider: ContributionRef;
      agent: ContributionRef;
      controlSessionId: string;
      requestedTargetSessionId: string | null;
      settings: unknown;
      connectedServices?: ConnectedServiceBindingsV1;
    }>) {
      return await resolveAgentRealtimeVoiceConversationBinding({
        ...input,
        globalSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
        inspect: inspectAgentRealtimeSession,
        ensureGlobalConversation: async ({ agent, isReusableSession }) => {
          const voice = voiceSettingsParse(
            input.settings && typeof input.settings === 'object'
              ? (input.settings as Readonly<{ voice?: unknown }>).voice
              : undefined,
          );
          const permissionIntent = readLocalConversationVoiceSettings(voice).agent.permissionIntent;
          if (!input.connectedServices) {
            throw Object.assign(
              new Error('voice_global_connected_service_binding_required'),
              { code: 'authentication_required' },
            );
          }
          return await ensureVoiceConversationSessionForVoiceHome({
            agentIdentity: agent,
            connectedServices: input.connectedServices,
            permissionIntent,
            // No exact resolved Codex runtime/version currently has provider-boundary
            // proof of first-turn model visibility after cold resume.
            coldResumeStartupInstructionsEffective: false,
            isReusableSession,
          });
        },
      });
    },
    async readProviderConversationState(input: Readonly<{ providerId: string; conversationSessionId: string }>) {
      if (!canPersistProviderConversationState(input)) return null;
      const session = storage.getState().sessions[input.conversationSessionId] ?? null;
      const metadata = session ? readSessionOwnerMetadataView(session) : null;
      const state = readVoiceProviderConversationMetadata(metadata, input.providerId);
      return state ? Object.freeze({ conversationId: state.conversationId }) : null;
    },
    async writeProviderConversationState(input: Readonly<{
      providerId: string;
      conversationSessionId: string;
      state: Readonly<{ conversationId: string }> | null;
    }>) {
      const session = storage.getState().sessions[input.conversationSessionId] ?? null;
      if (
        !canPersistProviderConversationState(input)
        && !(input.state === null && session)
      ) {
        throw new Error('voice_provider_conversation_persistence_unavailable');
      }
      await sync.patchSessionMetadataWithRetry(input.conversationSessionId, (metadata) =>
        writeVoiceProviderConversationMetadata(metadata, {
          providerId: input.providerId,
          state: input.state,
          updatedAt: Date.now(),
        }));
    },
    async forgetProviderConversationState(input: Readonly<{ providerId: string }>) {
      await runVoiceTranscriptHistoryCarrierOperation(async () => {
        const scope = getActiveServerAccountScope();
        if (!scope) throw new Error('voice_provider_conversation_scope_unavailable');
        const authority = await captureSessionRequestAuthorityForServerAccountScope({
          scope,
          activeRequest: (path, init) => apiSocket.request(path, init),
        });
        const conversationSessionId = await discoverVoiceHistorySession({
          prepareLookup: () => requireCurrentAccountStoredContentServerCompatibility({
            serverId: authority.scope.serverId,
          }),
          lookupByTags: async (tags) => {
            const response = await authority.request('/v2/sessions/lookup-by-tags', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ tags }),
            });
            if (!response.ok) {
              throw new Error('voice_provider_conversation_lookup_failed');
            }
            const parsed = SessionLookupByTagsResponseV2Schema.safeParse(await response.json());
            if (!parsed.success) {
              throw new Error('voice_provider_conversation_lookup_invalid');
            }
            return parsed.data.sessions;
          },
          hydrateSession: (sessionId) => sync.ensureSessionVisibleForMessageRoute(
            sessionId,
            { forceRefresh: true, authority },
          ),
          readHydratedSession: (sessionId) =>
            storage.getState().sessions[sessionId] ?? null,
        });
        if (!conversationSessionId) return;
        const currentScope = getActiveServerAccountScope();
        if (
          currentScope?.serverId !== scope.serverId
          || currentScope.accountId !== scope.accountId
        ) {
          throw new Error('voice_provider_conversation_scope_changed');
        }
        const fixedCarrierAttempt = getProviderConversationServiceFactory(
          host,
          input.providerId,
        ).createAttempt(conversationSessionId, {
          async writeForgottenState() {
            const writeScope = getActiveServerAccountScope();
            if (
              writeScope?.serverId !== scope.serverId
              || writeScope.accountId !== scope.accountId
            ) {
              throw new Error('voice_provider_conversation_scope_changed');
            }
            const session = storage.getState().sessions[conversationSessionId] ?? null;
            if (!session) {
              throw new Error('voice_provider_conversation_session_unavailable');
            }
            const metadata = readSessionOwnerMetadataView(session);
            if (!readVoiceProviderConversationMetadata(metadata, input.providerId)) return;
            await sync.patchSessionMetadataWithRetry(
              conversationSessionId,
              (currentMetadata) => writeVoiceProviderConversationMetadata(currentMetadata, {
                providerId: input.providerId,
                state: null,
                updatedAt: Date.now(),
              }),
              { serverId: scope.serverId },
            );
          },
        });
        await fixedCarrierAttempt.forget();
      });
    },
    applyTargetSelection: async (input: Parameters<typeof applyVoiceSessionTargetSelection>[0]) => {
      const operation = generation.runIfCurrent(() => applyVoiceSessionTargetSelection(input));
      if (!operation) throw new Error('voice_runtime_generation_revoked');
      await operation;
    },
    acquireAudioMode: async (ownerId: string) => {
      if (!generation.isCurrent()) throw new Error('voice_runtime_generation_revoked');
      if (typeof window !== 'undefined' && typeof document !== 'undefined') {
        return Object.freeze({ release: async () => {} });
      }
      const lease = await acquireVoiceBackgroundCallAudioMode(ownerId);
      return Object.freeze({
        async release() {
          await lease.release();
        },
      });
    },
    projectTranscript: ({
      conversationSessionId,
      event,
      source,
      retiringTranscriptDrain,
    }: Readonly<{
      conversationSessionId: string;
      event: Parameters<typeof projectCanonicalVoiceTranscriptEvent>[0]['event'];
      source?: Parameters<typeof projectCanonicalVoiceTranscriptEvent>[0]['source'];
      retiringTranscriptDrain?: BundledRetiringDirectMediaTranscriptDrain;
    }>) => {
      if (
        !generation.isCurrent()
        && !hasRetiringDirectMediaTranscriptDrain(retiringTranscriptDrain)
      ) {
        return null;
      }
      const result = projectCanonicalVoiceTranscriptEvent({
        conversationSessionId,
        event,
        ...(source ? { source } : {}),
      });
      const item = result?.item;
      if (!item?.final || item.role !== 'assistant') return null;
      return deriveCanonicalVoiceTranscriptEntryId({
        attemptIdentity: item.attemptIdentity,
        itemId: item.itemId,
        role: item.role,
      });
    },
    admitTranscriptPersistenceEvent: ({
      conversationSessionId,
      event,
      source,
    }: Parameters<BundledRealtimeProviderRuntimeHost['admitTranscriptPersistenceEvent']>[0]) => {
      if (!generation.isCurrent()) return null;
      const canonicalAdmission = admitCanonicalVoiceTranscriptPersistenceEvent({
        conversationSessionId,
        event,
        ...(source ? { source } : {}),
      });
      if (!canonicalAdmission) return null;
      const admission = Object.freeze({}) as BundledAdmittedCanonicalTranscriptPersistenceEvent;
      admittedCanonicalTranscriptPersistenceEvents.set(admission, canonicalAdmission);
      return admission;
    },
    commitAdmittedTranscriptPersistenceEvent: (
      admission: BundledAdmittedCanonicalTranscriptPersistenceEvent,
    ): string | null => {
      const canonicalAdmission = admittedCanonicalTranscriptPersistenceEvents.get(admission);
      if (!canonicalAdmission) return null;
      admittedCanonicalTranscriptPersistenceEvents.delete(admission);
      return commitAdmittedCanonicalVoiceTranscriptPersistenceEvent(canonicalAdmission);
    },
    releaseAdmittedTranscriptPersistenceEvent: (
      admission: BundledAdmittedCanonicalTranscriptPersistenceEvent,
    ): boolean => {
      const canonicalAdmission = admittedCanonicalTranscriptPersistenceEvents.get(admission);
      if (!canonicalAdmission) return false;
      admittedCanonicalTranscriptPersistenceEvents.delete(admission);
      return releaseAdmittedCanonicalVoiceTranscriptPersistenceEvent(canonicalAdmission);
    },
    settleTranscriptPersistence: async ({
      conversationSessionId,
      attemptIdentity,
      retiringTranscriptDrain,
    }: Readonly<{
      conversationSessionId: string;
      attemptIdentity: string;
      retiringTranscriptDrain?: BundledRetiringDirectMediaTranscriptDrain;
    }>) => {
      if (
        !generation.isCurrent()
        && !hasRetiringDirectMediaTranscriptDrain(retiringTranscriptDrain)
      ) return;
      await settleAdmittedCanonicalVoiceTranscriptPersistence({
        conversationSessionId,
        attemptIdentity,
      });
    },
    beginTranscriptAttempt: ({
      conversationSessionId,
      retiringTranscriptDrain,
    }: Readonly<{
      conversationSessionId: string;
      retiringTranscriptDrain?: BundledRetiringDirectMediaTranscriptDrain;
    }>) => {
      if (
        !generation.isCurrent()
        && !hasRetiringDirectMediaTranscriptDrain(retiringTranscriptDrain)
      ) return null;
      return beginCanonicalVoiceTranscriptAttempt({ conversationSessionId });
    },
    presentHostedLeaseNotice(input: Readonly<{
      controlSessionId: string;
      providerId: string;
      phase: 'started' | 'expiring' | 'expired';
      remainingMs: number;
    }>) {
      generation.runIfCurrent(() => {
        const conversationSessionId = voiceConversationBindingResolver.resolveByControlSessionId({
          controlSessionId: input.controlSessionId,
          adapterId: input.providerId,
        })?.conversationSessionId ?? null;
        if (!conversationSessionId) return;
        const text = input.phase === 'started'
          ? t('errors.voiceSessionLimitStarted', { duration: formatHostedLeaseDuration(input.remainingMs) })
          : input.phase === 'expiring'
            ? t('errors.voiceSessionLimitExpiring', { duration: formatHostedLeaseDuration(input.remainingMs) })
            : t('errors.voiceSessionLimitExpired');
        appendVoiceConversationNoteText({ conversationSessionId, text });
      });
    },
    presentAttemptDiagnostic: (input: Parameters<typeof presentVoiceProviderAttemptDiagnostic>[0]) => {
      generation.runIfCurrent(() => presentVoiceProviderAttemptDiagnostic(input));
    },
    clearAttemptStatus: (controlSessionId: string) => {
      generation.runIfCurrent(() => voiceOutputStatusStore.clearAttemptForSession(controlSessionId));
    },
    createInboundWatchdog: createRealtimeInboundWatchdog,
    voiceHooks: Object.freeze({
      onStarted: (sessionId: string) => generation.runIfCurrent(() => voiceHooks.onVoiceStarted(sessionId)) ?? '',
      onStopped: () => { generation.runIfCurrent(() => voiceHooks.onVoiceStopped()); },
    }),
  });
  const current = Object.freeze({ host, isCurrent: generation.isCurrent });
  currentRuntimeHost = current;
  return Object.freeze({
    host,
    revoke() {
      generation.revoke();
      if (currentRuntimeHost === current) currentRuntimeHost = null;
    },
  });
}

export type BundledConversationRuntimeHost = ReturnType<typeof createBundledConversationRuntimeHostLease>['host'];
