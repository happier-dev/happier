import { randomUUID } from 'node:crypto';
import { z } from 'zod';

import {
  AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1,
  AgentRuntimeJsonValueV1Schema,
  AgentSessionRuntimeEventV1Schema,
} from '@happier-dev/protocol/runtime';
import {
  AgentSessionStartupInstructionsV1Schema,
  SessionSystemRecordKindSchema,
  SessionSystemRecordNamespaceSchema,
  type AgentSessionStartupInstructionsV1,
  type PluginContributionIdentityV1,
  type PluginVoiceProviderContributionV1,
  PluginVoiceProviderContributionV1Schema,
} from '@happier-dev/protocol';
import type {
  AgentAcpAuthenticationDefinition,
  AgentAcpCompletionEvidenceOutcome,
  AgentAcpRuntimeDefinition,
  AgentAcpRuntimeExtensions,
  AgentAcpRuntimeOptions,
  AgentSessionOpenRequest,
  AgentSessionControlContext,
  AgentSessionGoalControlContext,
  AgentSessionHostServices,
  AgentSessionRuntime,
  AgentSessionConversationRollbackControl,
  AgentSessionHookServerStartRequest,
  AgentTranscriptFileFollowInput,
  AgentSessionRuntimeFactory,
  AgentSessionRuntimeContext,
  AgentTerminalSurface,
} from '@happier-dev/plugin-sdk/agent-runtime';
import {
  assertExperimentalAgentSessionRealtimeRuntime,
  type AgentSessionRealtimeConversation,
  type AgentSessionRealtimeHandle,
  type AgentSessionRealtimeLifecycleEvent,
} from '@happier-dev/plugin-sdk/experimental/agent-runtime/realtime';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type { PluginInvocationUi } from '@happier-dev/plugin-sdk/runtime';
import type {
  HostCurrentSessionInteractionsService,
  HostSessionInteractionOptions,
} from '@/agent/runtime/state/currentSessionUiTypes';

import { measureAgentSessionRuntimeEventJsonBytes } from '@/agent/runtime/session/events/agentSessionRuntimeEventStream';
import type {
  AgentRuntimeDaemonBridgeEffectV1,
  AgentRuntimeDaemonBridgeRequestV1,
  AgentRuntimeDaemonBridgeResponseV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonBridgeProtocol';
import type { ForegroundAgentRuntimeAdmissionOwner } from './foregroundAdmission';
import {
  AgentRuntimeDaemonBridgeEffectV1Schema,
  AgentRuntimeDaemonExternalSessionFollowEventV1Schema,
  AgentRuntimeDaemonExternalSessionFollowOpenResultV1Schema,
  AgentRuntimeDaemonExternalSessionTakeoverResultV1Schema,
  AgentRuntimeDaemonBridgeSuccessResultV1Schema,
  AgentRuntimeDaemonSessionOpenRequestV1Schema,
  AgentRuntimeDaemonSessionModelsSnapshotV1Schema,
  AgentRuntimeDaemonTerminalLaunchRequestV1Schema,
  AgentRuntimeDaemonTurnContributionsResultV1Schema,
  AgentRuntimeDaemonUiApprovalRequestV1Schema,
  AgentRuntimeDaemonUiApprovalResultV1Schema,
  AgentRuntimeDaemonRealtimeAvailabilityV1Schema,
  AgentRuntimeDaemonRealtimeLifecycleEventV1Schema,
  AgentRuntimeDaemonRealtimeStartResultV1Schema,
  AgentRuntimeDaemonRealtimeStopResultV1Schema,
} from '@/agent/runtime/session/process/agentRuntimeDaemonBridgeProtocol';
import type {
  ExternalSessionHostOperationOwner,
  ExternalSessionHostOperationPort,
} from '@/session/external/hostOperationOwner';
import {
  AgentRuntimeDaemonAcpCompletionEvidenceV1Schema,
  AgentRuntimeDaemonAcpOpenResultV1Schema,
  parseAgentRuntimeDaemonAcpChildOperationResultV1,
  parseAgentRuntimeDaemonAcpDaemonOperationResultV1,
  type AgentRuntimeDaemonAcpResolvedExecutableV1,
  type AgentRuntimeDaemonAcpDaemonOperationV1,
  type AgentRuntimeDaemonAcpChildOperationV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonAcpReverseSessionProtocol';
import {
  createAgentRuntimeDaemonAcpCallbackRegistry,
  encodeAgentRuntimeDaemonAcpOptionsV1,
  type AgentRuntimeDaemonAcpCallbackRegistry,
} from '@/agent/runtime/session/process/agentRuntimeDaemonAcpReverseSessionOptions';
import { normalizeAgentRuntimeBridgeError } from '@/agent/runtime/session/process/agentRuntimeBridgeError';
import { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';
import {
  resolvePluginExecManagedDependencyForHost,
  resolvePluginExecSystemToolForHost,
} from '@/plugins/runtime/invocation/services/exec';
import {
  observeAgentStreamTokenThroughRuntimeRegistry,
  resolvePluginToolPromptContributionsThroughRuntimeRegistry,
  transformAgentContextThroughPluginRuntimeRegistry,
  transformSessionInputThroughRuntimeRegistry,
} from '@/plugins/runtime/hooks/execution/dispatchAgentTurnHooks';
import type { AgentSessionStartupInstructionsMarkerV1 } from '@/daemon/types';
import { logger } from '@/ui/logger';
import {
  snapshotActivatedPluginRuntimeAuthority,
} from '@/plugins/runtime/lifecycle/activation/runtimeAuthority';
import {
  snapshotAgentSessionRealtimeVoiceProviders,
} from '@/agent/runtime/session/realtime/resolveAgentSessionRealtimeVoiceAuthority';
import type {
  PluginContributionRuntimeLifecycle,
} from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import type {
  SessionModelTransitionProviderTargetAuthorizer,
} from '@/providers/sessions/authorizeSessionModelTransitionTarget';

type RegistryLease = Awaited<ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>>;

type PendingEffectSettlement =
  | Readonly<{
      kind: 'complete';
      fingerprint: string;
      requiredAcknowledgedSequence: number;
      result: JsonValue;
    }>
  | Readonly<{
      kind: 'fail';
      fingerprint: string;
      requiredAcknowledgedSequence: number;
      error: Error;
    }>;

type PendingEffect = Readonly<{
  effect: AgentRuntimeDaemonBridgeEffectV1;
  jsonBytes: number;
  settlement: { current: PendingEffectSettlement | null };
  resolve(value: JsonValue): void;
  reject(error: Error): void;
}>;
type EffectInput = AgentRuntimeDaemonBridgeEffectV1 extends infer Effect
  ? Effect extends AgentRuntimeDaemonBridgeEffectV1
    ? Omit<Effect, 'effectId'>
    : never
  : never;
type AcpChildEffectInput =
  AgentRuntimeDaemonAcpChildOperationV1 extends infer Operation
    ? Operation extends AgentRuntimeDaemonAcpChildOperationV1
      ? Omit<Operation, 'effectId'>
      : never
    : never;

type SessionHandle = {
  lease: RegistryLease;
  runtime?: AgentSessionRuntime;
  sessions?: AgentSessionRuntimeFactory;
  terminalSurface?: AgentTerminalSurface;
  realtimeConversation?: AgentSessionRealtimeConversation;
  realtimeProvidersByKey: Map<string, RealtimeProviderAuthority>;
  realtimeHandlesById: Map<string, RealtimeHandleState>;
  runtimeContext?: AgentSessionRuntimeContext;
  openRequestFingerprint?: string;
  startupInstructions?: AgentSessionStartupInstructionsV1;
  startupInstructionsMarker?: AgentSessionStartupInstructionsMarkerV1;
  abort: AbortController;
  events: z.infer<typeof AgentSessionRuntimeEventV1Schema>[];
  eventsJsonBytes: number;
  lastAcknowledgedSequence: number;
  lastObservedSequence: number;
  pendingEffectsById: Map<string, PendingEffect>;
  pendingEffectsJsonBytes: number;
  settledEffectsById: Map<string, string>;
  settledEffectsJsonBytes: number;
  pendingRequestsById: Map<string, AbortController>;
  activeInputBindingsById: Map<string, Parameters<
    AgentSessionHostServices['activeInput']['bind']
  >[0]>;
  reverseAcpSessionsById: Map<string, ReverseAcpSession>;
  featureDecisions: Readonly<Record<string, boolean>>;
  hookCallbacksById: Map<string, AgentSessionHookServerStartRequest>;
  transcriptCallbacksById: Map<string, AgentTranscriptFileFollowInput>;
  externalSessionHostOperations?: ExternalSessionHostOperationPort;
  externalSessionFollowsById: Map<string, ActiveExternalSessionFollow>;
  externalSessionBindingIdentity: Readonly<{
    pluginId: string;
    agentId: string;
    generationId: string;
    sessionId: string;
    generationRetirementSignal: AbortSignal;
    isGenerationCurrent(): boolean;
  }>;
  wakePollers: Set<() => void>;
  streamHookTail: Promise<void>;
  detachRetirementListener?: () => void;
  releaseForegroundAdmission?: () => Promise<void>;
  isCurrent(): boolean;
  retiring: boolean;
  disposed: boolean;
};

type RealtimeHandleState = {
  handle: AgentSessionRealtimeHandle;
  terminal: AgentSessionRealtimeLifecycleEvent | null;
  waiters: Set<(event: AgentSessionRealtimeLifecycleEvent) => void>;
  subscription: Readonly<{ dispose(): void }>;
  detachProviderRetirement?: () => void;
  disposed: boolean;
};

type RealtimeProviderAuthority = Readonly<{
  identity: PluginContributionIdentityV1;
  generation: string;
  declaration: Extract<
    PluginVoiceProviderContributionV1,
    Readonly<{ kind: 'conversation' }>
  >;
  lifecycle: PluginContributionRuntimeLifecycle;
}>;

type ActiveExternalSessionFollow = {
  abort: AbortController;
  subscription?: Readonly<{ dispose(): void | Promise<void> }>;
  pendingDeliveries: Set<Promise<unknown>>;
  closePromise: Promise<void> | null;
};

type ReverseAcpSession = {
  callbacks: AgentRuntimeDaemonAcpCallbackRegistry;
  eventListeners: Set<Parameters<AgentSessionRuntime['watch']>[0]>;
  rollbackControlsById: Map<
    string,
    NonNullable<AgentSessionRuntime['conversationRollback']>
  >;
  providerSessionIdentity: Extract<
    z.infer<typeof AgentSessionRuntimeEventV1Schema>,
    Readonly<{ kind: 'provider-session-id' }>
  > | null;
  completionTurnId: string | null;
  completionEvidenceId: string | null;
  completionEvidenceSubmitted: boolean;
  releaseExecutable(): void;
  disposed: boolean;
};

const BRIDGE_BUFFER_LIMITS =
  AGENT_SESSION_RUNTIME_LIMITS_CANDIDATE_V1.p0MeasuredCandidates;
const BRIDGE_DISPOSE_TIMEOUT_MS = 5_000;
const AGENT_SESSION_OPEN_ATTESTATION_TIMEOUT_MS = 30_000;
const AGENT_SESSION_OPEN_ATTESTATION_POLL_MS = 10;

function readLocalExecutableId(
  reference: string | Readonly<{ pluginId: string; localId: string }>,
  pluginId: string,
): string {
  if (typeof reference === 'string') return reference;
  if (reference.pluginId !== pluginId) {
    throw new Error('ACP executable resolution cannot cross plugin identity');
  }
  return reference.localId;
}

function createIdempotentRelease(release?: () => void): () => void {
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release?.();
  };
}

function retireReverseAcpSession(reverse: ReverseAcpSession): void {
  if (reverse.disposed) return;
  reverse.disposed = true;
  reverse.callbacks.dispose();
  reverse.eventListeners.clear();
  reverse.rollbackControlsById.clear();
  reverse.providerSessionIdentity = null;
  reverse.completionTurnId = null;
  reverse.completionEvidenceId = null;
  reverse.completionEvidenceSubmitted = false;
  reverse.releaseExecutable();
}

function jsonBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function realtimeProviderKey(
  identity: PluginContributionIdentityV1,
): string {
  return `${identity.pluginId}\u0000${identity.localId}`;
}

function resolveRealtimeProviderAuthority(
  handle: SessionHandle,
  provider: Readonly<{
    identity: PluginContributionIdentityV1;
    generation: string;
  }>,
): RealtimeProviderAuthority | null {
  const authority = handle.realtimeProvidersByKey.get(
    realtimeProviderKey(provider.identity),
  );
  return authority
    && authority.generation === provider.generation
    && authority.lifecycle.isCurrent()
    && !authority.lifecycle.retirementSignal.aborted
      ? authority
      : null;
}

function settleRealtimeHandle(
  state: RealtimeHandleState,
  event: AgentSessionRealtimeLifecycleEvent,
): void {
  if (state.terminal) return;
  state.terminal = event;
  const listeners = [...state.waiters];
  state.waiters.clear();
  for (const listener of listeners) listener(event);
}

function hasExactStringSet(
  expected: readonly string[],
  actual: readonly string[] | undefined,
): boolean {
  if (!actual || expected.length !== actual.length) return false;
  const actualValues = new Set(actual);
  return expected.every((value) => actualValues.has(value));
}

function rememberSettledEffect(
  handle: SessionHandle,
  effectId: string,
  fingerprint: string,
): void {
  const previous = handle.settledEffectsById.get(effectId);
  if (previous !== undefined) {
    handle.settledEffectsJsonBytes -= jsonBytes(previous);
  }
  handle.settledEffectsById.set(effectId, fingerprint);
  handle.settledEffectsJsonBytes += jsonBytes(fingerprint);
  while (
    handle.settledEffectsById.size
      > BRIDGE_BUFFER_LIMITS.preWatchReplayBufferMaxEvents
    || handle.settledEffectsJsonBytes
      > BRIDGE_BUFFER_LIMITS.preWatchReplayBufferMaxJsonBytes
  ) {
    const oldest = handle.settledEffectsById.keys().next().value;
    if (typeof oldest !== 'string') break;
    const removed = handle.settledEffectsById.get(oldest);
    if (removed !== undefined) {
      handle.settledEffectsJsonBytes -= jsonBytes(removed);
    }
    handle.settledEffectsById.delete(oldest);
  }
}

function settleAcknowledgedEffects(handle: SessionHandle): void {
  for (const [effectId, pending] of handle.pendingEffectsById) {
    const settlement = pending.settlement.current;
    if (
      !settlement
      || settlement.requiredAcknowledgedSequence > handle.lastAcknowledgedSequence
    ) {
      continue;
    }
    handle.pendingEffectsById.delete(effectId);
    handle.pendingEffectsJsonBytes -= pending.jsonBytes;
    rememberSettledEffect(handle, effectId, settlement.fingerprint);
    if (settlement.kind === 'complete') pending.resolve(settlement.result);
    else pending.reject(settlement.error);
  }
}

const OpenResult = (runtime: AgentSessionRuntime): JsonValue => ({
  methods: [
    ...(runtime.cancel ? ['cancel' as const] : []),
    ...(runtime.updateConfiguration ? ['updateConfiguration' as const] : []),
    ...(runtime.compact ? ['compact' as const] : []),
    ...(runtime.conversationRollback?.rollback ? ['rollback' as const] : []),
    ...(runtime.conversationRollback?.reconcile ? ['reconcileRollback' as const] : []),
  ],
});

function ok(result: unknown): AgentRuntimeDaemonBridgeResponseV1 {
  return {
    ok: true,
    result: AgentRuntimeDaemonBridgeSuccessResultV1Schema.parse(result),
  };
}

function fail(error: unknown): AgentRuntimeDaemonBridgeResponseV1 {
  const normalized = normalizeAgentRuntimeBridgeError(
    error,
    'agent_runtime_daemon_bridge_failed',
  );
  return {
    ok: false,
    error: normalized,
  };
}

function wake(handle: SessionHandle): void {
  for (const listener of [...handle.wakePollers]) listener();
  handle.wakePollers.clear();
}

function acceptsStreamHookWork(handle: SessionHandle): boolean {
  if (handle.disposed) return false;
  try {
    return handle.isCurrent();
  } catch {
    return false;
  }
}

function enqueueAgentStreamTokenHook(
  handle: SessionHandle,
  payload: Parameters<typeof observeAgentStreamTokenThroughRuntimeRegistry>[1],
): void {
  if (!acceptsStreamHookWork(handle)) return;
  handle.streamHookTail = handle.streamHookTail
    .then(async () => {
      if (!acceptsStreamHookWork(handle)) return;
      await observeAgentStreamTokenThroughRuntimeRegistry(
        handle.lease.registry,
        payload,
      );
    })
    .catch(() => {
      logger.debug(
        '[plugins] Daemon Agent stream token hook dispatch failed (non-fatal)',
      );
    });
}

function waitForWork(handle: SessionHandle): Promise<void> {
  if (
    handle.events.length > 0
    || handle.pendingEffectsById.size > 0
    || handle.disposed
  ) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const generationTimer = setInterval(() => {
      if (!handle.isCurrent()) done();
    }, 25);
    generationTimer.unref?.();
    const timer = setTimeout(() => {
      handle.wakePollers.delete(done);
      clearInterval(generationTimer);
      resolve();
    }, 25_000);
    timer.unref?.();
    const done = () => {
      clearTimeout(timer);
      clearInterval(generationTimer);
      handle.wakePollers.delete(done);
      resolve();
    };
    handle.wakePollers.add(done);
  });
}

