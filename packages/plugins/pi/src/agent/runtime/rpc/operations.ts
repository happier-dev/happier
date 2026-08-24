import { randomUUID } from 'node:crypto';

import type {
  AgentSessionCompactRequest,
  AgentSessionConfigurationSnapshot,
  AgentSessionRuntime,
  AgentSessionRuntimeEvent,
  AgentSessionSendRequest,
  AgentSessionModelsService,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventSchema } from '@happier-dev/plugin-sdk/agents/runtime';
import type { PluginDiagnosticData } from '@happier-dev/plugin-sdk';
import type {
  ManagedExecutableRef } from '@happier-dev/plugin-sdk/managed-services';
import type {
  LoggerService as PluginLoggerService,
  PluginServices,
} from '@happier-dev/plugin-sdk';
import { raceWithTimeout } from '@happier-dev/plugin-sdk/async';
import {
  normalizeSlashCommandName,
} from '@happier-dev/plugin-sdk/sessions';
import {
  createAgentSessionPreAdmissionBuffer,
  type AgentSessionPreAdmissionBuffer,
  type AgentSessionPreAdmissionBufferResult,
} from '@happier-dev/plugin-sdk/agents/runtime';

import {
  PI_REQUEST_AUTH_CAPABILITY_PATH_ENV,
  PI_REQUEST_AUTH_PRODUCER_VERSION_ENV,
} from '../../auth/services/requestAuth/index.js';
import { PI_THINKING_LEVEL_ENV, resolvePiThinkingLevelFromEnv } from '../../../protocol/thinking.js';
import { buildPiRpcArgs, readPiConnectedServiceIdFromEnv } from './args.js';
import {
  createPiJsonStreamRpcClient,
  PiRpcNegativeAcknowledgementError,
  type PiJsonStreamRpcClient,
} from './client.js';
import {
  createPiRuntimeEventProjector,
  readPiProviderTurnId,
  readPiRuntimeRecordType,
  type PiRuntimeEvent,
} from './events.js';
import { classifyPiAgentEndBoundary } from './lifecycle.js';
import {
  readPiProviderFailureDiagnostic,
  readPiPromptRejectionDiagnostic,
  type PiProviderFailureDiagnostic,
} from './providerFailureDiagnostic.js';
import {
  PiRequestAuthCompatibilityError,
  resolvePiRequestAuthCompatibility,
} from './requestAuthCompatibility.js';
import type { PiPermissionMode, PiRpcStateData } from './types.js';
import { createPiSessionModelsSource } from '../modelsSource.js';
import { projectPiSessionStatsUsage } from './usage.js';
import {
  buildPiExtensionUiQuestionRequest,
  buildPiExtensionUiResponse,
  parsePiBlockingExtensionUiRequest,
  type PiBlockingExtensionUiRequest,
} from './extensionUi.js';

const PI_VERSION_PROBE_TIMEOUT_MS = 30_000;

type PiRuntimeOperationsParams = Readonly<{
  services: Pick<PluginServices, 'exec'> & Readonly<{
    interactions: Pick<PluginServices['interactions'], 'askQuestions'>;
  }>;
  models?: AgentSessionModelsService;
  logger: PluginLoggerService;
  cwd: string;
  env: Readonly<Record<string, string>>;
  unsetEnvKeys?: readonly string[];
  permissionMode?: PiPermissionMode;
  initialSessionId?: string | null;
  resumeSessionId?: string | null;
  sessionId: string;
  eagerStart?: boolean;
  happierToolsExtension?: Readonly<{ extensionPath: string; configPath: string }>;
}>;

type PiAvailableCommand = Readonly<{
  name: string;
  description?: string;
}>;

type RuntimeEventHandler = (event: AgentSessionRuntimeEvent) => void;
type RuntimeEventPublisher = (event: unknown) => void;

type ActiveTurnState = Readonly<{
  turnId: string;
  agentTurnId: string | null;
}>;

type PendingCompletion = Readonly<{
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}>;

type PendingPromptAdmission = {
  turnId: string;
  onAccepted: () => void;
  bufferedRecords: AgentSessionPreAdmissionBuffer<Readonly<Record<string, unknown>>>;
  bufferFailure: Exclude<AgentSessionPreAdmissionBufferResult, { status: 'accepted' }> | null;
};

type PendingCancellation = {
  turnId: string;
  reason: 'user' | 'hostShutdown' | 'sessionDispose' | 'runtimeRecovery';
  finalBoundaryObserved: boolean;
  finalBoundaryAgentTurnId: string | null;
};

type PiRuntimeTurnOperations = Readonly<{
  beginTurnLifecycle(turnId?: string): void;
  openSession(opts?: Readonly<Record<string, unknown>>): Promise<string | null>;
  sendTurnPrompt(
    prompt: string,
    turnId: string,
    delivery?: 'followUp',
    onAccepted?: () => void,
  ): Promise<void>;
  steerInFlightTurn(message: string): Promise<void>;
  waitForTurnCompletion(opts?: Readonly<Record<string, unknown>>): Promise<void>;
  subscribeRuntimeEvents(handler: RuntimeEventHandler): () => void;
  cancelTurn(
    turnId: string,
    reason: PendingCancellation['reason'],
  ): Promise<void>;
  readSessionIdentity(): Readonly<{ sessionId: string | null }>;
  updateSessionRuntimeConfig(update: AgentSessionConfigurationSnapshot): Promise<readonly string[]>;
  compactContext(request: AgentSessionCompactRequest): Promise<void>;
  publishRuntimeEvent(event: PiRuntimeEvent): void;
  resetOrDisposeRuntime(): Promise<void>;
}>;

type RuntimeOperationsWithRecordHandler = PiRuntimeTurnOperations & Readonly<{
  handleRuntimeRecord(record: Readonly<Record<string, unknown>>): void;
  handleProcessExit(result: Parameters<Parameters<PiJsonStreamRpcClient['onExit']>[0]>[0]): void;
}>;

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isPiRpcClientDisposedError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Pi RPC client disposed';
}

