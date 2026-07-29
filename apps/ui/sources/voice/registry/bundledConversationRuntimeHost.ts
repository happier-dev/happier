import { Platform } from 'react-native';
import { TokenStorage } from '@/auth/storage/tokenStorage';
import { randomUUID } from '@/platform/randomUUID';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import type {
  BundledRealtimeProviderRuntimeHost,
  BundledVoiceProviderDiagnosticEvent,
} from '@happier-dev/bundled-voice-runtime-contract';
import {
  AgentSessionRealtimeInspectResultV1Schema,
  describeActionForVoiceTool,
  VoiceRealtimeJsonValueSchema,
  zodSchemaToJsonSchemaObject,
  type ConnectedServiceBindingsV1,
  type VoiceRealtimeJsonValue,
} from '@happier-dev/protocol';
import type { PluginVoiceHostedConversationService } from '@happier-dev/plugin-sdk/runtime';
import { realtimeReadOnlyClientTools } from '@/realtime/realtimeClientTools';
import { fetchHappierVoiceToken, completeHappierVoiceSession } from '@/sync/api/voice/apiVoice';
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
import { VOICE_AGENT_GLOBAL_SESSION_ID } from '@/voice/agent/voiceAgentGlobalSessionId';
import { applyVoiceSessionTargetSelection } from '@/voice/binding/applyVoiceSessionTargetSelection';
import { voiceConversationBindingResolver } from '@/voice/binding/VoiceConversationBindingResolver';
import { voiceSessionBindingManager } from '@/voice/binding/voiceConversationBindingRuntime';
import { voiceSessionBindingStore } from '@/voice/binding/voiceConversationBindingStore';
import { redactVoiceToolResultForProvider } from '@/voice/context/redactVoiceToolResult';
import { voiceHooks } from '@/voice/context/voiceHooks';
import { isVoiceQaDebugRuntime } from '@/voice/qa/voiceQaDebugRuntime';
import { useVoiceQaStore } from '@/voice/qa/voiceQaStore';
import {
  createSdkHandleConnection,
  createWebRtcConnection,
  createWebSocketPcmConnection,
} from '@/voice/runtime/connection/VoiceRealtimeConnection';
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
import { createRealtimeMachineStorageMirror } from '@/voice/runtime/realtime/realtimeMachineStorageMirror';
import { VOICE_RUNTIME_CONFIG_DEFAULTS } from '@/voice/runtime/voiceRuntimeConfigDefaults';
import { voiceRuntimeLevelStore } from '@/voice/runtime/levels/voiceRuntimeLevelStore';
import { voiceOutputStatusStore } from '@/voice/runtime/outputStatus/voiceOutputStatusStore';
import {
  presentVoiceProviderAttemptDiagnostic,
} from '@/voice/runtime/outputStatus/presentVoiceProviderAttemptDiagnostic';
import {
  acquireVoiceBackgroundCallAudioMode,
} from '@/voice/runtime/voiceAudioMode';
import {
  beginCanonicalVoiceTranscriptAttempt,
  appendVoiceConversationNoteText,
  deriveCanonicalVoiceTranscriptEntryId,
  projectCanonicalVoiceTranscriptEvent,
  releaseCanonicalVoiceTranscriptConversation,
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
  VOICE_TRANSCRIPT_HISTORY_SYSTEM_SESSION_TAG,
} from '@/voice/persistence/voiceTranscriptHistorySession';
import { readVoiceSessionOwnerMetadataFromState } from '@/voice/shared/readVoiceSessionOwnerMetadata';
import {
  ensureVoiceConversationSessionForVoiceHome,
  resolveQualifiedAgentBackendTargetForMachine,
} from '@/voice/persistence/voiceConversationSession';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

function formatHostedLeaseDuration(ms: number): string {
  const bounded = Math.max(0, Math.floor(ms));
  return bounded < 90_000
    ? `${Math.max(1, Math.ceil(bounded / 1000))}s`
    : `${Math.max(1, Math.ceil(bounded / 60_000))}m`;
}
import { createAgentSessionRealtimeService } from '@/voice/runtime/agentRealtime/createAgentSessionRealtimeService';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { resolveAgentRealtimeVoiceConversationBinding } from './resolveAgentRealtimeVoiceConversationBinding';
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
}>): PluginVoiceHostedConversationService {
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
      state = 'terminal';
      leaseId = null;
      controller.abort();
      detachUpstreamAbort();
      // The canonical server lease is bounded and conservatively quota-counted.
      // Aborting an unverified local attempt must not become another binding or
      // billing writer.
    },
  });
}

