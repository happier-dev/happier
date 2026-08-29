import type {
  AgentLaunchEnvironment,
  AgentRuntime,
  AgentRuntimeContext,
  AgentRuntimeFactory,
  AgentPermissionIntent,
  AgentSessionModel,
  AgentSessionOpenRequest,
  AgentSessionProviderBinding,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { claudeHandoffSurface } from '../surfaces/sessions/handoff/providerOps.js';
import { isDeepStrictEqual } from 'node:util';
import { AgentRuntimeJsonValueSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import type { AgentModelDescriptor } from '@happier-dev/plugin-sdk/agents';
import {
  createAgentSessionPreAdmissionBuffer,
  type AgentSessionPreAdmissionBuffer,
  type AgentSessionPreAdmissionBufferResult,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { isRuntimeConfigUpdateOutcomeApplied } from '@happier-dev/plugin-sdk/agents/runtime';

import { createClaudeNativePermissionEngine } from '../permissions/nativePermissionEngine.js';
import { CLAUDE_STATIC_MODELS } from '../models.js';
import type {
  ClaudeEffectiveModelEvidence,
  ClaudeEffectiveModelEvidenceSubscription,
} from './effectiveModelEvidence.js';
import { createClaudeAgentSdkTurnOperations } from './remote/sdk/session.js';
import type {
  ClaudeRuntimePromptSubmissionOutcome,
  ClaudeRuntimeTurnOperations,
} from './providerOperations.js';
import type { ClaudeProviderEvent } from './providerEvents.js';
import {
  createClaudeNativeAgentSdkContext,
  createClaudeNativeGoalWorkStatePublisher,
} from './nativeServices.js';
import { createClaudeNativeGoalControl } from './goalControl/nativeControl.js';
import {
  parseClaudeTerminalRawSpawnOptionOverrides,
  partitionClaudeTerminalUserArgs,
} from './terminal/argv.js';
import { isClaudeUnifiedTerminalSelected } from './terminal/unified/selection.js';
import { openClaudeNativeUnifiedTerminalSession } from './terminal/unified/nativeSession.js';
import type {
  ClaudeUnifiedPromptDeliveryIdentity,
  ClaudeUnifiedPromptDeliveryOutcome,
} from './terminal/unified/turnOperations.js';
import {
  resolveClaudeLaunchSettingsOverlayArgs,
  resolveClaudeNativeBaseLaunchEnvironment,
  resolveClaudeNativeLaunchSettings,
} from './launchSettings.js';
import { mapToClaudePermissionMode } from './permissionMode.js';
import type {
  ClaudeUsageObservation,
  ClaudeUsageObservationSubscription,
} from '../usage/types.js';
import {
  isClaudeEffortSupportedForProviderModel,
  isClaudeUltracodeSupportedModelId,
  resolveClaudeEffortForModel,
} from './reasoningEffort.js';
import { probeClaudeSupportsEffortRaw } from '../preflight/models.js';

export {
  claudeExternalSessionsContribution,
} from '../surfaces/sessions/external/contribution.js';

/**
 * Provider-local event codec only. Claude's SDK and terminal leaves still share this strict
 * internal row vocabulary; `AgentRuntime` remains the sole public lifecycle owner and this module
 * translates every accepted row into canonical Agent-session events before the host can observe it.
 *
 * Contraction condition: delete this V1 codec import when both provider-operation leaves emit the
 * local pre-sequencing canonical event input directly and their remaining test-only V1 envelopes
 * are gone. It must never regain an activation, host-registration, or public-export carrier.
 */
type NativeSessionEventInput = AgentSessionRuntimeEvent extends infer Event
  ? Event extends AgentSessionRuntimeEvent
    ? Omit<Event, 'sequence' | 'sessionId' | 'emittedAtMs'>
    : never
  : never;

type NativeInputAcceptedDelivery = Extract<
  NativeSessionEventInput,
  { kind: 'input-accepted' }
>['delivery'];
type NativeInputIds = Extract<
  NativeSessionEventInput,
  { kind: 'input-accepted' }
>['inputIds'];

type ClaudeTerminalPromptDecision =
  | Readonly<{ kind: 'accepted' }>
  | Readonly<{
      kind: 'rejected_before_effect' | 'effect_may_have_occurred';
      failure: Exclude<Awaited<ReturnType<AgentSessionRuntime['send']>>, { status: 'admitted' }>;
    }>;

type ClaudeTerminalPromptDelivery = {
  inputIds: NativeInputIds;
  delivery: NativeInputAcceptedDelivery;
  decision: ClaudeTerminalPromptDecision | null;
};

type ClaudeNativePromptCustodyOperations =
  | Readonly<{
    promptCustody: 'unified_terminal';
    setOnPromptAcceptedByProvider: (
      handler: (info: ClaudeUnifiedPromptDeliveryIdentity) => void,
    ) => void;
    setOnPromptTerminallyRejectedBeforeProvider: (
      handler: (info: ClaudeUnifiedPromptDeliveryIdentity) => void,
    ) => void;
    setOnPromptDeliveryOutcome: (
      handler: ((outcome: ClaudeUnifiedPromptDeliveryOutcome) => void) | null,
    ) => void;
  }>
  | Readonly<{
    promptCustody?: undefined;
  }>;

export type ClaudeNativeSessionOperations = ClaudeRuntimeTurnOperations & Readonly<{
  supportsEffort?: boolean;
  subscribeEffectiveModel?: ClaudeEffectiveModelEvidenceSubscription;
  subscribeUsageObservation?: ClaudeUsageObservationSubscription;
  subscribeCanonicalAgentSessionEvents?: (
    handler: (event: AgentSessionRuntimeEvent) => void,
  ) => () => void;
  isTurnInFlight?: () => boolean;
  canSteerPrompt?: () => boolean;
  canInterruptForPendingInput?: () => boolean;
  notifyPromptQueuedDuringTurn?: () => void;
  applyConfigDeltaInFlight?: (
    delta: Readonly<{ permissionMode: AgentPermissionIntent }>,
  ) => Promise<Readonly<
    | { status: 'applied' | 'scheduled_in_turn' }
    | { status: 'unsupported' | 'failed'; reason?: string }
  >>;
  clearTerminalComposer?: (request?: Readonly<{
    sessionId?: string;
    expectedStateAtMs?: number;
  }>) => Promise<Readonly<
    | { ok: true; status: 'cleared' | 'already_empty'; sessionId?: string }
    | {
        ok: false;
        status: 'unsupported' | 'no_live_terminal' | 'not_safe' | 'generating' | 'dialog_open'
          | 'capture_unavailable' | 'clear_failed' | 'host_dead' | 'stale_state' | 'failed';
        errorCode?: string;
        error?: string;
        sessionId?: string;
      }
  >>;
  releaseConnectedServiceUsageLimitDialog?: () => Promise<void>;
  interruptPendingInputAndRun?: (request: Readonly<{
    sessionId?: string;
    localId: string;
    expectedStateAtMs?: number;
  }>) => Promise<unknown>;
  setGoal?: (
    objective: string | undefined,
    options?: Readonly<{ status?: string; tokenBudget?: number | null }>,
  ) => Promise<unknown>;
  clearGoal?: () => Promise<unknown>;
}> & ClaudeNativePromptCustodyOperations;

export type ClaudeNativeSessionFactory = (input: Readonly<{
  request: AgentSessionOpenRequest;
  context: AgentSessionRuntimeContext;
  supportsEffort?: boolean;
}>) => ClaudeNativeSessionOperations | Promise<ClaudeNativeSessionOperations>;

type ClaudeSupportsEffortResolver = (input: Readonly<{
  request: Readonly<{
    cwd: string;
    launchEnvironment?: AgentLaunchEnvironment;
    providerBinding?: AgentSessionProviderBinding;
  }>;
  context: AgentRuntimeContext;
}>) => Promise<boolean>;

export type CreateClaudeNativeRuntimeOptions = Readonly<{
  openSession: ClaudeNativeSessionFactory;
  resolveSupportsEffort?: ClaudeSupportsEffortResolver;
}>;

export function createClaudeNativeSessionOpener(openers: Readonly<{
  openAgentSdkSession: ClaudeNativeSessionFactory;
  openUnifiedTerminalSession: ClaudeNativeSessionFactory;
}>): ClaudeNativeSessionFactory {
  return async (input) => {
    const selected = await isClaudeUnifiedTerminalSelected({
      context: {
        features: input.context.session.services.features,
        settings: input.context.services.settings.forScope({ kind: 'account' }),
      },
    });
    const operations = await (selected
      ? openers.openUnifiedTerminalSession(input)
      : openers.openAgentSdkSession(input));
    return { ...operations, supportsEffort: input.supportsEffort === true };
  };
}

export async function resolveClaudeInstalledEffortSupport(input: Parameters<ClaudeSupportsEffortResolver>[0]) {
  return await probeClaudeSupportsEffortRaw({
    exec: input.context.services.exec,
    cwd: input.request.cwd,
    timeoutMs: 5_000,
    env: resolveClaudeNativeBaseLaunchEnvironment({
      launchEnvironment: input.request.launchEnvironment,
      processEnv: process.env,
    }),
  });
}

function diagnostic(code: string, message: string): PluginDiagnosticData {
  return { code, severity: 'error', message };
}

function jsonValue(value: unknown) {
  const parsed = AgentRuntimeJsonValueSchema.safeParse(value);
  return parsed.success ? parsed.data : { unavailable: true };
}

function textDelta(value: unknown): Readonly<{ text: string; channel: 'assistant' | 'reasoning' }> | null {
  if (typeof value === 'string') return { text: value, channel: 'assistant' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  return typeof record.text === 'string'
    ? { text: record.text, channel: record.thinking === true ? 'reasoning' : 'assistant' }
    : null;
}

function committedMessage(
  event: Extract<ClaudeProviderEvent, { kind: 'transcript-agent-message-committed' }>,
): Readonly<{ text: string; role: 'assistant' | 'reasoning' }> | null {
  if (!event.body || typeof event.body !== 'object' || Array.isArray(event.body)) return null;
  const body = event.body as Readonly<Record<string, unknown>>;
  const text = typeof body.message === 'string'
    ? body.message
    : typeof body.text === 'string'
      ? body.text
      : null;
  return text === null ? null : { text, role: body.thinking === true ? 'reasoning' : 'assistant' };
}

function mapEvent(event: ClaudeProviderEvent): NativeSessionEventInput | null {
  switch (event.kind) {
    case 'turn-start':
      return {
        kind: event.kind,
        turnId: event.turnId,
        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
        startedBy: event.startedBy === 'provider' ? 'provider' : 'host',
      };
    case 'turn-progress':
      return { kind: event.kind, turnId: event.turnId, ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}) };
    case 'turn-agent-id-observed':
      return { kind: event.kind, turnId: event.turnId, agentTurnId: event.agentTurnId };
    case 'turn-complete':
      return { kind: event.kind, turnId: event.turnId, ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}) };
    case 'turn-failed':
      return {
        kind: event.kind,
        turnId: event.turnId,
        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
        diagnostic: diagnostic(event.issue.code, event.issue.sanitizedPreview ?? event.issue.code),
      };
    case 'turn-cancelled':
      return {
        kind: event.kind,
        turnId: event.turnId,
        ...(event.agentTurnId ? { agentTurnId: event.agentTurnId } : {}),
        cause: 'providerCancelled',
        ...(event.reason ? { diagnostic: diagnostic('claude_turn_cancelled', event.reason) } : {}),
      };
    case 'message-delta': {
      const delta = textDelta(event.delta);
      return delta ? { kind: event.kind, turnId: event.turnId, ...delta } : null;
    }
    case 'tool-call':
      return {
        kind: event.kind,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        input: jsonValue(event.toolInput),
      };
    case 'tool-progress':
      return {
        kind: event.kind,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        progress: jsonValue(event.progress),
      };
    case 'tool-result':
      return {
        kind: event.kind,
        turnId: event.turnId,
        toolCallId: event.toolCallId,
        output: jsonValue(event.output),
        ...(event.isError === true ? { isError: true } : {}),
      };
    case 'session-id-publish': {
      const providerSessionId = typeof event.publishedSessionId === 'string'
        ? event.publishedSessionId.trim()
        : '';
      if (!providerSessionId) return null;
      const nativeSessionLogPath = typeof event.nativeSessionLogPath === 'string'
        ? event.nativeSessionLogPath.trim()
        : '';
      return {
        kind: 'provider-session-id',
        providerSessionId,
        ...(nativeSessionLogPath ? { nativeSessionLogPath } : {}),
      };
    }
    case 'transcript-agent-message-committed': {
      const message = committedMessage(event);
      return message
        ? { kind: 'transcript-message-committed', messageId: event.localId, ...message }
        : null;
    }
    case 'session-ended':
      return {
        kind: 'runtime-ended',
        cause: 'providerEnded',
        retryable: false,
        ...(event.reason ? { diagnostic: diagnostic('claude_runtime_ended', event.reason) } : {}),
      };
    case 'backend-error':
      return null;
    default:
      return null;
  }
}