class PiRpcSubmissionOutcomeUnknownError extends Error {
  readonly kind = 'possible_write';

  constructor(error: Error) {
    super(error.message);
    this.name = 'PiRpcSubmissionOutcomeUnknownError';
  }
}

function classifyPiRpcSubmissionFailure(error: Error): Error {
  return error instanceof PiRpcNegativeAcknowledgementError
    ? error
    : new PiRpcSubmissionOutcomeUnknownError(error);
}

function diagnostic(code: string, message: string): PluginDiagnosticData {
  return { code, severity: 'error', message };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizePiAvailableCommands(value: unknown): readonly PiAvailableCommand[] {
  const commands = isRecord(value) && Array.isArray(value.commands) ? value.commands : [];
  const byName = new Map<string, PiAvailableCommand>();
  for (const command of commands) {
    if (!isRecord(command)) continue;
    const name = normalizeSlashCommandName(command.name);
    if (!name || byName.has(name)) continue;
    const description = readString(command.description) ?? undefined;
    byName.set(name, Object.freeze({ name, ...(description ? { description } : {}) }));
  }
  return Object.freeze([...byName.values()].sort((left, right) => left.name.localeCompare(right.name)));
}

function readPiExtensionCommandNames(value: unknown): ReadonlySet<string> {
  const commands = isRecord(value) && Array.isArray(value.commands) ? value.commands : [];
  const names = new Set<string>();
  for (const command of commands) {
    if (!isRecord(command) || command.source !== 'extension') continue;
    const advertisedName = readString(command.name);
    if (!advertisedName) continue;
    const invocationName = advertisedName.startsWith('/') ? advertisedName.slice(1) : advertisedName;
    if (invocationName.length > 0) names.add(invocationName);
  }
  return names;
}

function readLeadingPiExtensionCommandName(prompt: string): string | null {
  if (!prompt.startsWith('/')) return null;
  const spaceIndex = prompt.indexOf(' ');
  const name = spaceIndex === -1 ? prompt.slice(1) : prompt.slice(1, spaceIndex);
  return name.length > 0 ? name : null;
}

function normalizeEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function hasPiRequestAuthProvider(env: Readonly<Record<string, string | undefined>>): boolean {
  return readString(env[PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]) !== null
    || readPiConnectedServiceIdFromEnv(env) !== null;
}

function assertPiRequestAuthRuntimeConfigured(env: Readonly<Record<string, string | undefined>>): void {
  if (
    readString(env.PI_CODING_AGENT_DIR) === null
    || readString(env[PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]) === null
  ) {
    throw new Error('Pi request-auth runtime requires the agent dir and child endpoint capability');
  }
}

async function requireSupportedPiRequestAuthVersion(
  params: PiRuntimeOperationsParams,
  executable: ManagedExecutableRef,
): Promise<string> {
  let output = '';
  try {
    const result = await params.services.exec.run({
      executable,
      args: ['--version'],
      cwd: { root: 'workspace', relativePath: '' },
      timeoutMs: PI_VERSION_PROBE_TIMEOUT_MS,
      maxStdoutBytes: 8 * 1024,
      maxStderrBytes: 8 * 1024,
    });
    if (result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0) {
      const decode = new TextDecoder();
      output = `${decode.decode(result.stdout)}\n${decode.decode(result.stderr)}`;
    }
  } catch {
    // The compatibility resolver below turns an unavailable/unreadable probe into a typed refusal.
  }
  const compatibility = resolvePiRequestAuthCompatibility(output);
  if (!compatibility.supported) {
    throw new PiRequestAuthCompatibilityError(compatibility);
  }
  return compatibility.version;
}

function readSessionIdFromState(value: unknown): string | null {
  return isRecord(value) ? readString(value.sessionId) : null;
}

function readTimeoutMs(opts: Readonly<Record<string, unknown>> | undefined): number | null {
  const value = opts?.timeoutMs ?? opts?.timeout;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function createCompletion(): PendingCompletion {
  let resolveCompletion: (() => void) | undefined;
  let rejectCompletion: ((error: Error) => void) | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    resolveCompletion = resolve;
    rejectCompletion = reject;
  });
  promise.catch(() => undefined);
  return {
    promise,
    resolve() {
      resolveCompletion?.();
    },
    reject(error: Error) {
      rejectCompletion?.(error);
    },
  };
}

async function withTimeout(promise: Promise<void>, opts: Readonly<Record<string, unknown>> | undefined): Promise<void> {
  const timeoutMs = readTimeoutMs(opts);
  if (timeoutMs === null) {
    await promise;
    return;
  }
  const result = await raceWithTimeout(promise, timeoutMs);
  switch (result.type) {
    case 'resolved':
      return;
    case 'rejected':
      throw result.error;
    case 'timeout':
      throw new Error(`Pi turn completion timed out after ${timeoutMs}ms`);
  }
}

function createPiExecSpec(
  params: PiRuntimeOperationsParams,
  executable: ManagedExecutableRef,
) {
  const thinkingLevel = resolvePiThinkingLevelFromEnv(params.env);
  return {
    kind: 'jsonStream' as const,
    launch: {
      executable,
      args: buildPiRpcArgs({
        permissionMode: params.permissionMode,
        thinkingLevel,
        resumeSessionId: params.resumeSessionId,
        connectedServiceId: readPiConnectedServiceIdFromEnv(params.env),
        env: params.env,
        happierToolsExtension: params.happierToolsExtension,
      }),
      cwd: { root: 'workspace' as const, relativePath: '' },
      env: {
        ...params.env,
        ...(thinkingLevel ? { [PI_THINKING_LEVEL_ENV]: thinkingLevel } : {}),
        NODE_ENV: 'production',
        DEBUG: '',
        CI: '1',
      },
      ...(params.unsetEnvKeys && params.unsetEnvKeys.length > 0
        ? { unsetEnvKeys: params.unsetEnvKeys }
        : {}),
    },
    maxFrameBytes: 16 * 1024 * 1024,
  };
}

