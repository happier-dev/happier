import type {
  AgentLaunchEnvironment,
  AgentExecutionRunEvent,
  AgentExecutionRunOpenRequest,
  AgentExecutionRunRuntime,
  AgentRuntime,
  AgentRuntimeContext,
  AgentRuntimeFactory,
  AgentPermissionIntent,
  AgentSessionOpenRequest,
  AgentSessionRuntime,
  AgentSessionRuntimeContext,
  AgentSessionRuntimeEvent,
} from '@happier-dev/plugin-sdk/agent-runtime';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { AgentRuntimeJsonValueSchema } from '@happier-dev/plugin-sdk/agent-runtime';
import type { PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import type { AgentModelDescriptor } from '@happier-dev/plugin-sdk/experimental/agents';
import {
  createAgentSessionPreAdmissionBuffer,
  type AgentSessionPreAdmissionBuffer,
  type AgentSessionPreAdmissionBufferResult,
} from '@happier-dev/agents/runtime/session/preAdmissionBuffer';
import { isRuntimeConfigUpdateOutcomeApplied } from '@happier-dev/agents';

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
  resolveClaudeNativeBaseLaunchEnvironment,
  resolveClaudeNativeLaunchSettings,
} from './launchSettings.js';
import type {
  ClaudeUsageObservation,
  ClaudeUsageObservationSubscription,
} from '../usage/types.js';
import {
  isClaudeEffortSupportedForProviderModel,
  isClaudeUltracodeSupportedModelId,
  resolveClaudeEffortForModel,
} from './reasoningEffort.js';
import { CLAUDE_AUTH_ENV_KEYS } from '../auth/services/runtime/env.js';
import { prepareClaudeQualifiedPurposeRoot } from '../auth/services/qualifiedPurposeRoot.js';

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

type NativeExecutionRunEventInput = AgentExecutionRunEvent extends infer Event
  ? Event extends AgentExecutionRunEvent
    ? Omit<Event, 'sequence' | 'runId' | 'emittedAtMs'>
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
  subscribeEffectiveModel?: ClaudeEffectiveModelEvidenceSubscription;
  subscribeUsageObservation?: ClaudeUsageObservationSubscription;
  subscribeCanonicalAgentSessionEvents?: (
    handler: (event: AgentSessionRuntimeEvent) => void,
  ) => () => void;
  isTurnInFlight?: () => boolean;
  canSteerPrompt?: () => boolean;
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
}>) => ClaudeNativeSessionOperations | Promise<ClaudeNativeSessionOperations>;

export type ClaudeNativeExecutionSessionFactory = (input: Readonly<{
  request: Extract<AgentExecutionRunOpenRequest, { kind: 'create' }>;
  context: AgentRuntimeContext;
}>) => ClaudeNativeSessionOperations | Promise<ClaudeNativeSessionOperations>;

export type CreateClaudeNativeRuntimeOptions = Readonly<{
  openSession: ClaudeNativeSessionFactory;
  openExecutionSession?: ClaudeNativeExecutionSessionFactory;
  prepareLaunchEnvironment?: ClaudeNativeLaunchEnvironmentPreparer;
}>;

type ClaudePreparedLaunchEnvironment = Readonly<{
  launchEnvironment: AgentLaunchEnvironment;
  armInvalidation(handler: () => Promise<void>): void;
  dispose(): Promise<void>;
}>;

export type ClaudeNativeLaunchEnvironmentPreparer = (input: Readonly<{
  request: Readonly<{
    cwd: string;
    launchEnvironment?: AgentLaunchEnvironment;
  }>;
  context: AgentRuntimeContext;
}>) => Promise<ClaudePreparedLaunchEnvironment>;

const CLAUDE_SUBSCRIPTION_PURPOSE = 'model_upstream';
const ANTHROPIC_API_KEY_PURPOSE = 'model_upstream_api_key';
const CLAUDE_CREDENTIAL_FILE_ID = '.credentials.json';

function sameService(
  binding: Awaited<ReturnType<AgentRuntimeContext['services']['connectedAccounts']['getBinding']>>,
  pluginId: string,
  localId: string,
): boolean {
  return binding?.service.pluginId === pluginId && binding.service.localId === localId;
}