function sendFailure(
  status: 'rejected' | 'unavailable' | 'unsupported',
  message?: string,
  retryable = status === 'unavailable',
): Exclude<Awaited<ReturnType<AgentSessionRuntime['send']>>, { status: 'admitted' }> {
  return {
    status,
    retryable,
    diagnostic: diagnostic(`claude_send_${status}`, message ?? `Claude input was ${status}.`),
  };
}

/**
 * Native AgentRuntime projection over Claude's provider operations. This consumes the operation
 * owner directly: the reachable native path never constructs or adapts a predecessor session
 * runtime carrier.
 */
export function createClaudeNativeSessionRuntimeFromOperations(
  operations: ClaudeNativeSessionOperations,
  request: AgentSessionOpenRequest,
  context: AgentSessionRuntimeContext,
  onDispose?: () => void | Promise<void>,
): AgentSessionRuntime {
  const listeners = new Set<(event: AgentSessionRuntimeEvent) => void>();
  let sequence = 0;
  let disposed = false;
  let appliedConfiguration = request.configuration;
  let usageObservationSequence = 0;
  let currentProviderBinding = request.providerBinding;
  let bufferedEvents: AgentSessionPreAdmissionBuffer<NativeSessionEventInput> | null = null;
  let bufferedEventFailure: Exclude<AgentSessionPreAdmissionBufferResult, { status: 'accepted' }> | null = null;
  const readBufferedEventFailure = () => bufferedEventFailure;
  let currentActivity: Extract<AgentSessionRuntimeEvent, { kind: 'runtime-activity-snapshot' }> | null = null;
  let currentModelId = currentProviderBinding?.model.id
    ?? request.configuration?.model.value
    ?? null;
  const terminalPromptDeliveriesByInputId = new Map<string, ClaudeTerminalPromptDelivery>();
  const unifiedPromptAcceptanceOperations =
    operations.promptCustody === 'unified_terminal' ? operations : null;
  const supportsEffort = operations.supportsEffort === true;
  const projectRuntimeModel = (model: AgentSessionModel): AgentSessionModel => {
    if (supportsEffort) return model;
    const { modelOptions: _effortOptions, ...modelWithoutEffortOptions } = model;
    const retainedOptions = (model.modelOptions ?? []).filter(
      (option) => option.id !== 'reasoning_effort' && option.id !== 'ultracode',
    );
    return {
      ...modelWithoutEffortOptions,
      ...(retainedOptions.length > 0 ? { modelOptions: retainedOptions } : {}),
      suppressedModelOptionIds: ['reasoning_effort', 'ultracode'],
    };
  };
  let models: readonly AgentSessionModel[] = currentProviderBinding
    ? [projectRuntimeModel(currentProviderBinding.model)]
    : CLAUDE_STATIC_MODELS.map((model) => projectRuntimeModel({
        id: model.id,
        name: model.name,
        ...(model.description ? { description: model.description } : {}),
        ...(model.contextWindowTokens ? { contextWindowTokens: model.contextWindowTokens } : {}),
        ...(model.extendedContextModelId
          ? { extendedContextModelId: model.extendedContextModelId }
          : {}),
        ...(model.modelOptions ? { modelOptions: model.modelOptions } : {}),
        ...(model.capabilities ? { capabilities: model.capabilities } : {}),
      }));
  const modelListeners = new Set<(snapshot: ReturnType<typeof readModels>) => void>();
  function readModels() {
    return {
      models,
      currentModelId,
    };
  }
  const publishModels = (): void => {
    const snapshot = readModels();
    for (const listener of modelListeners) listener(snapshot);
  };
  const emit = (event: NativeSessionEventInput, emittedAtMs = Date.now()): void => {
    const published = Object.freeze({
      ...event,
      sequence: ++sequence,
      sessionId: request.sessionId,
      emittedAtMs,
    }) as AgentSessionRuntimeEvent;
    for (const listener of listeners) listener(published);
  };
  const readTerminalPromptDelivery = (
    identity: ClaudeUnifiedPromptDeliveryIdentity,
  ): ClaudeTerminalPromptDelivery | null => {
    for (const inputId of identity.localIds ?? []) {
      const delivery = terminalPromptDeliveriesByInputId.get(inputId);
      if (delivery) return delivery;
    }
    return null;
  };
  const clearTerminalPromptDelivery = (delivery: ClaudeTerminalPromptDelivery): void => {
    for (const inputId of delivery.inputIds) {
      if (terminalPromptDeliveriesByInputId.get(inputId) === delivery) {
        terminalPromptDeliveriesByInputId.delete(inputId);
      }
    }
  };
  const acceptTerminalPromptDelivery = (identity: ClaudeUnifiedPromptDeliveryIdentity): void => {
    const delivery = readTerminalPromptDelivery(identity);
    if (!delivery || delivery.decision !== null) return;
    delivery.decision = { kind: 'accepted' };
    clearTerminalPromptDelivery(delivery);
    emit({
      kind: 'input-accepted',
      inputIds: delivery.inputIds,
      delivery: delivery.delivery,
    });
  };
  const rejectTerminalPromptDelivery = (
    identity: ClaudeUnifiedPromptDeliveryIdentity,
    reason = 'Claude rejected the input before provider custody.',
  ): void => {
    const delivery = readTerminalPromptDelivery(identity);
    if (!delivery || delivery.decision !== null) return;
    const failure = sendFailure('rejected', reason, true);
    delivery.decision = { kind: 'rejected_before_effect', failure };
    clearTerminalPromptDelivery(delivery);
    emit({
      kind: 'input-rejected',
      inputIds: delivery.inputIds,
      diagnostic: failure.diagnostic,
      retryable: true,
    });
  };
  const markTerminalPromptCustodyUnknown = (
    identity: ClaudeUnifiedPromptDeliveryIdentity,
    reason = 'Claude prompt transport may have occurred, but completion is unknown.',
  ): void => {
    const delivery = readTerminalPromptDelivery(identity);
    if (!delivery || delivery.decision !== null) return;
    const failure = sendFailure('unavailable', reason);
    delivery.decision = { kind: 'effect_may_have_occurred', failure };
    clearTerminalPromptDelivery(delivery);
    emit({
      kind: 'input-custody-unknown',
      inputIds: delivery.inputIds,
      issue: failure.diagnostic,
    });
  };
  unifiedPromptAcceptanceOperations?.setOnPromptAcceptedByProvider(acceptTerminalPromptDelivery);
  unifiedPromptAcceptanceOperations?.setOnPromptTerminallyRejectedBeforeProvider(
    rejectTerminalPromptDelivery,
  );
  unifiedPromptAcceptanceOperations?.setOnPromptDeliveryOutcome((outcome) => {
    if (outcome.type === 'provider_accepted') {
      acceptTerminalPromptDelivery(outcome);
    } else if (outcome.type === 'rejected_before_write') {
      rejectTerminalPromptDelivery(outcome, outcome.reason);
    } else if (outcome.type === 'possible_write') {
      markTerminalPromptCustodyUnknown(outcome, outcome.reason);
    }
  });
  const enqueueOrEmit = (event: NativeSessionEventInput, emittedAtMs: number): void => {
    if (!bufferedEvents) {
      emit(event, emittedAtMs);
      return;
    }
    const admission = bufferedEvents.admit(event);
    if (admission.status !== 'accepted' && bufferedEventFailure === null) {
      bufferedEventFailure = admission;
      bufferedEvents.dispose();
    }
  };
  const unsubscribeEvents = operations.subscribeProviderEvents((event) => {
    const mapped = mapEvent(event);
    if (mapped) enqueueOrEmit(mapped, event.emittedAtMs);
  });
  const unsubscribeActivity = operations.subscribeCanonicalAgentSessionEvents?.((event) => {
    if (event.kind !== 'runtime-activity-snapshot') return;
    currentActivity = event;
    enqueueOrEmit({
      kind: event.kind,
      state: event.state,
      activeCount: event.activeCount,
    }, event.emittedAtMs);
  }) ?? (() => undefined);
  const unsubscribeEffectiveModel = operations.subscribeEffectiveModel?.((evidence: ClaudeEffectiveModelEvidence) => {
    const modelId = evidence.modelId.trim();
    if (!modelId || disposed) return;
    currentModelId = modelId;
    const index = models.findIndex((model) => model.id === modelId);
    const previous = index >= 0 ? models[index] : undefined;
    const next = projectRuntimeModel({
      ...(previous ?? {}),
      id: modelId,
      name: evidence.displayName?.trim() || previous?.name || modelId,
      ...(evidence.contextWindowTokens !== null && evidence.contextWindowTokens !== undefined
        ? { contextWindowTokens: evidence.contextWindowTokens }
        : {}),
    });
    models = index >= 0
      ? models.map((model, modelIndex) => modelIndex === index ? next : model)
      : [...models, next];
    publishModels();
  }) ?? (() => undefined);
  const unsubscribeUsageObservation = operations.subscribeUsageObservation?.(
    (observation: ClaudeUsageObservation) => {
      if (disposed) return;
      emit({
        kind: 'usage-observed',
        observationId: `claude-usage-${++usageObservationSequence}`,
        source: observation.source,
        scope: observation.scope,
        ...(observation.modelId ? { modelId: observation.modelId } : {}),
        tokens: observation.tokens,
        ...(observation.cost ? { cost: observation.cost } : {}),
        ...(observation.contextSnapshot ? { context: observation.contextSnapshot } : {}),
      });
    },
  ) ?? (() => undefined);
  const activeInputBinding = context.session.services.activeInput.bind({
    isTurnInFlight: () => operations.isTurnInFlight?.() === true,
    canSteer: () => operations.canSteerPrompt?.() === true,
    canInterruptForPendingInput: () => operations.canInterruptForPendingInput?.() !== false,
    onPromptQueued: () => { operations.notifyPromptQueuedDuringTurn?.(); },
    applyPermissionIntentDuringTurn: async (permissionIntent) => {
      const apply = operations.applyConfigDeltaInFlight;
      return apply
        ? await apply({ permissionMode: permissionIntent })
        : { status: 'unsupported', reason: 'claude_in_flight_configuration_unavailable' };
    },
    clearTerminalComposer: async (clearRequest) => {
      const clear = operations.clearTerminalComposer;
      return clear
        ? await clear({
            sessionId: request.sessionId,
            ...(clearRequest.expectedStateAtMs !== undefined
              ? { expectedStateAtMs: clearRequest.expectedStateAtMs }
              : {}),
          })
        : { ok: false, status: 'unsupported', error: 'claude_terminal_composer_clear_unavailable' };
    },
    interruptPendingInputAndRun: async (interruptRequest) => {
      const interrupt = operations.interruptPendingInputAndRun;
      return interrupt
        ? await interrupt({
            sessionId: request.sessionId,
            localId: interruptRequest.localId,
            ...(interruptRequest.expectedStateAtMs !== undefined
              ? { expectedStateAtMs: interruptRequest.expectedStateAtMs }
              : {}),
          })
        : {
            ok: false,
            status: 'unsupported',
            localId: interruptRequest.localId,
            error: 'claude_pending_input_interrupt_unavailable',
          };
    },
  });
  const modelsBinding = context.session.services.models.bind({
    read: readModels,
    subscribe(listener) {
      modelListeners.add(listener);
      listener(readModels());
      return { dispose: () => { modelListeners.delete(listener); } };
    },
  });
  const initialProviderSessionId = operations.readProviderIdentity().sessionId?.trim();
  const sourceRuntimeDescriptor = request.runtimeDescriptorV1;
  const sourceRuntimeAgent = sourceRuntimeDescriptor?.agent;
  const effectiveConfigDir = request.launchEnvironment?.values.CLAUDE_CONFIG_DIR?.trim();
  const runtimeDescriptorV1 = sourceRuntimeDescriptor
    && sourceRuntimeDescriptor.v === 1
    && sourceRuntimeDescriptor.agentId === 'claude'
    && sourceRuntimeAgent
    && typeof sourceRuntimeAgent === 'object'
    ? Object.freeze({
        ...sourceRuntimeDescriptor,
        agent: Object.freeze({
          ...sourceRuntimeAgent,
          ...(effectiveConfigDir ? { configDir: effectiveConfigDir } : {}),
        }),
      })
    : undefined;

  return {
    ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
    async connectedServiceApplicationSettled() {
      await operations.releaseConnectedServiceUsageLimitDialog?.();
    },
    async send(nativeRequest) {
      if (disposed) return sendFailure('unavailable', 'Claude runtime is disposed.');
      bufferedEvents = createAgentSessionPreAdmissionBuffer();
      bufferedEventFailure = null;
      const nativeDelivery: NativeInputAcceptedDelivery = nativeRequest.delivery.kind === 'followUp'
        ? { kind: 'followUp', turnId: nativeRequest.delivery.turnId }
        : nativeRequest.delivery;
      const terminalPromptDelivery: ClaudeTerminalPromptDelivery | null = unifiedPromptAcceptanceOperations
        ? {
            inputIds: nativeRequest.inputIds,
            delivery: nativeDelivery,
            decision: null,
          }
        : null;
      if (terminalPromptDelivery) {
        for (const inputId of terminalPromptDelivery.inputIds) {
          terminalPromptDeliveriesByInputId.set(inputId, terminalPromptDelivery);
        }
      }
      let submissionOutcome: ClaudeRuntimePromptSubmissionOutcome;
      try {
        const meta = {
          localId: nativeRequest.inputIds[0] ?? null,
          localIds: [...nativeRequest.inputIds],
        };
        if (nativeRequest.delivery.kind === 'steer') {
          submissionOutcome = await operations.steerProviderTurn(nativeRequest.input.text, meta);
        } else {
          operations.beginProviderTurn(nativeRequest.delivery.turnId);
          submissionOutcome = await operations.sendProviderTurnPrompt(nativeRequest.input.text, meta);
        }
      } catch (error) {
        const queued = terminalPromptDelivery?.decision?.kind === 'accepted'
          ? bufferedEvents?.drain() ?? []
          : [];
        bufferedEvents?.dispose();
        bufferedEvents = null;
        bufferedEventFailure = null;
        if (terminalPromptDelivery?.decision) {
          for (const event of queued) emit(event);
          return terminalPromptDelivery.decision.kind === 'accepted'
            ? { status: 'admitted' }
            : terminalPromptDelivery.decision.failure;
        }
        if (terminalPromptDelivery) clearTerminalPromptDelivery(terminalPromptDelivery);
        const failure = sendFailure(
          'unavailable',
          error instanceof Error ? error.message : String(error),
        );
        emit({ kind: 'input-custody-unknown', inputIds: nativeRequest.inputIds, issue: failure.diagnostic });
        return failure;
      }
      const admissionFailure = readBufferedEventFailure();
      const canPublishBufferedEvents = admissionFailure === null
        && terminalPromptDelivery?.decision?.kind !== 'rejected_before_effect'
        && terminalPromptDelivery?.decision?.kind !== 'effect_may_have_occurred';
      const queued = canPublishBufferedEvents ? (bufferedEvents?.drain() ?? []) : [];
      bufferedEvents?.dispose();
      bufferedEvents = null;
      bufferedEventFailure = null;
      if (terminalPromptDelivery?.decision) {
        for (const event of queued) emit(event);
        return terminalPromptDelivery.decision.kind === 'accepted'
          ? { status: 'admitted' }
          : terminalPromptDelivery.decision.failure;
      }
      if (submissionOutcome.kind === 'accepted') {
        if (terminalPromptDelivery) clearTerminalPromptDelivery(terminalPromptDelivery);
        emit({
          kind: 'input-accepted',
          inputIds: nativeRequest.inputIds,
          delivery: nativeDelivery,
        });
      } else if (submissionOutcome.kind === 'rejected_before_effect') {
        if (terminalPromptDelivery) clearTerminalPromptDelivery(terminalPromptDelivery);
        const failure = sendFailure('rejected', submissionOutcome.reason, true);
        emit({
          kind: 'input-rejected',
          inputIds: nativeRequest.inputIds,
          diagnostic: failure.diagnostic,
          retryable: true,
        });
        return failure;
      } else if (submissionOutcome.kind === 'effect_may_have_occurred') {
        if (terminalPromptDelivery) clearTerminalPromptDelivery(terminalPromptDelivery);
        const failure = sendFailure('unavailable', submissionOutcome.reason);
        emit({
          kind: 'input-custody-unknown',
          inputIds: nativeRequest.inputIds,
          issue: failure.diagnostic,
        });
        return failure;
      }
      if (admissionFailure !== null && submissionOutcome.kind === 'custody_observed') {
        if (terminalPromptDelivery) clearTerminalPromptDelivery(terminalPromptDelivery);
        const failure = sendFailure(
          'unavailable',
          `Claude pre-admission event buffer rejected an event (${admissionFailure.status}${admissionFailure.status === 'overflow' ? `:${admissionFailure.reason}` : ''}).`,
        );
        emit({ kind: 'input-custody-unknown', inputIds: nativeRequest.inputIds, issue: failure.diagnostic });
        return failure;
      }
      for (const event of queued) emit(event);
      return { status: 'admitted' };
    },
    async cancel(cancelRequest) {
      try {
        const cancelled = await operations.cancelProviderTurn(cancelRequest.turnId);
        return cancelled !== false ? { status: 'requested', turnId: cancelRequest.turnId } : { status: 'notRunning' };
      } catch (error) {
        return {
          status: 'unavailable',
          diagnostic: diagnostic(
            'claude_cancel_unavailable',
            error instanceof Error ? error.message : String(error),
          ),
        };
      }
    },
    async updateConfiguration(configuration) {
      const nextProviderBinding = configuration.providerBinding;
      if (nextProviderBinding && !currentProviderBinding) {
        return {
          status: 'unsupported',
          diagnostic: diagnostic(
            'claude_provider_binding_restart_required',
            'Claude cannot apply a Provider binding to a native session without restarting it.',
          ),
        };
      }
      if (currentProviderBinding) {
        const providerModelChanged = configuration.model.value !== currentProviderBinding.model.id;
        if (providerModelChanged && !nextProviderBinding) {
          return {
            status: 'rejected',
            diagnostic: diagnostic(
              'claude_provider_model_descriptor_required',
              'A Provider-bound Claude model change requires the exact authorized Provider binding.',
            ),
          };
        }
        if (nextProviderBinding && (
          nextProviderBinding.connectionId !== currentProviderBinding.connectionId
          || !isDeepStrictEqual(
            nextProviderBinding.materialization,
            currentProviderBinding.materialization,
          )
        )) {
          return {
            status: 'unsupported',
            diagnostic: diagnostic(
              'claude_provider_binding_restart_required',
              'Claude requires a restart when the Provider connection or materialization changes.',
            ),
          };
        }
      }
      if (nextProviderBinding && configuration.model.value !== nextProviderBinding.model.id) {
        return {
          status: 'rejected',
          diagnostic: diagnostic(
            'claude_provider_model_descriptor_mismatch',
            'The authorized Provider model descriptor does not match the requested Claude model.',
          ),
        };
      }
      const effectiveProviderBinding = nextProviderBinding ?? currentProviderBinding;
      const previousOptions = appliedConfiguration?.options ?? {};
      const changedOptions = Object.entries(configuration.options).filter(([id, option]) => (
        previousOptions[id]?.value !== option.value
        || previousOptions[id]?.updatedAtMs !== option.updatedAtMs
      ));
      for (const id of Object.keys(previousOptions)) {
        if (!(id in configuration.options)) {
          changedOptions.push([id, { value: null, updatedAtMs: Date.now() }]);
        }
      }
      if (changedOptions.length > 1) {
        return {
          status: 'rejected',
          diagnostic: diagnostic(
            'claude_configuration_option_batch_unsupported',
            'Claude configuration updates must change at most one option at a time.',
          ),
        };
      }
      const changedOption = changedOptions[0];
      if (
        changedOption
        && !supportsEffort
        && (changedOption[0] === 'reasoning_effort' || changedOption[0] === 'ultracode')
      ) {
        return {
          status: 'unsupported',
          diagnostic: diagnostic(
            'claude_effort_unsupported_by_installed_cli',
            'The installed Claude CLI does not expose effort controls.',
          ),
        };
      }
      if (
        nextProviderBinding
        && currentProviderBinding
        && !isDeepStrictEqual(nextProviderBinding.model, currentProviderBinding.model)
      ) {
        const configuredEffort = configuration.options.reasoning_effort?.value;
        const configuredUltracode = configuration.options.ultracode?.value;
        const reasoningSupported = configuredEffort === null
          || configuredEffort === undefined
          || isClaudeEffortSupportedForProviderModel(nextProviderBinding.model, configuredEffort);
        const ultracodeEnabled = configuredUltracode === true || configuredUltracode === 'true';
        const ultracodeSupported = !ultracodeEnabled
          || isClaudeUltracodeSupportedModelId(
            nextProviderBinding.model.id,
            nextProviderBinding.model,
          );
        if (!reasoningSupported || !ultracodeSupported) {
          return {
            status: 'unsupported',
            diagnostic: diagnostic(
              'claude_provider_model_option_unsupported',
              `Provider model '${nextProviderBinding.model.id}' cannot atomically apply the current Claude configuration options.`,
            ),
          };
        }
      }
      const effectiveConfigOption = changedOption
        ? { id: changedOption[0], value: changedOption[1].value }
        : null;
      if (effectiveProviderBinding && effectiveConfigOption) {
        const { id, value } = effectiveConfigOption;
        const supported = id === 'reasoning_effort'
          ? value === null
            || isClaudeEffortSupportedForProviderModel(effectiveProviderBinding.model, value)
          : id === 'ultracode'
            ? (value === null || value === false || value === 'false')
              || (
                (value === true || value === 'true')
                && isClaudeUltracodeSupportedModelId(
                  effectiveProviderBinding.model.id,
                  effectiveProviderBinding.model,
                )
              )
            : false;
        if (!supported) {
          return {
            status: 'unsupported',
            diagnostic: diagnostic(
              'claude_provider_model_option_unsupported',
              `Provider model '${effectiveProviderBinding.model.id}' does not support this Claude configuration option.`,
            ),
          };
        }
      }
      const result = await operations.updateProviderConfiguration({
        ...(configuration.permissionIntent.value === null
          ? {}
          : { permissionMode: configuration.permissionIntent.value }),
        ...(configuration.model.value === null ? {} : { modelId: configuration.model.value }),
        ...(nextProviderBinding ? { providerBinding: nextProviderBinding } : {}),
        ...(effectiveConfigOption ? { configOption: effectiveConfigOption } : {}),
      });
      if (isRuntimeConfigUpdateOutcomeApplied(result)) {
        if (nextProviderBinding) {
          currentProviderBinding = nextProviderBinding;
          models = [projectRuntimeModel(nextProviderBinding.model)];
        }
        currentModelId = configuration.model.value;
        appliedConfiguration = configuration;
        publishModels();
        return {
          status: 'applied',
          changed: [
            'permissionIntent',
            'model',
            ...(effectiveConfigOption ? [`options.${effectiveConfigOption.id}`] : []),
          ],
        };
      }
      return {
        status: result?.status === 'unsupported' ? 'unsupported' : 'rejected',
        diagnostic: diagnostic('claude_configuration_rejected', 'Claude rejected the configuration update.'),
      };
    },
    watch(listener) {
      listeners.add(listener);
      if (initialProviderSessionId && !disposed) {
        listener(Object.freeze({
          kind: 'provider-session-id',
          providerSessionId: initialProviderSessionId,
          sequence: ++sequence,
          sessionId: request.sessionId,
          emittedAtMs: Date.now(),
        }));
      }
      if (currentActivity && !disposed) {
        listener(Object.freeze({
          kind: currentActivity.kind,
          state: currentActivity.state,
          activeCount: currentActivity.activeCount,
          sequence: ++sequence,
          sessionId: request.sessionId,
          emittedAtMs: currentActivity.emittedAtMs,
        }));
      }
      return { dispose: () => { listeners.delete(listener); } };
    },
    async dispose(reason) {
      if (disposed) return;
      disposed = true;
      bufferedEvents?.dispose();
      bufferedEvents = null;
      bufferedEventFailure = null;
      terminalPromptDeliveriesByInputId.clear();
      unifiedPromptAcceptanceOperations?.setOnPromptDeliveryOutcome(null);
      unsubscribeEvents();
      unsubscribeActivity();
      unsubscribeEffectiveModel();
      unsubscribeUsageObservation();
      activeInputBinding?.dispose();
      modelsBinding?.dispose();
      modelListeners.clear();
      listeners.clear();
      try {
        await operations.disposeProviderSession(reason ?? 'runtime_recovery');
      } finally {
        await onDispose?.();
      }
    },
  };
}