function createRuntimeOperations(params: Readonly<{
  rpc: PiJsonStreamRpcClient;
  logger: PluginLoggerService;
  sessionId: string;
  initialSessionId: string | null;
  subscribeRuntimeEvents: (handler: RuntimeEventHandler) => () => void;
  publishRuntimeEvent: RuntimeEventPublisher;
  isProviderNativeCommand: (prompt: string) => boolean;
  refreshModels?: () => void;
  observeUsage?: (turnId: string | null) => void;
  cancelBlockingExtensionUiRequests: () => Promise<void>;
}>): RuntimeOperationsWithRecordHandler {
  const runtimeEventProjector = createPiRuntimeEventProjector();
  let sessionId = params.initialSessionId;
  let activeTurn: ActiveTurnState | null = null;
  let activeTurnStartObserved = false;
  let activeTurnAssistantMessageObserved = false;
  let activeTurnProviderFailure: PiProviderFailureDiagnostic | null = null;
  let retryingTurnProviderFailure: PiProviderFailureDiagnostic | null = null;
  let replayingPromptAckFailureRecords = false;
  let settledTurnFailure: Error | null = null;
  let pendingCompletion: PendingCompletion | null = null;
  let disposalStarted = false;
  let unexpectedExitPublished = false;
  let publishedProviderSessionId: string | null = null;
  let pendingPromptAdmission: PendingPromptAdmission | null = null;
  let pendingCancellation: PendingCancellation | null = null;

  function beginTurn(
    agentTurnId: string | null = null,
    turnId: string = randomUUID(),
    startedBy: 'host' | 'provider' = 'provider',
  ): ActiveTurnState {
    runtimeEventProjector.resetTurn();
    const turn = Object.freeze({
      turnId,
      agentTurnId,
    });
    activeTurn = turn;
    activeTurnStartObserved = false;
    activeTurnAssistantMessageObserved = false;
    activeTurnProviderFailure = null;
    retryingTurnProviderFailure = null;
    settledTurnFailure = null;
    pendingCompletion = createCompletion();
    params.publishRuntimeEvent({
        kind: 'turn-start',
        sessionId: params.sessionId,
        emittedAtMs: Date.now(),
        turnId: turn.turnId,
        ...(agentTurnId ? { agentTurnId } : {}),
        startedBy,
      });
    return turn;
  }

  function clearActiveTurn(): void {
    activeTurn = null;
    activeTurnStartObserved = false;
    activeTurnAssistantMessageObserved = false;
    activeTurnProviderFailure = null;
    retryingTurnProviderFailure = null;
    pendingCompletion = null;
    runtimeEventProjector.resetTurn();
  }

  function rejectActiveTurn(error: Error): void {
    pendingCompletion?.reject(error);
    clearActiveTurn();
  }

  function readOrBeginTurn(
    agentTurnId: string | null = null,
    turnId?: string,
    startedBy: 'host' | 'provider' = 'provider',
  ): ActiveTurnState {
    if (!activeTurn) return beginTurn(agentTurnId, turnId, startedBy);
    if (agentTurnId && activeTurn.agentTurnId !== agentTurnId) {
      activeTurn = Object.freeze({
        turnId: activeTurn.turnId,
        agentTurnId,
      });
      params.publishRuntimeEvent({
          kind: 'turn-agent-id-observed',
          sessionId: params.sessionId,
          emittedAtMs: Date.now(),
          turnId: activeTurn.turnId,
          agentTurnId,
        });
    }
    return activeTurn;
  }

  function settleTurnFailedForEmptyResponse(
    turn: ActiveTurnState,
    agentTurnId: string | null,
    completion: PendingCompletion | null,
  ): boolean {
    const providerFailure = activeTurnProviderFailure;
    if (activeTurnAssistantMessageObserved && !providerFailure) return false;
    const emittedAtMs = Date.now();
    settledTurnFailure = new Error(providerFailure?.sanitizedPreview
      ?? 'Pi completed the turn without returning an assistant message. Check provider credentials, model availability, and Pi logs.');
    params.publishRuntimeEvent({
      kind: 'turn-failed',
      sessionId: params.sessionId,
      emittedAtMs,
      turnId: turn.turnId,
      ...(agentTurnId ? { agentTurnId } : {}),
      diagnostic: diagnostic(
        providerFailure?.code ?? 'pi_empty_provider_response',
        providerFailure?.sanitizedPreview
          ?? 'Pi completed the turn without returning an assistant message. Check provider credentials, model availability, and Pi logs.',
      ),
    });
    if (providerFailure) {
      params.logger.warn('[PiRuntime] Provider turn failed', {
        classification: providerFailure.classification,
        providerCode: providerFailure.code,
        sanitizedPreview: providerFailure.sanitizedPreview,
      });
    }
    clearActiveTurn();
    completion?.resolve();
    return true;
  }

  function settleTurnComplete(agentTurnId: string | null = null): void {
    const turn = activeTurn;
    if (!turn) return;
    const terminalProviderTurnId = agentTurnId ?? turn.agentTurnId;
    const completion = pendingCompletion;
    if (settleTurnFailedForEmptyResponse(turn, terminalProviderTurnId, completion)) {
      return;
    }
    params.publishRuntimeEvent({
        kind: 'turn-complete',
        sessionId: params.sessionId,
        emittedAtMs: Date.now(),
        turnId: turn.turnId,
        ...(terminalProviderTurnId ? { agentTurnId: terminalProviderTurnId } : {}),
      });
    settledTurnFailure = null;
    clearActiveTurn();
    completion?.resolve();
  }

  function settleProviderNativeCommandWithoutAgentTurn(): void {
    const turn = activeTurn;
    if (!turn) return;
    const completion = pendingCompletion;
    params.publishRuntimeEvent({
      kind: 'turn-complete',
      sessionId: params.sessionId,
      emittedAtMs: Date.now(),
      turnId: turn.turnId,
      ...(turn.agentTurnId ? { agentTurnId: turn.agentTurnId } : {}),
    });
    settledTurnFailure = null;
    clearActiveTurn();
    completion?.resolve();
  }

  function settleTurnCancelled(
    turnId: string,
    reason: PendingCancellation['reason'],
  ): void {
    const turn = activeTurn;
    if (!turn || turn.turnId !== turnId) return;
    const completion = pendingCompletion;
    const providerFailure = activeTurnProviderFailure ?? retryingTurnProviderFailure;
    params.publishRuntimeEvent({
      kind: 'turn-cancelled',
      sessionId: params.sessionId,
      emittedAtMs: Date.now(),
      turnId: turn.turnId,
      ...(turn.agentTurnId ? { agentTurnId: turn.agentTurnId } : {}),
      cause: reason,
      ...(providerFailure
        ? {
          diagnostic: diagnostic(
            providerFailure.code,
            providerFailure.sanitizedPreview,
          ),
        }
        : {}),
    });
    settledTurnFailure = null;
    clearActiveTurn();
    completion?.resolve();
  }

  function handleRuntimeRecordNow(record: Readonly<Record<string, unknown>>): void {
    const type = readPiRuntimeRecordType(record);
    const agentTurnId = readPiProviderTurnId(record);
    if (type === 'turn_start' || type === 'agent_start') {
      readOrBeginTurn(agentTurnId);
      activeTurnStartObserved = true;
      return;
    }
    const turn = activeTurn;
    const providerFailure = readPiProviderFailureDiagnostic(record);
    if (
      providerFailure
      && !activeTurnProviderFailure
      && (!replayingPromptAckFailureRecords || activeTurnStartObserved || activeTurnAssistantMessageObserved)
    ) {
      activeTurnProviderFailure = providerFailure;
      retryingTurnProviderFailure = null;
    }
    const projectedEvents = runtimeEventProjector.project(record, {
      sessionId: params.sessionId,
      turnId: turn?.turnId ?? null,
      agentSessionId: sessionId,
      nowMs: () => Date.now(),
    });
    if (projectedEvents.some((event) => event.kind === 'message-delta')) {
      activeTurnAssistantMessageObserved = true;
    }
    for (const event of projectedEvents) {
      params.publishRuntimeEvent(event);
    }
    if (projectedEvents.some((event) => (
      event.kind === 'context-compaction' && event.phase === 'completed'
    ))) {
      params.observeUsage?.(turn?.turnId ?? null);
    }
    if (
      replayingPromptAckFailureRecords
      && !activeTurnStartObserved
      && !activeTurnAssistantMessageObserved
      && (type === 'turn_end' || type === 'agent_end')
    ) {
      return;
    }
    if (type === 'turn_end') {
      if (agentTurnId) readOrBeginTurn(agentTurnId);
      return;
    }
    const agentEndBoundary = classifyPiAgentEndBoundary(record);
    if (agentEndBoundary === 'retrying') {
      retryingTurnProviderFailure = activeTurnProviderFailure;
      activeTurnProviderFailure = null;
      return;
    }
    if (type === 'auto_retry_end' && record.success === false) {
      activeTurnProviderFailure ??= retryingTurnProviderFailure;
      if (turn && pendingCancellation?.turnId === turn.turnId) {
        pendingCancellation.finalBoundaryObserved = true;
        pendingCancellation.finalBoundaryAgentTurnId =
          agentTurnId ?? turn.agentTurnId;
        return;
      }
      settleTurnComplete(activeTurn?.agentTurnId ?? null);
      return;
    }
    if (agentEndBoundary === 'final') {
      params.observeUsage?.(turn?.turnId ?? null);
      if (turn && pendingCancellation?.turnId === turn.turnId) {
        pendingCancellation.finalBoundaryObserved = true;
        pendingCancellation.finalBoundaryAgentTurnId = agentTurnId ?? turn.agentTurnId;
        return;
      }
      settleTurnComplete(activeTurn?.agentTurnId ?? null);
    }
  }

  function handleProcessExit(
    result: Parameters<Parameters<PiJsonStreamRpcClient['onExit']>[0]>[0],
  ): void {
    if (disposalStarted || unexpectedExitPublished) return;
    unexpectedExitPublished = true;
    const failure = result.error;
    const turn = activeTurn;
    const completion = pendingCompletion;
    if (turn) {
      const emittedAtMs = Date.now();
      params.publishRuntimeEvent({
        kind: 'turn-failed',
        sessionId: params.sessionId,
        emittedAtMs,
        turnId: turn.turnId,
        ...(turn.agentTurnId ? { agentTurnId: turn.agentTurnId } : {}),
        diagnostic: diagnostic('pi_rpc_unexpected_exit', failure.message),
      });
    }
    settledTurnFailure = failure;
    clearActiveTurn();
    completion?.reject(failure);
    params.publishRuntimeEvent({
        kind: 'runtime-ended',
        sessionId: params.sessionId,
        emittedAtMs: Date.now(),
        cause: 'processExited',
        retryable: true,
        diagnostic: diagnostic('pi_rpc_unexpected_exit', failure.message),
      });
  }

  return {
    beginTurnLifecycle(turnId) {
      beginTurn(null, turnId);
    },
    async openSession(opts?: Readonly<Record<string, unknown>>): Promise<string | null> {
      const requestedResumeId = readString(opts?.resumeId) ?? readString(opts?.providerSessionId);
      if (sessionId) {
        if (requestedResumeId && requestedResumeId !== sessionId) {
          throw new Error(`Pi session mismatch (expected ${requestedResumeId}, got ${sessionId})`);
        }
        if (publishedProviderSessionId !== sessionId) {
          publishedProviderSessionId = sessionId;
          params.publishRuntimeEvent({
            kind: 'provider-session-id',
            sessionId: params.sessionId,
            emittedAtMs: Date.now(),
            providerSessionId: sessionId,
          });
        }
        params.refreshModels?.();
        return sessionId;
      }
      const stateBefore = await params.rpc.send({ type: 'get_state' }, 30_000);
      sessionId = readSessionIdFromState(stateBefore.data);
      if (!sessionId && !requestedResumeId) {
        await params.rpc.send({ type: 'new_session' }, 60_000);
        const stateAfter = await params.rpc.send({ type: 'get_state' }, 30_000);
        sessionId = readSessionIdFromState(stateAfter.data);
      }
      if (!sessionId && requestedResumeId) {
        sessionId = requestedResumeId;
      }
      if (!sessionId) {
        throw new Error('Pi did not return a session id');
      }
      if (publishedProviderSessionId !== sessionId) {
        publishedProviderSessionId = sessionId;
        params.publishRuntimeEvent({
          kind: 'provider-session-id',
          sessionId: params.sessionId,
          emittedAtMs: Date.now(),
          providerSessionId: sessionId,
        });
      }
      params.refreshModels?.();
      return sessionId;
    },
    async sendTurnPrompt(
      prompt: string,
      turnId: string,
      delivery?: 'followUp',
      onAccepted: () => void = () => undefined,
    ): Promise<void> {
      if (pendingPromptAdmission) {
        throw new Error('Pi prompt admission is already in progress');
      }
      const admission: PendingPromptAdmission = {
        turnId,
        onAccepted,
        bufferedRecords: createAgentSessionPreAdmissionBuffer(),
        bufferFailure: null,
      };
      pendingPromptAdmission = admission;
      const providerNativeCommand = params.isProviderNativeCommand(prompt);
      const accept = () => {
        admission.onAccepted();
        readOrBeginTurn(null, admission.turnId, 'host');
      };
      const replayBufferedRecords = () => {
        const records = admission.bufferedRecords.drain();
        for (const record of records) handleRuntimeRecordNow(record);
      };
      try {
        await params.rpc.send({
          type: 'prompt',
          message: prompt,
          ...(delivery ? { streamingBehavior: delivery } : {}),
        }, 30_000);
        accept();
        if (admission.bufferFailure !== null) {
          const failure = admission.bufferFailure;
          throw new Error(
            `Pi pre-admission record buffer rejected a record (${failure.status}${failure.status === 'overflow' ? `:${failure.reason}` : ''})`,
          );
        }
        pendingPromptAdmission = null;
        replayBufferedRecords();
        admission.bufferedRecords.dispose();
        if (providerNativeCommand && activeTurn && !activeTurnStartObserved) {
          const state = await params.rpc.send({ type: 'get_state' }, 30_000)
            .then((response) => isRecord(response.data) ? response.data as PiRpcStateData : null)
            .catch(() => null);
          if (
            activeTurn
            && !activeTurnStartObserved
            && state?.isStreaming !== true
            && state?.isCompacting !== true
          ) {
            settleProviderNativeCommandWithoutAgentTurn();
          }
        }
      } catch (error) {
        const promptError = error instanceof Error ? error : new Error(String(error));
        if (admission.bufferFailure !== null) {
          admission.bufferedRecords.dispose();
          pendingPromptAdmission = null;
          const submissionError = classifyPiRpcSubmissionFailure(promptError);
          rejectActiveTurn(submissionError);
          throw submissionError;
        }
        replayingPromptAckFailureRecords = true;
        try {
          // Pi stream events do not echo the prompt request ID, so replay them for output/lifecycle
          // visibility without treating unrelated activity as acceptance evidence for this prompt.
          const records = admission.bufferedRecords.drain();
          for (const record of records) handleRuntimeRecordNow(record);
        } finally {
          replayingPromptAckFailureRecords = false;
          admission.bufferedRecords.dispose();
        }
        pendingPromptAdmission = null;
        const submissionError = classifyPiRpcSubmissionFailure(promptError);
        rejectActiveTurn(submissionError);
        throw submissionError;
      }
    },
    async steerInFlightTurn(message: string): Promise<void> {
      if (pendingPromptAdmission) {
        throw new Error('Pi prompt admission is already in progress');
      }
      try {
        await params.rpc.send({ type: 'prompt', message, streamingBehavior: 'steer' }, 30_000);
      } catch (error) {
        const promptError = error instanceof Error ? error : new Error(String(error));
        throw classifyPiRpcSubmissionFailure(promptError);
      }
    },
    async waitForTurnCompletion(opts?: Readonly<Record<string, unknown>>): Promise<void> {
      const completion = pendingCompletion;
      if (!completion) return;
      await withTimeout(completion.promise, opts);
    },
    subscribeRuntimeEvents(handler: RuntimeEventHandler): () => void {
      return params.subscribeRuntimeEvents(handler);
    },
    async cancelTurn(turnId, reason): Promise<void> {
      if (pendingCancellation) {
        throw new Error('Pi cancellation is already in progress');
      }
      const cancellation: PendingCancellation | null = activeTurn?.turnId === turnId
        ? {
          turnId,
          reason,
          finalBoundaryObserved: false,
          finalBoundaryAgentTurnId: null,
        }
        : null;
      pendingCancellation = cancellation;
      try {
        await params.cancelBlockingExtensionUiRequests();
        await params.rpc.send({ type: 'abort' }, 30_000);
      } catch (error) {
        if (pendingCancellation === cancellation) pendingCancellation = null;
        if (isPiRpcClientDisposedError(error)) return;
        if (
          cancellation?.finalBoundaryObserved
          && activeTurn?.turnId === cancellation.turnId
        ) {
          settleTurnComplete(cancellation.finalBoundaryAgentTurnId);
        }
        throw error;
      }
      if (pendingCancellation === cancellation) pendingCancellation = null;
      if (cancellation) settleTurnCancelled(cancellation.turnId, cancellation.reason);
    },
    readSessionIdentity() {
      return { sessionId };
    },
    async updateSessionRuntimeConfig(update): Promise<readonly string[]> {
      const changed: string[] = [];
      const modelId = readString(update.model.value);
      if (modelId) {
        const [provider, ...modelParts] = modelId.split('/');
        await params.rpc.send({
          type: 'set_model',
          provider: modelParts.length > 0 ? provider : 'default',
          modelId: modelParts.length > 0 ? modelParts.join('/') : modelId,
        }, 30_000);
        changed.push('model');
      }
      const reasoning = update.options.reasoning_effort ?? update.options.piThinkingLevel;
      const level = readString(reasoning?.value);
      if (level) {
        await params.rpc.send({ type: 'set_thinking_level', level }, 30_000);
        changed.push('options');
      }
      params.refreshModels?.();
      return changed;
    },
    async compactContext(request): Promise<void> {
      runtimeEventProjector.expectHostCompaction(request);
      try {
        await params.rpc.send({
          type: 'compact',
          ...(request.instructions ? { customInstructions: request.instructions } : {}),
        }, 60_000);
      } catch (error) {
        runtimeEventProjector.clearExpectedHostCompaction(request.compactionId);
        throw error;
      }
    },
    publishRuntimeEvent(event) {
      params.publishRuntimeEvent(event);
    },
    async resetOrDisposeRuntime(): Promise<void> {
      disposalStarted = true;
      await params.cancelBlockingExtensionUiRequests();
      pendingPromptAdmission?.bufferedRecords.dispose();
      pendingPromptAdmission = null;
      pendingCancellation = null;
      pendingCompletion?.reject(new Error('Pi runtime disposed'));
      clearActiveTurn();
      settledTurnFailure = null;
      await params.rpc.dispose();
    },
    handleRuntimeRecord(record) {
      const admission = pendingPromptAdmission;
      if (!admission) {
        handleRuntimeRecordNow(record);
        return;
      }
      const result = admission.bufferedRecords.admit(record);
      if (result.status !== 'accepted' && admission.bufferFailure === null) {
        admission.bufferFailure = result;
        admission.bufferedRecords.dispose();
      }
    },
    handleProcessExit,
  };
}