function mergeQualifiedAuthLaunchEnvironment(input: Readonly<{
  source?: AgentLaunchEnvironment;
  rootDir: string;
  authEnv: Readonly<Record<string, string>>;
}>): AgentLaunchEnvironment {
  const values = { ...(input.source?.values ?? {}) };
  for (const key of [...CLAUDE_AUTH_ENV_KEYS, 'CLAUDE_CONFIG_DIR'] as const) {
    delete values[key];
  }
  Object.assign(values, input.authEnv, { CLAUDE_CONFIG_DIR: input.rootDir });
  const materializedKeys = new Set(Object.keys(values));
  return Object.freeze({
    values: Object.freeze(values),
    unset: Object.freeze(
      (input.source?.unset ?? []).filter((key) => !materializedKeys.has(key)),
    ),
  });
}

async function waitForClaudePurposeObservations(
  observations: Iterable<Promise<void>>,
  signal: AbortSignal,
): Promise<void> {
  const abortError = () => signal.reason instanceof Error
    ? signal.reason
    : new Error('Claude qualified Connected Account preparation was aborted.');
  if (signal.aborted) throw abortError();
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
  });
  try {
    await Promise.race([Promise.all(observations), aborted]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}

export const prepareClaudeQualifiedConnectedAccountLaunch:
  ClaudeNativeLaunchEnvironmentPreparer = async ({ request, context }) => {
    const subscriptions: Array<Readonly<{ dispose(): void }>> = [];
    const initialObservations = new Map<string, Promise<void>>();
    const resolveInitial = new Map<string, () => void>();
    let invalidated = false;
    let invalidationHandler: (() => Promise<void>) | null = null;
    let rootDir: string | null = null;

    const invalidate = async (): Promise<void> => {
      invalidated = true;
      await invalidationHandler?.();
    };
    for (const purpose of [CLAUDE_SUBSCRIPTION_PURPOSE, ANTHROPIC_API_KEY_PURPOSE]) {
      initialObservations.set(purpose, new Promise<void>((resolve) => {
        resolveInitial.set(purpose, resolve);
      }));
      let initial = true;
      subscriptions.push(context.services.connectedAccounts.watch(purpose, () => {
        if (initial) {
          initial = false;
          resolveInitial.get(purpose)?.();
          resolveInitial.delete(purpose);
          return;
        }
        return invalidate();
      }));
    }

    try {
      await waitForClaudePurposeObservations(
        initialObservations.values(),
        context.signal,
      );
      const subscriptionBinding = await context.services.connectedAccounts.getBinding(
        CLAUDE_SUBSCRIPTION_PURPOSE,
        { signal: context.signal },
      );
      const useSubscription = sameService(
        subscriptionBinding,
        'happier.agent.claude',
        'claude-subscription',
      );
      const anthropicBinding = useSubscription
        ? null
        : await context.services.connectedAccounts.getBinding(
            ANTHROPIC_API_KEY_PURPOSE,
            { signal: context.signal },
          );
      const useAnthropic = sameService(
        anthropicBinding,
        'happier.agent.claude',
        'anthropic',
      );
      if (!useSubscription && !useAnthropic) {
        return Object.freeze({
          launchEnvironment: request.launchEnvironment ?? Object.freeze({
            values: Object.freeze({}),
            unset: Object.freeze([]),
          }),
          armInvalidation(handler) {
            invalidationHandler = handler;
            if (invalidated) void handler();
          },
          async dispose() {
            for (const subscription of subscriptions) subscription.dispose();
          },
        });
      }

      rootDir = await mkdtemp(join(tmpdir(), 'happier-claude-qualified-account-'));
      await prepareClaudeQualifiedPurposeRoot({
        rootDir,
        processEnv: process.env,
        sessionDirectory: request.cwd,
      });

      let authEnv: Readonly<Record<string, string>>;
      if (useSubscription) {
        const [environment, files] = await Promise.all([
          context.services.connectedAccounts.materialize(
            CLAUDE_SUBSCRIPTION_PURPOSE,
            { kind: 'environment', keys: ['CLAUDE_CODE_OAUTH_TOKEN'] },
            { signal: context.signal },
          ),
          context.services.connectedAccounts.materialize(
            CLAUDE_SUBSCRIPTION_PURPOSE,
            { kind: 'files', fileIds: [CLAUDE_CREDENTIAL_FILE_ID] },
            { signal: context.signal },
          ),
        ]);
        if (environment.kind !== 'environment' || files.kind !== 'files') {
          throw new Error('Claude Subscription returned an invalid qualified materialization.');
        }
        const setupToken = environment.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ?? '';
        const credentialFile = files.files[CLAUDE_CREDENTIAL_FILE_ID];
        if (Boolean(setupToken) === Boolean(credentialFile)) {
          throw new Error('Claude Subscription did not materialize one unambiguous credential mode.');
        }
        if (credentialFile) {
          await writeFile(
            join(rootDir, CLAUDE_CREDENTIAL_FILE_ID),
            credentialFile,
            { mode: 0o600, flag: 'wx' },
          );
          authEnv = Object.freeze({});
        } else {
          authEnv = Object.freeze({ CLAUDE_CODE_OAUTH_TOKEN: setupToken });
        }
      } else {
        const environment = await context.services.connectedAccounts.materialize(
          ANTHROPIC_API_KEY_PURPOSE,
          { kind: 'environment', keys: ['ANTHROPIC_API_KEY'] },
          { signal: context.signal },
        );
        if (environment.kind !== 'environment') {
          throw new Error('Anthropic returned an invalid qualified materialization.');
        }
        const apiKey = environment.env.ANTHROPIC_API_KEY?.trim() ?? '';
        if (!apiKey) {
          throw new Error('Anthropic did not materialize ANTHROPIC_API_KEY.');
        }
        authEnv = Object.freeze({ ANTHROPIC_API_KEY: apiKey });
      }

      const launchEnvironment = mergeQualifiedAuthLaunchEnvironment({
        source: request.launchEnvironment,
        rootDir,
        authEnv,
      });
      return Object.freeze({
        launchEnvironment,
        armInvalidation(handler) {
          invalidationHandler = handler;
          if (invalidated) void handler();
        },
        async dispose() {
          for (const subscription of subscriptions) subscription.dispose();
          if (rootDir) await rm(rootDir, { recursive: true, force: true });
        },
      });
    } catch (error) {
      for (const subscription of subscriptions) subscription.dispose();
      if (rootDir) await rm(rootDir, { recursive: true, force: true });
      throw error;
    }
  };

export function createClaudeNativeSessionOpener(openers: Readonly<{
  openAgentSdkSession: ClaudeNativeSessionFactory;
  openUnifiedTerminalSession: ClaudeNativeSessionFactory;
}>): ClaudeNativeSessionFactory {
  return async (input) => {
    const selected = await isClaudeUnifiedTerminalSelected({
      context: {
        features: input.context.session.services.features,
        settings: input.context.services.settings,
      },
    });
    return await (selected
      ? openers.openUnifiedTerminalSession(input)
      : openers.openAgentSdkSession(input));
  };
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
      return providerSessionId ? { kind: 'provider-session-id', providerSessionId } : null;
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
      return {
        kind: 'runtime-ended',
        cause: 'protocolError',
        retryable: false,
        diagnostic: diagnostic(event.error.code ?? 'claude_backend_error', event.error.message),
      };
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
  context?: AgentSessionRuntimeContext,
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
  let models: readonly AgentModelDescriptor[] = currentProviderBinding
    ? [currentProviderBinding.model]
    : CLAUDE_STATIC_MODELS.map((model) => ({
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
    const next = {
      ...(previous ?? {}),
      id: modelId,
      name: evidence.displayName?.trim() || previous?.name || modelId,
      ...(evidence.contextWindowTokens !== null && evidence.contextWindowTokens !== undefined
        ? { contextWindowTokens: evidence.contextWindowTokens }
        : {}),
    };
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
  const activeInputBinding = context?.session.services.activeInput.bind({
    isTurnInFlight: () => operations.isTurnInFlight?.() === true,
    canSteer: () => operations.canSteerPrompt?.() === true,
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
  const modelsBinding = context?.session.services.models?.bind({
    read: readModels,
    subscribe(listener) {
      modelListeners.add(listener);
      listener(readModels());
      return { dispose: () => { modelListeners.delete(listener); } };
    },
  });
  const initialProviderSessionId = operations.readProviderIdentity().sessionId?.trim();

  return {
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
          operations.beginProviderTurn();
          submissionOutcome = await operations.sendProviderTurnPrompt(nativeRequest.input.text, meta);
        }
      } catch (error) {
        const queued = bufferedEvents?.drain() ?? [];
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
        for (const event of queued) emit(event);
        return failure;
      }
      const admissionFailure = readBufferedEventFailure();
      const queued = admissionFailure === null ? (bufferedEvents?.drain() ?? []) : [];
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
        for (const event of queued) emit(event);
        return failure;
      } else if (submissionOutcome.kind === 'effect_may_have_occurred') {
        if (terminalPromptDelivery) clearTerminalPromptDelivery(terminalPromptDelivery);
        const failure = sendFailure('unavailable', submissionOutcome.reason);
        emit({
          kind: 'input-custody-unknown',
          inputIds: nativeRequest.inputIds,
          issue: failure.diagnostic,
        });
        for (const event of queued) emit(event);
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
        await operations.cancelProviderTurn();
        return { status: 'requested', turnId: cancelRequest.turnId };
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
      if (effectiveProviderBinding && changedOption) {
        const [id, option] = changedOption;
        const value = option.value;
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
        ...(changedOption
          ? { configOption: { id: changedOption[0], value: changedOption[1].value } }
          : {}),
      });
      if (isRuntimeConfigUpdateOutcomeApplied(result)) {
        if (nextProviderBinding) {
          currentProviderBinding = nextProviderBinding;
          models = [nextProviderBinding.model];
        }
        currentModelId = configuration.model.value;
        appliedConfiguration = configuration;
        publishModels();
        return {
          status: 'applied',
          changed: [
            'permissionIntent',
            'model',
            ...(changedOption ? [`options.${changedOption[0]}`] : []),
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
      const terminal = metadataRecord(request.metadata.terminalRuntime);
      const rawArgs = readStringArray(request.metadata.claudeArgs)
        ?? readStringArray(terminal.claudeArgs)
        ?? [];
      const partition = partitionClaudeTerminalUserArgs(rawArgs);
      const overrides = parseClaudeTerminalRawSpawnOptionOverrides(rawArgs);
      const model = readString(request.metadata.model) ?? overrides.model;
      const fallbackModel = readString(request.metadata.fallbackModel) ?? overrides.fallbackModel;
      const customSystemPrompt = readString(request.metadata.customSystemPrompt) ?? overrides.customSystemPrompt;
      const appendSystemPrompt = readString(request.metadata.appendSystemPrompt) ?? overrides.appendSystemPrompt;
      return {
        argv: [
          ...partition.flagArgs,
          ...(model ? ['--model', model] : []),
          ...(fallbackModel ? ['--fallback-model', fallbackModel] : []),
          ...(customSystemPrompt ? ['--system-prompt', customSystemPrompt] : []),
          ...(appendSystemPrompt ? ['--append-system-prompt', appendSystemPrompt] : []),
          ...partition.positionalArgs,
          ...partition.trailingPermissionFlagArgs,
        ],
        process: { stdio: 'inherit', windowsHide: true },
        presentation: {
          onLaunch: { target: 'local', reason: 'claude_terminal_runtime_launcher_start' },
          onExit: { target: 'remote', reason: 'claude_terminal_runtime_launcher_exit' },
        },
      };
    },
  };
}

function createExecutionRunRuntime(
  request: Extract<AgentExecutionRunOpenRequest, { kind: 'create' }>,
  session: AgentSessionRuntime,
): AgentExecutionRunRuntime {
  const listeners = new Set<(event: AgentExecutionRunEvent) => void>();
  const history: AgentExecutionRunEvent[] = [];
  let eventSequence = 0;
  let turnOrdinal = 0;
  let activeTurnId: string | null = null;
  const emit = (event: NativeExecutionRunEventInput, emittedAtMs = Date.now()): void => {
    const value = Object.freeze({
      ...event,
      sequence: ++eventSequence,
      runId: request.runId,
      emittedAtMs,
    }) as AgentExecutionRunEvent;
    history.push(value);
    for (const listener of listeners) listener(value);
  };
  const subscription = session.watch((event) => {
    if (event.kind === 'message-delta') {
      emit({ kind: 'output-delta', channel: event.channel, text: event.text }, event.emittedAtMs);
    } else if (event.kind === 'provider-session-id') {
      emit({ kind: 'checkpoint', checkpointId: event.providerSessionId }, event.emittedAtMs);
    } else if (event.kind === 'turn-progress') {
      emit({ kind: 'run-progress' }, event.emittedAtMs);
    } else if (event.kind === 'turn-complete') {
      activeTurnId = null;
      emit({ kind: 'run-complete' }, event.emittedAtMs);
    } else if (event.kind === 'turn-failed') {
      activeTurnId = null;
      emit({ kind: 'run-failed', diagnostic: event.diagnostic }, event.emittedAtMs);
    } else if (event.kind === 'turn-cancelled') {
      activeTurnId = null;
      emit({ kind: 'run-cancelled', ...(event.diagnostic ? { diagnostic: event.diagnostic } : {}) }, event.emittedAtMs);
    }
  });
  const send: AgentExecutionRunRuntime['send'] = async (input, options) => {
    activeTurnId = `${request.runId}-turn-${++turnOrdinal}`;
    const result = await session.send({
      inputIds: [`${request.runId}-input-${turnOrdinal}`],
      input,
      delivery: { kind: 'newTurn', turnId: activeTurnId },
    }, options);
    return result.status === 'admitted'
      ? { status: 'admitted' as const }
      : { status: result.status, diagnostic: result.diagnostic };
  };
  emit({ kind: 'run-start' });
  return {
    send,
    async stop(options) {
      if (!activeTurnId) return { status: 'notRunning' };
      const result = await session.cancel?.({ turnId: activeTurnId, reason: 'user' }, options);
      return { status: result?.status ?? 'unsupported' };
    },
    watch(listener) {
      listeners.add(listener);
      for (const event of history) listener(event);
      return { dispose: () => { listeners.delete(listener); } };
    },
    async dispose() {
      subscription.dispose();
      listeners.clear();
      await session.dispose();
    },
  };
}

export function createClaudeNativeRuntime(
  options: CreateClaudeNativeRuntimeOptions,
): AgentRuntime {
  const goals = createClaudeNativeGoalControl();
  return {
    sessions: {
      goals: goals.control,
      async open(request, context) {
        const prepared = options.prepareLaunchEnvironment
          ? await options.prepareLaunchEnvironment({ request, context })
          : null;
        const effectiveRequest = prepared
          ? Object.freeze({
              ...request,
              launchEnvironment: prepared.launchEnvironment,
            }) as AgentSessionOpenRequest
          : request;
        let operations: ClaudeNativeSessionOperations;
        try {
          operations = await options.openSession({
            request: effectiveRequest,
            context,
          });
        } catch (error) {
          await prepared?.dispose();
          throw error;
        }
        const releaseGoals = goals.bind(request.sessionId, operations);
        try {
          const runtime = createClaudeNativeSessionRuntimeFromOperations(
            operations,
            effectiveRequest,
            context,
            async () => {
              releaseGoals();
              await prepared?.dispose();
            },
          );
          prepared?.armInvalidation(
            async () => await runtime.dispose('runtime_recovery'),
          );
          return runtime;
        } catch (error) {
          releaseGoals();
          await prepared?.dispose();
          throw error;
        }
      },
    },
    executionRuns: {
      async open(request, context) {
        if (request.kind !== 'create') {
          throw new Error(`Claude execution runs do not support ${request.kind}.`);
        }
        if (!options.openExecutionSession) {
          throw new Error('Claude native execution session factory is unavailable.');
        }
        const sessionRequest: AgentSessionOpenRequest = {
          kind: 'create',
          sessionId: request.runId,
          cwd: request.cwd,
          ...(request.launchEnvironment ? { launchEnvironment: request.launchEnvironment } : {}),
        };
        const prepared = options.prepareLaunchEnvironment
          ? await options.prepareLaunchEnvironment({
              request: sessionRequest,
              context,
            })
          : null;
        const effectiveRequest = prepared
          ? Object.freeze({
              ...request,
              launchEnvironment: prepared.launchEnvironment,
            }) as Extract<AgentExecutionRunOpenRequest, { kind: 'create' }>
          : request;
        const effectiveSessionRequest: AgentSessionOpenRequest = prepared
          ? Object.freeze({
              ...sessionRequest,
              launchEnvironment: prepared.launchEnvironment,
            })
          : sessionRequest;
        let operations: ClaudeNativeSessionOperations;
        try {
          operations = await options.openExecutionSession({
            request: effectiveRequest,
            context,
          });
        } catch (error) {
          await prepared?.dispose();
          throw error;
        }
        const session = createClaudeNativeSessionRuntimeFromOperations(
          operations,
          effectiveSessionRequest,
          undefined,
          async () => await prepared?.dispose(),
        );
        prepared?.armInvalidation(
          async () => await session.dispose('runtime_recovery'),
        );
        const runtime = createExecutionRunRuntime(request, session);
        const result = await runtime.send(request.input);
        if (result.status !== 'admitted') await runtime.dispose();
        return runtime;
      },
    },
    surfaces: {
      terminal: terminalSurface(),
    },
  };
}

function providerSessionId(request: AgentSessionOpenRequest): string | null {
  if (request.kind === 'resume') return request.providerSessionId;
  if (request.kind === 'fork') return request.source.providerSessionId;
  return null;
}

async function openClaudeNativeAgentSdkSession(input: Readonly<{
  request: AgentSessionOpenRequest;
  context: AgentSessionRuntimeContext;
}>): Promise<ClaudeNativeSessionOperations> {
  const sdkContext = createClaudeNativeAgentSdkContext(input.context, input.context);
  const launchSettings = await resolveClaudeNativeLaunchSettings({
    settings: input.context.services.settings,
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
  const initialEffort = resolveClaudeEffortForModel({
    modelId: initialModelId,
    effort: requestedEffort,
    ...(providerModel ? { providerModel } : {}),
  });
  const requestedUltracode = input.request.configuration?.options.ultracode?.value;
  const initialUltracode = (requestedUltracode === true || requestedUltracode === 'true')
    && isClaudeUltracodeSupportedModelId(initialModelId, providerModel);
  return createClaudeAgentSdkTurnOperations({
    ctx: sdkContext,
    queryContext: sdkContext.agentRuntime.exec,
    permissionEngine: createClaudeNativePermissionEngine(input.context),
    directory: input.request.cwd,
    launchEnv: launchSettings.launchEnv,
    advancedOptions: launchSettings.advancedOptions,
    permissionMode: input.request.configuration?.permissionIntent.value ?? 'default',
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

async function openClaudeNativeExecutionSession(input: Readonly<{
  request: Extract<AgentExecutionRunOpenRequest, { kind: 'create' }>;
  context: AgentRuntimeContext;
}>): Promise<ClaudeNativeSessionOperations> {
  const sdkContext = createClaudeNativeAgentSdkContext(input.context);
  const launchSettings = await resolveClaudeNativeLaunchSettings({
    settings: input.context.services.settings,
    launchEnv: resolveClaudeNativeBaseLaunchEnvironment({
      launchEnvironment: input.request.launchEnvironment,
      processEnv: process.env,
    }),
    includeAdvancedOptions: true,
  });
  return createClaudeAgentSdkTurnOperations({
    ctx: sdkContext,
    queryContext: sdkContext.agentRuntime.exec,
    permissionEngine: createClaudeNativePermissionEngine(input.context),
    directory: input.request.cwd,
    launchEnv: launchSettings.launchEnv,
    advancedOptions: launchSettings.advancedOptions,
    permissionMode: 'default',
    happierSessionId: null,
    publishSdkMessages: true,
    enableSessionWorkState: false,
    enableSessionResumability: false,
  });
}

export const createClaudeAgentRuntime: AgentRuntimeFactory = () => createClaudeNativeRuntime({
  openSession: createClaudeNativeSessionOpener({
    openAgentSdkSession: openClaudeNativeAgentSdkSession,
    openUnifiedTerminalSession: openClaudeNativeUnifiedTerminalSession,
  }),
  openExecutionSession: openClaudeNativeExecutionSession,
  prepareLaunchEnvironment: prepareClaudeQualifiedConnectedAccountLaunch,
});