function readCandidateAgentSessionBasis(sessionId: string): Readonly<{
  machineId: string | null;
  backendId: string;
}> | null {
  const session = storage.getState().sessions[sessionId];
  const metadata = session ? readSessionOwnerMetadataView(session) : null;
  if (!session || session.active !== true || !metadata) return null;
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
  if (!backendId) return null;
  const machineId = typeof metadata.machineId === 'string'
    ? metadata.machineId.trim() || null
    : null;
  return Object.freeze({ machineId, backendId });
}

async function isCandidateAgentSession(sessionId: string, agent: ContributionRef): Promise<boolean> {
  const candidate = readCandidateAgentSessionBasis(sessionId);
  if (!candidate) return false;
  const expectedTarget = await resolveQualifiedAgentBackendTargetForMachine({
    machineId: candidate.machineId,
    agent,
  });
  const liveCandidate = readCandidateAgentSessionBasis(sessionId);
  return liveCandidate !== null
    && liveCandidate.machineId === candidate.machineId
    && liveCandidate.backendId === candidate.backendId
    && expectedTarget?.backendId === liveCandidate.backendId;
}

async function inspectAgentRealtimeSession(input: Readonly<{
  sessionId: string;
  provider: ContributionRef;
  agent: ContributionRef;
}>): Promise<boolean> {
  // Local metadata is only a candidate prefilter. The session-scoped inspect RPC
  // below proves the exact qualified Agent ref through the daemon's normalized projection.
  if (!await isCandidateAgentSession(input.sessionId, input.agent)) return false;
  try {
    const raw = await sessionRpcWithServerScope({
      sessionId: input.sessionId,
      method: SESSION_RPC_METHODS.SESSION_AGENT_REALTIME_INSPECT,
      payload: { v: 1, provider: input.provider },
    });
    const parsed = AgentSessionRealtimeInspectResultV1Schema.safeParse(raw);
    return parsed.success && parsed.data.ok && parsed.data.status === 'available';
  } catch {
    return false;
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
  const host = Object.freeze({
    globalVoiceSessionId: VOICE_AGENT_GLOBAL_SESSION_ID,
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
      transitionToAcquiringMic: (controlSessionId: string, adapterId: string) =>
        generation.runIfCurrent(() => voiceConversationRuntimeMachine.transitionToAcquiringMic({ controlSessionId, adapterId })),
      transitionToConnecting: (controlSessionId: string, adapterId: string) =>
        generation.runIfCurrent(() => voiceConversationRuntimeMachine.transitionToConnecting({ controlSessionId, adapterId })),
      setReconnecting: (controlSessionId: string, adapterId: string, reconnecting: boolean) =>
        generation.runIfCurrent(() => voiceConversationRuntimeMachine.setReconnecting({
          controlSessionId,
          adapterId,
          reconnecting,
        })),
      transitionToConnected: (controlSessionId: string, adapterId: string) =>
        generation.runIfCurrent(() => voiceConversationRuntimeMachine.transitionToConnected({ controlSessionId, adapterId })),
      transitionToSpeaking: (controlSessionId: string, adapterId: string) =>
        generation.runIfCurrent(() => voiceConversationRuntimeMachine.transitionToSpeaking({ controlSessionId, adapterId })),
      transitionToEnding: (controlSessionId: string, adapterId: string) =>
        generation.runIfCurrent(() => voiceConversationRuntimeMachine.transitionToEnding({ controlSessionId, adapterId })),
      transitionToDisconnected: (controlSessionId: string, adapterId: string, error: unknown | null) =>
        generation.runIfCurrent(() => voiceConversationRuntimeMachine.transitionToDisconnected({
          controlSessionId,
          adapterId,
          error: error as Parameters<typeof voiceConversationRuntimeMachine.transitionToDisconnected>[0]['error'],
        })),
      setError: (controlSessionId: string, adapterId: string, error: unknown) =>
        generation.runIfCurrent(() => voiceConversationRuntimeMachine.setError({
          controlSessionId,
          adapterId,
          error: error as Parameters<typeof voiceConversationRuntimeMachine.setError>[0]['error'],
        })),
      setMuted: (muted: boolean) => generation.runIfCurrent(() => voiceConversationRuntimeMachine.setMuted(muted)),
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
    createWebRtcConnection,
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
    }>) {
      if (!generation.isCurrent()) throw new Error('voice_runtime_generation_revoked');
      const requestedTargetSessionId =
        typeof input.requestedTargetSessionId === 'string'
        && input.requestedTargetSessionId.trim()
          ? input.requestedTargetSessionId.trim()
          : null;
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
      if (
        existing?.adapterId === input.adapterId
        && existing.lifetime === 'runtime_attempt'
        && existing.targetSessionId === requestedTargetSessionId
        && existingOwnsRequestedCarrier
      ) {
        if (requestedTargetSessionId) {
          const hydrated = await sync.ensureSessionVisibleForMessageRoute(
            requestedTargetSessionId,
            { forceRefresh: true },
          );
          if (
            hydrated.kind !== 'available'
            || hydrated.sessionId !== requestedTargetSessionId
          ) {
            throw new Error(
              `Voice transcript target session ${requestedTargetSessionId} could not be hydrated`,
            );
          }
        }
        return Object.freeze({
          conversationSessionId: existing.conversationSessionId,
        });
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
      if (!generation.isCurrent()) throw new Error('voice_runtime_generation_revoked');
      voiceSessionBindingStore.getState().bind({
        adapterId: input.adapterId,
        controlSessionId: input.controlSessionId,
        conversationSessionId,
        lifetime: 'runtime_attempt',
        transcriptMode: 'synthetic',
        targetSessionId: requestedTargetSessionId,
        updatedAt: Date.now(),
      });
      return Object.freeze({ conversationSessionId });
    },
    releaseDirectMediaConversation(input: Readonly<{
      adapterId: string;
      controlSessionId: string;
      conversationSessionId: string;
    }>) {
      const binding = voiceSessionBindingStore.getState().getByConversationSessionId(
        input.conversationSessionId,
      );
      if (
        binding?.adapterId !== input.adapterId
        || binding.controlSessionId !== input.controlSessionId
        || binding.lifetime !== 'runtime_attempt'
      ) return;
      voiceSessionBindingStore.getState().unbind(input.conversationSessionId);
      releaseCanonicalVoiceTranscriptConversation(input.conversationSessionId);
    },
    resolveConversationSessionId(controlSessionId: string, adapterId: string) {
      return voiceConversationBindingResolver.resolveByControlSessionId({ controlSessionId, adapterId })?.conversationSessionId ?? null;
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
          return await sessionRpcWithServerScope({ sessionId, method, payload });
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
      if (!canPersistProviderConversationState(input)) {
        throw new Error('voice_provider_conversation_persistence_unavailable');
      }
      await sync.patchSessionMetadataWithRetry(input.conversationSessionId, (metadata) =>
        writeVoiceProviderConversationMetadata(metadata, {
          providerId: input.providerId,
          state: input.state,
          updatedAt: Date.now(),
        }));
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
    createStorageMirror(input: Parameters<BundledRealtimeProviderRuntimeHost['createStorageMirror']>[0]) {
      return createRealtimeMachineStorageMirror({
        adapterId: input.adapterId,
        getSnapshot: () => input.getSnapshot() as ReturnType<typeof getVoiceConversationRuntimeSnapshot>,
        subscribe: input.subscribe,
        projectSnapshot: (snapshot) => input.projectSnapshot(snapshot),
        getStoragePort: () => storage.getState(),
      });
    },
    projectTranscript: ({ conversationSessionId, event, source }: Readonly<{
      conversationSessionId: string;
      event: Parameters<typeof projectCanonicalVoiceTranscriptEvent>[0]['event'];
      source?: Parameters<typeof projectCanonicalVoiceTranscriptEvent>[0]['source'];
    }>) => generation.runIfCurrent(() => {
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
    }) ?? null,
    beginTranscriptAttempt: ({ conversationSessionId }: Readonly<{
      conversationSessionId: string;
    }>) => generation.runIfCurrent(() => beginCanonicalVoiceTranscriptAttempt({
      conversationSessionId,
    })) ?? null,
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
    runtimeConfig: Object.freeze({
      handleReadyTimeoutMs: VOICE_RUNTIME_CONFIG_DEFAULTS.realtimeConversationHandleReadyTimeoutMs,
      watchdogPollMs: VOICE_RUNTIME_CONFIG_DEFAULTS.realtimeWatchdogPollMs,
      watchdogPlateauMs: VOICE_RUNTIME_CONFIG_DEFAULTS.realtimeWatchdogPlateauMs,
      inboundStallMs: VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.inboundWatchdog.stallTimeoutMs,
      awaitingResponseMs: VOICE_RUNTIME_CONFIG_DEFAULTS.realtime.inboundWatchdog.awaitingResponseTimeoutMs,
    }),
    ...(isVoiceQaDebugRuntime()
      ? {
          diagnostics: Object.freeze({
            appendSystem: (message: string) => generation.runIfCurrent(() => useVoiceQaStore.getState().appendSystem(message)),
            appendProviderEvent: (event: BundledVoiceProviderDiagnosticEvent) =>
              generation.runIfCurrent(() => useVoiceQaStore.getState().appendRealtimeProviderEvent(event)),
            appendError: (reason: string) => generation.runIfCurrent(() => useVoiceQaStore.getState().appendError(reason)),
          }),
        }
      : {}),
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