export type PiSessionRuntime = AgentSessionRuntime;

function createPiSessionRuntime(params: Readonly<{
  operations: PiRuntimeTurnOperations;
  logger: PluginLoggerService;
  sessionId: string;
  resumeSessionId: string | null;
  clearSubscribers: () => void;
}>): PiSessionRuntime {
  let disposed = false;
  let activeCompactionId: string | null = null;
  const compactionSubscription = params.operations.subscribeRuntimeEvents((event) => {
    if (
      event.kind === 'context-compaction'
      && event.compactionId === activeCompactionId
      && ['completed', 'failed', 'cancelled', 'outcomeUnknown'].includes(event.phase)
    ) {
      activeCompactionId = null;
    }
  });

  const publishInputRejected = (request: AgentSessionSendRequest, reason: PluginDiagnosticData): void => {
    params.operations.publishRuntimeEvent({
      kind: 'input-rejected',
      sessionId: params.sessionId,
      emittedAtMs: Date.now(),
      inputIds: request.inputIds,
      diagnostic: reason,
      retryable: false,
    });
  };

  const publishInputAccepted = (request: AgentSessionSendRequest): void => {
    params.operations.publishRuntimeEvent({
      kind: 'input-accepted',
      sessionId: params.sessionId,
      emittedAtMs: Date.now(),
      inputIds: request.inputIds,
      delivery: request.delivery,
    });
  };

  const publishInputCustodyUnknown = (request: AgentSessionSendRequest, issue: PluginDiagnosticData): void => {
    params.operations.publishRuntimeEvent({
      kind: 'input-custody-unknown',
      sessionId: params.sessionId,
      emittedAtMs: Date.now(),
      inputIds: request.inputIds,
      issue,
    });
  };

  const publishInputDeliveryFailed = (request: AgentSessionSendRequest, issue: PluginDiagnosticData): void => {
    if (request.delivery.kind === 'steer') {
      params.operations.publishRuntimeEvent({
        kind: 'input-custody-unknown',
        sessionId: params.sessionId,
        emittedAtMs: Date.now(),
        inputIds: request.inputIds,
        issue,
      });
      return;
    }
    params.operations.publishRuntimeEvent({
      kind: 'input-delivery-failed',
      sessionId: params.sessionId,
      emittedAtMs: Date.now(),
      inputIds: request.inputIds,
      delivery: request.delivery,
      issue,
      duplicateRisk: 'unknown',
    });
  };

  return {
    async send(request, options) {
      const prompt = readString(request.input.text);
      if (!prompt) {
        const reason = diagnostic('pi_input_missing_text', 'Pi runtime input did not include text');
        publishInputRejected(request, reason);
        return { status: 'rejected', diagnostic: reason, retryable: false };
      }
      if (options?.signal?.aborted === true) {
        const reason = diagnostic('pi_input_aborted', 'Pi runtime input was aborted before delivery');
        publishInputRejected(request, reason);
        return { status: 'rejected', diagnostic: reason, retryable: false };
      }
      let accepted = false;
      try {
        await params.operations.openSession(
          params.resumeSessionId ? { resumeId: params.resumeSessionId } : undefined,
        );
        if (request.delivery.kind === 'steer') {
          await params.operations.steerInFlightTurn(prompt);
          publishInputAccepted(request);
          accepted = true;
        } else {
          await params.operations.sendTurnPrompt(
            prompt,
            request.delivery.turnId,
            request.delivery.kind === 'followUp' ? 'followUp' : undefined,
            () => {
              publishInputAccepted(request);
              accepted = true;
            },
          );
        }
        return { status: 'admitted' };
      } catch (error) {
        const outcomeUnknown = error instanceof PiRpcSubmissionOutcomeUnknownError;
        const providerFailure = error instanceof PiRpcNegativeAcknowledgementError
          ? readPiPromptRejectionDiagnostic(error)
          : null;
        if (providerFailure) {
          params.logger.warn('[PiRuntime] Provider prompt rejected', {
            classification: providerFailure.classification,
            providerCode: providerFailure.code,
            sanitizedPreview: providerFailure.sanitizedPreview,
          });
        }
        const reason = providerFailure
          ? diagnostic(providerFailure.code, providerFailure.sanitizedPreview)
          : diagnostic(
            outcomeUnknown ? 'pi_input_outcome_unknown' : 'pi_input_rejected',
            error instanceof Error ? error.message : String(error),
          );
        if (accepted) publishInputDeliveryFailed(request, reason);
        else if (outcomeUnknown) publishInputCustodyUnknown(request, reason);
        else publishInputRejected(request, reason);
        return { status: 'rejected', diagnostic: reason, retryable: false };
      }
    },
    async cancel(request, options) {
      if (options?.signal?.aborted) {
        return { status: 'unavailable', diagnostic: diagnostic('pi_cancel_aborted', 'Pi cancellation was aborted') };
      }
      try {
        await params.operations.cancelTurn(request.turnId, request.reason);
        return { status: 'requested', turnId: request.turnId };
      } catch (error) {
        return {
          status: 'unavailable',
          diagnostic: diagnostic('pi_cancel_failed', error instanceof Error ? error.message : String(error)),
        };
      }
    },
    async updateConfiguration(update, options) {
      if (options?.signal?.aborted) {
        return { status: 'unavailable', diagnostic: diagnostic('pi_configuration_aborted', 'Pi configuration update was aborted') };
      }
      try {
        return { status: 'applied', changed: await params.operations.updateSessionRuntimeConfig(update) };
      } catch (error) {
        return {
          status: 'rejected',
          diagnostic: diagnostic('pi_configuration_failed', error instanceof Error ? error.message : String(error)),
        };
      }
    },
    async compact(request, options) {
      if (options?.signal?.aborted) {
        return { status: 'rejected', diagnostic: diagnostic('pi_compaction_aborted', 'Pi compaction was aborted'), retryable: false };
      }
      if (activeCompactionId) {
        return { status: 'rejected', diagnostic: diagnostic('pi_compaction_in_progress', 'Pi compaction is already running'), retryable: true };
      }
      activeCompactionId = request.compactionId;
      try {
        await params.operations.compactContext(request);
        return { status: 'admitted' };
      } catch (error) {
        activeCompactionId = null;
        return {
          status: 'rejected',
          diagnostic: diagnostic('pi_compaction_failed', error instanceof Error ? error.message : String(error)),
          retryable: true,
        };
      }
    },
    watch(listener) {
      const unsubscribe = params.operations.subscribeRuntimeEvents(listener);
      return { dispose: unsubscribe };
    },
    dispose: async () => {
      if (disposed) return;
      disposed = true;
      compactionSubscription();
      params.clearSubscribers();
      await params.operations.resetOrDisposeRuntime();
    },
  };
}