function buildPollResult(handle: SessionHandle) {
  const events: SessionHandle['events'] = [];
  const effects: AgentRuntimeDaemonBridgeEffectV1[] = [];
  let bytes = jsonBytes({ events: [], effects: [] });
  const maxBytes = BRIDGE_BUFFER_LIMITS.preWatchReplayBufferMaxJsonBytes;
  const maxItems = BRIDGE_BUFFER_LIMITS.preWatchReplayBufferMaxEvents;
  for (const pending of handle.pendingEffectsById.values()) {
    if (pending.settlement.current) continue;
    if (effects.length >= maxItems) break;
    const separatorBytes = effects.length > 0 ? 1 : 0;
    if (bytes + separatorBytes + pending.jsonBytes > maxBytes) break;
    effects.push(pending.effect);
    bytes += separatorBytes + pending.jsonBytes;
  }
  for (const event of handle.events) {
    if (events.length >= maxItems) break;
    const eventBytes = measureAgentSessionRuntimeEventJsonBytes(event);
    const separatorBytes = events.length > 0 ? 1 : 0;
    if (bytes + separatorBytes + eventBytes > maxBytes) break;
    events.push(event);
    bytes += separatorBytes + eventBytes;
  }
  return { events, effects };
}

async function disposeRuntimeBounded(
  runtime: AgentSessionRuntime | undefined,
  reason: Parameters<AgentSessionRuntime['dispose']>[0],
): Promise<void> {
  const disposal = Promise.resolve(runtime?.dispose(reason))
    .catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      disposal,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, BRIDGE_DISPOSE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function closeExternalSessionFollow(
  handle: SessionHandle,
  followId: string,
): Promise<void> {
  const follow = handle.externalSessionFollowsById.get(followId);
  if (!follow) return;
  if (!follow.closePromise) {
    follow.closePromise = Promise.resolve().then(async () => {
      // Stop the source first, then allow every already-emitted event to reach
      // its child projector before retiring the acknowledged bridge callback.
      // Aborting first would reject those in-flight effects and lose the
      // transcript tail when a terminal process exits immediately after write.
      await follow.subscription?.dispose();
      await Promise.allSettled([...follow.pendingDeliveries]);
      follow.abort.abort('closed');
      if (handle.externalSessionFollowsById.get(followId) === follow) {
        handle.externalSessionFollowsById.delete(followId);
      }
    });
  }
  const closePromise = follow.closePromise;
  try {
    await closePromise;
  } catch (error) {
    if (
      handle.externalSessionFollowsById.get(followId) === follow
      && follow.closePromise === closePromise
    ) {
      follow.closePromise = null;
    }
    throw error;
  }
}

async function closeExternalSessionFollowBounded(
  handle: SessionHandle,
  followId: string,
  options: Readonly<{
    onRejection: 'fence' | 'retain';
  }> = { onRejection: 'fence' },
): Promise<void> {
  const follow = handle.externalSessionFollowsById.get(followId);
  if (!follow) return;
  const close = closeExternalSessionFollow(handle, followId);
  let timedOut = false;
  let shouldFence = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      close,
      new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          timedOut = true;
          resolve();
        }, BRIDGE_DISPOSE_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  } catch (error) {
    if (options.onRejection === 'retain') {
      shouldFence = false;
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (shouldFence) {
      follow.abort.abort('closed');
      if (handle.externalSessionFollowsById.get(followId) === follow) {
        handle.externalSessionFollowsById.delete(followId);
      }
    }
  }
  if (!timedOut) return;
  void close.catch(() => undefined);
}

async function drainExternalSessionFollowsBeforeRetirement(
  handle: SessionHandle,
): Promise<void> {
  await Promise.allSettled(
    [...handle.externalSessionFollowsById.keys()].map(
      async (followId) =>
        await closeExternalSessionFollowBounded(handle, followId),
    ),
  );
}

async function disposeRealtimeHandleState(
  state: RealtimeHandleState,
  terminalReason:
    AgentSessionRealtimeLifecycleEvent['reason'] = 'agent_session_disposed',
): Promise<void> {
  if (state.disposed) return;
  state.disposed = true;
  settleRealtimeHandle(state, {
    kind: 'terminal',
    reason: terminalReason,
  });
  state.detachProviderRetirement?.();
  state.detachProviderRetirement = undefined;
  try {
    state.subscription.dispose();
  } finally {
    state.waiters.clear();
    await Promise.resolve(state.handle.dispose());
  }
}

async function disposeHandle(handle: SessionHandle, reason: Parameters<AgentSessionRuntime['dispose']>[0]) {
  if (handle.disposed) return;
  handle.disposed = true;
  handle.detachRetirementListener?.();
  handle.detachRetirementListener = undefined;
  for (const state of handle.realtimeHandlesById.values()) {
    settleRealtimeHandle(state, {
      kind: 'terminal',
      reason: 'agent_session_disposed',
    });
  }
  handle.abort.abort(reason);
  for (const controller of handle.pendingRequestsById.values()) {
    controller.abort(reason);
  }
  handle.pendingRequestsById.clear();
  for (const pending of handle.pendingEffectsById.values()) {
    pending.reject(new Error('Agent runtime session bridge disposed'));
  }
  handle.pendingEffectsById.clear();
  handle.pendingEffectsJsonBytes = 0;
  handle.activeInputBindingsById.clear();
  handle.hookCallbacksById.clear();
  handle.transcriptCallbacksById.clear();
  await Promise.allSettled(
    [...handle.realtimeHandlesById.values()].map(
      async (state) => await disposeRealtimeHandleState(state),
    ),
  );
  handle.realtimeHandlesById.clear();
  await Promise.allSettled(
    [...handle.externalSessionFollowsById.keys()].map(
      async (followId) =>
        await closeExternalSessionFollowBounded(handle, followId),
    ),
  );
  await handle.externalSessionHostOperations?.retire().catch(() => undefined);
  delete handle.externalSessionHostOperations;
  for (const reverse of handle.reverseAcpSessionsById.values()) {
    retireReverseAcpSession(reverse);
  }
  handle.reverseAcpSessionsById.clear();
  wake(handle);
  try {
    await disposeRuntimeBounded(handle.runtime, reason);
  } finally {
    await Promise.allSettled([
      handle.lease.release(),
      handle.releaseForegroundAdmission?.(),
    ]);
  }
}

async function runRequest<T>(params: Readonly<{
  handle: SessionHandle;
  requestId: string;
  execute(signal: AbortSignal): Promise<T>;
}>): Promise<T> {
  if (params.handle.pendingRequestsById.has(params.requestId)) {
    throw new Error('Agent runtime session bridge request id is already active');
  }
  const controller = new AbortController();
  params.handle.pendingRequestsById.set(params.requestId, controller);
  const signal = AbortSignal.any([params.handle.abort.signal, controller.signal]);
  try {
    return await params.execute(signal);
  } finally {
    if (params.handle.pendingRequestsById.get(params.requestId) === controller) {
      params.handle.pendingRequestsById.delete(params.requestId);
    }
  }
}

function assertCurrentForNewWork(handle: SessionHandle): void {
  if (handle.retiring || handle.disposed || !handle.isCurrent()) {
    throw createGenerationStaleError();
  }
}

function createGenerationStaleError(): Error & { code: string } {
  const error = new Error(
    'Agent runtime session bridge belongs to a retired plugin generation',
  ) as Error & { code: string };
  error.code = 'plugin_generation_stale';
  return error;
}