function metadataRecord(value: unknown): Readonly<Record<string, unknown>> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : {};
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readStringArray(value: unknown): readonly string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : null;
}

function terminalSurface(): NonNullable<AgentRuntime['surfaces']>['terminal'] {
  return {
    resolveLaunch(request) {
      const model = request.modelSelection?.modelId.trim() || null;
      const permissionMode = request.configuration?.permissionIntent.value ?? null;
      return {
        argv: resolveClaudeLaunchSettingsOverlayArgs({
          args: [
            ...(model ? ['--model', model] : []),
            ...(permissionMode ? ['--permission-mode', mapToClaudePermissionMode(permissionMode)] : []),
          ],
          interactionKind: 'interactive_terminal',
          permissionMode: permissionMode ? mapToClaudePermissionMode(permissionMode) : null,
          launchSettings: {},
        }),
        process: { stdio: 'inherit', windowsHide: true },
        presentation: {
          onLaunch: { target: 'local', reason: 'claude_terminal_runtime_launcher_start' },
          onExit: { target: 'remote', reason: 'claude_terminal_runtime_launcher_exit' },
        },
      };
    },
  };
}

export function createClaudeNativeRuntime(
  options: CreateClaudeNativeRuntimeOptions,
): AgentRuntime {
  const goals = createClaudeNativeGoalControl();
  const openSession = async (
    request: AgentSessionOpenRequest,
    context: AgentSessionRuntimeContext,
  ): Promise<AgentSessionRuntime> => {
    const supportsEffort = await (options.resolveSupportsEffort
      ?? resolveClaudeInstalledEffortSupport)({ request, context });
    const operations = await options.openSession({ request, context, supportsEffort });
    const releaseGoals = goals.bind(request.sessionId, operations);
    try {
      const runtime = createClaudeNativeSessionRuntimeFromOperations(
        operations,
        request,
        context,
        releaseGoals,
      );
      return runtime;
    } catch (error) {
      releaseGoals();
      throw error;
    }
  };
  const runtime: AgentRuntime = {
    toolExecution: { capability: 'interceptable' },
    sessions: {
      goals: goals.control,
      async open(request, context) {
        return await openSession(request, context);
      },
    },
    surfaces: {
      terminal: terminalSurface(),
      handoff: claudeHandoffSurface,
    },
  };
  return runtime;
}