export async function createPiRuntimeOperations(params: PiRuntimeOperationsParams): Promise<PiSessionRuntime> {
  const normalizedEnv = normalizeEnv(params.env);
  const requestAuthEnabled = hasPiRequestAuthProvider(normalizedEnv);
  if (requestAuthEnabled) {
    assertPiRequestAuthRuntimeConfigured(normalizedEnv);
  }
  let requestAuthProducerVersion: string | null = null;
  const resolved = await params.services.exec.systemTools.resolve({
    toolId: 'pi-cli',
    purpose: 'Run the Pi RPC runtime',
    cwd: params.cwd,
  });
  const executable = resolved.executable;
  if (requestAuthEnabled) {
    requestAuthProducerVersion = await requireSupportedPiRequestAuthVersion(params, executable);
  }
  const handle = await params.services.exec.clients.spawn(createPiExecSpec({
    ...params,
    env: {
      ...normalizedEnv,
      ...(requestAuthProducerVersion
        ? { [PI_REQUEST_AUTH_PRODUCER_VERSION_ENV]: requestAuthProducerVersion }
        : {}),
    },
  }, executable));
  const subscribers = new Set<RuntimeEventHandler>();
  let retainedAvailableCommandsEvent: AgentSessionRuntimeEvent | null = null;
  let malformedRuntimeEventPublished = false;
  let terminalRuntimeEventPublished = false;
  let sequence = 0;
  const publishParsedRuntimeEvent = (event: AgentSessionRuntimeEvent): void => {
    if (terminalRuntimeEventPublished) return;
    if (event.kind === 'available-commands') retainedAvailableCommandsEvent = event;
    for (const subscriber of subscribers) {
      subscriber(event);
    }
    if (event.kind === 'runtime-ended') terminalRuntimeEventPublished = true;
  };
  const publishMalformedRuntimeEventDiagnostic = (
    event: unknown,
    issues: ReadonlyArray<Readonly<{ message: string }>>,
  ): void => {
    params.logger.warn('[PiRuntime] rejected malformed AgentSessionRuntimeEvent payload');
    if (malformedRuntimeEventPublished) return;
    malformedRuntimeEventPublished = true;
    const eventKind = isRecord(event) && typeof event.kind === 'string' ? event.kind : null;
    const parsedDiagnostic = AgentSessionRuntimeEventSchema.safeParse({
      sequence: sequence + 1,
      kind: 'runtime-ended',
      sessionId: params.sessionId,
      emittedAtMs: Math.max(0, Math.trunc(Date.now())),
      cause: 'protocolError',
      retryable: true,
      diagnostic: {
        code: 'malformed_runtime_event',
        severity: 'error',
        message: 'Pi emitted a malformed native runtime event',
        details: {
          eventKind,
          issues: issues.slice(0, 5).map((issue) => ({
            message: issue.message,
          })),
        },
      },
    });
    if (parsedDiagnostic.success) {
      sequence += 1;
      publishParsedRuntimeEvent(parsedDiagnostic.data);
    }
  };
  const publishRuntimeEvent: RuntimeEventPublisher = (event): void => {
    const parsed = AgentSessionRuntimeEventSchema.safeParse(
      isRecord(event) ? { ...event, sequence: sequence + 1 } : event,
    );
    if (parsed.success) {
      sequence += 1;
      publishParsedRuntimeEvent(parsed.data);
      return;
    }
    publishMalformedRuntimeEventDiagnostic(event, parsed.error.issues);
  };
  let operations: RuntimeOperationsWithRecordHandler | null = null;
  let usageObservationSequence = 0;
  let usageObservationChain = Promise.resolve();
  const blockingExtensionUiRequests = new Map<string, Readonly<{
    controller: AbortController;
    task: Promise<void>;
  }>>();
  let rpc: PiJsonStreamRpcClient;
  const cancelBlockingExtensionUiRequests = async (): Promise<void> => {
    const active = [...blockingExtensionUiRequests.values()];
    for (const request of active) request.controller.abort();
    await Promise.allSettled(active.map((request) => request.task));
  };
  const handleBlockingExtensionUiRequest = (request: PiBlockingExtensionUiRequest): void => {
    if (blockingExtensionUiRequests.has(request.id)) return;
    const controller = new AbortController();
    const task = (async (): Promise<void> => {
      let result: unknown;
      try {
        result = await params.services.interactions.askQuestions(
          buildPiExtensionUiQuestionRequest(request),
          { signal: controller.signal },
        );
      } catch (error) {
        if (!controller.signal.aborted) {
          params.logger.warn('[PiRuntime] Extension dialog interaction failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      try {
        await rpc.write(buildPiExtensionUiResponse(request, result));
      } catch (error) {
        params.logger.warn('[PiRuntime] Extension dialog response failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        blockingExtensionUiRequests.delete(request.id);
      }
    })();
    blockingExtensionUiRequests.set(request.id, { controller, task });
  };
  rpc = createPiJsonStreamRpcClient({
    handle,
    onEvent(record) {
      if (record.type === 'runtime_event') {
        publishRuntimeEvent(record.event);
        return;
      }
      const blockingExtensionUiRequest = parsePiBlockingExtensionUiRequest(record);
      if (blockingExtensionUiRequest) {
        handleBlockingExtensionUiRequest(blockingExtensionUiRequest);
        return;
      }
      operations?.handleRuntimeRecord(record);
    },
  });
  let availableCommands: readonly PiAvailableCommand[] = [];
  let availableExtensionCommandNames: ReadonlySet<string> = new Set();
  try {
    const response = await rpc.send({ type: 'get_commands' }, 30_000);
    availableCommands = normalizePiAvailableCommands(response.data);
    availableExtensionCommandNames = readPiExtensionCommandNames(response.data);
    publishRuntimeEvent({
      kind: 'available-commands',
      sessionId: params.sessionId,
      emittedAtMs: Date.now(),
      commands: availableCommands,
    });
  } catch (error) {
    params.logger.warn('[PiRuntime] Command catalog refresh failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const availableCommandNames = new Set(availableCommands.map((command) => command.name));
  const modelsSource = params.models
    ? createPiSessionModelsSource({
        readState: async () => (await rpc.send({ type: 'get_state' }, 30_000)).data,
        readAvailableModels: async () => (await rpc.send({ type: 'get_available_models' }, 30_000)).data,
        onError: (error) => {
          params.logger.warn('[PiRuntime] Model catalog refresh failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        },
      })
    : null;
  operations = createRuntimeOperations({
    rpc,
    logger: params.logger,
    sessionId: params.sessionId,
    initialSessionId: params.initialSessionId ?? null,
    subscribeRuntimeEvents(handler) {
      subscribers.add(handler);
      if (retainedAvailableCommandsEvent) handler(retainedAvailableCommandsEvent);
      return () => {
        subscribers.delete(handler);
      };
    },
    publishRuntimeEvent,
    isProviderNativeCommand(prompt) {
      const name = readLeadingPiExtensionCommandName(prompt);
      return name !== null && availableExtensionCommandNames.has(name);
    },
    observeUsage(turnId) {
      usageObservationChain = usageObservationChain.then(async () => {
        const response = await rpc.send({ type: 'get_session_stats' }, 30_000);
        const observedAtMs = Date.now();
        const event = projectPiSessionStatsUsage({
          stats: response.data,
          sessionId: params.sessionId,
          turnId,
          observationId: `pi-usage-${++usageObservationSequence}`,
          observedAtMs,
        });
        if (event) publishRuntimeEvent(event);
      }).catch((error) => {
        params.logger.warn('[PiRuntime] Session usage refresh failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    },
    cancelBlockingExtensionUiRequests,
    ...(modelsSource ? { refreshModels: () => { void modelsSource.refresh(); } } : {}),
  });
  let modelsBinding: ReturnType<AgentSessionModelsService['bind']> | null = null;
  try {
    modelsBinding = modelsSource && params.models ? params.models.bind(modelsSource) : null;
  } catch (error) {
    modelsSource?.dispose();
    await rpc.dispose();
    throw error;
  }
  const unsubscribeProcessExit = rpc.onExit((result) => {
    operations?.handleProcessExit(result);
  });
  if (params.eagerStart === true) {
    await operations.openSession(
      params.resumeSessionId ? { resumeId: params.resumeSessionId } : undefined,
    );
  }
  return createPiSessionRuntime({
    operations,
    logger: params.logger,
    sessionId: params.sessionId,
    resumeSessionId: readString(params.resumeSessionId),
    clearSubscribers: () => {
      modelsBinding?.dispose();
      modelsBinding = null;
      modelsSource?.dispose();
      unsubscribeProcessExit();
      subscribers.clear();
    },
  });
}
