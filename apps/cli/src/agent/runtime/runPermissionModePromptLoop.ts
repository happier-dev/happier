import { readQueuedPromptDeliveryIdentity, hasQueuedPromptDeliveryIdentity, confirmLocallyConsumedPrompt, observeLocalSpecialCommandSettlement } from './permissions/localSpecialCommandSettlement';
import type { ManualCompactionQueue } from './queueSpecialCommands';
import { randomUUID } from 'node:crypto';

import { readPendingLocalId } from '@happier-dev/protocol/sessions/pending/pendingLocalId';
import { AgentSessionStartupInstructionsV1Schema } from '@happier-dev/protocol/runtime/agentSessionStartupInstructionsV1';
import { validatePluginHookPayloadV1 } from '@happier-dev/protocol/plugins/hooks';
import { isModelRefGrantedV1, isPermissionModeGrantedV1 } from '@happier-dev/protocol/auth/apiTokenGrant';
import type { SessionPendingQueueDeliveryTiming, ProviderBoundModelRef, SessionModelTransitionResultV1, AgentSessionStartupInstructionsMarkerV1 } from '@happier-dev/protocol';
import { readNonBlankOpaqueIdentifier } from '@happier-dev/protocol/strings/opaqueIdentifier';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import { resolveOfflineReconnectionBackoffDelayMs } from '@/api/offline/serverConnectionErrors';
import type { ACPProvider } from '@/api/session/sessionMessageTypes';
import type { PermissionMode } from '@/api/types';
import { parseSpecialCommand } from '@/cli/parsers/specialCommands';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { isDefaultWriteLikeToolName } from '@/agent/permissions/writeLikeToolNameHeuristics';
import type { MessageQueue2 } from '@/agent/runtime/modeMessageQueue';
import { resolveAppendSystemPromptBaseOverride } from '@/agent/runtime/permissions/appendSystemPrompt';
import {
  isRuntimeTurnFailureAlreadySurfaced,
  type RuntimeTurnOperations,
  type RuntimeTurnMessage,
  type RuntimeTurnPromptMeta,
  type RuntimeTurnSessionOpenIntent,
} from '@/agent/runtime/turns/runtimeTurnOperations';
import {
  initializePermissionModeStateSync,
} from '@/agent/runtime/permissions/modeStateSync';
import {
  createSessionProviderInputConsumerSessionAdapter,
  waitForNextPermissionModeMessage,
} from '@/agent/runtime/waitForNextPermissionModeMessage';
import type { MessageBuffer } from '@/ui/ink/messageBuffer';
import type {
  PermissionModeQueuedPrompt,
  PermissionModeQueuedPromptMode,
} from '@/agent/runtime/permissions/queuedPrompt';
import {
  normalizePermissionModeQueuedPromptLocalIds,
  isNextTurnContextQueuedPrompt,
} from '@/agent/runtime/permissions/queuedPrompt';
import { fitHappierReplaySeedWithinTotalBudget } from '@happier-dev/agents';

import { configuration } from '@/configuration';
import {
  resolveProviderPromptWithReplaySeed,
  type ReplaySeedSettlementOutcome,
} from '@/agent/runtime/replaySeed/replaySeedV1';
import type { UnsettledReplaySeedRetirement } from '@/agent/runtime/replaySeed/unsettledReplaySeedRetirement';
import { projectSessionInputReferencesV1 } from '@happier-dev/protocol/sessions/messages/sessionInputReferenceProjectionV1';
import { isAbortLikeError } from '@/agent/runtime/lifecycle/classifyAbortLikeError';
import { isAgentNativeResumeIdentityMismatchError } from '@/session/agentTransition/agentNativeReturn';
import {
  createSessionProviderInputConsumer,
  PendingQueueMaterializationAuthError,
} from '@/agent/runtime/session/input/sessionProviderInputConsumer';
import type { RegisterProviderAcceptedEffect, SessionProviderInputRejectedBeforeEffectReason } from '@/agent/runtime/session/input/providerInputOutcome';
import type {
  DrainPendingResult,
  MessageBatch,
  SessionProviderInputConsumer,
} from '@/agent/runtime/session/input/_types';
import { PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE } from '@/agent/runtime/session/input/pendingQueueDrainPolicy';
import {
  DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS,
  waitForSessionMetadataRetryBackoff,
} from '@/agent/runtime/session/metadataWaitRetryBackoff';
import {
  beginAssistantTextSnapshotTurnScope,
  completeAssistantTextSnapshotTurnScope,
  resetAssistantTextSnapshotTurnScope,
  type AssistantTextSnapshotTurnScope,
} from '@/agent/runtime/turns/assistantTextSnapshotTurnScope';
import type { StructuredInputCatalogReaders, StructuredInputComposerReferenceResolver } from '@/agent/runtime/turns/resolveStructuredInputProviderContext';
import { prepareSessionInputForProviderDispatch, resolveSessionInputForProviderDispatch, readStructuredInputPreparationFailure, type ComposerAttachmentDispatchResolver } from '@/agent/runtime/turns/prepareSessionInputForProviderDispatch';
import { logger } from '@/ui/logger';
import type { AgentCompositionToolSelection } from '@/plugins/runtime/hooks/execution/dispatchAgentTurnHooks';
import type { HostPreparedContext } from '@/agent/runtime/session/contextOnly/hostContextOnlyInput';
import { createPromptCompositionScope, type PromptPlanComposition } from '@/agent/prompting/promptComposition';
import type { SessionPromptPlanResolver } from '@/agent/prompting/coding/sessionPromptPlan';
import type { ReadyNotificationTurnContext } from '@/agent/runtime/notifications/createReadyNotificationDispatcher';

export { projectSessionComposerAttachmentDispatchInput } from '@/agent/runtime/turns/prepareSessionInputForProviderDispatch';
export type { ComposerAttachmentDispatchResolver } from '@/agent/runtime/turns/prepareSessionInputForProviderDispatch';

export type PermissionModePromptLoopTurnOperations = RuntimeTurnOperations & Readonly<{
  supportsInFlightSteer?: () => boolean;
  canSteerPrompt?: () => boolean;
  compactContext?: (command: string) => Promise<void>;
  sendTurnPrompt: (
    prompt: string,
    meta?: RuntimeTurnPromptMeta,
  ) => Promise<void>;
  // Read at dispatch to reconstruct provider context for composer references (INV-9).
  listVendorPlugins?: () => Promise<unknown>;
  listSkills?: () => Promise<unknown>;
  resolveComposerReference?: StructuredInputComposerReferenceResolver['resolve'];
  shouldResumeAfterPermissionModeChange?: () => boolean;
  prepareHostContext?: (input: Readonly<{
    signal: AbortSignal;
    /** Final required provider prompt before optional Follow blocks are admitted. */
    requiredPrompt: string;
    contextOnlyWorkerUpdate?: import('@happier-dev/protocol').WorkerUpdateV1;
    contextOnlyWorkerLocalId?: string;
    followDeliveries?: PermissionModeQueuedPrompt['followDeliveries'];
  }>) => Promise<HostPreparedContext | null>;
}>;

export type PromptLoopOverrideSynchronizer = Readonly<{
  syncFromMetadata: () => void;
  flushPendingAfterStart: () => Promise<void>;
}>;

export type PromptLoopPermissionHandler = Readonly<
  Pick<ProviderEnforcedPermissionHandler, 'setPermissionMode'> & {
    reset: (options?: Parameters<ProviderEnforcedPermissionHandler['reset']>[0]) => void | Promise<void>;
  }
>;

type QueuedPermissionModeMessage = {
  message: PermissionModeQueuedPrompt;
  mode: PermissionModeQueuedPromptMode;
  hash: string;
  userEchoPublished?: true;
  preparationFailureCount?: number;
};

export type PromptLoopResetReason =
  | 'mode_change'
  | 'clear';

export type PromptLoopBoundaryReason =
  | 'turn_completed'
  | 'mode_change_reset'
  | 'clear_reset';

export type PromptLoopCheckpointLifecycle = Readonly<{
  onBeforePromptDispatch?: (params: Readonly<{
    messageId: string;
    prompt: string;
  }>) => void | Promise<void>;
  onTurnStarted?: (params: Readonly<{
    messageId: string;
    turnId: string;
    sequence?: number;
  }>) => void | Promise<void>;
  onTurnFinal?: (params: Readonly<{
    messageId: string;
    turnId: string;
    status: 'completed' | 'aborted' | 'interrupted' | 'unknown';
    sequence?: number;
  }>) => void | Promise<void>;
  onTurnAbortedBeforeStart?: (params: Readonly<{
    messageId: string;
  }>) => void | Promise<void>;
  onSessionEnd?: () => void | Promise<void>;
}>;

type CheckpointRuntimeMessage = Readonly<{
  type?: unknown;
  id?: unknown;
  reason?: unknown;
  sequence?: number;
}>;

type PromptLoopStatusPublisherOptions = Readonly<{
  agentMessageType: ACPProvider;
  messageBuffer: MessageBuffer;
  session: ApiSessionClient;
}>;

class StrictInitialResumeError extends Error {
  public readonly cause: unknown;
  constructor(message: string, cause: unknown) {
    super(message);
    this.name = 'StrictInitialResumeError';
    this.cause = cause;
  }
}

async function parkAfterPendingMaterializationAuthFailure(params: Readonly<{
  messageQueue: MessageQueue2<QueuedPermissionModeMessage['mode'], PermissionModeQueuedPrompt>;
  session: ApiSessionClient;
  abortSignal: AbortSignal;
}>): Promise<void> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(params.abortSignal.reason);
  params.abortSignal.addEventListener('abort', onAbort, { once: true });
  if (params.abortSignal.aborted) controller.abort(params.abortSignal.reason);

  try {
    const winner = await Promise.race([
      params.messageQueue.waitForMessagesSignal(controller.signal).then(() => 'queue' as const),
      params.session.waitForMetadataUpdate(controller.signal).then((ok) => ok ? 'metadata' as const : 'metadata-unavailable' as const),
    ]);
    controller.abort('permission-mode-auth-park-wake');
    if (winner === 'metadata-unavailable' && !params.abortSignal.aborted) {
      await waitForSessionMetadataRetryBackoff({
        abortSignal: params.abortSignal,
        backoffMs: DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS,
      });
    }
  } finally {
    params.abortSignal.removeEventListener('abort', onAbort);
    controller.abort('permission-mode-auth-park-dispose');
  }
}

/**
 * Retain prompt custody until recovery. Wakes are the queue growing
 * beyond the depth captured before the failed attempt (new input
 * seeking admission), the incumbent Session metadata/reconnect wake, an optional
 * paced preparation retry, or shutdown. The queue is
 * never consumed: already-queued input stays queued as the single custody holder for the normal
 * pop path, and each wake grants one new preparation/admission attempt.
 *
 * Already-queued input cannot spin this wait. Only transient prompt preparation
 * requests paced retries; replay-seed retirement remains event-driven.
 */