function providerSessionId(request: AgentSessionOpenRequest): string | null {
  if (request.kind === 'resume') return request.providerSessionId;
  if (request.kind === 'fork') return request.source.providerSessionId;
  return null;
}

async function openClaudeNativeAgentSdkSession(input: Readonly<{
  request: AgentSessionOpenRequest;
  context: AgentSessionRuntimeContext;
  supportsEffort?: boolean;
}>): Promise<ClaudeNativeSessionOperations> {
  const sdkContext = createClaudeNativeAgentSdkContext(input.context);
  const launchSettings = await resolveClaudeNativeLaunchSettings({
    settings: input.context.services.settings.forScope({ kind: 'account' }),
    launchEnv: resolveClaudeNativeBaseLaunchEnvironment({
      launchEnvironment: input.request.launchEnvironment,
      processEnv: process.env,
    }),
    includeAdvancedOptions: true,
  });
  const initialModelId = input.request.providerBinding?.model.id
    ?? input.request.configuration?.model.value
    ?? null;
  const providerModel = input.request.providerBinding?.model;
  const requestedEffort = input.request.configuration?.options.reasoning_effort?.value;
  const initialEffort = input.supportsEffort === true ? resolveClaudeEffortForModel({
    modelId: initialModelId,
    effort: requestedEffort,
    ...(providerModel ? { providerModel } : {}),
  }) : null;
  const requestedUltracode = input.request.configuration?.options.ultracode?.value;
  const initialUltracode = input.supportsEffort === true
    && (requestedUltracode === true || requestedUltracode === 'true')
    && isClaudeUltracodeSupportedModelId(initialModelId, providerModel);
  return createClaudeAgentSdkTurnOperations({
    ctx: sdkContext,
    queryContext: sdkContext.agentRuntime.exec,
    permissionEngine: createClaudeNativePermissionEngine(input.context),
    directory: input.request.cwd,
    launchEnv: launchSettings.launchEnv,
    advancedOptions: launchSettings.advancedOptions,
    permissionMode: input.request.configuration?.permissionIntent.value ?? 'default',
    supportsEffort: input.supportsEffort === true,
    initialModelId,
    ...(initialEffort ? { initialEffort } : {}),
    ...(initialUltracode ? { initialUltracode: true } : {}),
    ...(input.request.providerBinding
      ? { providerModel: input.request.providerBinding.model }
      : {}),
    initialProviderSessionId: providerSessionId(input.request),
    happierSessionId: input.request.sessionId,
    mcpServers: input.request.mcpServers,
    publishTranscriptMessages: true,
    enableSessionWorkState: true,
    enableSessionResumability: true,
    publishGoalWorkState: createClaudeNativeGoalWorkStatePublisher(input.context),
  });
}

export const createClaudeAgentRuntime: AgentRuntimeFactory = () => createClaudeNativeRuntime({
  openSession: createClaudeNativeSessionOpener({
    openAgentSdkSession: openClaudeNativeAgentSdkSession,
    openUnifiedTerminalSession: openClaudeNativeUnifiedTerminalSession,
  }),
  resolveSupportsEffort: resolveClaudeInstalledEffortSupport,
});