export function createAgentRuntimeSessionBridgeRoutes(options: Readonly<{
  resolveStartupInstructions?(sessionId: string): unknown;
  onStartupInstructionsApplied?(
    sessionId: string,
    marker: AgentSessionStartupInstructionsMarkerV1,
  ): void | Promise<void>;
  foregroundAdmission?: Pick<
    ForegroundAgentRuntimeAdmissionOwner,
    'claimEnvironment' | 'releaseSession' | 'dispose'
  >;
  externalSessionHostOperationOwner?: ExternalSessionHostOperationOwner;
  externalSessionHostBindingContext?: Readonly<{
    machineId: string;
    readAccountRevision(): string | null;
  }>;
  authorizeProviderModelTransition?: (
    params: Readonly<{
      sessionId: string;
      agentId: string;
      lease: RegistryLease;
      selection:
        Parameters<
          SessionModelTransitionProviderTargetAuthorizer
        >[0]['selection'];
    }>,
  ) => ReturnType<SessionModelTransitionProviderTargetAuthorizer>;
}> = {}) {
  const handles = new Map<string, SessionHandle>();

  const attachStartupInstructions = (
    request: AgentSessionOpenRequest,
    startupInstructions: AgentSessionStartupInstructionsV1 | undefined,
  ): AgentSessionOpenRequest => {
    if (!startupInstructions) return request;
    if (request.kind === 'fork') {
      throw new Error('Agent startup instructions are not supported for forks');
    }
    return Object.freeze({ ...request, startupInstructions });
  };

  const dispatchEffect = async <T>(
    handle: SessionHandle,
    effect: EffectInput,
    parser: Readonly<{ parse(value: unknown): T }>,
    options?: Readonly<{
      signal?: AbortSignal;
      onAbort?(effectId: string): void;
      disposeSessionOnBackpressure?: boolean;
    }>,
  ): Promise<T> => {
    if (handle.disposed) throw new Error('Agent runtime session bridge is disposed');
    const effectId = randomUUID();
    const parsedEffect = AgentRuntimeDaemonBridgeEffectV1Schema.parse({
      ...effect,
      effectId,
    });
    const effectJsonBytes = jsonBytes(parsedEffect);
    if (
      handle.pendingEffectsById.size
        >= BRIDGE_BUFFER_LIMITS.preWatchReplayBufferMaxEvents
      || handle.pendingEffectsJsonBytes + effectJsonBytes
        > BRIDGE_BUFFER_LIMITS.preWatchReplayBufferMaxJsonBytes
    ) {
      if (options?.disposeSessionOnBackpressure !== false) {
        void disposeHandle(handle, 'runtime_recovery');
      }
      throw new Error('Agent runtime session bridge effect backpressure exceeded');
    }
    let abortListener: (() => void) | undefined;
    try {
      const value = await new Promise<JsonValue>((resolve, reject) => {
        const pending: PendingEffect = {
          effect: parsedEffect,
          jsonBytes: effectJsonBytes,
          settlement: { current: null },
          resolve,
          reject,
        };
        handle.pendingEffectsById.set(effectId, pending);
        handle.pendingEffectsJsonBytes += effectJsonBytes;
        if (options?.signal) {
          abortListener = () => {
            options.onAbort?.(effectId);
            const error = new Error(
              'Agent runtime bridge effect was aborted',
            ) as Error & { code: string };
            error.name = 'AbortError';
            error.code = 'ABORT_ERR';
            pending.reject(error);
          };
          if (options.signal.aborted) abortListener();
          else options.signal.addEventListener('abort', abortListener, { once: true });
        }
        wake(handle);
      });
      return parser.parse(value);
    } finally {
      if (abortListener) {
        options?.signal?.removeEventListener('abort', abortListener);
      }
    }
  };

  const dispatchDetached = (
    handle: SessionHandle,
    promise: Promise<unknown>,
  ): void => {
    void promise
      .catch(() => disposeHandle(handle, 'runtime_recovery'))
      .catch(() => undefined);
  };

  const dispatchCancelableEffect = async <T>(
    handle: SessionHandle,
    effect: EffectInput,
    parser: Readonly<{ parse(value: unknown): T }>,
    signal?: AbortSignal,
  ): Promise<T> => await dispatchEffect(handle, effect, parser, {
    signal,
    onAbort(targetEffectId) {
      dispatchDetached(handle, dispatchEffect(handle, {
        kind: 'effect.cancel',
        targetEffectId,
      }, z.null()));
    },
  });

  const dispatchAcpChildEffect = async (
    handle: SessionHandle,
    operation: AcpChildEffectInput,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (operation.kind === 'acp.session.send') {
      const reverse = handle.reverseAcpSessionsById.get(
        operation.reverseSessionId,
      );
      if (!reverse || reverse.disposed) {
        throw new Error('ACP reverse session is unavailable');
      }
      reverse.completionTurnId = operation.request.delivery.turnId;
      reverse.completionEvidenceId = null;
      reverse.completionEvidenceSubmitted = false;
    }
    return await dispatchCancelableEffect(
      handle,
      operation,
      {
        parse(value) {
          return parseAgentRuntimeDaemonAcpChildOperationResultV1(
            { ...operation, effectId: 'result-parser' } as AgentRuntimeDaemonAcpChildOperationV1,
            value,
          );
        },
      },
      signal,
    );
  };

  const dispatchAcpDaemonOperation = async (
    handle: SessionHandle,
    operation: AgentRuntimeDaemonAcpDaemonOperationV1,
    signal: AbortSignal,
  ): Promise<unknown> => {
    const reverse = handle.reverseAcpSessionsById.get(operation.reverseSessionId);
    if (!reverse || reverse.disposed) {
      throw new Error('ACP reverse-session callback target is unavailable');
    }
    let completionEvidence: z.infer<
      typeof AgentRuntimeDaemonAcpCompletionEvidenceV1Schema
    > | null = null;
    const readCompletionEvidenceResponse = () => {
      if (
        signal.aborted
        || handle.disposed
        || !handle.isCurrent()
        || reverse.disposed
      ) {
        completionEvidence = null;
        signal.throwIfAborted();
        throw createGenerationStaleError();
      }
      return completionEvidence;
    };
    const callback = <Callback>(
      kind: Parameters<AgentRuntimeDaemonAcpCallbackRegistry['get']>[0],
      callbackId: string,
    ): Callback => reverse.callbacks.get(kind, callbackId) as Callback;
    const extensionContext = (
      context: Extract<
        AgentRuntimeDaemonAcpDaemonOperationV1,
        { kind: 'acp.callback.extension.request' }
      >['context'],
    ) => {
      const currentTurn = context.currentTurn;
      const providerSessionId = context.providerSessionId;
      const completionEvidenceId =
        currentTurn?.completionEvidenceId ?? null;
      if (
        completionEvidenceId !== null
        && reverse.completionTurnId === currentTurn?.turnId
        && reverse.completionEvidenceId === null
      ) {
        reverse.completionEvidenceId = completionEvidenceId;
        reverse.completionEvidenceSubmitted = false;
      }
      return Object.freeze({
        method: context.method,
        ...(context.requestId ? { requestId: context.requestId } : {}),
        signal,
        ...(providerSessionId
          ? { providerSessionId }
          : {}),
        ...(currentTurn && completionEvidenceId
          ? {
              currentTurn: Object.freeze({
                turnId: currentTurn.turnId,
                submitCompletionEvidence(
                  evidence: Readonly<{
                    providerSessionId: string;
                    promptId: string;
                    outcome: AgentAcpCompletionEvidenceOutcome;
                  }>,
                ): boolean {
                  const parsedEvidence =
                    AgentRuntimeDaemonAcpCompletionEvidenceV1Schema.safeParse(
                      evidence,
                    );
                  if (
                    handle.disposed
                    || !handle.isCurrent()
                    || reverse.disposed
                    || signal.aborted
                    || !parsedEvidence.success
                    || parsedEvidence.data.providerSessionId
                      !== providerSessionId
                    || parsedEvidence.data.promptId !== currentTurn.turnId
                    || reverse.completionTurnId !== currentTurn.turnId
                    || reverse.completionEvidenceId !== completionEvidenceId
                    || reverse.completionEvidenceSubmitted
                  ) {
                    return false;
                  }
                  reverse.completionEvidenceSubmitted = true;
                  completionEvidence = parsedEvidence.data;
                  return true;
                },
              }),
            }
          : {}),
      });
    };
    let result: unknown;
    switch (operation.kind) {
      case 'acp.callback.auth.selectMethod':
        result = await callback<NonNullable<Extract<
          AgentAcpAuthenticationDefinition,
          { selectMethod: unknown }
        >['selectMethod']>>(
          'auth.selectMethod',
          operation.callbackId,
        )(operation.context);
        break;
      case 'acp.callback.model.project':
        result = callback<NonNullable<
          NonNullable<AgentAcpRuntimeDefinition['models']>['projectModel']
        >>('model.project', operation.callbackId)(
          operation.rawModel,
          operation.normalizedModel,
        );
        break;
      case 'acp.callback.model.projectUpdate':
        result = callback<NonNullable<
          NonNullable<AgentAcpRuntimeDefinition['models']>['projectUpdate']
        >>('model.projectUpdate', operation.callbackId)(operation.input);
        break;
      case 'acp.callback.model.projectSetModelResponse':
        result = callback<NonNullable<
          NonNullable<AgentAcpRuntimeDefinition['models']>['projectSetModelResponse']
        >>('model.projectSetModelResponse', operation.callbackId)(operation.input);
        break;
      case 'acp.callback.tool.resolveName':
        result = callback<NonNullable<AgentAcpRuntimeDefinition['toolNameResolver']>>(
          'tool.resolveName',
          operation.callbackId,
        )(operation.request) ?? null;
        break;
      case 'acp.callback.tool.sanitizeUpdate':
        result = callback<
          (update: Readonly<Record<string, unknown>>) => Readonly<Record<string, unknown>>
        >('tool.sanitizeUpdate', operation.callbackId)(operation.update);
        break;
      case 'acp.callback.generatedMedia.projectTerminalOutput':
        result = callback<NonNullable<
          NonNullable<
            AgentAcpRuntimeDefinition['generatedMedia']
          >['projectTerminalOutput']
        >>('generatedMedia.projectTerminalOutput', operation.callbackId)(
          operation.input,
        );
        break;
      case 'acp.callback.history.projectUserMessageProviderCheckpoint':
        result = callback<NonNullable<
          NonNullable<
            AgentAcpRuntimeDefinition['history']
          >['projectUserMessageProviderCheckpoint']
        >>(
          'history.projectUserMessageProviderCheckpoint',
          operation.callbackId,
        )(operation.input);
        break;
      case 'acp.callback.history.fork.buildParams':
        result = callback<NonNullable<
          NonNullable<NonNullable<
            AgentAcpRuntimeDefinition['history']
          >['fork']>['buildParams']
        >>('history.fork.buildParams', operation.callbackId)(operation.input);
        break;
      case 'acp.callback.history.fork.readProviderSessionId':
        result = callback<NonNullable<
          NonNullable<NonNullable<
            AgentAcpRuntimeDefinition['history']
          >['fork']>['readProviderSessionId']
        >>('history.fork.readProviderSessionId', operation.callbackId)(
          operation.response,
        );
        break;
      case 'acp.callback.history.createConversationRollback': {
        const historySession = Object.freeze({
          getProviderSessionId: () =>
            reverse.providerSessionIdentity?.providerSessionId ?? null,
          async requestExtension(
            methods: readonly [string, ...string[]],
            params: JsonValue,
            options?: Readonly<{ signal?: AbortSignal; timeoutMs?: number }>,
          ) {
            return await dispatchAcpChildEffect(handle, {
              kind: 'acp.historySession.requestExtension',
              reverseSessionId: operation.reverseSessionId,
              historySessionId: operation.historySessionId,
              methods: [methods[0], ...methods.slice(1)],
              params,
              ...(options?.timeoutMs === undefined
                ? {}
                : { timeoutMs: options.timeoutMs }),
            }, options?.signal) as JsonValue;
          },
        });
        const control = callback<(
          session: typeof historySession,
        ) => AgentSessionConversationRollbackControl>(
          'history.createConversationRollback',
          operation.callbackId,
        )(historySession);
        const controlId = randomUUID();
        reverse.rollbackControlsById.set(controlId, control);
        result = { controlId };
        break;
      }
      case 'acp.callback.history.rollback': {
        const control = reverse.rollbackControlsById.get(operation.controlId);
        if (!control) throw new Error('ACP rollback control is unavailable');
        result = await control.rollback(operation.request, { signal });
        break;
      }
      case 'acp.callback.history.reconcile': {
        const control = reverse.rollbackControlsById.get(operation.controlId);
        if (!control?.reconcile) {
          throw new Error('ACP rollback reconciliation control is unavailable');
        }
        result = await control.reconcile(operation.request, { signal });
        break;
      }
      case 'acp.callback.extension.request':
        result = {
          value: await callback<NonNullable<
          AgentAcpRuntimeExtensions['requests']
        >[string]>('extension.request', operation.callbackId)(
            operation.params,
            extensionContext(operation.context),
          ),
          completionEvidence: readCompletionEvidenceResponse(),
        };
        break;
      case 'acp.callback.extension.notification':
        await callback<NonNullable<
          AgentAcpRuntimeExtensions['notifications']
        >[string]>('extension.notification', operation.callbackId)(
          operation.params,
          extensionContext(operation.context),
        );
        result = {
          completionEvidence: readCompletionEvidenceResponse(),
        };
        break;
      case 'acp.session.event':
        if (operation.event.kind === 'provider-session-id') {
          reverse.providerSessionIdentity = operation.event;
        }
        for (const listener of [...reverse.eventListeners]) {
          await listener(operation.event);
        }
        result = null;
        break;
      case 'acp.callback.cancel':
        handle.pendingRequestsById.get(operation.targetRequestId)?.abort(
          'cancelled',
        );
        result = null;
        break;
    }
    return parseAgentRuntimeDaemonAcpDaemonOperationResultV1(operation, result);
  };

  const finishPreparedOpen = async (
    handle: SessionHandle,
    requestId: string,
    request: AgentSessionOpenRequest,
  ): Promise<SessionHandle> => {
    assertCurrentForNewWork(handle);
    if (!handle.sessions || !handle.runtimeContext) {
      throw new Error('Agent runtime session bridge factory is not prepared');
    }
    if (handle.runtime) {
      throw new Error('Agent runtime session bridge session is already open');
    }
    if (handle.openRequestFingerprint !== JSON.stringify(request)) {
      throw new Error('Agent runtime session bridge prepared request does not match');
    }
    const sessionId = request.sessionId;
    const runtimeContext = handle.runtimeContext;
    const sessions = handle.sessions;
    const runtime = await runRequest({
      handle,
      requestId,
      execute: async (signal) => await sessions.open(
        request,
        Object.freeze({
          ...runtimeContext,
          signal: AbortSignal.any([runtimeContext.signal, signal]),
        }),
      ),
    });
    if (handle.disposed) {
      await disposeRuntimeBounded(runtime, 'runtime_recovery');
      throw new Error(
        'Agent runtime session bridge was disposed during session admission',
      );
    }
    if (!handle.isCurrent()) {
      await disposeRuntimeBounded(runtime, 'plugin_deactivated');
      throw new Error(
        'Agent runtime session bridge generation retired during session admission',
      );
    }
    handle.runtime = runtime;
    if (handle.realtimeProvidersByKey.size > 0) {
      // A declaration authorizes the optional facet; absence or malformed
      // implementation makes Voice unavailable without failing the base session.
      try {
        handle.realtimeConversation =
          assertExperimentalAgentSessionRealtimeRuntime(
            runtime,
          ).realtimeConversation;
      } catch {
        delete handle.realtimeConversation;
      }
    }
    if (
      options.externalSessionHostOperationOwner
      || options.externalSessionHostBindingContext
    ) {
      if (
        !options.externalSessionHostOperationOwner
        || !options.externalSessionHostBindingContext
      ) {
        if (handles.get(sessionId) === handle) handles.delete(sessionId);
        await disposeHandle(handle, 'runtime_recovery');
        throw new Error(
          'External Session host operation bridge is incompletely configured',
        );
      }
      try {
        const identity = handle.externalSessionBindingIdentity;
        handle.externalSessionHostOperations =
          options.externalSessionHostOperationOwner.bind({
            pluginId: identity.pluginId,
            agentId: identity.agentId,
            generationId: identity.generationId,
            sessionId: identity.sessionId,
            machineId:
              options.externalSessionHostBindingContext.machineId,
            readAccountRevision:
              options.externalSessionHostBindingContext.readAccountRevision,
            sessionSignal: handle.abort.signal,
            generationRetirementSignal:
              identity.generationRetirementSignal,
            isGenerationCurrent: identity.isGenerationCurrent,
          });
      } catch (error) {
        if (handles.get(sessionId) === handle) handles.delete(sessionId);
        await disposeHandle(handle, 'runtime_recovery');
        throw error;
      }
    }
    if (handle.startupInstructions) {
      const startupInstructionsMarker = handle.startupInstructionsMarker!;
      delete handle.startupInstructions;
      delete handle.startupInstructionsMarker;
      const {
        startupInstructions: _appliedStartupInstructions,
        ...attestedRequest
      } = request as Exclude<AgentSessionOpenRequest, { kind: 'fork' }>;
      handle.openRequestFingerprint = JSON.stringify(attestedRequest);
      try {
        await options.onStartupInstructionsApplied?.(
          sessionId,
          startupInstructionsMarker,
        );
      } catch (error) {
        if (handles.get(sessionId) === handle) {
          handles.delete(sessionId);
        }
        await disposeHandle(handle, 'runtime_recovery');
        throw error;
      }
    }
    const subscription = runtime.watch((event) => {
      const parsed = AgentSessionRuntimeEventV1Schema.parse(event);
      const eventJsonBytes = measureAgentSessionRuntimeEventJsonBytes(parsed);
      if (
        parsed.sessionId !== sessionId
        || parsed.sequence <= handle.lastObservedSequence
        || handle.events.length
          >= BRIDGE_BUFFER_LIMITS.preWatchReplayBufferMaxEvents
        || handle.eventsJsonBytes + eventJsonBytes
          > BRIDGE_BUFFER_LIMITS.preWatchReplayBufferMaxJsonBytes
      ) {
        void disposeHandle(handle, 'runtime_recovery');
        return;
      }
      handle.lastObservedSequence = parsed.sequence;
      handle.events.push(parsed);
      handle.eventsJsonBytes += eventJsonBytes;
      wake(handle);
      if (parsed.kind === 'message-delta') {
        enqueueAgentStreamTokenHook(handle, {
          sessionId: parsed.sessionId,
          agentId: runtimeContext.agent.id,
          runtimeFamily: 'hostSession',
          turnId: parsed.turnId,
          tokenText: parsed.text,
          streamKind: parsed.channel === 'reasoning' ? 'thinking' : 'assistant',
          timestampMs: parsed.emittedAtMs,
        });
      }
    });
    handle.abort.signal.addEventListener(
      'abort',
      () => subscription.dispose(),
      { once: true },
    );
    return handle;
  };

  const connectedAccountSelectionSchema = z.object({
    purpose: z.string().trim().min(1),
    account: z.object({
      service: z.object({
        pluginId: z.string().trim().min(1),
        localId: z.string().trim().min(1),
      }).strict(),
      accountId: z.string().trim().min(1),
    }).strict(),
  }).strict();
  const controlContextWireSchema = z.object({
    cwd: z.string().min(1),
    activity: z.enum(['active', 'inactive']),
    providerSessionId: z.string().trim().min(1).optional(),
    connectedAccounts: z.array(connectedAccountSelectionSchema).max(256),
  }).strict();
  const createControlContext = (
    handle: SessionHandle,
    value: JsonValue,
  ): AgentSessionControlContext => {
    const context = handle.runtimeContext;
    if (!context) throw new Error('Agent runtime session bridge context is unavailable');
    const wire = controlContextWireSchema.parse(value);
    return Object.freeze({
      plugin: context.plugin,
      contribution: context.contribution,
      surface: context.surface,
      signal: context.signal,
      services: context.services,
      ui: context.ui,
      agent: context.agent,
      protocols: context.protocols,
      session: Object.freeze({
        id: context.session.id,
        cwd: wire.cwd,
        activity: wire.activity,
        ...(wire.providerSessionId
          ? { providerSessionId: wire.providerSessionId }
          : {}),
        connectedAccounts: Object.freeze([...wire.connectedAccounts]),
      }),
    });
  };

  const open = async (
    request: Extract<
      AgentRuntimeDaemonBridgeRequestV1['operation'],
      { kind: 'factory.prepare' | 'session.open' }
    >,
  ): Promise<SessionHandle> => {
    const existing = handles.get(request.request.sessionId);
    if (existing) {
      if (request.kind === 'session.open') {
        return await finishPreparedOpen(
          existing,
          request.requestId,
          attachStartupInstructions(
            request.request as AgentSessionOpenRequest,
            existing.startupInstructions,
          ),
        );
      }
      throw new Error('Agent runtime session bridge already owns this session');
    }
    const lease = await acquireAuthoritativePluginRuntimeRegistryLease();
    let release = true;
    let openingHandle: SessionHandle | null = null;
    try {
      const registration = lease.registry.agentRuntimesByAgentId.get(request.descriptor.agentId);
      if (
        !registration?.hasPrimaryRuntime
        || registration.pluginId !== request.descriptor.pluginId
        || registration.pluginVersion !== request.descriptor.pluginVersion
        || registration.generation !== request.descriptor.generation
        || (registration.immutableGenerationId ?? undefined)
          !== request.descriptor.immutableGenerationId
        || !registration.isCurrent()
      ) {
        throw new Error('Agent runtime session bridge descriptor is stale or mismatched');
      }
      const authoritativeRuntimeAuthority =
        snapshotActivatedPluginRuntimeAuthority(
          lease.registry,
          registration.pluginId,
        );
      if (
        !authoritativeRuntimeAuthority
        || !hasExactStringSet(
          authoritativeRuntimeAuthority.permissions,
          request.descriptor.runtimeAuthority?.permissions,
        )
        || !hasExactStringSet(
          authoritativeRuntimeAuthority.runtimeCapabilities,
          request.descriptor.runtimeAuthority?.runtimeCapabilities,
        )
      ) {
        throw new Error(
          'Agent runtime session bridge descriptor authority is stale or mismatched',
        );
      }
      let startupInstructions: AgentSessionStartupInstructionsV1 | undefined;
      let startupInstructionsMarker:
        | AgentSessionStartupInstructionsMarkerV1
        | undefined;
      let startupInstructionsInput: unknown;
      try {
        startupInstructionsInput = options.resolveStartupInstructions?.(
          request.request.sessionId,
        );
      } catch {
        throw new Error('Agent startup instructions could not be resolved');
      }
      if (startupInstructionsInput !== undefined) {
        if (
          registration.startupInstructionsVersions?.[0] !== 1
          || registration.startupInstructionsVersions.length !== 1
        ) {
          throw new Error(
            'Selected Agent runtime does not support startup instructions',
          );
        }
        const parsed = AgentSessionStartupInstructionsV1Schema.safeParse(
          startupInstructionsInput,
        );
        if (!parsed.success) {
          throw new Error('Agent startup instructions failed validation');
        }
        startupInstructions = Object.freeze({ ...parsed.data });
        startupInstructionsMarker = Object.freeze({
          v: startupInstructions.v,
          id: startupInstructions.id,
          revision: startupInstructions.revision,
        });
      }
      const runtimeOpenRequest = attachStartupInstructions(
        request.request as AgentSessionOpenRequest,
        startupInstructions,
      );
      const abort = new AbortController();
      const retirementSignal = registration.retirementSignal;
      if (!(retirementSignal instanceof AbortSignal)) {
        throw new Error(
          'Agent runtime session bridge registration has no generation retirement signal',
        );
      }
      const runtimeSignal = AbortSignal.any([abort.signal, retirementSignal]);
      const agentRuntime = await registration.createRuntime({ signal: runtimeSignal });
      if (runtimeSignal.aborted || !registration.isCurrent()) {
        throw createGenerationStaleError();
      }
      const sessions = agentRuntime.sessions;
      if (!sessions) throw new Error('Native Agent runtime does not support sessions');
      const terminalSurface = agentRuntime.surfaces?.terminal;
      if (
        (terminalSurface !== undefined)
          !== (request.descriptor.runtimeSurfaces?.terminal === true)
      ) {
        throw new Error(
          'Agent runtime session bridge terminal surface does not match its descriptor',
        );
      }
      const currentRealtimeProviders =
        snapshotAgentSessionRealtimeVoiceProviders({
          runtimeRegistry: lease.registry,
          policyAgentRef: {
            pluginId: registration.pluginId,
            localId: registration.agentId,
          },
        });
      const realtimeProvidersByKey = new Map<string, RealtimeProviderAuthority>();
      for (
        const carried of
          request.descriptor.runtimeSurfaces?.realtimeConversation?.providers
          ?? []
      ) {
        const current = currentRealtimeProviders.find(({ provider, lifecycle }) => (
          provider.identity.pluginId === carried.identity.pluginId
          && provider.identity.localId === carried.identity.localId
          && provider.manifestDigest === carried.manifestDigest
          && lifecycle.generation === carried.generation
          && JSON.stringify(
            PluginVoiceProviderContributionV1Schema.parse(
              provider.definition,
            ),
          ) === JSON.stringify(carried.declaration)
        ));
        if (!current || current.provider.definition.kind !== 'conversation') {
          continue;
        }
        realtimeProvidersByKey.set(
          realtimeProviderKey(carried.identity),
          Object.freeze({
            identity: carried.identity,
            generation: carried.generation,
            declaration: current.provider.definition,
            lifecycle: current.lifecycle,
          }),
        );
      }
      const handle: SessionHandle = {
        lease,
        abort,
        events: [],
        eventsJsonBytes: 0,
        lastAcknowledgedSequence: -1,
        lastObservedSequence: -1,
        pendingEffectsById: new Map(),
        pendingEffectsJsonBytes: 0,
        settledEffectsById: new Map(),
        settledEffectsJsonBytes: 0,
        pendingRequestsById: new Map(),
        realtimeHandlesById: new Map(),
        realtimeProvidersByKey,
        ...(startupInstructions ? { startupInstructions } : {}),
        ...(startupInstructionsMarker ? { startupInstructionsMarker } : {}),
        activeInputBindingsById: new Map(),
        reverseAcpSessionsById: new Map(),
        featureDecisions: Object.freeze({}),
        hookCallbacksById: new Map(),
        transcriptCallbacksById: new Map(),
        externalSessionFollowsById: new Map(),
        externalSessionBindingIdentity: Object.freeze({
          pluginId: registration.pluginId,
          agentId: registration.agentId,
          generationId: registration.generation,
          sessionId: request.request.sessionId,
          generationRetirementSignal: retirementSignal,
          isGenerationCurrent: registration.isCurrent,
        }),
        wakePollers: new Set(),
        streamHookTail: Promise.resolve(),
        ...(terminalSurface ? { terminalSurface } : {}),
        isCurrent: registration.isCurrent,
        ...(options.foregroundAdmission
          ? {
              releaseForegroundAdmission: async () =>
                await options.foregroundAdmission!.releaseSession(
                  request.request.sessionId,
                ),
            }
          : {}),
        retiring: false,
        disposed: false,
      };
      openingHandle = handle;
      handles.set(request.request.sessionId, handle);
      const jsonResult = <T>(schema: z.ZodType<T>) => schema;
      const interactionResultSchema = z.object({
        kind: z.enum(['approval', 'questions', 'confirmation']),
        status: z.enum(['approved', 'denied', 'cancelled', 'unavailable', 'answered']),
      }).passthrough();
      const requestInteraction = async (
        interactionRequest: JsonValue,
        options?: HostSessionInteractionOptions,
      ) => {
          return interactionResultSchema.parse(await dispatchCancelableEffect(handle, {
            kind: 'session.interactions.request',
            request: AgentRuntimeJsonValueV1Schema.parse(interactionRequest),
            ...(options?.permissionContext
              ? { permissionContext: options.permissionContext }
              : {}),
          }, jsonResult(AgentRuntimeJsonValueV1Schema), options?.signal));
      };
      const interactions: HostCurrentSessionInteractionsService = Object.freeze({
        request: requestInteraction as HostCurrentSessionInteractionsService['request'],
      });
      const diagnosticSchema = z.object({
        code: z.string(),
        severity: z.enum(['info', 'warning', 'error']),
        message: z.string().optional(),
      }).strict();
      const questionChoiceAnswerSchema = z.discriminatedUnion('type', [
        z.object({ type: z.literal('choice'), choiceId: z.string() }).strict(),
        z.object({ type: z.literal('custom'), value: z.string() }).strict(),
      ]);
      const questionAnswerSchema = z.discriminatedUnion('type', [
        z.object({ type: z.literal('text'), value: z.string() }).strict(),
        z.object({
          type: z.literal('single'),
          answer: questionChoiceAnswerSchema,
        }).strict(),
        z.object({
          type: z.literal('multiple'),
          answers: z.tuple([questionChoiceAnswerSchema]).rest(questionChoiceAnswerSchema),
        }).strict(),
      ]);
      const questionsResultSchema = z.discriminatedUnion('status', [
        z.object({
          status: z.literal('answered'),
          answers: z.record(z.string(), questionAnswerSchema),
        }).strict(),
        z.object({
          status: z.literal('cancelled'),
          diagnostic: diagnosticSchema.optional(),
        }).strict(),
        z.object({
          status: z.literal('unavailable'),
          diagnostic: diagnosticSchema,
        }).strict(),
      ]);
      const ui: PluginInvocationUi = Object.freeze({
        async requestApproval(request: unknown) {
          try {
            assertCurrentForNewWork(handle);
            return await dispatchCancelableEffect(handle, {
              kind: 'ui.requestApproval',
              request: AgentRuntimeDaemonUiApprovalRequestV1Schema.parse(request),
            }, AgentRuntimeDaemonUiApprovalResultV1Schema, handle.abort.signal);
          } catch {
            let current = false;
            try {
              current = handle.isCurrent();
            } catch {
              // An unverifiable generation fails closed like a retired one.
            }
            if (!current) {
              return Object.freeze({
                status: 'unavailable' as const,
                diagnostic: Object.freeze({
                  code: 'plugin_generation_stale',
                  severity: 'error' as const,
                  message: 'The Agent runtime generation is no longer current',
                }),
              });
            }
            if (handle.abort.signal.aborted) {
              return Object.freeze({ status: 'cancelled' as const });
            }
            return Object.freeze({
              status: 'unavailable' as const,
              diagnostic: Object.freeze({
                code: 'plugin_ui_approval_unavailable',
                severity: 'error' as const,
                message: 'The daemon could not complete the tool approval interaction',
              }),
            });
          }
        },
        async askQuestions(questions: unknown, options?: unknown) {
          try {
            assertCurrentForNewWork(handle);
            return await dispatchCancelableEffect(handle, {
              kind: 'ui.askQuestions',
              questions: AgentRuntimeJsonValueV1Schema.parse(questions),
              ...(options === undefined
                ? {}
                : { options: AgentRuntimeJsonValueV1Schema.parse(options) }),
            }, questionsResultSchema, handle.abort.signal);
          } catch {
            let current = false;
            try {
              current = handle.isCurrent();
            } catch {
              // An unverifiable generation fails closed like a retired one.
            }
            if (!current) {
              return Object.freeze({
                status: 'unavailable' as const,
                diagnostic: Object.freeze({
                  code: 'plugin_generation_stale',
                  severity: 'error' as const,
                  message: 'The Agent runtime generation is no longer current',
                }),
              });
            }
            if (handle.abort.signal.aborted) {
              return Object.freeze({ status: 'cancelled' as const });
            }
            return Object.freeze({
              status: 'unavailable' as const,
              diagnostic: Object.freeze({
                code: 'plugin_ui_questions_unavailable',
                severity: 'error' as const,
                message: 'The daemon could not complete the questions interaction',
              }),
            });
          }
        },
        async confirm(message: string, options?: unknown) {
          return await dispatchEffect(handle, {
            kind: 'ui.confirm',
            message,
            ...(options === undefined
              ? {}
              : { options: AgentRuntimeJsonValueV1Schema.parse(options) }),
          }, z.boolean());
        },
        async notify(message: string, options?: unknown) {
          await dispatchEffect(handle, {
            kind: 'ui.notify',
            message,
            ...(options === undefined
              ? {}
              : { options: AgentRuntimeJsonValueV1Schema.parse(options) }),
          }, z.null());
        },
        status: Object.freeze({
          async set(key: string, text: string | null) {
            await dispatchEffect(handle, { kind: 'ui.status.set', key, text }, z.null());
          },
        }),
        widget: Object.freeze({
          async set(key: string, widget: unknown) {
            await dispatchEffect(handle, {
              kind: 'ui.widget.set',
              key,
              widget: AgentRuntimeJsonValueV1Schema.parse(widget),
            }, z.null());
          },
        }),
        title: Object.freeze({
          async set(title: string | null) {
            await dispatchEffect(handle, { kind: 'ui.title.set', title }, z.null());
          },
        }),
        composer: Object.freeze({
          async replace(text: string) {
            await dispatchEffect(handle, { kind: 'ui.composer.replace', text }, z.null());
          },
        }),
      });
      const mediaRoots = new Map<string, string>();
      const media = Object.freeze({
        async registerSourceRoot(input: Readonly<{ rootPath: string }>) {
          const sourceId = await dispatchEffect(handle, {
            kind: 'session.media.registerSourceRoot',
            rootPath: input.rootPath,
          }, z.string().min(1));
          mediaRoots.set(sourceId, input.rootPath);
          return Object.freeze({
            async publishGenerated(mediaRequest: unknown) {
              return await dispatchEffect(handle, {
                kind: 'session.media.publishGenerated',
                sourceId,
                request: AgentRuntimeJsonValueV1Schema.parse(mediaRequest),
              }, z.object({ status: z.literal('published') }).strict());
            },
            dispose() {
              mediaRoots.delete(sourceId);
              dispatchDetached(handle, dispatchEffect(handle, {
                kind: 'session.media.disposeSourceRoot',
                sourceId,
              }, z.null()));
            },
          });
        },
      });
      const models = Object.freeze({
        bind(source: Readonly<{
          read(): unknown;
          subscribe(listener: (snapshot: unknown) => void): Readonly<{ dispose(): void }>;
        }>) {
          let disposed = false;
          const publish = (snapshot: unknown) => {
            if (disposed) return;
            dispatchDetached(handle, dispatchEffect(handle, {
              kind: 'session.models.publish',
              snapshot:
                AgentRuntimeDaemonSessionModelsSnapshotV1Schema.parse(snapshot),
            }, z.null()));
          };
          publish(source.read());
          const subscription = source.subscribe(publish);
          return Object.freeze({
            dispose() {
              disposed = true;
              subscription.dispose();
            },
          });
        },
      });
      const invocationServices = lease.registry.createAgentInvocationServices({
        pluginId: registration.pluginId,
        pluginVersion: registration.pluginVersion,
        agentId: registration.agentId,
        generation: registration.generation,
        correlationId: request.request.sessionId,
        cwd: request.request.cwd,
        environment: request.request.launchEnvironment?.values,
        providerBindingActive: request.request.providerBinding !== undefined,
        signal: abort.signal,
        session: Object.freeze({
          id: request.request.sessionId,
          current: Object.freeze({ interactions }),
        }),
        isGenerationCurrent: registration.isCurrent,
      });
      const services = invocationServices;
      const systemRecords: AgentSessionHostServices['systemRecords'] = Object.freeze({
        async read(systemRequest) {
          const result = await dispatchEffect(handle, {
            kind: 'session.systemRecords.read',
            request: AgentRuntimeJsonValueV1Schema.parse(systemRequest),
          }, AgentRuntimeJsonValueV1Schema);
          if (result === null) return null;
          return z.object({
            namespace: SessionSystemRecordNamespaceSchema,
            kind: SessionSystemRecordKindSchema,
            localId: z.string(),
            payload: AgentRuntimeJsonValueV1Schema,
          }).strict().parse(result);
        },
        async write(systemRequest) {
          await dispatchEffect(handle, {
            kind: 'session.systemRecords.write',
            request: AgentRuntimeJsonValueV1Schema.parse(systemRequest),
          }, z.null());
        },
      });
      const activeInput: AgentSessionHostServices['activeInput'] = Object.freeze({
        bind(binding) {
          const bindingId = randomUUID();
          handle.activeInputBindingsById.set(bindingId, binding);
          void dispatchEffect(handle, {
            kind: 'session.activeInput.bind',
            bindingId,
            isTurnInFlight: binding.isTurnInFlight(),
            canSteer: binding.canSteer(),
          }, z.null()).catch(() => {
            handle.activeInputBindingsById.delete(bindingId);
            void disposeHandle(handle, 'runtime_recovery');
          });
          let disposed = false;
          return Object.freeze({
            dispose() {
              if (disposed) return;
              disposed = true;
              handle.activeInputBindingsById.delete(bindingId);
              void dispatchEffect(handle, {
                kind: 'session.activeInput.unbind',
                bindingId,
              }, z.null()).catch(() => undefined);
            },
          });
        },
        publishStatus(status) {
          dispatchDetached(handle, dispatchEffect(handle, {
            kind: 'session.activeInput.publishStatus',
            status: AgentRuntimeJsonValueV1Schema.parse(status),
          }, z.null()));
        },
      });
      type TerminalHostService = NonNullable<
        AgentSessionHostServices['terminalHost']
      >;
      type HookService = AgentSessionHostServices['sessionHooks'];
      type FileFollowService =
        AgentSessionHostServices['transcripts']['fileFollow'];
      const hostServices: AgentSessionHostServices = Object.freeze({
        features: Object.freeze({
          isEnabled(featureId: string) {
            return handle.featureDecisions[featureId] === true;
          },
        }),
        terminalHost: Object.freeze({
          async resolve(
            terminalRequest: Parameters<NonNullable<
              AgentSessionHostServices['terminalHost']
            >['resolve']>[0],
          ) {
            return await dispatchEffect(handle, {
              kind: 'session.terminal.resolve',
              request: terminalRequest,
            }, AgentRuntimeJsonValueV1Schema) as Awaited<ReturnType<
              NonNullable<AgentSessionHostServices['terminalHost']>['resolve']
            >>;
          },
          async createOrAttachHost(
            terminalRequest: Parameters<
              TerminalHostService['createOrAttachHost']
            >[0],
          ) {
            return await dispatchEffect(handle, {
              kind: 'session.terminal.createOrAttachHost',
              request: AgentRuntimeJsonValueV1Schema.parse(terminalRequest),
            }, AgentRuntimeJsonValueV1Schema) as Awaited<ReturnType<
              NonNullable<
                AgentSessionHostServices['terminalHost']
              >['createOrAttachHost']
            >>;
          },
          async injectUserPrompt(
            terminalHandle: Parameters<TerminalHostService['injectUserPrompt']>[0],
            input: Parameters<TerminalHostService['injectUserPrompt']>[1],
          ) {
            return await dispatchEffect(handle, {
              kind: 'session.terminal.injectUserPrompt',
              handle: AgentRuntimeJsonValueV1Schema.parse(terminalHandle),
              input: AgentRuntimeJsonValueV1Schema.parse(input),
            }, AgentRuntimeJsonValueV1Schema) as Awaited<ReturnType<
              NonNullable<
                AgentSessionHostServices['terminalHost']
              >['injectUserPrompt']
            >>;
          },
          async interruptTurn(
            terminalHandle: Parameters<TerminalHostService['interruptTurn']>[0],
          ) {
            await dispatchEffect(handle, {
              kind: 'session.terminal.interruptTurn',
              handle: AgentRuntimeJsonValueV1Schema.parse(terminalHandle),
            }, z.null());
          },
          async evaluateLiveness(
            terminalHandle: Parameters<TerminalHostService['evaluateLiveness']>[0],
          ) {
            return await dispatchEffect(handle, {
              kind: 'session.terminal.evaluateLiveness',
              handle: AgentRuntimeJsonValueV1Schema.parse(terminalHandle),
            }, AgentRuntimeJsonValueV1Schema) as Awaited<ReturnType<
              NonNullable<
                AgentSessionHostServices['terminalHost']
              >['evaluateLiveness']
            >>;
          },
          async captureInputState(
            terminalHandle: Parameters<TerminalHostService['captureInputState']>[0],
          ) {
            return await dispatchEffect(handle, {
              kind: 'session.terminal.captureInputState',
              handle: AgentRuntimeJsonValueV1Schema.parse(terminalHandle),
            }, AgentRuntimeJsonValueV1Schema) as Awaited<ReturnType<
              NonNullable<
                AgentSessionHostServices['terminalHost']
              >['captureInputState']
            >>;
          },
          async controlPort(
            terminalHandle: Parameters<TerminalHostService['controlPort']>[0],
          ) {
            const opened = z.object({
              controlPortId: z.string().min(1),
              hostKind: z.enum(['tmux', 'zellij', 'windows_console']),
            }).strict().nullable().parse(await dispatchEffect(handle, {
              kind: 'session.terminal.controlPort.open',
              handle: AgentRuntimeJsonValueV1Schema.parse(terminalHandle),
            }, AgentRuntimeJsonValueV1Schema));
            if (!opened) return null;
            const call = async (
              method: 'sendLiteralText'
                | 'sendRawSequence'
                | 'sendSpecialKey'
                | 'captureScreen',
              argument?: string,
            ) => await dispatchEffect(handle, {
              kind: 'session.terminal.controlPort.call',
              controlPortId: opened.controlPortId,
              method,
              ...(argument === undefined ? {} : { argument }),
            }, AgentRuntimeJsonValueV1Schema);
            return Object.freeze({
              hostKind: opened.hostKind,
              async sendLiteralText(text: string) {
                return await call('sendLiteralText', text) as Awaited<ReturnType<
                  NonNullable<Awaited<ReturnType<NonNullable<
                    AgentSessionHostServices['terminalHost']
                  >['controlPort']>>>['sendLiteralText']
                >>;
              },
              async sendRawSequence(sequence: string) {
                return await call('sendRawSequence', sequence) as Awaited<ReturnType<
                  NonNullable<Awaited<ReturnType<NonNullable<
                    AgentSessionHostServices['terminalHost']
                  >['controlPort']>>>['sendRawSequence']
                >>;
              },
              async sendSpecialKey(
                key: Parameters<NonNullable<Awaited<ReturnType<
                  TerminalHostService['controlPort']
                >>>['sendSpecialKey']>[0],
              ) {
                return await call('sendSpecialKey', key) as Awaited<ReturnType<
                  NonNullable<Awaited<ReturnType<NonNullable<
                    AgentSessionHostServices['terminalHost']
                  >['controlPort']>>>['sendSpecialKey']
                >>;
              },
              async captureScreen() {
                return await call('captureScreen') as Awaited<ReturnType<
                  NonNullable<Awaited<ReturnType<NonNullable<
                    AgentSessionHostServices['terminalHost']
                  >['controlPort']>>>['captureScreen']
                >>;
              },
            });
          },
          async dispose(
            terminalHandle: Parameters<TerminalHostService['dispose']>[0],
            intent: Parameters<TerminalHostService['dispose']>[1],
          ) {
            await dispatchEffect(handle, {
              kind: 'session.terminal.dispose',
              handle: AgentRuntimeJsonValueV1Schema.parse(terminalHandle),
              intent: AgentRuntimeJsonValueV1Schema.parse(intent),
            }, z.null());
          },
        }),
        models,
        activeInput,
        sessionHooks: Object.freeze({
          async startServer(
            hookRequest: Parameters<HookService['startServer']>[0],
          ) {
            const callbackId = randomUUID();
            handle.hookCallbacksById.set(callbackId, hookRequest);
            try {
              const opened = z.object({
                handleId: z.string().min(1),
                port: z.number().int().positive(),
                sessionHookSecretFile: z.string().optional(),
                permissionHookSecretFile: z.string().optional(),
              }).strict().parse(await dispatchEffect(handle, {
                kind: 'session.hooks.startServer',
                callbackId,
                request: {
                  hasSessionHook: hookRequest.onSessionHook !== undefined,
                  hasPermissionHook: hookRequest.onPermissionHook !== undefined,
                  hasStatuslineUpdate:
                    hookRequest.onStatuslineUpdate !== undefined,
                  hasDefaultPermissionHookResponse:
                    hookRequest.defaultPermissionHookResponse !== undefined,
                  hasPermissionRequestTimeoutForTool:
                    hookRequest.permissionRequestTimeoutMsForTool !== undefined,
                  ...(hookRequest.sessionHookSecret === undefined
                    ? {}
                    : { sessionHookSecret: hookRequest.sessionHookSecret }),
                  ...(hookRequest.permissionHookSecret === undefined
                    ? {}
                    : { permissionHookSecret: hookRequest.permissionHookSecret }),
                  ...(hookRequest.permissionRequestTimeoutMs === undefined
                    ? {}
                    : {
                        permissionRequestTimeoutMs:
                          hookRequest.permissionRequestTimeoutMs,
                      }),
                },
              }, AgentRuntimeJsonValueV1Schema));
              let disposed = false;
              return Object.freeze({
                port: opened.port,
                ...(opened.sessionHookSecretFile
                  ? { sessionHookSecretFile: opened.sessionHookSecretFile }
                  : {}),
                ...(opened.permissionHookSecretFile
                  ? { permissionHookSecretFile: opened.permissionHookSecretFile }
                  : {}),
                stop() {
                  if (disposed) return;
                  void dispatchEffect(handle, {
                    kind: 'session.hooks.handle.stop',
                    handleId: opened.handleId,
                  }, z.null()).catch(() => undefined);
                },
                async dispose() {
                  if (disposed) return;
                  disposed = true;
                  handle.hookCallbacksById.delete(callbackId);
                  await dispatchEffect(handle, {
                    kind: 'session.hooks.handle.dispose',
                    handleId: opened.handleId,
                  }, z.null());
                },
              });
            } catch (error) {
              handle.hookCallbacksById.delete(callbackId);
              throw error;
            }
          },
          async resolveForwarderAssets() {
            return await dispatchEffect(handle, {
              kind: 'session.hooks.resolveForwarderAssets',
            }, AgentRuntimeJsonValueV1Schema) as Awaited<ReturnType<
              AgentSessionHostServices['sessionHooks']['resolveForwarderAssets']
            >>;
          },
          async createPluginDir(
            hookRequest: Parameters<HookService['createPluginDir']>[0],
          ) {
            return await dispatchEffect(handle, {
              kind: 'session.hooks.createPluginDir',
              request: AgentRuntimeJsonValueV1Schema.parse(hookRequest),
            }, z.string().min(1));
          },
          async disposePluginDir(
            pluginDir: Parameters<HookService['disposePluginDir']>[0],
          ) {
            await dispatchEffect(handle, {
              kind: 'session.hooks.disposePluginDir',
              pluginDir,
            }, z.null());
          },
          async publishProviderTranscript(
            transcriptRequest: Parameters<
              HookService['publishProviderTranscript']
            >[0],
          ) {
            await dispatchEffect(handle, {
              kind: 'session.hooks.publishProviderTranscript',
              request: AgentRuntimeJsonValueV1Schema.parse(transcriptRequest),
            }, z.null());
          },
        }),
        transcripts: Object.freeze({
          fileFollow: Object.freeze({
            async follow(input: Parameters<FileFollowService['follow']>[0]) {
              const callbackId = randomUUID();
              handle.transcriptCallbacksById.set(callbackId, input);
              try {
                const opened = z.object({
                  handleId: z.string().min(1),
                  id: z.string().min(1),
                }).strict().parse(await dispatchCancelableEffect(handle, {
                  kind: 'session.transcripts.fileFollow.follow',
                  callbackId,
                  input: {
                    path: input.path,
                    startAt: input.startAt,
                    ...(input.strategy ? { strategy: input.strategy } : {}),
                    ...(input.policy ? { policy: input.policy } : {}),
                  },
                }, AgentRuntimeJsonValueV1Schema, input.signal));
                let closed = false;
                const closeFollow = async (
                  options?: Parameters<Awaited<ReturnType<
                    FileFollowService['follow']
                  >>['close']>[0],
                ): Promise<void> => {
                  if (closed) return;
                  closed = true;
                  input.signal?.removeEventListener('abort', closeOnAbort);
                  handle.transcriptCallbacksById.delete(callbackId);
                  await dispatchEffect(handle, {
                    kind: 'session.transcripts.fileFollow.close',
                    handleId: opened.handleId,
                    ...(options
                      ? {
                          options:
                            AgentRuntimeJsonValueV1Schema.parse(options),
                        }
                      : {}),
                  }, z.null());
                };
                const closeOnAbort = (): void => {
                  dispatchDetached(handle, closeFollow());
                };
                if (input.signal?.aborted) closeOnAbort();
                else input.signal?.addEventListener('abort', closeOnAbort, {
                  once: true,
                });
                return Object.freeze({
                  id: opened.id,
                  async drainNow(
                    options?: Parameters<Awaited<ReturnType<
                      FileFollowService['follow']
                    >>['drainNow']>[0],
                  ) {
                    await dispatchEffect(handle, {
                      kind: 'session.transcripts.fileFollow.drainNow',
                      handleId: opened.handleId,
                      ...(options
                        ? {
                            options:
                              AgentRuntimeJsonValueV1Schema.parse(options),
                          }
                        : {}),
                    }, z.null());
                  },
                  async close(
                    options?: Parameters<Awaited<ReturnType<
                      FileFollowService['follow']
                    >>['close']>[0],
                  ) {
                    await closeFollow(options);
                  },
                });
              } catch (error) {
                handle.transcriptCallbacksById.delete(callbackId);
                throw error;
              }
            },
          }),
        }),
        accountUsage: Object.freeze({
          async resolveSourceContext(
            input: Parameters<
              AgentSessionHostServices['accountUsage']['resolveSourceContext']
            >[0],
            options?: Parameters<
              AgentSessionHostServices['accountUsage']['resolveSourceContext']
            >[1],
          ) {
            return await dispatchCancelableEffect(handle, {
              kind: 'session.accountUsage.resolveSourceContext',
              input,
            }, AgentRuntimeJsonValueV1Schema, options?.signal) as Awaited<ReturnType<
              AgentSessionHostServices['accountUsage']['resolveSourceContext']
            >>;
          },
          async recordSnapshot(
            input: Parameters<
              AgentSessionHostServices['accountUsage']['recordSnapshot']
            >[0],
            options?: Parameters<
              AgentSessionHostServices['accountUsage']['recordSnapshot']
            >[1],
          ) {
            return await dispatchCancelableEffect(handle, {
              kind: 'session.accountUsage.recordSnapshot',
              input: AgentRuntimeJsonValueV1Schema.parse(input),
            }, AgentRuntimeJsonValueV1Schema, options?.signal) as Awaited<ReturnType<
              AgentSessionHostServices['accountUsage']['recordSnapshot']
            >>;
          },
          async adoptProvisionalRecord(
            input: Parameters<
              AgentSessionHostServices['accountUsage']['adoptProvisionalRecord']
            >[0],
            options?: Parameters<
              AgentSessionHostServices['accountUsage']['adoptProvisionalRecord']
            >[1],
          ) {
            return await dispatchCancelableEffect(handle, {
              kind: 'session.accountUsage.adoptProvisionalRecord',
              input: AgentRuntimeJsonValueV1Schema.parse(input),
            }, AgentRuntimeJsonValueV1Schema, options?.signal) as Awaited<ReturnType<
              AgentSessionHostServices['accountUsage']['adoptProvisionalRecord']
            >>;
          },
        }),
        auth: Object.freeze({
          async refreshRuntimeAuth(
            authRequest: Parameters<
              AgentSessionHostServices['auth']['refreshRuntimeAuth']
            >[0],
            options?: Parameters<
              AgentSessionHostServices['auth']['refreshRuntimeAuth']
            >[1],
          ) {
            return await dispatchCancelableEffect(handle, {
              kind: 'session.auth.refreshRuntimeAuth',
              request: authRequest,
            }, AgentRuntimeJsonValueV1Schema, options?.signal) as Awaited<ReturnType<
              AgentSessionHostServices['auth']['refreshRuntimeAuth']
            >>;
          },
        }),
        mcp: Object.freeze({
          async resolveServers(options?: Parameters<
            AgentSessionHostServices['mcp']['resolveServers']
          >[0]) {
            return await dispatchCancelableEffect(handle, {
              kind: 'session.mcp.resolveServers',
            }, AgentRuntimeJsonValueV1Schema, options?.signal) as Awaited<ReturnType<
              AgentSessionHostServices['mcp']['resolveServers']
            >>;
          },
        }),
        systemRecords,
        workflowActivity: Object.freeze({
          async publishHeadline(
            headline: Parameters<
              AgentSessionHostServices['workflowActivity']['publishHeadline']
            >[0],
          ) {
            await dispatchEffect(handle, {
              kind: 'session.workflow.publishHeadline',
              headline,
            }, z.null());
          },
        }),
      });
      const context: AgentSessionRuntimeContext = Object.freeze({
        plugin: Object.freeze({
          id: registration.pluginId,
          version: registration.pluginVersion,
        }),
        contribution: Object.freeze({
          id: registration.agentId,
          qualifiedId: `${registration.pluginId}/agents/${registration.agentId}`,
        }),
        surface: 'agent',
        signal: abort.signal,
        services,
        ui,
        agent: Object.freeze({ id: registration.agentId }),
        session: Object.freeze({
          id: request.request.sessionId,
          services: hostServices,
        }),
        protocols: Object.freeze({
          acp: Object.freeze({
            async open(
              acpRequest: AgentSessionOpenRequest,
              options: AgentAcpRuntimeOptions,
            ) {
              assertCurrentForNewWork(handle);
              let resolvedExecutable:
                AgentRuntimeDaemonAcpResolvedExecutableV1 | undefined;
              let releaseExecutable = createIdempotentRelease();
              if (options.transport.kind === 'stdio') {
                const executableId = readLocalExecutableId(
                  options.transport.executable.id,
                  registration.pluginId,
                );
                if (options.transport.executable.kind === 'systemTool') {
                  const resolved = await resolvePluginExecSystemToolForHost(
                    services.exec,
                    {
                    toolId: executableId,
                    purpose: `agent-acp:${registration.agentId}`,
                    cwd: acpRequest.cwd,
                    preferredPath: options.transport.preferredPath,
                    signal: abort.signal,
                    },
                  );
                  const resolvedId = readLocalExecutableId(
                    resolved.executable.id,
                    registration.pluginId,
                  );
                  if (
                    resolved.executable.kind !== 'systemTool'
                    || resolvedId !== executableId
                  ) {
                    throw new Error(
                      `ACP system tool '${executableId}' did not resolve to its exact declared executable`,
                    );
                  }
                  resolvedExecutable = Object.freeze({
                    kind: 'systemTool',
                    toolId: executableId,
                    command: resolved.command,
                    ...(resolved.args ? { args: [...resolved.args] } : {}),
                    ...(resolved.env ? { env: { ...resolved.env } } : {}),
                  });
                } else {
                  if (options.transport.preferredPath !== undefined) {
                    throw new Error(
                      'Managed-dependency ACP transports cannot override their resolved executable path',
                    );
                  }
                  const resolved = await resolvePluginExecManagedDependencyForHost(
                    services.exec,
                    executableId,
                    { signal: abort.signal },
                  );
                  releaseExecutable = createIdempotentRelease(resolved.release);
                  resolvedExecutable = Object.freeze({
                    kind: 'managedDependency',
                    dependencyId: executableId,
                    command: resolved.command,
                    ...(resolved.args ? { args: [...resolved.args] } : {}),
                    ...(resolved.env ? { env: { ...resolved.env } } : {}),
                  });
                }
              }
              const reverseSessionId = randomUUID();
              const reverse: ReverseAcpSession = {
                callbacks: createAgentRuntimeDaemonAcpCallbackRegistry(),
                eventListeners: new Set(),
                rollbackControlsById: new Map(),
                providerSessionIdentity: null,
                completionTurnId: null,
                completionEvidenceId: null,
                completionEvidenceSubmitted: false,
                releaseExecutable,
                disposed: false,
              };
              handle.reverseAcpSessionsById.set(reverseSessionId, reverse);
              try {
                const result = await dispatchEffect(handle, {
                  kind: 'acp.session.open',
                  reverseSessionId,
                  request: AgentRuntimeDaemonSessionOpenRequestV1Schema.parse(acpRequest),
                  options: encodeAgentRuntimeDaemonAcpOptionsV1(
                    options,
                    reverse.callbacks,
                    resolvedExecutable,
                  ),
                }, AgentRuntimeDaemonAcpOpenResultV1Schema);
                if (result.reverseSessionId !== reverseSessionId) {
                  throw new Error('ACP reverse-session identity mismatch');
                }
                const methods = new Set(result.methods);
                let disposed = false;
                const runtime: AgentSessionRuntime = Object.freeze({
                  async send(
                    sendRequest: Parameters<AgentSessionRuntime['send']>[0],
                    sendOptions?: Parameters<AgentSessionRuntime['send']>[1],
                  ) {
                    return await dispatchAcpChildEffect(handle, {
                      kind: 'acp.session.send',
                      reverseSessionId,
                      request: sendRequest,
                    }, sendOptions?.signal) as Awaited<ReturnType<AgentSessionRuntime['send']>>;
                  },
                  ...(methods.has('cancel')
                    ? {
                        async cancel(
                          cancelRequest: Parameters<NonNullable<
                            AgentSessionRuntime['cancel']
                          >>[0],
                          cancelOptions?: Parameters<NonNullable<
                            AgentSessionRuntime['cancel']
                          >>[1],
                        ) {
                          return await dispatchAcpChildEffect(handle, {
                            kind: 'acp.session.cancel',
                            reverseSessionId,
                            turnId: cancelRequest.turnId,
                            reason: cancelRequest.reason,
                          }, cancelOptions?.signal) as Awaited<ReturnType<
                            NonNullable<AgentSessionRuntime['cancel']>
                          >>;
                        },
                      }
                    : {}),
                  ...(methods.has('updateConfiguration')
                    ? {
                        async updateConfiguration(
                          configurationRequest: Parameters<NonNullable<
                            AgentSessionRuntime['updateConfiguration']
                          >>[0],
                          configurationOptions?: Parameters<NonNullable<
                            AgentSessionRuntime['updateConfiguration']
                          >>[1],
                        ) {
                          return await dispatchAcpChildEffect(handle, {
                            kind: 'acp.session.updateConfiguration',
                            reverseSessionId,
                            request: configurationRequest,
                          }, configurationOptions?.signal) as Awaited<ReturnType<
                            NonNullable<AgentSessionRuntime['updateConfiguration']>
                          >>;
                        },
                      }
                    : {}),
                  ...(methods.has('compact')
                    ? {
                        async compact(
                          compactRequest: Parameters<NonNullable<
                            AgentSessionRuntime['compact']
                          >>[0],
                          compactOptions?: Parameters<NonNullable<
                            AgentSessionRuntime['compact']
                          >>[1],
                        ) {
                          return await dispatchAcpChildEffect(handle, {
                            kind: 'acp.session.compact',
                            reverseSessionId,
                            request: compactRequest,
                          }, compactOptions?.signal) as Awaited<ReturnType<
                            NonNullable<AgentSessionRuntime['compact']>
                          >>;
                        },
                      }
                    : {}),
                  ...(methods.has('rollback') && methods.has('reconcileRollback')
                    ? {
                        conversationRollback: Object.freeze({
                          async rollback(
                            rollbackRequest: Parameters<NonNullable<
                              AgentSessionRuntime['conversationRollback']
                            >['rollback']>[0],
                            rollbackOptions?: Parameters<NonNullable<
                              AgentSessionRuntime['conversationRollback']
                            >['rollback']>[1],
                          ) {
                            return await dispatchAcpChildEffect(handle, {
                              kind: 'acp.session.rollback',
                              reverseSessionId,
                              request: rollbackRequest,
                            }, rollbackOptions?.signal) as Awaited<ReturnType<NonNullable<
                              AgentSessionRuntime['conversationRollback']
                            >['rollback']>>;
                          },
                          async reconcile(
                            rollbackRequest: Parameters<NonNullable<
                              NonNullable<
                                AgentSessionRuntime['conversationRollback']
                              >['reconcile']
                            >>[0],
                            rollbackOptions?: Parameters<NonNullable<
                              NonNullable<
                                AgentSessionRuntime['conversationRollback']
                              >['reconcile']
                            >>[1],
                          ) {
                            return await dispatchAcpChildEffect(handle, {
                              kind: 'acp.session.reconcileRollback',
                              reverseSessionId,
                              request: rollbackRequest,
                            }, rollbackOptions?.signal) as Awaited<ReturnType<NonNullable<
                              NonNullable<
                                AgentSessionRuntime['conversationRollback']
                              >['reconcile']
                            >>>;
                          },
                        }),
                      }
                    : {}),
                  watch(
                    listener: Parameters<AgentSessionRuntime['watch']>[0],
                  ) {
                    if (reverse.disposed) {
                      return Object.freeze({ dispose() {} });
                    }
                    reverse.eventListeners.add(listener);
                    if (reverse.providerSessionIdentity) {
                      listener(reverse.providerSessionIdentity);
                    }
                    return Object.freeze({
                      dispose() {
                        reverse.eventListeners.delete(listener);
                      },
                    });
                  },
                  async dispose(
                    reason: Parameters<AgentSessionRuntime['dispose']>[0] =
                      'session_closed',
                  ) {
                    if (disposed) return;
                    disposed = true;
                    handle.reverseAcpSessionsById.delete(reverseSessionId);
                    try {
                      await dispatchAcpChildEffect(handle, {
                        kind: 'acp.session.dispose',
                        reverseSessionId,
                        reason,
                      }).catch(() => undefined);
                    } finally {
                      retireReverseAcpSession(reverse);
                    }
                  },
                });
                return runtime;
              } catch (error) {
                handle.reverseAcpSessionsById.delete(reverseSessionId);
                retireReverseAcpSession(reverse);
                throw error;
              }
            },
          }),
        }),
        workState: Object.freeze({
          publisher(declaredSourceId: string) {
            return Object.freeze({
              async publish(
                workRequest: unknown,
                options?: Readonly<{ signal?: AbortSignal }>,
              ) {
                return await dispatchCancelableEffect(handle, {
                  kind: 'session.workState.publish',
                  declaredSourceId,
                  request: AgentRuntimeJsonValueV1Schema.parse(workRequest),
                }, z.union([
                  z.object({
                    status: z.enum(['applied', 'unchanged']),
                    revision: z.string(),
                    sourceSequence: z.number(),
                  }).strict(),
                  z.object({
                    status: z.literal('ignoredStale'),
                    revision: z.string(),
                    currentSourceSequence: z.number(),
                  }).strict(),
                  z.object({
                    status: z.enum(['conflict', 'unavailable']),
                    diagnostic: diagnosticSchema,
                  }).strict(),
                ]), options?.signal);
              },
            });
          },
        }),
      });
      handle.sessions = sessions;
      handle.runtimeContext = context;
      handle.openRequestFingerprint = JSON.stringify(runtimeOpenRequest);
      const retire = () => {
        if (
          handles.get(request.request.sessionId) !== handle
          || handle.retiring
          || handle.disposed
        ) {
          return;
        }
        handle.retiring = true;
        void drainExternalSessionFollowsBeforeRetirement(handle)
          .finally(async () => {
            if (handles.get(request.request.sessionId) === handle) {
              handles.delete(request.request.sessionId);
            }
            await disposeHandle(handle, 'runtime_recovery');
          })
          .catch(() => undefined);
      };
      retirementSignal.addEventListener('abort', retire, { once: true });
      handle.detachRetirementListener = () => {
        retirementSignal.removeEventListener('abort', retire);
      };
      if (retirementSignal.aborted || !registration.isCurrent()) {
        throw createGenerationStaleError();
      }
      release = false;
      if (request.kind === 'factory.prepare') return handle;
      return await finishPreparedOpen(
        handle,
        request.requestId,
        runtimeOpenRequest,
      );
    } finally {
      if (release) {
        handles.delete(request.request.sessionId);
        if (openingHandle) {
          await disposeHandle(openingHandle, 'runtime_recovery');
        } else {
          await lease.release();
        }
      }
    }
  };

  return Object.freeze({
    async awaitAgentSessionOpen(input: Readonly<{
      sessionId: string;
      timeoutMs?: number;
    }>): Promise<
      | Readonly<{ status: 'opened'; request: AgentSessionOpenRequest }>
      | Readonly<{ status: 'timeout' }>
    > {
      const sessionId = input.sessionId.trim();
      const requestedTimeoutMs = input.timeoutMs;
      const timeoutMs = typeof requestedTimeoutMs === 'number'
        && Number.isFinite(requestedTimeoutMs)
        && requestedTimeoutMs >= 0
        ? Math.trunc(requestedTimeoutMs)
        : AGENT_SESSION_OPEN_ATTESTATION_TIMEOUT_MS;
      const deadlineMs = Date.now() + timeoutMs;
      while (true) {
        const handle = handles.get(sessionId);
        if (
          handle
          && !handle.disposed
          && handle.runtime
          && handle.openRequestFingerprint
        ) {
          // The fingerprint is produced only from the already parsed request
          // passed to sessions.open; runtime assignment proves that call resolved.
          return Object.freeze({
            status: 'opened' as const,
            request: JSON.parse(handle.openRequestFingerprint) as AgentSessionOpenRequest,
          });
        }
        const remainingMs = deadlineMs - Date.now();
        if (!sessionId || remainingMs <= 0) {
          return Object.freeze({ status: 'timeout' as const });
        }
        await new Promise<void>((resolve) => {
          setTimeout(
            resolve,
            Math.min(AGENT_SESSION_OPEN_ATTESTATION_POLL_MS, remainingMs),
          );
        });
      }
    },
    async dispatch(
      request: AgentRuntimeDaemonBridgeRequestV1,
    ): Promise<AgentRuntimeDaemonBridgeResponseV1> {
      try {
        const operation = request.operation;
        if (operation.kind === 'foreground.environment.claim') {
          if (!options.foregroundAdmission) {
            throw new Error(
              'Foreground Agent runtime admission is unavailable',
            );
          }
          return ok(
            await options.foregroundAdmission.claimEnvironment(request),
          );
        }
        if (operation.kind === 'factory.prepare') {
          const handle = await open(operation);
          const sessions = handle.sessions;
          if (!sessions) throw new Error('Agent runtime session bridge factory failed to prepare');
          return ok({
            controls: [
              ...(sessions.continuation ? ['continuation'] : []),
              ...(sessions.goals ? ['goals'] : []),
              ...(sessions.catalog ? ['catalog'] : []),
              ...(sessions.usageLimitRecovery ? ['usageLimitRecovery'] : []),
            ],
          });
        }
        if (operation.kind === 'session.open') {
          const prepared = handles.get(operation.request.sessionId);
          if (prepared) {
            prepared.featureDecisions = Object.freeze({ ...operation.featureDecisions });
          }
          const handle = await open(operation);
          if (!handle.runtime) throw new Error('Agent runtime session bridge failed to open');
          return ok(OpenResult(handle.runtime));
        }
        const handle = handles.get(request.context.sessionId);
        if (!handle || handle.disposed) {
          throw new Error('Agent runtime session bridge handle is unavailable');
        }
        if (
          handle.retiring
          && operation.kind !== 'channel.poll'
          && operation.kind !== 'effect.complete'
          && operation.kind !== 'effect.fail'
        ) {
          throw createGenerationStaleError();
        }
        if (
          operation.kind.startsWith('acp.callback.')
          || operation.kind === 'acp.session.event'
          || operation.kind === 'session.hooks.callback'
          || operation.kind === 'session.transcripts.fileFollow.callback'
          || operation.kind === 'session.turnContributions.resolve'
          || operation.kind === 'channel.poll'
        ) {
          if (!handle.isCurrent() && !handle.retiring) {
            handles.delete(request.context.sessionId);
            await disposeHandle(handle, 'runtime_recovery');
            assertCurrentForNewWork(handle);
          }
        }
        if (
          operation.kind.startsWith('acp.callback.')
          || operation.kind === 'acp.session.event'
        ) {
          return ok(await runRequest({
            handle,
            requestId: operation.requestId,
            execute: async (signal) => await dispatchAcpDaemonOperation(
              handle,
              operation as AgentRuntimeDaemonAcpDaemonOperationV1,
              signal,
            ),
          }));
        }
        switch (operation.kind) {
          case 'runtime.terminal.resolveLaunch': {
            if (!handle.runtime) {
              throw new Error('Agent runtime session bridge is not open');
            }
            assertCurrentForNewWork(handle);
            const terminalSurface = handle.terminalSurface;
            if (!terminalSurface) {
              throw new Error('Agent terminal launch surface is unavailable');
            }
            const terminalRequest =
              AgentRuntimeDaemonTerminalLaunchRequestV1Schema.parse(
                operation.request,
              );
            return ok(await runRequest({
              handle,
              requestId: operation.requestId,
              execute: async () =>
                AgentRuntimeJsonValueV1Schema.parse(
                  await terminalSurface.resolveLaunch(terminalRequest),
                ),
            }));
          }
          case 'runtime.realtimeConversation.inspect': {
            assertCurrentForNewWork(handle);
            const authority = resolveRealtimeProviderAuthority(
              handle,
              operation.provider,
            );
            const realtime = handle.realtimeConversation;
            if (!authority || !realtime) {
              return ok({
                status: 'unavailable',
                reason: authority
                  ? 'unsupported_runtime'
                  : 'feature_unavailable',
                diagnostic: {
                  code: authority
                    ? 'agent_realtime_runtime_unavailable'
                    : 'agent_realtime_provider_authority_stale',
                  severity: 'info',
                },
              });
            }
            return ok(
              AgentRuntimeDaemonRealtimeAvailabilityV1Schema.parse(
                await runRequest({
                  handle,
                  requestId: operation.requestId,
                  execute: async (signal) =>
                    await realtime.inspect({ signal }),
                }),
              ),
            );
          }
          case 'runtime.realtimeConversation.start': {
            assertCurrentForNewWork(handle);
            const authority = resolveRealtimeProviderAuthority(
              handle,
              operation.provider,
            );
            const realtime = handle.realtimeConversation;
            if (!authority || !realtime) {
              return ok({
                status: 'unavailable',
                diagnostic: {
                  code: authority
                    ? 'agent_realtime_runtime_unavailable'
                    : 'agent_realtime_provider_authority_stale',
                  severity: 'info',
                },
              });
            }
            return ok(await runRequest({
              handle,
              requestId: operation.requestId,
              execute: async (signal) => {
                const started = await realtime.start(
                  { transport: operation.transport },
                  { signal },
                );
                if (started.status !== 'started') {
                  return AgentRuntimeDaemonRealtimeStartResultV1Schema.parse(
                    started,
                  );
                }
                if (signal.aborted) {
                  await Promise.resolve(started.handle.dispose());
                  return { status: 'aborted' as const };
                }
                const handleId = randomUUID();
                const waiters = new Set<
                  (event: AgentSessionRealtimeLifecycleEvent) => void
                >();
                const state: RealtimeHandleState = {
                  handle: started.handle,
                  terminal: null,
                  waiters,
                  subscription: { dispose() {} },
                  disposed: false,
                };
                try {
                  state.subscription = started.handle.watch((rawEvent) => {
                    if (state.terminal || state.disposed) return;
                    const parsed =
                      AgentRuntimeDaemonRealtimeLifecycleEventV1Schema.safeParse(
                        rawEvent,
                      );
                    const event = parsed.success
                      ? parsed.data
                      : {
                          kind: 'terminal' as const,
                          reason: 'error' as const,
                          diagnostic: {
                            code: 'agent_realtime_terminal_event_invalid',
                            severity: 'error' as const,
                          },
                        };
                    settleRealtimeHandle(state, event);
                  });
                } catch (error) {
                  await Promise.resolve(started.handle.dispose())
                    .catch(() => undefined);
                  throw error;
                }
                handle.realtimeHandlesById.set(handleId, state);
                const onProviderRetired = () => {
                  settleRealtimeHandle(state, {
                    kind: 'terminal',
                    reason: 'aborted',
                    diagnostic: {
                      code: 'agent_realtime_provider_retired',
                      severity: 'info',
                    },
                  });
                  void disposeRealtimeHandleState(state).catch(() => undefined);
                };
                authority.lifecycle.retirementSignal.addEventListener(
                  'abort',
                  onProviderRetired,
                  { once: true },
                );
                state.detachProviderRetirement = () => {
                  authority.lifecycle.retirementSignal.removeEventListener(
                    'abort',
                    onProviderRetired,
                  );
                };
                if (authority.lifecycle.retirementSignal.aborted) {
                  onProviderRetired();
                }
                if (state.disposed) {
                  handle.realtimeHandlesById.delete(handleId);
                  return { status: 'aborted' as const };
                }
                return AgentRuntimeDaemonRealtimeStartResultV1Schema.parse({
                  status: 'started',
                  transport: started.transport,
                  handleId,
                });
              },
            }));
          }
          case 'runtime.realtimeConversation.handle.stop': {
            const state = handle.realtimeHandlesById.get(operation.handleId);
            if (!state || state.disposed) {
              throw new Error('Agent realtime conversation handle is unavailable');
            }
            return ok(
              AgentRuntimeDaemonRealtimeStopResultV1Schema.parse(
                await runRequest({
                  handle,
                  requestId: operation.requestId,
                  execute: async (signal) =>
                    await state.handle.stop({ signal }),
                }),
              ),
            );
          }
          case 'runtime.realtimeConversation.handle.watch': {
            const state = handle.realtimeHandlesById.get(operation.handleId);
            if (!state || (state.disposed && !state.terminal)) {
              throw new Error('Agent realtime conversation handle is unavailable');
            }
            return ok(await runRequest({
              handle,
              requestId: operation.requestId,
              execute: async (signal) => {
                if (state.terminal) return state.terminal;
                return await new Promise<AgentSessionRealtimeLifecycleEvent>(
                  (resolve, reject) => {
                    const settle = (
                      event: AgentSessionRealtimeLifecycleEvent,
                    ) => {
                      signal.removeEventListener('abort', abort);
                      resolve(event);
                    };
                    const abort = () => {
                      state.waiters.delete(settle);
                      reject(signal.reason);
                    };
                    state.waiters.add(settle);
                    signal.addEventListener('abort', abort, { once: true });
                    if (signal.aborted) abort();
                  },
                );
              },
            }));
          }
          case 'runtime.realtimeConversation.handle.dispose': {
            const state = handle.realtimeHandlesById.get(operation.handleId);
            if (!state) return ok(null);
            handle.realtimeHandlesById.delete(operation.handleId);
            await runRequest({
              handle,
              requestId: operation.requestId,
              execute: async () =>
                await disposeRealtimeHandleState(state, 'aborted'),
            });
            return ok(null);
          }
          case 'factory.continuation.verify': {
            assertCurrentForNewWork(handle);
            const control = handle.sessions?.continuation;
            if (!control) throw new Error('Agent continuation control is unavailable');
            if (operation.request.kind === 'create') {
              throw new Error('Agent continuation verification requires resume or fork');
            }
            const continuationRequest = operation.request as Exclude<
              AgentSessionOpenRequest,
              { kind: 'create' }
            >;
            return ok(await runRequest({
              handle,
              requestId: operation.requestId,
              execute: async (signal) => await control.verify(
                continuationRequest,
                createControlContext(handle, operation.context),
                { signal },
              ),
            }));
          }
          case 'factory.goals.get':
          case 'factory.goals.set':
          case 'factory.goals.clear': {
            assertCurrentForNewWork(handle);
            const control = handle.sessions?.goals;
            if (!control) throw new Error('Agent goal control is unavailable');
            const context: AgentSessionGoalControlContext = Object.freeze({
              ...createControlContext(handle, operation.context),
              goalSource: Object.freeze({
                async publish(
                  goalRequest: Parameters<
                    AgentSessionGoalControlContext['goalSource']['publish']
                  >[0],
                  goalOptions?: Parameters<
                    AgentSessionGoalControlContext['goalSource']['publish']
                  >[1],
                ) {
                  return await dispatchCancelableEffect(handle, {
                    kind: 'factory.goalSource.publish',
                    goalSourceId: operation.goalSourceId,
                    request: AgentRuntimeJsonValueV1Schema.parse(goalRequest),
                  }, AgentRuntimeJsonValueV1Schema, goalOptions?.signal) as Awaited<
                    ReturnType<AgentSessionGoalControlContext['goalSource']['publish']>
                  >;
                },
              }),
            });
            return ok(await runRequest({
              handle,
              requestId: operation.requestId,
              execute: async (signal) => {
                if (operation.kind === 'factory.goals.get') {
                  return await control.get(context, { signal });
                }
                if (operation.kind === 'factory.goals.clear') {
                  return await control.clear(context, { signal });
                }
                const mutation = z.union([
                  z.object({
                    objective: z.string(),
                    status: z.enum(['active', 'paused', 'complete']).optional(),
                    tokenBudget: z.number().nullable().optional(),
                  }).strict(),
                  z.object({
                    objective: z.string().optional(),
                    status: z.enum(['active', 'paused', 'complete']),
                    tokenBudget: z.number().nullable().optional(),
                  }).strict(),
                  z.object({
                    objective: z.string().optional(),
                    status: z.enum(['active', 'paused', 'complete']).optional(),
                    tokenBudget: z.number().nullable(),
                  }).strict(),
                ]).parse(operation.mutation);
                return await control.set(mutation, context, { signal });
              },
            }));
          }
          case 'factory.catalog.list': {
            assertCurrentForNewWork(handle);
            const control = handle.sessions?.catalog;
            if (!control) throw new Error('Agent catalog control is unavailable');
            const catalogRequest = z.discriminatedUnion('kind', [
              z.object({
                kind: z.literal('vendorPlugins'),
                cursor: z.string().optional(),
                limit: z.number().int().positive().optional(),
              }).strict(),
              z.object({
                kind: z.literal('skills'),
                cursor: z.string().optional(),
                limit: z.number().int().positive().optional(),
              }).strict(),
            ]).parse(operation.request);
            return ok(await runRequest({
              handle,
              requestId: operation.requestId,
              execute: async (signal) => await control.list(
                catalogRequest,
                createControlContext(handle, operation.context),
                { signal },
              ),
            }));
          }
          case 'factory.usageLimitRecovery.execute': {
            assertCurrentForNewWork(handle);
            const control = handle.sessions?.usageLimitRecovery;
            if (!control) {
              throw new Error('Agent usage-limit recovery control is unavailable');
            }
            const recoveryRequest = z.discriminatedUnion('kind', [
              z.object({
                kind: z.literal('checkNow'),
                issueFingerprint: z.string().optional(),
                resumePromptMode: z.enum(['standard', 'off', 'custom']).optional(),
              }).strict(),
              z.object({
                kind: z.literal('consumeResetCredit'),
                issueFingerprint: z.string(),
              }).strict(),
            ]).parse(operation.request);
            return ok(await runRequest({
              handle,
              requestId: operation.requestId,
              execute: async (signal) => await control.execute(
                recoveryRequest,
                createControlContext(handle, operation.context),
                { signal },
              ),
            }));
          }
          case 'factory.abandon':
            if (handle.runtime) {
              throw new Error('Agent runtime session bridge cannot abandon an open session');
            }
            handles.delete(request.context.sessionId);
            await disposeHandle(handle, 'runtime_recovery');
            return ok(null);
          case 'session.send':
            if (!handle.runtime) throw new Error('Agent runtime session bridge is not open');
            assertCurrentForNewWork(handle);
            return ok(await runRequest({
              handle,
              requestId: operation.requestId,
              execute: async (signal) => await handle.runtime!.send(
                operation.request,
                { signal },
              ),
            }));
          case 'session.cancel':
            if (!handle.runtime) throw new Error('Agent runtime session bridge is not open');
            return ok(handle.runtime.cancel
              ? await runRequest({
                  handle,
                  requestId: operation.requestId,
                  execute: async (signal) => await handle.runtime!.cancel!({
                    turnId: operation.turnId,
                    reason: operation.reason,
                  }, { signal }),
                })
              : { status: 'unsupported' });
          case 'session.updateConfiguration':
            if (!handle.runtime) throw new Error('Agent runtime session bridge is not open');
            assertCurrentForNewWork(handle);
            return ok(handle.runtime.updateConfiguration
              ? await runRequest({
                  handle,
                  requestId: operation.requestId,
                  execute: async (signal) => await handle.runtime!.updateConfiguration!(
                    operation.request,
                    { signal },
                  ),
                })
              : { status: 'unsupported', diagnostic: {
                  code: 'agent_runtime_configuration_unsupported',
                  severity: 'info',
                } });
          case 'session.modelTransition.authorize':
            assertCurrentForNewWork(handle);
            if (!options.authorizeProviderModelTransition) {
              throw new Error(
                'Daemon Provider model-transition authorization is unavailable',
              );
            }
            return ok(await runRequest({
              handle,
              requestId: operation.requestId,
              execute: async () =>
                await options.authorizeProviderModelTransition!({
                  sessionId: request.context.sessionId,
                  agentId: request.context.agentId,
                  lease: handle.lease,
                  selection: operation.selection,
                }),
            }));
          case 'session.compact':
            if (!handle.runtime) throw new Error('Agent runtime session bridge is not open');
            assertCurrentForNewWork(handle);
            return ok(handle.runtime.compact
              ? await runRequest({
                  handle,
                  requestId: operation.requestId,
                  execute: async (signal) => await handle.runtime!.compact!(
                    operation.request,
                    { signal },
                  ),
                })
              : { status: 'unsupported', diagnostic: {
                  code: 'agent_runtime_compaction_unsupported',
                  severity: 'info',
                }, retryable: false });
          case 'session.rollback':
            if (!handle.runtime) throw new Error('Agent runtime session bridge is not open');
            assertCurrentForNewWork(handle);
            return ok(handle.runtime.conversationRollback?.rollback
              ? await runRequest({
                  handle,
                  requestId: operation.requestId,
                  execute: async (signal) => await handle.runtime!
                    .conversationRollback!.rollback(operation.request, { signal }),
                })
              : { status: 'unsupported', diagnostic: {
                  code: 'agent_runtime_rollback_unsupported',
                  severity: 'info',
                } });
          case 'session.reconcileRollback':
            if (!handle.runtime) throw new Error('Agent runtime session bridge is not open');
            assertCurrentForNewWork(handle);
            return ok(handle.runtime.conversationRollback?.reconcile
              ? await runRequest({
                  handle,
                  requestId: operation.requestId,
                  execute: async (signal) => await handle.runtime!
                    .conversationRollback!.reconcile(operation.request, { signal }),
                })
              : { status: 'unsupported', diagnostic: {
                  code: 'agent_runtime_rollback_reconcile_unsupported',
                  severity: 'info',
                } });
          case 'session.turnContributions.resolve':
            assertCurrentForNewWork(handle);
            return ok(await runRequest({
              handle,
              requestId: operation.requestId,
              execute: async (signal) => {
                if (operation.request.kind === 'prompt') {
                  const promptAssetBlocks =
                    await handle.lease.registry.resolvePromptAssetBlocks({
                      agentId: request.context.agentId,
                      sessionId: request.context.sessionId,
                      ...(operation.request.selectedAsset
                        ? { selectedAsset: operation.request.selectedAsset }
                        : {}),
                      ...(operation.request.machineId
                        ? { machineId: operation.request.machineId }
                        : {}),
                      ...(operation.request.featureIds
                        ? { featureIds: operation.request.featureIds }
                        : {}),
                      signal,
                    });
                  const toolPromptContributions =
                    resolvePluginToolPromptContributionsThroughRuntimeRegistry(
                      handle.lease.registry,
                    );
                  return AgentRuntimeDaemonTurnContributionsResultV1Schema.parse({
                    kind: 'prompt',
                    promptAssetBlocks,
                    toolPromptContributions,
                  });
                }
                if (operation.request.kind === 'transformSessionInput') {
                  const payload =
                    await transformSessionInputThroughRuntimeRegistry(
                      handle.lease.registry,
                      operation.request.payload,
                      { signal },
                    );
                  return AgentRuntimeDaemonTurnContributionsResultV1Schema.parse({
                    kind: 'transformSessionInput',
                    payload,
                  });
                }
                const payload =
                  await transformAgentContextThroughPluginRuntimeRegistry(
                    handle.lease.registry,
                    operation.request.payload,
                    { signal },
                  );
                return AgentRuntimeDaemonTurnContributionsResultV1Schema.parse({
                  kind: 'transformAgentContext',
                  payload,
                });
              },
            }));
          case 'channel.poll':
            if (
              operation.afterSequence < handle.lastAcknowledgedSequence
              || operation.afterSequence > handle.lastObservedSequence
            ) {
              throw new Error('Agent runtime session bridge event acknowledgement is invalid');
            }
            if (operation.afterSequence > handle.lastAcknowledgedSequence) {
              handle.lastAcknowledgedSequence = operation.afterSequence;
              while (
                handle.events[0]
                && handle.events[0].sequence <= handle.lastAcknowledgedSequence
              ) {
                const acknowledged = handle.events.shift();
                if (acknowledged) {
                  handle.eventsJsonBytes -=
                    measureAgentSessionRuntimeEventJsonBytes(acknowledged);
                }
              }
              settleAcknowledgedEffects(handle);
            }
            await waitForWork(handle);
            if (!handle.isCurrent() && !handle.retiring) {
              handles.delete(request.context.sessionId);
              await disposeHandle(handle, 'runtime_recovery');
              assertCurrentForNewWork(handle);
            }
            return ok(buildPollResult(handle));
          case 'effect.complete': {
            const pending = handle.pendingEffectsById.get(operation.effectId);
            const fingerprint = JSON.stringify({
              kind: operation.kind,
              result: operation.result,
            });
            if (!pending) {
              if (handle.settledEffectsById.get(operation.effectId) === fingerprint) {
                return ok(null);
              }
              throw new Error('Agent runtime session bridge effect is unavailable');
            }
            if (pending.settlement.current) {
              if (pending.settlement.current.fingerprint === fingerprint) return ok(null);
              throw new Error('Agent runtime session bridge effect settlement conflicts');
            }
            pending.settlement.current = {
              kind: 'complete',
              fingerprint,
              requiredAcknowledgedSequence: handle.lastObservedSequence,
              result: operation.result,
            };
            settleAcknowledgedEffects(handle);
            return ok(null);
          }
          case 'effect.fail': {
            const pending = handle.pendingEffectsById.get(operation.effectId);
            const fingerprint = JSON.stringify({
              kind: operation.kind,
              error: operation.error,
            });
            if (!pending) {
              if (handle.settledEffectsById.get(operation.effectId) === fingerprint) {
                return ok(null);
              }
              throw new Error('Agent runtime session bridge effect is unavailable');
            }
            const effectError = new Error(operation.error.message) as Error & { code: string };
            effectError.code = operation.error.code;
            if (pending.settlement.current) {
              if (pending.settlement.current.fingerprint === fingerprint) return ok(null);
              throw new Error('Agent runtime session bridge effect settlement conflicts');
            }
            pending.settlement.current = {
              kind: 'fail',
              fingerprint,
              requiredAcknowledgedSequence: handle.lastObservedSequence,
              error: effectError,
            };
            settleAcknowledgedEffects(handle);
            return ok(null);
          }
          case 'session.externalSession.takeover': {
            assertCurrentForNewWork(handle);
            const port = handle.externalSessionHostOperations;
            if (!port) {
              throw new Error(
                'External Session takeover host operation is unavailable',
              );
            }
            return ok(
              AgentRuntimeDaemonExternalSessionTakeoverResultV1Schema.parse(
                await runRequest({
                  handle,
                  requestId: operation.requestId,
                  execute: async (signal) => await port.executeTakeover({
                    ref: operation.ref,
                    source: operation.source,
                    signal,
                  }),
                }),
              ),
            );
          }
          case
            'session.externalSession.follow.openProviderSession':
          case 'session.externalSession.follow.open': {
            assertCurrentForNewWork(handle);
            const port = handle.externalSessionHostOperations;
            if (!port) {
              throw new Error(
                'External Session follow host operation is unavailable',
              );
            }
            if (handle.externalSessionFollowsById.has(operation.followId)) {
              throw new Error(
                'External Session follow id is already active',
              );
            }
            const active: ActiveExternalSessionFollow = {
              abort: new AbortController(),
              pendingDeliveries: new Set(),
              closePromise: null,
            };
            // Install the route-local identity before acquisition so a source
            // that emits synchronously cannot race its first acknowledged
            // child effect.
            handle.externalSessionFollowsById.set(
              operation.followId,
              active,
            );
            try {
              const result =
                await runRequest({
                  handle,
                  requestId: operation.requestId,
                  execute: async (signal) => {
                    const followSignal = AbortSignal.any([
                      signal,
                      active.abort.signal,
                    ]);
                    const listener: Parameters<
                      ExternalSessionHostOperationPort[
                        'executeFollow'
                      ]
                    >[0]['listener'] = async (event) => {
                        if (
                          handle.disposed
                          || !handle.isCurrent()
                          || handle.externalSessionFollowsById.get(
                            operation.followId,
                          ) !== active
                        ) {
                          throw createGenerationStaleError();
                        }
                        const delivery = dispatchEffect(
                          handle,
                          {
                            kind:
                              'session.externalSession.follow.event',
                            followId: operation.followId,
                            event:
                              AgentRuntimeDaemonExternalSessionFollowEventV1Schema.parse(
                                event,
                              ),
                          },
                          z.null(),
                          {
                            signal: followSignal,
                            disposeSessionOnBackpressure: false,
                          },
                        );
                        active.pendingDeliveries.add(delivery);
                        try {
                          await delivery;
                        } finally {
                          active.pendingDeliveries.delete(delivery);
                        }
                    };
                    const options = {
                      ...(operation.cursor
                        ? { cursor: operation.cursor }
                        : {}),
                      signal: followSignal,
                    };
                    return operation.kind
                      ===
                        'session.externalSession.follow.openProviderSession'
                      ? await port.executeProviderSessionFollow({
                        agentId: operation.agentId,
                        providerSessionId:
                          operation.providerSessionId,
                        options,
                        listener,
                      })
                      : await port.executeFollow({
                        ref: operation.ref,
                        source: operation.source,
                        options,
                        listener,
                      });
                  },
                });
              if (result.status === 'following') {
                active.subscription = result.subscription;
              } else {
                await closeExternalSessionFollowBounded(
                  handle,
                  operation.followId,
                );
              }
              return ok(
                AgentRuntimeDaemonExternalSessionFollowOpenResultV1Schema.parse(
                  result.status === 'following'
                    ? {
                        status: 'following',
                        startingCursor: result.startingCursor,
                      }
                    : result,
                ),
              );
            } catch (error) {
              await closeExternalSessionFollowBounded(
                handle,
                operation.followId,
              );
              throw error;
            }
          }
          case 'session.externalSession.follow.close':
            await closeExternalSessionFollowBounded(
              handle,
              operation.followId,
              { onRejection: 'retain' },
            );
            return ok(null);
          case 'request.cancel': {
            handle.pendingRequestsById.get(operation.targetRequestId)?.abort('cancelled');
            return ok(null);
          }
          case 'activeInput.onPromptQueued': {
            const binding = handle.activeInputBindingsById.get(operation.bindingId);
            if (!binding) throw new Error('Agent active-input binding is unavailable');
            binding.onPromptQueued();
            return ok(null);
          }
          case 'activeInput.applyPermissionIntent': {
            const binding = handle.activeInputBindingsById.get(operation.bindingId);
            if (!binding) throw new Error('Agent active-input binding is unavailable');
            return ok(await binding.applyPermissionIntentDuringTurn(
              z.enum([
                'default',
                'read-only',
                'safe-yolo',
                'yolo',
                'plan',
              ]).parse(operation.permissionIntent),
            ));
          }
          case 'activeInput.clearTerminalComposer': {
            const binding = handle.activeInputBindingsById.get(operation.bindingId);
            if (!binding) throw new Error('Agent active-input binding is unavailable');
            return ok(await binding.clearTerminalComposer(
              z.object({
                expectedStateAtMs: z.number().optional(),
              }).strict().parse(operation.request),
            ));
          }
          case 'activeInput.interruptPendingInputAndRun': {
            const binding = handle.activeInputBindingsById.get(operation.bindingId);
            if (!binding) throw new Error('Agent active-input binding is unavailable');
            return ok(await binding.interruptPendingInputAndRun(
              z.object({
                localId: z.string().trim().min(1),
                expectedStateAtMs: z.number().optional(),
              }).strict().parse(operation.request),
            ));
          }
          case 'session.hooks.callback': {
            const callback = handle.hookCallbacksById.get(operation.callbackId);
            if (!callback) throw new Error('Agent session-hook callback is unavailable');
            if (operation.callbackKind === 'session') {
              const payload = z.object({
                providerSessionId: z.string().min(1),
                data: z.record(z.string(), z.unknown()),
              }).strict().parse(operation.payload);
              await callback.onSessionHook?.(
                payload.providerSessionId,
                payload.data,
              );
              return ok(null);
            }
            if (operation.callbackKind === 'permission') {
              return ok(await callback.onPermissionHook?.(
                z.record(z.string(), z.unknown()).parse(operation.payload),
              ) ?? null);
            }
            if (operation.callbackKind === 'statusline') {
              await callback.onStatuslineUpdate?.(
                z.record(z.string(), z.unknown()).parse(operation.payload),
              );
              return ok(null);
            }
            if (operation.callbackKind === 'defaultPermission') {
              return ok(await callback.defaultPermissionHookResponse?.(
                z.record(z.string(), z.unknown()).parse(operation.payload),
              ) ?? null);
            }
            const toolName = z.string().nullable().parse(operation.payload);
            const timeout = await callback.permissionRequestTimeoutMsForTool?.(
              toolName,
            );
            return ok(timeout === undefined
              ? { kind: 'undefined' }
              : { kind: 'value', value: timeout });
          }
          case 'session.transcripts.fileFollow.callback': {
            const callback = handle.transcriptCallbacksById.get(
              operation.callbackId,
            );
            if (!callback) {
              throw new Error('Agent transcript callback is unavailable');
            }
            if (operation.callbackKind === 'line') {
              await callback.onLine(z.object({
                line: z.string(),
                sourcePath: z.string(),
                sequence: z.number().int().nonnegative(),
              }).strict().parse(operation.payload));
              return ok(null);
            }
            if (operation.callbackKind === 'reset') {
              await callback.onReset?.(z.object({
                reason: z.enum(['missing', 'replaced', 'truncated']),
              }).strict().parse(operation.payload));
              return ok(null);
            }
            const error = z.object({ message: z.string() }).strict()
              .parse(operation.payload);
            await callback.onError?.(new Error(error.message));
            return ok(null);
          }
          case 'session.dispose':
            handles.delete(request.context.sessionId);
            await disposeHandle(handle, operation.reason);
            return ok(null);
        }
        throw new Error(`Unsupported agent runtime bridge operation: ${operation.kind}`);
      } catch (error) {
        return fail(error);
      }
    },
    async disposeSession(sessionIdRaw: string) {
      const sessionId = sessionIdRaw.trim();
      if (!sessionId) return;
      const handle = handles.get(sessionId);
      if (!handle) {
        await options.foregroundAdmission?.releaseSession(sessionId);
        return;
      }
      handles.delete(sessionId);
      await disposeHandle(handle, 'runtime_recovery');
    },
    async dispose() {
      const active = [...handles.values()];
      handles.clear();
      await Promise.allSettled([
        ...active.map((handle) => disposeHandle(handle, 'host_shutdown')),
        ...(options.foregroundAdmission
          ? [options.foregroundAdmission.dispose()]
          : []),
      ]);
    },
  });
}

export type AgentRuntimeSessionBridgeRoutes =
  ReturnType<typeof createAgentRuntimeSessionBridgeRoutes>;