async function parkUntilPromptRecovery(params: Readonly<{
  messageQueue: MessageQueue2<QueuedPermissionModeMessage['mode'], PermissionModeQueuedPrompt>;
  session: ApiSessionClient;
  queuedDepthBeforeAttempt: number;
  abortSignal: AbortSignal;
  preparationRetryDelayMs?: number;
}>): Promise<void> {
  const controller = new AbortController();
  const onAbort = () => controller.abort(params.abortSignal.reason);
  params.abortSignal.addEventListener('abort', onAbort, { once: true });
  if (params.abortSignal.aborted) controller.abort(params.abortSignal.reason);

  try {
    const preparationRetry = params.preparationRetryDelayMs === undefined ? null
      : waitForSessionMetadataRetryBackoff({
        abortSignal: controller.signal,
        backoffMs: params.preparationRetryDelayMs,
      });
    const winner = await Promise.race([
      params.messageQueue
        .waitForQueueGrowthBeyond(params.queuedDepthBeforeAttempt, controller.signal)
        .then(() => 'queue' as const),
      params.session
        .waitForMetadataUpdate(controller.signal)
        .then(async (ok) => {
          // A closed metadata subscription must not shorten Home outage pacing.
          // Queue growth still races this wait and can wake preparation early.
          if (!ok && preparationRetry) {
            await preparationRetry;
            return 'preparation-retry' as const;
          }
          return ok ? 'metadata' as const : 'metadata-unavailable' as const;
        }),
      ...(preparationRetry ? [preparationRetry.then(() => 'preparation-retry' as const)] : []),
    ]);
    controller.abort('prompt-recovery-park-wake');
    if (winner === 'metadata-unavailable' && !params.abortSignal.aborted) {
      await waitForSessionMetadataRetryBackoff({
        abortSignal: params.abortSignal,
        backoffMs: DEFAULT_SESSION_METADATA_WAIT_RETRY_BACKOFF_MS,
      });
    }
  } finally {
    params.abortSignal.removeEventListener('abort', onAbort);
    controller.abort('prompt-recovery-park-dispose');
  }
}

function readCheckpointRuntimeMessage(runtimeEvent: RuntimeTurnMessage): CheckpointRuntimeMessage | null {
  switch (runtimeEvent.kind) {
    case 'turn-start':
      return { type: 'task_started', id: runtimeEvent.turnId, sequence: runtimeEvent.sequence };
    case 'turn-complete':
      return { type: 'task_complete', id: runtimeEvent.turnId, sequence: runtimeEvent.sequence };
    case 'turn-cancelled':
      return { type: 'turn_aborted', id: runtimeEvent.turnId, reason: runtimeEvent.cause, sequence: runtimeEvent.sequence };
    case 'turn-failed':
      return { type: 'turn_failed', id: runtimeEvent.turnId, sequence: runtimeEvent.sequence };
    default:
      return null;
  }
}

function readCheckpointTurnId(message: CheckpointRuntimeMessage): string | null {
  return typeof message.id === 'string' && message.id.trim().length > 0 ? message.id : null;
}

function readRuntimeRestartModeHash(mode: QueuedPermissionModeMessage['mode']): string {
  return JSON.stringify({
    permissionMode: mode.permissionMode,
    appendSystemPrompt: mode.appendSystemPrompt ?? null,
    suppressUserEcho: mode.suppressUserEcho === true,
    providerPromptAlreadyResolved: mode.providerPromptAlreadyResolved === true,
  });
}

type PreTurnFailure = Readonly<{
  code: string;
  message: string;
  retryable: boolean;
  reason?: SessionProviderInputRejectedBeforeEffectReason;
}>;

class PreTurnPromptFailure extends Error {
  constructor(readonly settlement: PreTurnFailure) {
    super(settlement.message);
    this.name = 'PreTurnPromptFailure';
  }
}

function createModelTransitionPreTurnFailure(
  transition: Extract<SessionModelTransitionResultV1, { ok: false }>,
): PreTurnPromptFailure {
  const reason = transition.status === 'owner_unavailable'
    ? 'provider_unavailable_before_acceptance' as const
    : transition.status === 'reconciliation_required'
      ? 'runtime_config_blocked' as const
      : 'provider_rejected_before_acceptance' as const;
  return new PreTurnPromptFailure({
    code: `session_model_transition_${transition.status}`,
    message: transition.reason ?? `Structured model transition failed: ${transition.status}`,
    retryable: reason !== 'provider_rejected_before_acceptance',
    reason,
  });
}

function readPreTurnFailure(error: unknown): PreTurnFailure {
  if (error instanceof PreTurnPromptFailure) {
    return error.settlement;
  }
  const structuredFailure = readStructuredInputPreparationFailure(error);
  if (structuredFailure) return structuredFailure;
  const candidate = error && typeof error === 'object' && !Array.isArray(error)
    ? error as Readonly<{ code?: unknown; status?: unknown; retryable?: unknown }>
    : null;
  const code = typeof candidate?.code === 'string' && candidate.code.trim().length > 0
    ? candidate.code
    : 'provider_pre_turn_failed';
  const message = error instanceof Error && error.message.trim().length > 0
    ? error.message
    : 'Provider input preparation failed before provider acceptance';
  return {
    code,
    message,
    // Prompt preparation owns this status. Preserve its pending custody instead
    // of turning an unavailable required source into a terminal provider refusal.
    retryable: typeof candidate?.retryable === 'boolean'
      ? candidate.retryable
      : candidate?.status === 'preparation_pending',
  };
}

/**
 * All provider-input work before `beginTurnLifecycle` shares one durable settlement owner. It
 * may park or terminally reject the exact pending input, but never retires local custody or
 * releases identity on this dispatch-only path.
 */
async function observePreTurnFailureSettlement(params: Readonly<{
  session: ApiSessionClient;
  message: PermissionModeQueuedPrompt;
  error: PreTurnFailure;
}>): Promise<void> {
  if (params.message.hostContextOnly) return;
  const identity = readQueuedPromptDeliveryIdentity(params.message);
  if (identity.localIds.length === 0) return;
  const reason = params.error.reason
    ?? (params.error.retryable
      ? 'provider_unavailable_before_acceptance' as const
      : 'provider_rejected_before_acceptance' as const);
  await Promise.all(identity.localIds.map(async (localId) => {
    try {
      await params.session.observeProviderInputSettlement({
        kind: 'rejected_before_effect',
        localId,
        userMessageSeq: identity.localIds.length === 1 ? identity.userMessageSeq : null,
        reason,
        diagnostic: {
          code: params.error.code,
          severity: 'error',
          message: params.error.message,
        },
        retryable: params.error.retryable,
      });
    } catch {
      // Settlement is best effort. The already-durable Message remains pending if the block
      // write itself is unavailable, and normal queue recovery owns the retry.
    }
  }));
}

function isLocalSpecialCommandPrompt(message: PermissionModeQueuedPrompt, mode?: QueuedPermissionModeMessage['mode']): boolean {
  if (mode?.providerPromptAlreadyResolved === true) return false;
  return parseSpecialCommand(message.text).type !== null;
}

function isQueuedPromptAlreadyLocallyConsumed(
  session: ApiSessionClient,
  message: PermissionModeQueuedPrompt,
  mode?: QueuedPermissionModeMessage['mode'],
): boolean {
  if (message.hostContextOnly) return false;
  if (!isLocalSpecialCommandPrompt(message, mode)) return false;
  const hasUserMessageLocalConsumption = session.hasUserMessageLocalConsumption;
  if (typeof hasUserMessageLocalConsumption !== 'function') return false;
  const identity = readQueuedPromptDeliveryIdentity(message);
  if (!hasQueuedPromptDeliveryIdentity(identity)) return false;
  return hasUserMessageLocalConsumption.call(session, identity);
}

function mapCheckpointFinalStatus(message: CheckpointRuntimeMessage): 'completed' | 'aborted' | 'interrupted' | 'unknown' {
  if (message.type === 'task_complete') return 'completed';
  if (message.type === 'turn_failed') return 'aborted';
  if (message.type === 'turn_aborted') {
    return typeof message.reason === 'string' && /\b(interrupted|interrupt|user)\b/i.test(message.reason)
      ? 'interrupted'
      : 'aborted';
  }
  return 'unknown';
}

async function runCheckpointHook(fn: (() => void | Promise<void>) | undefined): Promise<void> {
  if (!fn) return;
  try {
    await fn();
  } catch {
    // Checkpoint evidence is best-effort and must not block turn lifecycle.
  }
}

function readEagerPendingDrainFailureMessage(result: DrainPendingResult): string | null {
  if (result.stoppedReason === 'auth_failure') {
    return 'Pending prompts could not be restored after startup because session authentication failed; reconnect and retry.';
  }
  if (result.stoppedReason === 'error') {
    return 'Pending prompts could not be restored after startup; please retry once the session is reachable.';
  }
  return null;
}

async function publishPromptLoopAgentMessage(
  opts: PromptLoopStatusPublisherOptions,
  body: Parameters<ApiSessionClient['enqueueAgentMessageCommitted']>[1],
  localId = randomUUID(),
): Promise<void> {
  await opts.session.enqueueAgentMessageCommitted(
    opts.agentMessageType,
    body,
    {
      localId,
      provenance: { kind: 'non_dependent', source: 'external' },
    },
  );
}

async function publishPromptLoopStatus(
  opts: PromptLoopStatusPublisherOptions,
  message: string,
): Promise<void> {
  opts.messageBuffer.addMessage(message, 'status');
  await publishPromptLoopAgentMessage(opts, { type: 'message', message });
}

function readAgentContextMessageContentText(message: unknown): string | null {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    return null;
  }
  const content = (message as Readonly<Record<string, unknown>>).content;
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content.flatMap((part) => (
    part && typeof part === 'object' && !Array.isArray(part) && typeof (part as Readonly<Record<string, unknown>>).text === 'string'
      ? [(part as Readonly<Record<string, string>>).text]
      : []
  )).join('');
  return text.length > 0 ? text : null;
}

function renderAgentContextMessagesPrompt(messages: unknown): string | null {
  if (!Array.isArray(messages)) {
    return null;
  }
  const parts = messages.flatMap((message) => {
    const text = readAgentContextMessageContentText(message);
    return text !== null && text.length > 0 ? [text] : [];
  });
  return parts.length > 0 ? parts.join('\n\n') : null;
}

async function transformAgentContextPromptBeforeDispatch(params: Readonly<{
  transformAgentContextBeforeDispatch?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
  errorPolicy?: 'fallback' | 'throw';
  sessionId: string;
  agentId: string;
  prompt: string;
  timestampMs: number;
}>): Promise<string> {
  if (!params.transformAgentContextBeforeDispatch) {
    return params.prompt;
  }
  try {
    const transformed = await params.transformAgentContextBeforeDispatch({
      sessionId: params.sessionId,
      agentId: params.agentId,
      runtimeFamily: 'hostSession',
      prompt: params.prompt,
      messages: [{ role: 'user', content: params.prompt }],
      timestampMs: params.timestampMs,
    });
    const validation = validatePluginHookPayloadV1({
      hookId: 'agent.context.before',
      payload: transformed,
    });
    if (!validation.success) {
      logger.debug('[plugins] agent.context.before returned an invalid payload; using original provider prompt', {
        error: validation.message,
      });
      return params.prompt;
    }
    if (!transformed || typeof transformed !== 'object' || Array.isArray(transformed)) {
      return params.prompt;
    }
    const transformedPrompt = typeof transformed.prompt === 'string' ? transformed.prompt : params.prompt;
    if (transformedPrompt !== params.prompt) {
      return transformedPrompt;
    }
    return renderAgentContextMessagesPrompt(transformed.messages) ?? transformedPrompt;
  } catch (error) {
    if (params.errorPolicy === 'throw') {
      throw error;
    }
    logger.debug('[plugins] agent.context.before failed; using original provider prompt');
    return params.prompt;
  }
}

export async function runPermissionModePromptLoop(opts: {
  providerName: string;
  agentMessageType: ACPProvider;
  explicitPermissionMode: PermissionMode | undefined;
  session: ApiSessionClient;
  messageQueue: MessageQueue2<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>;
  manualCompaction?: Pick<ManualCompactionQueue<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>, 'setRunning'>;
  permissionHandler: PromptLoopPermissionHandler;
  runtime: PermissionModePromptLoopTurnOperations;
  /** Host composition must not clone the Agent's receiver-sensitive operations. */
  prepareHostContext?: PermissionModePromptLoopTurnOperations['prepareHostContext'];
  createOverrideSynchronizer: (isStarted: () => boolean, isInputSettled: () => boolean) => PromptLoopOverrideSynchronizer;
  messageBuffer: MessageBuffer;
  shouldExit: () => boolean;
  getAbortSignal: () => AbortSignal;
  keepAlive: () => void;
  setThinking: (value: boolean) => void;
  sendReady: (context?: ReadyNotificationTurnContext) => void | Promise<void>;
  currentPermissionModeUpdatedAt: number;
  setCurrentPermissionMode: (mode: PermissionMode) => void;
  setCurrentPermissionModeUpdatedAt: (updatedAt: number) => void;
  initialResumeId?: string;
  strictInitialResume?: boolean;
  /**
   * The host invalidates a requested native identity before a failed strict
   * resume can be observed by a later departure capture.
   */
  onStrictInitialResumeFailure?: ((params: Readonly<{
    resumeId: string;
    error: unknown;
  }>) => void | Promise<void>) | null;
  /** Host lifecycle records preparation/dispatch failures that have no native turn event. */
  onPromptFailure?: (error: unknown) => void | Promise<void>;
  startRuntimeBeforeFirstPrompt?: boolean;
  onAfterStart?: (() => void | Promise<void>) | null;
  onBeforeReset?: ((params: { reason: PromptLoopResetReason }) => void | Promise<void>) | null;
  onAfterReset?: ((params: { reason: PromptLoopResetReason }) => void | Promise<void>) | null;
  onAfterLoopBoundary?: ((params: { reason: PromptLoopBoundaryReason }) => void | Promise<void>) | null;
  checkpointLifecycle?: PromptLoopCheckpointLifecycle | null;
  beforePendingMaterialize?: (() => boolean | Promise<boolean>) | null;
  pendingQueueDrainMaxPopPerWake?: number;
  pendingQueueDeliveryTiming?: SessionPendingQueueDeliveryTiming;
  inputConsumer?: SessionProviderInputConsumer<PermissionModeQueuedPromptMode, PermissionModeQueuedPrompt>;
  resolveFreshSessionSystemPrompt?: ((args: {
    baseOverride?: string | null;
    excludePluginIds?: readonly string[];
  }) => Promise<string | null | undefined>) & Pick<SessionPromptPlanResolver, 'assertPreparedPlanCurrent'>;
  /** Catalog support and current full-plan native acceptance, supplied by the host owner. */
  readSessionPromptPlanDeliveryState?: () => Readonly<{
    marker?: AgentSessionStartupInstructionsMarkerV1;
    startupInstructionsSupported: boolean;
    revisionChanges?: 'resume';
    nativeDeliveredMarker?: AgentSessionStartupInstructionsMarkerV1;
  }>;
  readSessionPromptPlanComposition?: () => PromptPlanComposition | null;
  /**
   * Resolves bounded plugin-selected material for this next provider turn.
   * The loop owns placement; this callback cannot replace a provider prompt
   * or start an in-flight turn.
   */
  resolveAgentCompositionBeforeDispatch?: (args: {
    signal: AbortSignal;
  }) => Promise<AgentCompositionToolSelection & Readonly<{
    prompt: string | null | undefined;
  }> | null | undefined>;
  /**
   * Exposes the exact active composition selection to the already-configured
   * native MCP server. A null value restores ordinary un-managed catalog visibility.
   */
  setActiveAgentCompositionToolSelection?: (
    selection: AgentCompositionToolSelection | null,
  ) => void;
  /**
   * The daemon-owned current-generation attachment resolver. The loop owns
   * only its immediately-before-dispatch call and supplies cancellation.
   */
  resolveComposerAttachmentForDispatch?: ComposerAttachmentDispatchResolver;
  readReferenceAction?: StructuredInputCatalogReaders['readReferenceAction'];
  transformAgentContextBeforeDispatch?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>;
  transformAgentContextErrorPolicy?: 'fallback' | 'throw';
  transitionModelSelectionBeforePrompt?: (
    selection: ProviderBoundModelRef,
    runWithActiveSelection: (
      transferPromptAdmission: (opts: Readonly<{
        abortSignal: AbortSignal;
        dispatch: () => Promise<void>;
      }>) => Promise<
        | Readonly<{ status: 'dispatched'; value: void }>
        | Readonly<{ status: 'cancelled' }>
      >,
    ) => Promise<void>,
  ) => Promise<SessionModelTransitionResultV1>;
  readActiveModelSelection?: () => ProviderBoundModelRef;
  onProviderPromptDispatchPrepared?: (input: Readonly<{
    localIds: readonly string[];
    selection: ProviderBoundModelRef;
  }>) => void;
  /**
   * Registers replay/Follow effects against the exact localId settled by the host's canonical
   * provider-input outcome normalizer. Transport send completion is never provider acceptance.
   */
  registerProviderAcceptedEffect: RegisterProviderAcceptedEffect;
  /** Host lifecycle freezes protected cause facts immediately before runtime begin. */
  onBeforeTurnBegin?: (
    input: PermissionModeQueuedPrompt,
    snapshotScope: AssistantTextSnapshotTurnScope | null,
  ) => void | (() => ReadyNotificationTurnContext | undefined);
  /**
   * Session-scoped hold for a replay seed the provider already accepted whose metadata
   * retirement has not succeeded. The loop records failed settlement outcomes here and, at
   * each admission boundary, retries the same idempotent settler once — no provider input is
   * popped or dispatched while a retirement keeps failing.
   */
  replaySeedRetirement?: UnsettledReplaySeedRetirement;
  releaseRejectedBeforeProviderPromptIdentity?: (
    session: ApiSessionClient,
    message: PermissionModeQueuedPrompt,
  ) => void;
  formatPromptErrorMessage: (error: unknown) => string;
}): Promise<void> {
  let modelRequestScope = createPromptCompositionScope();
  const prepareHostContext: PermissionModePromptLoopTurnOperations['prepareHostContext'] = opts.prepareHostContext
    ?? (async (input) => await opts.runtime.prepareHostContext?.(input) ?? null);
  let wasStarted = false;
  let currentRuntimeRestartModeHash: string | null = null;
  let pending: QueuedPermissionModeMessage | null = null;
  let turnInFlight = false;
  let pendingFreshSessionSystemPrompt = false;
  type SessionSystemPromptDelivery = Readonly<{
    text: string;
    marker?: AgentSessionStartupInstructionsMarkerV1;
    native?: boolean;
  }>;
  let lastDeliveredSessionSystemPrompt: SessionSystemPromptDelivery | null = null;
  let pendingSessionSystemPromptDelivery: SessionSystemPromptDelivery | null = null;
  let nativeSessionPlanRevision = opts.runtime.readSessionStartupInstructions?.()?.revision ?? 0;
  let hasNativeStartupPlan = opts.runtime.readSessionStartupInstructions?.() != null;
  let runtimePermissionModeApplied: PermissionMode | null = null;
  let activeCheckpointMessageId: string | null = null;
  let activeCheckpointTurnId: string | null = null;
  let activeCheckpointFinalSequence: number | undefined;
  let activeCheckpointFinalStatus: 'completed' | 'aborted' | 'interrupted' | 'unknown' = 'unknown';
  let checkpointLifecycleTail: Promise<void> = Promise.resolve();
  const enqueueCheckpointHook = (fn: (() => void | Promise<void>) | undefined): Promise<void> => {
    const pending = checkpointLifecycleTail.then(() => runCheckpointHook(fn));
    checkpointLifecycleTail = pending;
    return pending;
  };
  let snapshotFreshForNextPromptBoundary = false;
  const pendingQueueDrainMaxPopPerWake = Math.max(
    1,
    Math.trunc(opts.pendingQueueDrainMaxPopPerWake ?? PENDING_QUEUE_ONE_AT_A_TIME_MAX_POP_PER_WAKE),
  );
  const inputConsumer = opts.inputConsumer ?? createSessionProviderInputConsumer({
    messageQueue: opts.messageQueue,
    session: createSessionProviderInputConsumerSessionAdapter(opts.session),
    reconcileWhenEmpty: 'skip',
    pendingQueueDeliveryTiming: opts.pendingQueueDeliveryTiming,
    refreshBeforeQueuedBatch: false,
    pendingDrainMaxPopPerWake: pendingQueueDrainMaxPopPerWake,
  });
  let activeTurnPendingPumpController: AbortController | null = null;
  const stopActiveTurnPendingPump = (): void => {
    const controller = activeTurnPendingPumpController;
    if (!controller) return;
    activeTurnPendingPumpController = null;
    controller.abort('permission-mode-prompt-loop:turn-ended');
  };
  const startActiveTurnPendingPump = (): void => {
    // Arm the single Pending consumer for the live turn. The server decides whether a
    // claimed row is enqueue, send-now/interrupt, or steer. Steering capability is not
    // a prerequisite for send-now interrupt while the turn is in flight.
    if (activeTurnPendingPumpController) return;
    const controller = new AbortController();
    activeTurnPendingPumpController = controller;
    void inputConsumer.pumpPendingWhileActive({
      abortSignal: controller.signal,
      maxPopPerWake: pendingQueueDrainMaxPopPerWake,
      // Once an exact provider turn exists, keep the single Pending consumer armed
      // through non-steerable settling windows. The server remains the sole owner of
      // whether a row is eligible and whether its provider action is steer or interrupt.
      shouldContinue: () => turnInFlight,
      logPrefix: `[${opts.providerName}]`,
      reason: 'active-turn',
    }).catch(() => {
      logger.debug(`[${opts.providerName}] Active-turn Pending pump stopped after non-fatal error`);
    }).finally(() => {
      if (activeTurnPendingPumpController === controller) {
        activeTurnPendingPumpController = null;
      }
    });
  };

  const unsubscribeCheckpointRuntimeMessages = (() => {
    try {
      return opts.runtime.subscribeRuntimeEvents((event) => {
        if (event.kind === 'context-compaction' && event.phase !== 'progress') {
          opts.manualCompaction?.setRunning(event.phase === 'started');
        } else if (event.kind === 'runtime-ended') {
          opts.manualCompaction?.setRunning(false);
        }
        if (!turnInFlight && (event.kind === 'turn-complete'
          || event.kind === 'turn-failed' || event.kind === 'turn-cancelled')) {
          // Native terminal input can finish while this loop is parked rather than
          // awaiting its own turn. Reuse the same settlement boundary before waking
          // the existing Pending consumer; terminal events are not metadata updates.
          void (async () => {
            await opts.onAfterLoopBoundary?.({ reason: 'turn_completed' });
            inputConsumer.notifyInputReadinessChanged();
          })().catch(() => {
            logger.debug(`[${opts.providerName}] Native-turn Pending wake could not settle`);
          });
        }
        if (event.kind === 'context-compaction' && event.phase === 'completed') {
          // The canonical event invalidates this delivery owner. No compact
          // command heuristic, separate cadence or provider-specific marker.
          pendingFreshSessionSystemPrompt = true;
          pendingSessionSystemPromptDelivery = null;
        }
        if (!opts.checkpointLifecycle) return;
        const message = readCheckpointRuntimeMessage(event);
        if (!message || typeof message.type !== 'string') return;
        const messageId = activeCheckpointMessageId;
        if (!messageId) return;
        const turnId = readCheckpointTurnId(message);
        if (message.type === 'task_started' && turnId) {
          activeCheckpointTurnId = turnId;
          // Register the native turn immediately so terminal publication can join
          // the checkpoint owner's preparation even while capture is still running.
          const started = runCheckpointHook(() => opts.checkpointLifecycle?.onTurnStarted?.({
            messageId, turnId, ...(message.sequence === undefined ? {} : { sequence: message.sequence }),
          }));
          checkpointLifecycleTail = checkpointLifecycleTail.then(() => started);
          return;
        }
        if (
          (message.type === 'task_complete' || message.type === 'turn_aborted' || message.type === 'turn_failed')
          && turnId
        ) {
          activeCheckpointTurnId = activeCheckpointTurnId ?? turnId;
          activeCheckpointFinalStatus = mapCheckpointFinalStatus(message);
          activeCheckpointFinalSequence = message.sequence;
        }
      });
    } catch {
      return () => undefined;
    }
  })();

  // Opaque Agent identity: used for presence here and reported verbatim.
  const normalizedResumeId = readNonBlankOpaqueIdentifier(opts.initialResumeId) ?? '';
  let nextSessionIsFresh = normalizedResumeId.length === 0;
  let announceInitialResume = normalizedResumeId.length > 0;
  let strictInitialResumePending = opts.strictInitialResume === true && normalizedResumeId.length > 0;
  const reportStrictInitialResumeFailure = async (error: unknown): Promise<boolean> => {
    if (
      !strictInitialResumePending
      || !isAgentNativeResumeIdentityMismatchError(error)
    ) return false;
    // Clear this before awaiting the owner callback. A callback failure still
    // must not re-enter another path that interprets the same offered identity
    // as accepted.
    strictInitialResumePending = false;
    await opts.onStrictInitialResumeFailure?.({ resumeId: normalizedResumeId, error });
    return true;
  };
  if (normalizedResumeId) {
    snapshotFreshForNextPromptBoundary = opts.session.getMetadataSnapshot() !== null;
  }

  // Native turn facts start only after prompt preparation succeeds. Capability
  // replacement must also wait for this loop's already-collected input.
  const overrideSync = opts.createOverrideSynchronizer(() => wasStarted, () => !turnInFlight);

  const permissionModeStateSync = await initializePermissionModeStateSync({
    explicitPermissionMode: opts.explicitPermissionMode,
    session: opts.session,
    currentPermissionModeUpdatedAt: opts.currentPermissionModeUpdatedAt,
    take: 50,
    applyMode: ({ mode, updatedAt }) => {
      opts.setCurrentPermissionMode(mode);
      opts.setCurrentPermissionModeUpdatedAt(updatedAt);
      opts.permissionHandler.setPermissionMode(mode);
    },
  });
  opts.setCurrentPermissionModeUpdatedAt(permissionModeStateSync.permissionModeUpdatedAt);

  const syncPermissionModeFromMetadata = () => {
    const updatedAt = permissionModeStateSync.syncFromMetadata(opts.session.getMetadataSnapshot());
    opts.setCurrentPermissionModeUpdatedAt(updatedAt);
  };

  const refreshSessionSnapshotBeforeTurnBestEffort = async (): Promise<void> => {
    if (typeof opts.session.refreshSessionSnapshotFromServerBestEffort === 'function') {
      try {
        await opts.session.refreshSessionSnapshotFromServerBestEffort({ reason: 'primaryTurnRuntimeState' });
        snapshotFreshForNextPromptBoundary = true;
      } catch {
        // Best-effort only: prompt delivery must not block on snapshot refresh failures.
      }
      return;
    }
    if (typeof opts.session.ensureMetadataSnapshot === 'function') {
      try {
        await opts.session.ensureMetadataSnapshot();
        snapshotFreshForNextPromptBoundary = true;
      } catch {
        // Best-effort only.
      }
    }
  };

  const ensureFreshSessionSnapshotBeforeTurnBestEffort = async (): Promise<void> => {
    if (snapshotFreshForNextPromptBoundary) {
      return;
    }
    await refreshSessionSnapshotBeforeTurnBestEffort();
  };

  overrideSync.syncFromMetadata();

  const ensureRuntimeStarted = async (): Promise<{ startedFreshSessionForTurn: boolean; exitRequested: boolean }> => {
    if (wasStarted) return { startedFreshSessionForTurn: false, exitRequested: false };
    const startedFreshSessionForTurn = nextSessionIsFresh;
    nextSessionIsFresh = false;
    if (announceInitialResume) {
      announceInitialResume = false;
      opts.messageBuffer.addMessage('Resuming previous context…', 'status');
    }

    await opts.onAfterStart?.();
    wasStarted = true;
    await overrideSync.flushPendingAfterStart();
    if (!snapshotFreshForNextPromptBoundary) {
      await refreshSessionSnapshotBeforeTurnBestEffort();
    }
    syncPermissionModeFromMetadata();
    overrideSync.syncFromMetadata();
    return { startedFreshSessionForTurn, exitRequested: false };
  };

  try {
    if ((opts.startRuntimeBeforeFirstPrompt === true || normalizedResumeId.length > 0) && !wasStarted) {
      if (!snapshotFreshForNextPromptBoundary) {
        await refreshSessionSnapshotBeforeTurnBestEffort();
      }
      overrideSync.syncFromMetadata();
      let eagerStart: { startedFreshSessionForTurn: boolean; exitRequested: boolean };
      try {
        eagerStart = await ensureRuntimeStarted();
      } catch (error) {
        // A resume request does not make every startup fault an identity fact.
        // Quota, overload, auth and ordinary transport failures retain the
        // provider's normal error path; only its typed strict-native mismatch
        // can invalidate the same-machine record or fail closed as identity.
        if (
          strictInitialResumePending
          && !isAbortLikeError(error)
          && isAgentNativeResumeIdentityMismatchError(error)
        ) {
          await reportStrictInitialResumeFailure(error);
          strictInitialResumePending = false;
          throw new StrictInitialResumeError('Strict initial resume failed', error);
        }
        if (strictInitialResumePending && !isAbortLikeError(error)) {
          strictInitialResumePending = false;
          await opts.onStrictInitialResumeFailure?.({
            resumeId: normalizedResumeId,
            error,
          });
        }
        throw error;
      }
      if (eagerStart.exitRequested) return;
      const pendingDrainResult = await inputConsumer.drainPending({
        shouldContinue: async () => (await (opts.beforePendingMaterialize?.() ?? true)) !== false,
        logPrefix: `[${opts.providerName}]`,
        reason: 'permission-mode-eager-start',
        ...(opts.pendingQueueDeliveryTiming === 'after_runtime_idle' ? { deliveryTiming: 'after_runtime_idle' } : {}),
      });
      const pendingDrainFailureMessage = readEagerPendingDrainFailureMessage(pendingDrainResult);
      if (pendingDrainFailureMessage) {
        await publishPromptLoopStatus(opts, pendingDrainFailureMessage);
      }
      pendingFreshSessionSystemPrompt = eagerStart.startedFreshSessionForTurn;
    }

    // The pop path's wait for the next queued provider input: it materializes server-pending
    // rows into the queue and observes queue, metadata, and admission wakes.
    const waitForNextQueuedPermissionModeMessage = async (): Promise<
      MessageBatch<QueuedPermissionModeMessage['mode'], PermissionModeQueuedPrompt> | null
    > => {
      return await waitForNextPermissionModeMessage({
        messageQueue: opts.messageQueue,
        abortSignal: opts.getAbortSignal(),
        session: opts.session,
        beforeCollectQueuedBatch: async () => {
          // The metadata wake is armed by the input consumer before this callback runs. Re-read
          // the already-projected snapshot here so an update that landed during post-turn
          // lifecycle work cannot fall between the previous sync and the next one-shot wait.
          syncPermissionModeFromMetadata();
          overrideSync.syncFromMetadata();
          if (!turnInFlight) {
            await overrideSync.flushPendingAfterStart();
          }
          opts.messageQueue.discardMatching((queuedMessage, queuedMode) =>
            isQueuedPromptAlreadyLocallyConsumed(opts.session, queuedMessage, queuedMode),
          );
        },
        beforePendingMaterialize: opts.beforePendingMaterialize,
        onMetadataUpdate: async () => {
          await refreshSessionSnapshotBeforeTurnBestEffort();
          syncPermissionModeFromMetadata();
          overrideSync.syncFromMetadata();
          if (!turnInFlight) {
            await overrideSync.flushPendingAfterStart();
          }
        },
        pendingDrainMaxPopPerWake: pendingQueueDrainMaxPopPerWake,
        pendingQueueDeliveryTiming: opts.pendingQueueDeliveryTiming,
        inputConsumer,
      });
    };

    while (!opts.shouldExit()) {
      try {
      // A seed the provider already ACCEPTED must be retired before any further provider input
      // is admitted. The admission boundary retries the same idempotent settler once; while the
      // retirement keeps failing, nothing is dispatched and nothing is consumed. The loop
      // parks without taking queue custody and wakes when another input seeks admission or on
      // shutdown. Each wake re-runs this gate before any dispatch, so a recovered write admits
      // queued input without reapplying the seed.
      // Capture the queue edge before the retirement attempt. Input can arrive while that
      // async write is settling; using the later park-entry depth would miss that wake.
      const queuedDepthBeforeRetirementAttempt = opts.messageQueue.size();
      const unsettledRetirementOutcome = opts.replaySeedRetirement
        ? (opts.getAbortSignal().aborted
          // Shutdown with a possibly-outstanding retirement stays blocked. The park returns
          // immediately on the aborted signal and the loop's exit check ends it.
          ? 'failed' as const
          : await opts.replaySeedRetirement.settleBeforeAdmitting())
        : null;
      if (unsettledRetirementOutcome === 'failed') {
        await parkUntilPromptRecovery({
          messageQueue: opts.messageQueue,
          session: opts.session,
          queuedDepthBeforeAttempt: queuedDepthBeforeRetirementAttempt,
          abortSignal: opts.getAbortSignal(),
        });
        continue;
      }

      let message: QueuedPermissionModeMessage | null = pending;
      pending = null;

    if (!message) {
      let next: MessageBatch<QueuedPermissionModeMessage['mode'], PermissionModeQueuedPrompt> | null;
      try {
        next = await waitForNextQueuedPermissionModeMessage();
      } catch (error) {
        if (!(error instanceof PendingQueueMaterializationAuthError)) throw error;
        logger.debug('[INPUT-CONSUMER] Parking permission-mode prompt loop after pending materialization auth failure');
        await parkAfterPendingMaterializationAuthFailure({
          messageQueue: opts.messageQueue,
          session: opts.session,
          abortSignal: opts.getAbortSignal(),
        });
        continue;
      }
      if (!next) continue;
      message = { message: next.message, mode: next.mode, hash: next.hash };
    }
    if (!message) continue;
    turnInFlight = true;
    // Optional quiet inputs keep queue custody until their exact original
    // occurrence reaches the provider. A local command, blocked user input or
    // omitted context must leave them available to the next real turn.
    for (const follow of message.message.followDeliveries ?? []) {
      if (opts.messageQueue.isClosed()) break;
      if (follow.localInputId === message.message.localId) continue;
      const retained: PermissionModeQueuedPrompt = { text: '', localId: follow.localInputId,
        ...(follow.userMessageSeq === null ? {} : { userMessageSeq: follow.userMessageSeq }),
        followDeliveries: [follow] };
      if (!isNextTurnContextQueuedPrompt(retained)) continue;
      opts.messageQueue.discardMatching(prompt => prompt.localId === follow.localInputId
        && Boolean(prompt.followDeliveries?.some(item => item.localInputId === follow.localInputId)));
      opts.messageQueue.push(retained, { permissionMode: message.mode.permissionMode });
    }
    const inputPreparationStartedAt = performance.now();
    const queuedDepthBeforePreparation = opts.messageQueue.size();
    logger.infoFile('[PermissionModePromptLoop] Input collected', {
      sessionId: opts.session.sessionId,
      localIds: normalizePermissionModeQueuedPromptLocalIds(message.message),
    });

    if (isQueuedPromptAlreadyLocallyConsumed(opts.session, message.message, message.mode)) {
      continue;
    }

    const readCallerInputFailure = (): PreTurnFailure | null => {
      const constraints = message.mode.callerInputConstraints;
      if (!constraints) return null;
      const effectiveModel = message.mode.modelSelection ?? opts.readActiveModelSelection?.() ?? 'automatic';
      const code = !isModelRefGrantedV1(constraints, effectiveModel)
        ? 'model_not_granted'
        : !isPermissionModeGrantedV1(constraints, message.mode.permissionMode)
          ? 'permission_mode_not_granted' : null;
      return code ? { code, message: code, retryable: false } : null;
    };
    // Reject before permission mutation/reset, then recheck under provider dispatch custody.
    const callerInputFailure = readCallerInputFailure();
    if (callerInputFailure) {
      await observePreTurnFailureSettlement({ session: opts.session, message: message.message, error: callerInputFailure });
      await publishPromptLoopAgentMessage(opts, { type: 'message', message: callerInputFailure.message });
      await opts.sendReady();
      continue;
    }

    opts.permissionHandler.setPermissionMode(message.mode.permissionMode);

    const runtimeRestartModeHash = readRuntimeRestartModeHash(message.mode);
    if (
      wasStarted
      && currentRuntimeRestartModeHash
      && runtimeRestartModeHash !== currentRuntimeRestartModeHash
    ) {
      const resumeId = opts.runtime.readSessionIdentity().sessionId;
      currentRuntimeRestartModeHash = runtimeRestartModeHash;
      const shouldResumeAfterPermissionModeChange =
        typeof opts.runtime.shouldResumeAfterPermissionModeChange === 'function'
          ? opts.runtime.shouldResumeAfterPermissionModeChange()
          : true;
      const nextSessionOpenIntent: RuntimeTurnSessionOpenIntent =
        resumeId && shouldResumeAfterPermissionModeChange
          ? {
              kind: 'resume',
              providerSessionId: resumeId,
              importHistory: false,
            }
          : { kind: 'create' };

      opts.messageBuffer.addMessage(`Restarting ${opts.providerName} session (permission settings changed)…`, 'status');
      await opts.onBeforeReset?.({ reason: 'mode_change' });
      resetAssistantTextSnapshotTurnScope(opts.session, 'mode_change');
      await opts.permissionHandler.reset();
      await opts.runtime.resetOrDisposeRuntime(undefined, nextSessionOpenIntent);
      modelRequestScope = createPromptCompositionScope();
      wasStarted = false;
      nextSessionIsFresh = nextSessionOpenIntent.kind === 'create';
      if (nextSessionIsFresh) lastDeliveredSessionSystemPrompt = null;
      pendingSessionSystemPromptDelivery = null;
      runtimePermissionModeApplied = null;
      pendingFreshSessionSystemPrompt = false;
      await opts.onAfterReset?.({ reason: 'mode_change' });
      opts.setThinking(false);
      opts.keepAlive();
      await opts.onAfterLoopBoundary?.({ reason: 'mode_change_reset' });

      pending = message;
      continue;
    }

    currentRuntimeRestartModeHash = runtimeRestartModeHash;
    await ensureFreshSessionSnapshotBeforeTurnBestEffort();
    syncPermissionModeFromMetadata();
    overrideSync.syncFromMetadata();
    await overrideSync.flushPendingAfterStart();
    if (!message.mode.suppressUserEcho && !message.userEchoPublished) {
      opts.messageBuffer.addMessage(message.message.text, 'user');
      message.userEchoPublished = true;
    }

    const providerPromptAlreadyResolved = message.mode.providerPromptAlreadyResolved === true;
    const special = providerPromptAlreadyResolved
      ? { type: null } as const
      : parseSpecialCommand(message.message.text);
    if (special.type === 'clear') {
      opts.session.markPendingProviderInputDispatched(normalizePermissionModeQueuedPromptLocalIds(message.message));
      opts.messageBuffer.addMessage(`Resetting ${opts.providerName} session…`, 'status');
      await opts.onBeforeReset?.({ reason: 'clear' });
      resetAssistantTextSnapshotTurnScope(opts.session, 'clear');
      await opts.permissionHandler.reset();
      await opts.runtime.resetOrDisposeRuntime(undefined, { kind: 'create' });
      modelRequestScope = createPromptCompositionScope();
      lastDeliveredSessionSystemPrompt = null;
      pendingSessionSystemPromptDelivery = null;
      wasStarted = false;
      nextSessionIsFresh = true;
      runtimePermissionModeApplied = null;
      pendingFreshSessionSystemPrompt = false;
      await opts.onAfterReset?.({ reason: 'clear' });
      opts.setThinking(false);
      opts.keepAlive();
      opts.messageBuffer.addMessage('Session reset.', 'status');
      await opts.onAfterLoopBoundary?.({ reason: 'clear_reset' });
      observeLocalSpecialCommandSettlement({
        session: opts.session,
        message: message.message,
        outcome: { kind: 'accepted' },
      });
      confirmLocallyConsumedPrompt(opts.session, message.message);
      await opts.sendReady();
      continue;
    }

    let shouldSendReady = true;
    let suppressFlushTurnFailure = false;
    let beganTurn = false;
    let handledPreTurnFailure = false;
    // The input was withdrawn before dispatch: nothing reached the provider,
    // so no turn, no ACK and no ready/finished notification is manufactured.
    let inputWithdrawnBeforeTurn = false;
    let currentCheckpointMessageId: string | null = null;
    let assistantTextSnapshotScope: AssistantTextSnapshotTurnScope | null = null;
    let readReadyTurnContext: (() => ReadyNotificationTurnContext | undefined) | undefined;
    // Retiring the replay seed belongs to provider ACCEPTANCE of the prompt the seed was
    // prefixed to — not to that prompt's turn completing. Once the provider has taken
    // custody the seed is in its context whether the turn then completes, aborts, errors,
    // or the backend is disposed. Gating retirement on the send returning leaves the seed
    // live for any runtime whose send spans the whole turn, and the next message re-carries
    // the entire carry-over context. Retirement therefore starts at the acceptance signal
    // and is drained in this iteration's `finally` so a later failure still settles it.
    let pendingReplaySeedSettlement: (() => Promise<ReplaySeedSettlementOutcome>) | null = null;
    let replaySeedSettlement: Promise<ReplaySeedSettlementOutcome> | null = null;
    let releaseUndispatchedReplaySeed: (() => Promise<void>) | null = null;
    const releaseReplaySeedBeforeProviderDispatch = async (): Promise<void> => {
      const release = releaseUndispatchedReplaySeed;
      if (!release) return;
      releaseUndispatchedReplaySeed = null;
      pendingReplaySeedSettlement = null;
      await release();
    };
    // Idempotent: the first call takes the pending settler, so a runtime that both signals
    // acceptance and then returns normally retires exactly once.
    const confirmProviderAccepted = (): void => {
      const settle = pendingReplaySeedSettlement;
      if (!settle) return;
      pendingReplaySeedSettlement = null;
      // The seed owner reports its own failures through the outcome and never rejects; the
      // promise is drained below so retirement is durable before the next prompt is read.
      replaySeedSettlement = opts.replaySeedRetirement
        ? opts.replaySeedRetirement.settleOnProviderAcceptance(settle)
        : settle();
    };
    const drainReplaySeedSettlement = async (): Promise<void> => {
      const settlement = replaySeedSettlement;
      if (!settlement) return;
      replaySeedSettlement = null;
      await settlement;
    };
    try {
      const promptDeliveryIdentity = readQueuedPromptDeliveryIdentity(message.message);
      const localIds = [...promptDeliveryIdentity.localIds];
      const userMessageSeqs = [...promptDeliveryIdentity.userMessageSeqs];
      let { userMessageSeq } = promptDeliveryIdentity;
      const localId = localIds[0] ?? null;
      currentCheckpointMessageId = localId ?? message.hash;
      if (!wasStarted) {
        const runtimeStart = await ensureRuntimeStarted();
        logger.infoFile('[PermissionModePromptLoop] Runtime startup settled', {
          sessionId: opts.session.sessionId, localId,
          durationMs: Math.round(performance.now() - inputPreparationStartedAt),
          exitRequested: runtimeStart.exitRequested,
        });
        if (runtimeStart.exitRequested) {
          shouldSendReady = false;
          return;
        }
        pendingFreshSessionSystemPrompt ||= runtimeStart.startedFreshSessionForTurn;
      }
      const providerNativeCommand = special.type === null
        && opts.runtime.isProviderNativeCommand?.(message.message.text) === true;
      const runProviderInputDispatch = async (
        dispatch: () => Promise<void>,
      ): Promise<'dispatched' | 'cancelled'> => {
        if (!inputConsumer) {
          await dispatch();
          return 'dispatched';
        }
        return (
          await inputConsumer.runProviderInputDispatch({
            abortSignal: opts.getAbortSignal(),
            dispatch,
          })
        ).status;
      };
      const transitionAndDispatchProviderInput = async (
        dispatch: () => Promise<void>,
      ): Promise<'dispatched' | 'cancelled'> => {
        const failure = readCallerInputFailure();
        if (failure) throw new PreTurnPromptFailure(failure);
        const dispatchGrantedInput = async (): Promise<void> => {
          const failure = readCallerInputFailure();
          if (failure) throw new PreTurnPromptFailure(failure);
          if (runtimePermissionModeApplied !== message.mode.permissionMode) {
            await opts.runtime.updateSessionRuntimeConfig({ permissionMode: message.mode.permissionMode });
            runtimePermissionModeApplied = message.mode.permissionMode;
          }
          await dispatch();
        };
        const requestedSelection = message.mode.modelSelection;
        if (!requestedSelection) {
          return await runProviderInputDispatch(dispatchGrantedInput);
        }
        if (!opts.transitionModelSelectionBeforePrompt) {
          const transition = {
            ok: false,
            status: 'owner_unavailable',
            activeSelection: null,
            requestedSelection,
            reason: 'Structured model transition owner is unavailable',
          } as const;
          throw createModelTransitionPreTurnFailure(transition);
        }

        let dispatchStatus: 'dispatched' | 'cancelled' | null = null;
        const transition = await opts.transitionModelSelectionBeforePrompt(
          requestedSelection,
          async (transferPromptAdmission) => {
            dispatchStatus = (
              await transferPromptAdmission({
                abortSignal: opts.getAbortSignal(),
                dispatch: dispatchGrantedInput,
              })
            ).status;
          },
        );
        if (!transition.ok) {
          throw createModelTransitionPreTurnFailure(transition);
        }
        if (dispatchStatus === null) {
          throw new Error(
            'Structured model transition owner did not enter canonical prompt custody',
          );
        }
        return dispatchStatus;
      };
      if (special.type === 'compact') {
        let compactFailureMessage: string | null = null;
        const dispatchCompactContext = async (): Promise<void> => {
          try {
            if (typeof opts.runtime.compactContext === 'function') {
              opts.session.markPendingProviderInputDispatched(localIds);
              await opts.runtime.compactContext(special.originalMessage ?? message.message.text.trim());
            } else {
              throw new Error('/compact is not supported by this runtime');
            }
          } catch (error) {
            if (isAbortLikeError(error)) throw error;
            compactFailureMessage = opts.formatPromptErrorMessage(error);
            await publishPromptLoopAgentMessage(opts, { type: 'message', message: compactFailureMessage });
          }
        };
        if (
          await transitionAndDispatchProviderInput(dispatchCompactContext)
          === 'cancelled'
        ) {
          shouldSendReady = false;
          continue;
        }
        opts.setThinking(false);
        opts.keepAlive();
        await opts.onAfterLoopBoundary?.({ reason: 'turn_completed' });
        if (shouldSendReady) {
          await opts.sendReady();
        }
        observeLocalSpecialCommandSettlement({
          session: opts.session,
          message: message.message,
          outcome: compactFailureMessage === null
            ? { kind: 'accepted' }
            : { kind: 'rejected_before_effect', diagnosticMessage: compactFailureMessage },
        });
        confirmLocallyConsumedPrompt(opts.session, message.message);
        continue;
      }
      const dispatchProviderPrompt = async (): Promise<void> => {
        const preparationStartedAt = performance.now();
        let phaseStartedAt = preparationStartedAt;
        const recordPreparationPhase = (phase: string): void => {
          const now = performance.now();
          logger.infoFile('[PermissionModePromptLoop] Turn preparation phase', {
            phase, sessionId: opts.session.sessionId, localId,
            durationMs: Math.round(now - phaseStartedAt),
            elapsedMs: Math.round(now - preparationStartedAt),
            sinceInputCollectedMs: Math.round(now - inputPreparationStartedAt),
          });
          phaseStartedAt = now;
        };
        recordPreparationPhase('entered');
        activeCheckpointMessageId = currentCheckpointMessageId;
        activeCheckpointTurnId = null;
        activeCheckpointFinalStatus = 'unknown';
        const nowMs = Date.now();
        const dispatchAbortSignal = opts.getAbortSignal();
        const resolvedReplaySeed = providerPromptAlreadyResolved || providerNativeCommand
          ? null
          : await resolveProviderPromptWithReplaySeed({
              session: opts.session,
              userText: message.message.text,
              allowSeed: special.type === null,
              localId,
              nowMs,
              refreshMetadataBeforeRead: false,
            });
        pendingReplaySeedSettlement = resolvedReplaySeed?.settleOnProviderAcceptance ?? null;
        releaseUndispatchedReplaySeed = resolvedReplaySeed?.seedApplied
          ? resolvedReplaySeed.releaseUndispatchedSeed
          : null;
        const referenceServices = {
          sessionId: opts.session.sessionId,
          materializeDiscussionAttachmentsForDispatch: (input: Parameters<ApiSessionClient['materializeDiscussionAttachmentsForDispatch']>[0]) =>
            opts.session.materializeDiscussionAttachmentsForDispatch(input),
          catalogs: {
            readReferenceAction: opts.readReferenceAction,
            ...(typeof opts.runtime.listSkills === 'function' ? { listSkills: () => opts.runtime.listSkills!() } : {}),
            ...(typeof opts.runtime.listVendorPlugins === 'function' ? { listVendorPlugins: () => opts.runtime.listVendorPlugins!() } : {}),
          },
          ...(opts.runtime.resolveComposerReference ? { resolveComposerReference: (input: Parameters<StructuredInputComposerReferenceResolver['resolve']>[0]) => opts.runtime.resolveComposerReference!(input) } : {}),
          ...(opts.resolveComposerAttachmentForDispatch ? { resolveComposerAttachmentForDispatch: opts.resolveComposerAttachmentForDispatch } : {}),
        };
        const resolvedInputContext = await resolveSessionInputForProviderDispatch({
          prompt: message.message, signal: dispatchAbortSignal,
          localId: localIds.length === 1 ? localId : null, services: referenceServices,
        });
        // Replay and dispatch consume the same current projection. Only its bounded
        // context spends the existing UTF-16 reservation; upload listings remain outside.
        let replaySeedWasOmitted = false;
        const seedResolution = ((): { providerPrompt: string } => {
          if (!resolvedReplaySeed) return { providerPrompt: message.message.text };
          if (!resolvedReplaySeed.seedApplied) return resolvedReplaySeed;
          const referenceChars = projectSessionInputReferencesV1({
            text: '', references: resolvedInputContext.promptContext.references,
          }).boundedBlockChars;
          const fittedSeedText = fitHappierReplaySeedWithinTotalBudget({
            seedText: resolvedReplaySeed.seedText,
            // A persisted seed may have been sealed under a larger Account or
            // wire cap than this daemon allows. Even without a Session
            // reference it therefore goes through the one dispatch budget;
            // only the actual rendered reference block consumes a reservation.
            reservedChars: referenceChars === 0 ? 0 : referenceChars + 2,
            maxPromptChars: configuration.replaySeedMaxChars,
          });
          if (!fittedSeedText) {
            // The reservation left no room, so the provider gets the user's text
            // and none of the seed. Retiring it here would be the worst outcome
            // available: the consume updater blanks `seedText`, so the whole
            // replay context would be destroyed for a prompt that never carried
            // a byte of it. Undelivered means unsettled — the seed stays for the
            // next dispatch, which may well have room. Its durable dispatch association is
            // released for the same reason: this prompt may still be accepted, and an
            // association left behind would make that acceptance retire an undelivered seed.
            pendingReplaySeedSettlement = null;
            replaySeedWasOmitted = true;
            return { providerPrompt: message.message.text };
          }
          return {
            providerPrompt: `${fittedSeedText}\n\n${message.message.text}`,
          };
        })();
        if (replaySeedWasOmitted) {
          await releaseReplaySeedBeforeProviderDispatch();
        }
        recordPreparationPhase('replay_seed');
        const agentComposition = providerNativeCommand
          ? undefined
          : await opts.resolveAgentCompositionBeforeDispatch?.({
              signal: dispatchAbortSignal,
            });
        recordPreparationPhase('agent_composition');
        const effectiveAgentCompositionPrompt =
          typeof agentComposition?.prompt === 'string'
            ? agentComposition.prompt.trim()
            : '';
        snapshotFreshForNextPromptBoundary = false;
        const resolveSessionPlan = !providerPromptAlreadyResolved && !providerNativeCommand;
        const explicitBaseOverride = resolveAppendSystemPromptBaseOverride(message.mode);
        const freshSessionSystemPrompt = resolveSessionPlan
          ? await opts.resolveFreshSessionSystemPrompt?.({
              baseOverride: explicitBaseOverride,
              ...(agentComposition?.managedPluginIds.length
                ? { excludePluginIds: agentComposition.managedPluginIds }
                : {}),
            })
          : undefined;
        recordPreparationPhase('session_prompt_plan');
        const effectiveAppendSystemPrompt = typeof freshSessionSystemPrompt === 'string'
          ? freshSessionSystemPrompt.trim()
          : '';
        if (resolveSessionPlan) opts.resolveFreshSessionSystemPrompt?.assertPreparedPlanCurrent?.();
        const planDeliveryState = resolveSessionPlan ? opts.readSessionPromptPlanDeliveryState?.() : undefined;
        const marker = planDeliveryState?.marker;
        const nativeMarker = planDeliveryState?.nativeDeliveredMarker;
        const nativeStartup = opts.runtime.readSessionStartupInstructions?.();
        if (nativeStartup || nativeMarker) hasNativeStartupPlan = true;
        const planChanged = lastDeliveredSessionSystemPrompt === null
          || effectiveAppendSystemPrompt !== lastDeliveredSessionSystemPrompt.text
          || (marker !== undefined && (marker.id !== lastDeliveredSessionSystemPrompt.marker?.id
            || marker.revision !== lastDeliveredSessionSystemPrompt.marker?.revision));
        const canReopenForNativePlan = planDeliveryState?.startupInstructionsSupported === true
          && opts.runtime.readSessionStartupInstructionsSupport?.() !== false
          && planDeliveryState.revisionChanges === 'resume';
        const nativePlanMatches = () => {
          const startup = opts.runtime.readSessionStartupInstructions?.();
          return planDeliveryState?.startupInstructionsSupported === true
            && (startup?.instructions ?? '') === effectiveAppendSystemPrompt.normalize('NFC')
            && (!effectiveAppendSystemPrompt || marker === undefined
              || (startup?.id === marker.id && startup.revision === marker.revision));
        };
        let preparedNativePlan = lastDeliveredSessionSystemPrompt === null && nativePlanMatches();
        const lostNativePlan = lastDeliveredSessionSystemPrompt?.native === true && !nativePlanMatches();
        if (resolveSessionPlan && canReopenForNativePlan
          && !preparedNativePlan && (planChanged || lostNativePlan)) {
          const providerSessionId = opts.runtime.readSessionIdentity().sessionId;
          const nextIntent: RuntimeTurnSessionOpenIntent = providerSessionId
            ? { kind: 'resume', providerSessionId, importHistory: false }
            : { kind: 'create' };
          const startupInstructions = effectiveAppendSystemPrompt
            ? AgentSessionStartupInstructionsV1Schema.parse({
                ...(marker ?? { v: 1, id: 'happier.coding_session_plan', revision: ++nativeSessionPlanRevision }),
                instructions: effectiveAppendSystemPrompt.normalize('NFC'),
              }) : null;
          // A preserved terminal host retains old startup text. Close only the native runtime
          // incarnation and reopen the same conversation through its canonical factory.
          opts.resolveFreshSessionSystemPrompt?.assertPreparedPlanCurrent?.();
          await opts.runtime.resetOrDisposeRuntime('session_closed', { ...nextIntent, startupInstructions });
          modelRequestScope = createPromptCompositionScope();
          if (startupInstructions) {
            nativeSessionPlanRevision = startupInstructions.revision;
            hasNativeStartupPlan = true;
          }
          preparedNativePlan = startupInstructions === null || nativePlanMatches();
        }
        recordPreparationPhase('native_plan_delivery');
        const deliveredNatively = preparedNativePlan
          || (!planChanged && !lostNativePlan && lastDeliveredSessionSystemPrompt?.native === true)
          || (planDeliveryState?.startupInstructionsSupported === true
          && marker !== undefined && nativeMarker !== undefined
          && marker.id === nativeMarker.id && marker.revision === nativeMarker.revision);
        const shouldApplyFreshSessionSystemPrompt = resolveSessionPlan && !deliveredNatively
          && (pendingFreshSessionSystemPrompt || planChanged || lostNativePlan);
        const providerPrompt = [
          shouldApplyFreshSessionSystemPrompt && effectiveAppendSystemPrompt.length > 0
            ? [
                (hasNativeStartupPlan || (Boolean(opts.initialResumeId)
                  && planDeliveryState?.startupInstructionsSupported === true)) && !canReopenForNativePlan
                  ? 'These instructions supersede the Happier startup instructions and any earlier Happier session plan.'
                  : '',
                effectiveAppendSystemPrompt,
              ].filter(Boolean).join('\n\n')
            : '',
          effectiveAgentCompositionPrompt,
          seedResolution.providerPrompt,
        ].filter((part) => part.length > 0).join('\n\n');
        const transformedDispatchPrompt = providerNativeCommand
          ? message.message.text
          : await transformAgentContextPromptBeforeDispatch({
              transformAgentContextBeforeDispatch: opts.transformAgentContextBeforeDispatch,
              errorPolicy: opts.transformAgentContextErrorPolicy,
              sessionId: opts.session.sessionId,
              agentId: opts.agentMessageType,
              prompt: providerPrompt,
              timestampMs: nowMs,
            });
        // Composer references and attachments carry durable identity only, so their current
        // provider projection is reconstructed here — at the single host dispatch choke
        // point, after the queue has drained and immediately before the provider call.
        // Resolving at admission would freeze a snapshot for however long the message sits
        // in the permission-mode queue.
        recordPreparationPhase('agent_context_transform');
        const preparedDispatch = await prepareSessionInputForProviderDispatch({
          prompt: message.message,
          transformedUserText: transformedDispatchPrompt,
          providerNativeCommand,
          signal: dispatchAbortSignal,
          localId: localIds.length === 1 ? localId : null,
          resolvedContext: resolvedInputContext,
          services: {
            ...referenceServices,
            reconcileSessionInputForProviderDispatch: input => opts.session.reconcileSessionInputForProviderDispatch(input),
            ...(opts.readActiveModelSelection ? { modelRequest: { scope: modelRequestScope,
              startupInstructions: effectiveAppendSystemPrompt,
              toolSelection: agentComposition ? { managedPluginIds: agentComposition.managedPluginIds,
                selectedTools: agentComposition.selectedTools, selectedToolBindings: agentComposition.selectedToolBindings } : null,
              readSelection: opts.readActiveModelSelection } } : {}),
            ...(shouldApplyFreshSessionSystemPrompt && transformedDispatchPrompt === providerPrompt
              ? { injectedPromptComponents: opts.readSessionPromptPlanComposition?.()?.components } : {}),
            retainPromptComposition: async composition => {
              await opts.session.enqueueSessionEventCommitted({ type: 'prompt-composition', composition });
            },
          },
        });
        recordPreparationPhase('input_preparation');
        const requiredDispatchPrompt = preparedDispatch.requiredPrompt;
        const requiredProviderContextForBudget = preparedDispatch.requiredProviderContextForBudget;
        // Interceptable runtimes dispatch during capture; their first write-like
        // tool joins this baseline. Observable runtimes must capture before send.
        // Follow authorization remains the final admission before native dispatch.
        const checkpointBaseline = enqueueCheckpointHook(() => opts.checkpointLifecycle?.onBeforePromptDispatch?.({
          messageId: currentCheckpointMessageId!,
          prompt: requiredDispatchPrompt,
        }));
        if (opts.runtime.setBeforeToolExecution) {
          opts.runtime.setBeforeToolExecution(async toolName => {
            if (!isDefaultWriteLikeToolName(toolName)) return;
            await checkpointBaseline;
            opts.runtime.setBeforeToolExecution?.(null);
          });
        } else {
          await checkpointBaseline;
        }
        recordPreparationPhase('checkpoint');

        const hostContextOnly = message.message.hostContextOnly;
        // Required workflow text is already FIN-materialized, not optional context.
        let preparedHostContext: HostPreparedContext | null = hostContextOnly?.kind === 'session_follow'
          ? hostContextOnly.prepared
          : hostContextOnly?.kind === 'workflow_step' || providerNativeCommand
          || !localId
          ? null
          : await prepareHostContext?.({
              signal: dispatchAbortSignal,
              requiredPrompt: requiredProviderContextForBudget,
              ...(message.message.followDeliveries?.length ? { followDeliveries: message.message.followDeliveries } : {}),
              ...(hostContextOnly?.kind === 'worker_update' ? {
                contextOnlyWorkerUpdate: hostContextOnly.update,
                ...(localId ? { contextOnlyWorkerLocalId: localId } : {}),
              } : {}),
            }) ?? null;
        const preparedFollowContext = preparedHostContext;
        if (!hostContextOnly && preparedHostContext?.recheckAdmission
          && !await preparedHostContext.recheckAdmission(dispatchAbortSignal)) preparedHostContext = null;
        const withdrawnFollowLocalInputIds = preparedFollowContext?.withdrawnFollowLocalInputIds;
        const withdrawFollowInput = async (localId: string) => {
          if (!await opts.session.withdrawSessionInputBeforeProviderDispatch({ localId, signal: dispatchAbortSignal })) {
            throw new PreTurnPromptFailure({ code: 'session_follow_withdrawal_unavailable',
              message: 'The followed request withdrawal could not be confirmed', retryable: true,
              reason: 'provider_unavailable_before_acceptance' });
          }
        };
        for (const follow of message.message.followDeliveries ?? []) {
          if (!withdrawnFollowLocalInputIds?.includes(follow.localInputId) || follow.localInputId === localId) continue;
          await withdrawFollowInput(follow.localInputId);
          opts.messageQueue.discardMatching(prompt => prompt.localId === follow.localInputId
            && Boolean(prompt.followDeliveries?.some(item => item.localInputId === follow.localInputId)));
        }
        if (localId && withdrawnFollowLocalInputIds?.includes(localId)) {
          await withdrawFollowInput(localId);
          inputWithdrawnBeforeTurn = true;
          return;
        }
        if (message.message.followDeliveries?.some(delivery => delivery.localInputId === message.message.localId)
          && !preparedHostContext?.representedFollowLocalInputIds?.includes(localId ?? '')) {
          // Losing the route also removes the source observation, so hydration
          // cannot prove withdrawal. Pending still owns that exact original.
          if (localId && await opts.session.reconcileSessionInputForProviderDispatch({ localId, signal: dispatchAbortSignal }) === 'withdrawn') {
            inputWithdrawnBeforeTurn = true;
            return;
          }
          throw new PreTurnPromptFailure({ code: 'session_follow_context_unavailable',
            message: 'Follow context is unavailable before provider dispatch', retryable: true,
            reason: 'provider_unavailable_before_acceptance' });
        }
        const contextOnlyWorkerUpdate = hostContextOnly?.kind === 'worker_update'
          ? preparedHostContext?.contextOnlyWorkerUpdate === undefined
            ? hostContextOnly.update
            : preparedHostContext.contextOnlyWorkerUpdate
          : null;
        if (hostContextOnly?.kind === 'worker_update' && !contextOnlyWorkerUpdate) {
          if (preparedHostContext?.contextOnlyWorkerDisposition === 'deferred'
            && await hostContextOnly.recheckAdmission(dispatchAbortSignal)
            && !dispatchAbortSignal.aborted) {
            inputConsumer.deferContextOnlyInput({ ...message, isolate: true });
          }
          inputWithdrawnBeforeTurn = true;
          return;
        }
        if (hostContextOnly) {
          const result = await inputConsumer.finalizeContextOnlyInput({
            batch: { ...message, isolate: true },
            abortSignal: dispatchAbortSignal,
            recheck: async () => {
              if (hostContextOnly.kind === 'session_follow') {
                return await hostContextOnly.prepared.recheckAdmission(dispatchAbortSignal);
              }
              if (hostContextOnly.kind === 'worker_update') {
                return await hostContextOnly.recheckAdmission(dispatchAbortSignal)
                  && (await preparedHostContext?.recheckAdmission?.(dispatchAbortSignal) ?? true);
              }
              const identity = { localInputId: hostContextOnly.localInputId };
              const deliverable = await hostContextOnly.isWorkflowStepDeliverable(identity);
              if (!deliverable || hostContextOnly.withdrawal.isWithdrawn(identity)) {
                await hostContextOnly.withdrawal.reportWorkflowStepWithdrawn(identity);
                return false;
              }
              return true;
            },
            commit: async () => {
              if (hostContextOnly.kind !== 'workflow_step') {
                await hostContextOnly.commitHostEvent([
                  ...(contextOnlyWorkerUpdate && localId ? [{ localId, update: contextOnlyWorkerUpdate }] : []),
                  ...(preparedHostContext?.workerUpdateEvents ?? []),
                ]);
                return true;
              }
              let publication: Promise<void> | null = null;
              const claimed = hostContextOnly.withdrawal.claimDispatch(
                { localInputId: hostContextOnly.localInputId },
                () => { publication = hostContextOnly.commitHostEvent(); },
              );
              if (publication) await publication;
              return claimed;
            },
          });
          if (result !== 'committed') {
            inputWithdrawnBeforeTurn = true;
            return;
          }
        }
        const representedFollowDeliveries = message.message.followDeliveries?.filter(follow =>
          preparedHostContext?.representedFollowLocalInputIds?.includes(follow.localInputId)) ?? [];
        const representedPendingInputs = [
          ...(providerNativeCommand ? [] : message.message.fileReviewNoteContext ?? []).flatMap(note => note.localId
            ? [{ localId: note.localId, userMessageSeq: note.userMessageSeq }] : []),
          ...representedFollowDeliveries.map(follow => ({ localId: follow.localInputId, userMessageSeq: follow.userMessageSeq })),
          ...(message.message.returnedAnswerContext ?? []).flatMap(answer => answer.localId
            ? [{ localId: answer.localId, userMessageSeq: answer.userMessageSeq }] : []),
        ].filter(input => input.localId !== localId);
        // Native grammar stays first; the canonical resolved context follows as arguments.
        const dispatchPrompt = preparedDispatch.renderPrompt({
          ...(preparedHostContext && !providerNativeCommand
            ? { sessionFollowUpdates: preparedHostContext.updates, workerUpdates: preparedHostContext.workerUpdates }
            : {}),
          ...(contextOnlyWorkerUpdate && !providerNativeCommand ? { workerUpdates: [contextOnlyWorkerUpdate, ...(preparedHostContext?.workerUpdates ?? [])] } : {}),
          // Only exact originals re-admitted by the Follow owner earn native
          // representation, including quiet originals joining a real input.
          runFollowDeliveries: representedFollowDeliveries,
        });

        if (localIds.length > 0 && opts.readActiveModelSelection && opts.onProviderPromptDispatchPrepared) {
          opts.onProviderPromptDispatchPrepared({
            localIds: [...new Set([...localIds, ...representedPendingInputs.map(input => input.localId)])],
            selection: opts.readActiveModelSelection(),
          });
        }
        const resolvedStructuredInput = preparedDispatch.structuredInput;
        const promptDeliveryMeta = {
          ...(message.message.discussionAddressing ? { discussionAddressing: message.message.discussionAddressing } : {}),
          ...(message.message.actionRequestAttributionV1
            ? { actionRequestAttributionV1: message.message.actionRequestAttributionV1 } : {}),
          ...(localId === null ? {} : { localId }),
          ...(localIds.length === 0 ? {} : { localIds }),
          ...(userMessageSeq === null ? {} : { userMessageSeq }),
          ...(userMessageSeqs.length === 0 ? {} : { userMessageSeqs }),
          ...(resolvedStructuredInput
            ? { structuredInput: resolvedStructuredInput }
            : {}),
          ...(message.message.causalPermissionAuthority
            ? { causalPermissionAuthority: message.message.causalPermissionAuthority }
            : {}),
        };
        // Reference/catalog resolution is fail-closed prompt preparation. Starting a runtime
        // turn before it succeeds would leave providers with an active lifecycle that never
        // received a prompt when current access is denied.
        opts.setActiveAgentCompositionToolSelection?.(
          agentComposition?.managedPluginIds.length
            ? {
                managedPluginIds: agentComposition.managedPluginIds,
                selectedTools: agentComposition.selectedTools,
                selectedToolBindings: agentComposition.selectedToolBindings,
              }
            : null,
        );
        // Awaited context and checkpoint preparation can withdraw the resolved plan.
        if (resolveSessionPlan) opts.resolveFreshSessionSystemPrompt?.assertPreparedPlanCurrent?.();
        recordPreparationPhase('host_context');
        if (!hostContextOnly) await preparedHostContext?.commitWorkerUpdateEvents?.();
        if (!await preparedDispatch.assertAdmission()) {
          inputWithdrawnBeforeTurn = true;
          return;
        }
        assistantTextSnapshotScope = beginAssistantTextSnapshotTurnScope(opts.session);
        const readyTurnContext = opts.onBeforeTurnBegin?.(message.message, assistantTextSnapshotScope);
        if (typeof readyTurnContext === 'function') readReadyTurnContext = readyTurnContext;
        opts.runtime.beginTurnLifecycle();
        beganTurn = true;
        startActiveTurnPendingPump();
        const acknowledgeHostContextAccepted = (pendingSettlement?: Promise<void>): void => {
          if (!localId) return;
          if (hostContextOnly && hostContextOnly.kind !== 'session_follow') hostContextOnly.acknowledgeAccepted();
          preparedHostContext?.acknowledgeAccepted(message.message.hostContextOnly
            ? { kind: 'context_only_wake', eventLocalId: localId }
            : { kind: 'admitted_input', localInputId: localId, userMessageSeq }, pendingSettlement);
        };
        if (localId) {
          const sessionSystemPromptDelivery = shouldApplyFreshSessionSystemPrompt || preparedNativePlan
            ? { text: effectiveAppendSystemPrompt, ...(marker ? { marker } : {}),
                ...(preparedNativePlan ? { native: true } : {}) } : null;
          if (sessionSystemPromptDelivery) pendingSessionSystemPromptDelivery = sessionSystemPromptDelivery;
          opts.registerProviderAcceptedEffect(
            localId,
            pendingReplaySeedSettlement || preparedHostContext || hostContextOnly || sessionSystemPromptDelivery
              ? (pendingSettlement) => {
                  if (pendingReplaySeedSettlement) confirmProviderAccepted();
                  acknowledgeHostContextAccepted(pendingSettlement);
                  if (sessionSystemPromptDelivery && pendingSessionSystemPromptDelivery === sessionSystemPromptDelivery) {
                    lastDeliveredSessionSystemPrompt = sessionSystemPromptDelivery;
                    pendingSessionSystemPromptDelivery = null;
                    pendingFreshSessionSystemPrompt = false;
                  }
                }
              : null,
            representedPendingInputs,
          );
        }
        for (const follow of representedFollowDeliveries) {
          if (follow.localInputId === localId) continue;
          opts.registerProviderAcceptedEffect(follow.localInputId, (pendingSettlement) => {
            preparedHostContext?.acknowledgeAccepted({ kind: 'admitted_input',
              localInputId: follow.localInputId, userMessageSeq: follow.userMessageSeq }, pendingSettlement);
          });
        }
        // Invoking the runtime is the effect boundary. From here onward a thrown transport or
        // AbortError is ambiguous, so the durable association must remain for reconciliation.
        opts.session.markPendingProviderInputDispatched([
          ...localIds, ...representedPendingInputs.map(input => input.localId),
        ]);
        releaseUndispatchedReplaySeed = null;
        for (const follow of representedFollowDeliveries) {
          opts.messageQueue.discardMatching(prompt => prompt.localId === follow.localInputId
            && Boolean(prompt.followDeliveries?.some(item => item.localInputId === follow.localInputId)));
        }
        for (const answer of message.message.returnedAnswerContext ?? []) {
          if (!answer.localId) continue;
          opts.messageQueue.discardMatching(prompt => prompt.localId === answer.localId
            && prompt.returnedAnswer?.delivery === 'next_turn');
        }
        for (const note of providerNativeCommand ? [] : message.message.fileReviewNoteContext ?? []) {
          if (!note.localId) continue;
          opts.messageQueue.discardMatching(prompt => prompt.localId === note.localId && prompt.fileReviewNote !== undefined);
        }
        recordPreparationPhase('native_send_entered');
        const providerSend = Object.keys(promptDeliveryMeta).length === 0
          ? opts.runtime.sendTurnPrompt(dispatchPrompt)
          : opts.runtime.sendTurnPrompt(dispatchPrompt, promptDeliveryMeta);
        void preparedDispatch.retainComposition({ deliveryKind: 'newTurn', observedAtMs: Date.now(),
          turnId: null });
        // Runtime adapters update exact steerability synchronously when provider dispatch
        // acquires a live turn. Re-check only at that lifecycle edge; no cadence or inferred
        // turn-in-flight state is allowed to start the Pending pump.
        startActiveTurnPendingPump();
        await providerSend;
        recordPreparationPhase('native_send_returned');
        // Provider transport custody alone cannot settle replay or Follow effects. The
        // mandatory localId-correlated delivery outcome port owns that exact decision.
        await drainReplaySeedSettlement();
      };
      if (
        await transitionAndDispatchProviderInput(dispatchProviderPrompt)
        === 'cancelled'
      ) {
        shouldSendReady = false;
        continue;
      }
    } catch (error) {
      const preTurnFailure = !beganTurn && !isAbortLikeError(error)
        ? readPreTurnFailure(error)
        : null;
      if (preTurnFailure?.retryable && error !== null && typeof error === 'object'
        && 'status' in error && error.status === 'preparation_pending') {
        // No native effect occurred. Keep this exact input in the existing loop
        // custody instead of durably blocking it and publishing a failed turn.
        // Each event or paced retry re-runs full preparation/currentness checks.
        // Reuse offline reconnection's 5s..60s jittered policy with saturation at
        // ten failures (not an attempt cap); no separate prompt retry budget.
        message.preparationFailureCount = (message.preparationFailureCount ?? 0) + 1;
        opts.setThinking(false);
        opts.keepAlive();
        logger.infoFile('[PermissionModePromptLoop] Prompt preparation waiting for recovery', {
          code: 'preparation_pending',
        });
        await parkUntilPromptRecovery({
          messageQueue: opts.messageQueue,
          session: opts.session,
          queuedDepthBeforeAttempt: queuedDepthBeforePreparation,
          abortSignal: opts.getAbortSignal(),
          preparationRetryDelayMs: resolveOfflineReconnectionBackoffDelayMs(message.preparationFailureCount),
        });
        if (opts.getAbortSignal().aborted) return;
        pending = message;
        handledPreTurnFailure = true;
        shouldSendReady = false;
        continue;
      }
      if (preTurnFailure) {
        await observePreTurnFailureSettlement({
          session: opts.session,
          message: message.message,
          error: preTurnFailure,
        });
      }
      if (
        strictInitialResumePending
        && !(error instanceof StrictInitialResumeError)
        && !isAbortLikeError(error)
        && isAgentNativeResumeIdentityMismatchError(error)
      ) {
        await reportStrictInitialResumeFailure(error);
        strictInitialResumePending = false;
        const formatted = opts.formatPromptErrorMessage(error);
        opts.messageBuffer.addMessage(`Resume failed; cannot continue: ${formatted}`, 'status');
        await publishPromptLoopAgentMessage(opts, {
          type: 'message',
          message: `Resume failed; cannot continue: ${formatted}`,
        });
        shouldSendReady = false;
        suppressFlushTurnFailure = true;
        throw new StrictInitialResumeError('Strict initial resume failed', error);
      }
      if (error instanceof StrictInitialResumeError) {
        shouldSendReady = false;
        suppressFlushTurnFailure = true;
        throw error;
      }
      if (!isAbortLikeError(error) && !isRuntimeTurnFailureAlreadySurfaced(error)) {
        await opts.onPromptFailure?.(error);
        handledPreTurnFailure = !beganTurn;
      }
    } finally {
      await releaseReplaySeedBeforeProviderDispatch();
      try {
        if (beganTurn) {
          if (suppressFlushTurnFailure) {
            try {
              await opts.runtime.waitForTurnCompletion();
            } catch {}
          } else {
            // A turn-completion failure (e.g. a classified terminal injection/acceptance failure
            // from the Claude unified host) must NOT escape the loop into a process-killing fatal:
            // surface it to the transcript and let the loop re-enter on the next queued message.
            // Abort-like errors are the shutdown signal and are re-thrown so teardown proceeds.
            try {
              await opts.runtime.waitForTurnCompletion();
              strictInitialResumePending = false;
            } catch (completionError) {
              if (isAbortLikeError(completionError)) {
                throw completionError;
              }
              if (await reportStrictInitialResumeFailure(completionError)) {
                shouldSendReady = false;
                suppressFlushTurnFailure = true;
                throw new StrictInitialResumeError('Strict initial resume failed', completionError);
              }
              // A generic completion failure is loop-local. It cannot prove a
              // requested native identity mismatched, so it must not erase the
              // native-return record or turn into a strict identity failure.
              strictInitialResumePending = false;
              if (!isRuntimeTurnFailureAlreadySurfaced(completionError)) {
                await publishPromptLoopAgentMessage(opts, {
                  type: 'message',
                  message: opts.formatPromptErrorMessage(completionError),
                });
              }
            }
          }
        }
      } finally {
        // Keep the selection live for every provider tool call in this turn,
        // then clear it before the loop can admit the next prompt.
        opts.setActiveAgentCompositionToolSelection?.(null);
        stopActiveTurnPendingPump();
        turnInFlight = false;
      }
      // Exact provider acceptance can arrive while waitForTurnCompletion is pending. Drain only
      // after that boundary so the next prompt cannot read replaySeedV1 before the accepted
      // prompt's metadata settlement has completed. Rejected or ambiguous input never invokes
      // the registered effect and therefore leaves the seed live.
      await drainReplaySeedSettlement();
      if (beganTurn) {
        if (currentCheckpointMessageId && !activeCheckpointTurnId) {
          activeCheckpointTurnId = currentCheckpointMessageId;
          await enqueueCheckpointHook(() => opts.checkpointLifecycle?.onTurnStarted?.({
            messageId: currentCheckpointMessageId!,
            turnId: activeCheckpointTurnId!,
          }));
        }
        if (currentCheckpointMessageId && activeCheckpointTurnId) {
          const checkpointMessageId = currentCheckpointMessageId;
          const checkpointTurnId = activeCheckpointTurnId;
          const checkpointFinalSequence = activeCheckpointFinalSequence;
          await enqueueCheckpointHook(() => opts.checkpointLifecycle?.onTurnFinal?.({
            messageId: checkpointMessageId,
            turnId: checkpointTurnId,
            status: activeCheckpointFinalStatus,
            ...(checkpointFinalSequence === undefined ? {} : { sequence: checkpointFinalSequence }),
          }));
        } else if (currentCheckpointMessageId) {
          await enqueueCheckpointHook(() => opts.checkpointLifecycle?.onTurnAbortedBeforeStart?.({
            messageId: currentCheckpointMessageId!,
          }));
        }
        activeCheckpointMessageId = null;
        activeCheckpointTurnId = null;
        activeCheckpointFinalStatus = 'unknown';
        activeCheckpointFinalSequence = undefined;
        // Metadata updates can arrive while we're mid-turn.
        overrideSync.syncFromMetadata();
        opts.setThinking(false);
        opts.keepAlive();
        await opts.onAfterLoopBoundary?.({ reason: 'turn_completed' });
        if (shouldSendReady) {
          await opts.sendReady(readReadyTurnContext?.());
        }
        completeAssistantTextSnapshotTurnScope(opts.session, assistantTextSnapshotScope);
      } else if (handledPreTurnFailure || inputWithdrawnBeforeTurn) {
        if (currentCheckpointMessageId) {
          await enqueueCheckpointHook(() => opts.checkpointLifecycle?.onTurnAbortedBeforeStart?.({
            messageId: currentCheckpointMessageId!,
          }));
        }
        activeCheckpointMessageId = null;
        activeCheckpointTurnId = null;
        activeCheckpointFinalStatus = 'unknown';
        activeCheckpointFinalSequence = undefined;
        opts.setThinking(false);
        opts.keepAlive();
        if (handledPreTurnFailure && shouldSendReady) {
          await opts.sendReady();
        }
      }
    }
      } finally {
        turnInFlight = false;
        inputConsumer.releaseInputBatch();
      }
  }

  } finally {
    resetAssistantTextSnapshotTurnScope(opts.session, 'session_end');
    unsubscribeCheckpointRuntimeMessages();
    opts.runtime.setBeforeToolExecution?.(null);
    await enqueueCheckpointHook(() => opts.checkpointLifecycle?.onSessionEnd?.());
  }
}
