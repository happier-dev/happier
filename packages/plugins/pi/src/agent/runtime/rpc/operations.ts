import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { createSecureTempDirectorySync, writeAtomicTextFile } from '@happier-dev/plugin-sdk/fs';
import { buildPiModelDiscoveryExtensionSource, parsePiModelDiscoveryRecord } from '../../models/discoveryExtension.js';

import type {
  AgentSessionCompactRequest,
  AgentSessionConfigurationSnapshot,
  AgentSessionRuntime,
  AgentSessionRuntimeEvent,
  AgentSessionSendRequest,
  AgentSessionModelsService,
  AgentSessionOpenRequest,
} from '@happier-dev/plugin-sdk/agents/runtime';
import { AgentSessionRuntimeEventSchema, resolvePromptCacheLastUseAtMs } from '@happier-dev/plugin-sdk/agents/runtime';
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
  SessionCapabilityNoticeV1Schema,
  type SessionCapabilityNoticeV1,
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
  buildPiProviderFailureLogEvidence,
  readPiProviderFailureDiagnostic,
  readPiPromptRejectionDiagnostic,
  type PiProviderFailureDiagnostic,
  type PiProviderFailureLogEvidence,
} from './providerFailureDiagnostic.js';
import {
  PiRequestAuthCompatibilityError,
  resolvePiRequestAuthCompatibility,
} from './requestAuthCompatibility.js';
import type { PiPermissionMode, PiRpcStateData } from './types.js';
import { resolvePiEffectiveLaunchPermissionPolicy } from './permissions.js';
import { createPiSessionModelsSource } from '../modelsSource.js';
import { projectPiSessionStatsUsage } from './usage.js';
import { AGENT_DEFINITION } from '../../definition.js';
import {
  buildPiExtensionUiQuestionRequest,
  buildPiExtensionUiResponse,
  parsePiBlockingExtensionUiRequest,
  parsePiExtensionUserInput,
  type PiBlockingExtensionUiRequest,
  type PiExtensionUiResponse,
} from './extensionUi.js';
import { PI_MCP_APPROVAL_CALL_PREFIX, PI_MCP_CAPABILITY_NOTICE_RECORD_TYPE } from '../../tools/extensionSource.js';
import { preparePiHappierToolsExtension, type PreparedPiHappierToolsExtension } from '../../tools/assets.js';

const PI_VERSION_PROBE_TIMEOUT_MS = 30_000;
// Session opening is one provider-lifecycle operation. Keep every RPC in that
// sequence under the same budget so an inner acknowledgement cannot abandon a
// valid cold start before the owning open operation is allowed to settle.
const PI_SESSION_OPEN_TIMEOUT_MS = 5 * 60_000;

class PiSessionOpenTimeoutError extends Error {
  constructor(phase: string) {
    super(`Pi session open timed out during ${phase} after ${PI_SESSION_OPEN_TIMEOUT_MS}ms`);
    this.name = 'PiSessionOpenTimeoutError';
  }
}

export type PiSessionOpenLifecycle = Readonly<{
  signal: AbortSignal;
  remainingMs(phase: string, maximumMs?: number): number;
  waitFor<T>(
    operation: Promise<T>,
    phase: string,
    disposeLateResult?: (value: T) => void | Promise<void>,
  ): Promise<T>;
  dispose(): void;
}>;

export function createPiSessionOpenLifecycle(params: Readonly<{
  signal?: AbortSignal;
  onLateCleanupError?: (error: unknown) => void;
}> = {}): PiSessionOpenLifecycle {
  const startedAtMs = Date.now();
  const controller = new AbortController();
  let currentPhase = 'session open';
  let timedOut = false;
  let disposed = false;
  const abortFromParent = () => controller.abort(params.signal?.reason);
  if (params.signal?.aborted) abortFromParent();
  else params.signal?.addEventListener('abort', abortFromParent, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new PiSessionOpenTimeoutError(currentPhase));
  }, PI_SESSION_OPEN_TIMEOUT_MS);
  timeout.unref?.();

  const readAbortError = (phase: string): Error => {
    if (timedOut) return new PiSessionOpenTimeoutError(phase);
    return controller.signal.reason instanceof Error
      ? controller.signal.reason
      : new Error(`Pi session open was cancelled during ${phase}`);
  };
  const remainingMs = (phase: string, maximumMs?: number): number => {
    currentPhase = phase;
    if (controller.signal.aborted) throw readAbortError(phase);
    const remaining = PI_SESSION_OPEN_TIMEOUT_MS - (Date.now() - startedAtMs);
    if (remaining <= 0) throw new PiSessionOpenTimeoutError(phase);
    return maximumMs === undefined ? remaining : Math.min(remaining, maximumMs);
  };
  return Object.freeze({
    signal: controller.signal,
    remainingMs,
    async waitFor<T>(operation: Promise<T>, phase: string, disposeLateResult?: (value: T) => void | Promise<void>) {
      remainingMs(phase);
      return await new Promise<T>((resolve, reject) => {
        let settled = false;
        const settle = (callback: () => void) => {
          if (settled) return false;
          settled = true;
          controller.signal.removeEventListener('abort', onAbort);
          callback();
          return true;
        };
        const onAbort = () => settle(() => reject(readAbortError(phase)));
        controller.signal.addEventListener('abort', onAbort, { once: true });
        if (controller.signal.aborted) onAbort();
        void operation.then(
          (value) => {
            if (settle(() => resolve(value))) return;
            if (!disposeLateResult) return;
            void Promise.resolve(disposeLateResult(value)).catch((error) => {
              params.onLateCleanupError?.(error);
            });
          },
          (error: unknown) => {
            settle(() => reject(error));
          },
        );
      });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timeout);
      params.signal?.removeEventListener('abort', abortFromParent);
    },
  });
}

type PiRuntimeOperationsParams = Readonly<{
  skills?: AgentSessionOpenRequest['skills'];
  services: Pick<PluginServices, 'exec'> & Readonly<{
    interactions: Pick<PluginServices['interactions'], 'askQuestions' | 'requestApproval'>;
  }>;
  models?: AgentSessionModelsService;
  logger: PluginLoggerService;
  cwd: string;
  env: Readonly<Record<string, string>>;
  unsetEnvKeys?: readonly string[];
  permissionMode?: PiPermissionMode;
  initialSessionId?: string | null;
  resumeSessionSelector?: string | null;
  resumeProviderSessionId?: string | null;
  sessionId: string;
  eagerStart?: boolean;
  sessionOpenLifecycle?: PiSessionOpenLifecycle;
  happierToolsExtension?: Readonly<{ extensionPath: string; configPath: string }>;
  mcpServersStrictMode?: boolean;
  publishCapabilityNotice?: (notice: SessionCapabilityNoticeV1) => Promise<void>;
}>;

type PiAvailableCommand = Readonly<{
  name: string;
  description?: string;
}>;

type PiConversationEventHandler = (event: PiRuntimeEvent) => void;
type RuntimeEventPublisher = (event: PiRuntimeEvent) => void;

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
  turnStartedAtMs: number;
  onAccepted: () => void;
  bufferedRecords: AgentSessionPreAdmissionBuffer<Readonly<{
    record: Readonly<Record<string, unknown>>;
    observedAtMs: number;
  }>>;
  bufferFailure: Exclude<AgentSessionPreAdmissionBufferResult, { status: 'accepted' }> | null;
  /**
   * Cancellation reason once an abort for this exact admission has been
   * acknowledged while the admission was still awaiting its own prompt
   * acknowledgement. A late prompt ACK then begins the turn only to settle it
   * cancelled; `null` leaves the ordinary admission flow untouched.
   */
  cancelledReason: PendingCancellation['reason'] | null;
};

type PendingCancellation = {
  turnId: string;
  reason: 'user' | 'hostShutdown' | 'sessionDispose' | 'runtimeRecovery';
  finalBoundaryObserved: boolean;
  finalBoundaryAgentTurnId: string | null;
};

type PiRuntimeTurnOperations = Readonly<{
  beginTurnLifecycle(turnId?: string): void;
  openSession(
    resume?: Readonly<{
      selector: string;
      providerSessionId: string;
    }>,
    lifecycle?: PiSessionOpenLifecycle,
  ): Promise<string | null>;
  sendTurnPrompt(
    prompt: string,
    turnId: string,
    delivery?: 'followUp',
    onAccepted?: () => void,
  ): Promise<void>;
  steerInFlightTurn(message: string): Promise<void>;
  waitForTurnCompletion(opts?: Readonly<Record<string, unknown>>): Promise<void>;
  subscribeRuntimeEvents(handler: PiConversationEventHandler, replayStartupEvents?: boolean): () => void;
  /**
   * Cancel the exact tracked Pi turn (active or in-flight admission). Returns
   * `false` without touching the Pi process when `turnId` does not identify
   * the tracked turn, so a stale or replayed cancel can never abort an
   * unrelated native turn.
   */
  cancelTurn(
    turnId: string,
    reason: PendingCancellation['reason'],
  ): Promise<boolean>;
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

/**
 * Request-auth is in play exactly when the host projected a child capability
 * for it.
 *
 * A connected-service SELECTION is not that signal. Pi takes an OpenAI or
 * Anthropic API key and a Claude setup-token DIRECTLY — the materializer writes
 * those into `auth.<provider>` and deliberately projects no capability — so
 * deriving the mode from the selection refused every direct-token connected
 * account before spawn. The materializer already fails closed when a purpose
 * that DOES require request-auth has no capability, so this reads the one fact
 * the runtime can see.
 */
function hasPiRequestAuthProvider(env: Readonly<Record<string, string | undefined>>): boolean {
  return readString(env[PI_REQUEST_AUTH_CAPABILITY_PATH_ENV]) !== null;
}

function assertPiRequestAuthRuntimeConfigured(env: Readonly<Record<string, string | undefined>>): void {
  if (readString(env.PI_CODING_AGENT_DIR) === null) {
    throw new Error('Pi request-auth runtime requires the agent dir and child endpoint capability');
  }
}

async function requireSupportedPiRequestAuthVersion(
  params: PiExecutionRunConversationParams,
  executable: ManagedExecutableRef,
  lifecycle?: PiSessionOpenLifecycle,
): Promise<string> {
  let output = '';
  try {
    const request = {
      executable,
      args: ['--version'],
      cwd: { root: 'workspace', relativePath: '' },
      timeoutMs: lifecycle?.remainingMs('request-auth version probe', PI_VERSION_PROBE_TIMEOUT_MS)
        ?? PI_VERSION_PROBE_TIMEOUT_MS,
      maxStdoutBytes: 8 * 1024,
      maxStderrBytes: 8 * 1024,
    } as const;
    const operation = params.services.exec.run(request, lifecycle ? { signal: lifecycle.signal } : undefined);
    const result = lifecycle
      ? await lifecycle.waitFor(operation, 'request-auth version probe')
      : await operation;
    if (result.termination.observed.kind === 'exit' && result.termination.observed.exitCode === 0) {
      const decode = new TextDecoder();
      output = `${decode.decode(result.stdout)}\n${decode.decode(result.stderr)}`;
    }
  } catch {
    lifecycle?.remainingMs('request-auth version probe');
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
  params: PiExecutionRunConversationParams,
  executable: ManagedExecutableRef,
  modelDiscoveryExtensionPath?: string,
) {
  const thinkingLevel = resolvePiThinkingLevelFromEnv(params.env);
  return {
    kind: 'jsonStream' as const,
    launch: {
      executable,
      args: buildPiRpcArgs({
        skillsRoot: params.skills?.skillsRoot,
        modelDiscoveryExtensionPath,
        permissionMode: params.permissionMode,
        thinkingLevel,
        resumeSessionId: params.resumeSessionSelector,
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
  initialSessionId: string | null;
  subscribeRuntimeEvents: (handler: PiConversationEventHandler, replayStartupEvents?: boolean) => () => void;
  publishRuntimeEvent: RuntimeEventPublisher;
  resolveProviderNativeCommand: (prompt: string) => Promise<boolean>;
  refreshCommands?: () => void;
  refreshModels?: () => void;
  observeUsage?: (turnId: string | null, promptCacheLastUseAtMs?: number) => void;
  cancelBlockingExtensionUiRequests: () => Promise<void>;
}>): RuntimeOperationsWithRecordHandler {
  const runtimeEventProjector = createPiRuntimeEventProjector();
  let sessionId = params.initialSessionId;
  let activeTurn: ActiveTurnState | null = null;
  let activeTurnStartObserved = false;
  let activeTurnAssistantMessageObserved = false;
  let turnStartedAtMs: number | undefined;
  let lastNonModelItemCompletedAtMs: number | undefined;
  type ProviderFailureObservation = Readonly<{
    diagnostic: PiProviderFailureDiagnostic;
    evidence: PiProviderFailureLogEvidence;
  }>;
  let activeTurnProviderFailure: ProviderFailureObservation | null = null;
  let retryingTurnProviderFailure: ProviderFailureObservation | null = null;
  let replayingPromptAckFailureRecords = false;
  let settledTurnFailure: Error | null = null;
  let pendingCompletion: PendingCompletion | null = null;
  let disposalStarted = false;
  let unexpectedExitPublished = false;
  let publishedProviderSessionId: string | null = null;
  let pendingPromptAdmission: PendingPromptAdmission | null = null;
  let pendingCancellation: PendingCancellation | null = null;
  let piCompactionInProgress = false;

  function beginTurn(
    agentTurnId: string | null = null,
    turnId: string = randomUUID(),
    startedBy: 'host' | 'provider' = 'provider',
    startedAtMs: number = Date.now(),
  ): ActiveTurnState {
    runtimeEventProjector.resetTurn();
    const turn = Object.freeze({
      turnId,
      agentTurnId,
    });
    activeTurn = turn;
    activeTurnStartObserved = false;
    activeTurnAssistantMessageObserved = false;
    turnStartedAtMs = startedAtMs;
    lastNonModelItemCompletedAtMs = undefined;
    activeTurnProviderFailure = null;
    retryingTurnProviderFailure = null;
    settledTurnFailure = null;
    pendingCompletion = createCompletion();
    params.publishRuntimeEvent({
        kind: 'turn-start',
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
    turnStartedAtMs = undefined;
    lastNonModelItemCompletedAtMs = undefined;
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
    startedAtMs?: number,
  ): ActiveTurnState {
    if (!activeTurn) return beginTurn(agentTurnId, turnId, startedBy, startedAtMs);
    if (agentTurnId && activeTurn.agentTurnId !== agentTurnId) {
      activeTurn = Object.freeze({
        turnId: activeTurn.turnId,
        agentTurnId,
      });
      params.publishRuntimeEvent({
          kind: 'turn-agent-id-observed',
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
    settledTurnFailure = new Error(providerFailure?.diagnostic.sanitizedPreview
      ?? 'Pi completed the turn without returning an assistant message. Check provider credentials, model availability, and Pi logs.');
    params.publishRuntimeEvent({
      kind: 'turn-failed',
      emittedAtMs,
      turnId: turn.turnId,
      ...(agentTurnId ? { agentTurnId } : {}),
      diagnostic: diagnostic(
        providerFailure?.diagnostic.code ?? 'pi_empty_provider_response',
        providerFailure?.diagnostic.sanitizedPreview
          ?? 'Pi completed the turn without returning an assistant message. Check provider credentials, model availability, and Pi logs.',
      ),
    });
    if (providerFailure) {
      params.logger.warn('[PiRuntime] Provider turn failed', {
        classification: providerFailure.diagnostic.classification,
        providerCode: providerFailure.diagnostic.code,
        retryable: providerFailure.diagnostic.piRetryable,
        failureRecord: providerFailure.evidence,
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
      emittedAtMs: Date.now(),
      turnId: turn.turnId,
      ...(turn.agentTurnId ? { agentTurnId: turn.agentTurnId } : {}),
      cause: reason,
      ...(providerFailure
        ? {
          diagnostic: diagnostic(
            providerFailure.diagnostic.code,
            providerFailure.diagnostic.sanitizedPreview,
          ),
        }
        : {}),
    });
    settledTurnFailure = null;
    clearActiveTurn();
    completion?.resolve();
  }

  function handleRuntimeRecordNow(record: Readonly<Record<string, unknown>>, observedAtMs: number): void {
    const type = readPiRuntimeRecordType(record);
    const agentTurnId = readPiProviderTurnId(record);
    if (type === 'turn_start' || type === 'agent_start') {
      readOrBeginTurn(agentTurnId, undefined, 'provider', observedAtMs);
      activeTurnStartObserved = true;
      return;
    }
    const turn = activeTurn;
    const providerFailureDiagnostic = readPiProviderFailureDiagnostic(record);
    if (turn && type === 'message_start' && record.message && typeof record.message === 'object'
      && 'role' in record.message && record.message.role === 'assistant') {
      turnStartedAtMs ??= observedAtMs;
    }
    if (turn && type === 'tool_execution_end') {
      lastNonModelItemCompletedAtMs = observedAtMs;
    }
    const providerFailure = providerFailureDiagnostic
      ? {
        diagnostic: providerFailureDiagnostic,
        evidence: buildPiProviderFailureLogEvidence(record),
      }
      : null;
    if (
      providerFailure
      && !activeTurnProviderFailure
      && (!replayingPromptAckFailureRecords || activeTurnStartObserved || activeTurnAssistantMessageObserved)
    ) {
      activeTurnProviderFailure = providerFailure;
      retryingTurnProviderFailure = null;
    }
    const projectedEvents = runtimeEventProjector.project(record, {
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
    const agentEndBoundary = classifyPiAgentEndBoundary(record, {
      piRetryableProviderFailure: activeTurnProviderFailure?.diagnostic.piRetryable,
    });
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
      params.observeUsage?.(turn?.turnId ?? null, resolvePromptCacheLastUseAtMs({
        turnStartedAtMs,
        lastNonModelItemCompletedAtMs,
      }));
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
    async openSession(resume, lifecycle): Promise<string | null> {
      const requestedResumeSelector = readString(resume?.selector);
      const requestedProviderSessionId = readString(resume?.providerSessionId);
      if (sessionId) {
        if (requestedProviderSessionId && requestedProviderSessionId !== sessionId) {
          throw new Error(`Pi session mismatch (expected ${requestedProviderSessionId}, got ${sessionId})`);
        }
        if (publishedProviderSessionId !== sessionId) {
          publishedProviderSessionId = sessionId;
          params.publishRuntimeEvent({
            kind: 'provider-session-id',
            emittedAtMs: Date.now(),
            providerSessionId: sessionId,
          });
        }
        params.refreshCommands?.();
        params.refreshModels?.();
        return sessionId;
      }
      const ownedLifecycle = lifecycle ?? createPiSessionOpenLifecycle();
      try {
        const stateBefore = await ownedLifecycle.waitFor(params.rpc.send(
          { type: 'get_state' },
          ownedLifecycle.remainingMs('provider session state'),
        ), 'provider session state');
        sessionId = readSessionIdFromState(stateBefore.data);
        if (!sessionId && !requestedResumeSelector) {
          await ownedLifecycle.waitFor(params.rpc.send(
            { type: 'new_session' },
            ownedLifecycle.remainingMs('provider session creation'),
          ), 'provider session creation');
          const stateAfter = await ownedLifecycle.waitFor(params.rpc.send(
            { type: 'get_state' },
            ownedLifecycle.remainingMs('provider session state'),
          ), 'provider session state');
          sessionId = readSessionIdFromState(stateAfter.data);
        }
        if (!sessionId && requestedResumeSelector && requestedProviderSessionId) {
          sessionId = requestedProviderSessionId;
        }
        if (!sessionId) {
          throw new Error('Pi did not return a session id');
        }
        if (publishedProviderSessionId !== sessionId) {
          publishedProviderSessionId = sessionId;
          params.publishRuntimeEvent({
            kind: 'provider-session-id',
            emittedAtMs: Date.now(),
            providerSessionId: sessionId,
          });
        }
        params.refreshCommands?.();
        params.refreshModels?.();
        return sessionId;
      } finally {
        if (!lifecycle) ownedLifecycle.dispose();
      }
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
        turnStartedAtMs: Date.now(),
        onAccepted,
        bufferedRecords: createAgentSessionPreAdmissionBuffer(),
        bufferFailure: null,
        cancelledReason: null,
      };
      pendingPromptAdmission = admission;
      const providerNativeCommand = params.resolveProviderNativeCommand(prompt);
      const accept = () => {
        admission.onAccepted();
        readOrBeginTurn(null, admission.turnId, 'host', admission.turnStartedAtMs);
        // The provider did accept the prompt, so the input stays admitted; the
        // turn it begins terminalizes cancelled instead of resurrecting an
        // already aborted admission.
        if (admission.cancelledReason !== null && activeTurn?.turnId === admission.turnId) {
          settleTurnCancelled(admission.turnId, admission.cancelledReason);
        }
      };
      const replayBufferedRecords = () => {
        const records = admission.bufferedRecords.drain();
        for (const { record, observedAtMs } of records) handleRuntimeRecordNow(record, observedAtMs);
      };
      try {
        // Pi queues this response behind an in-progress context compaction. In that state
        // the process lifecycle bounds admission; otherwise retain the ordinary response-
        // loss deadline and its custody-unknown classification.
        await params.rpc.send({
          type: 'prompt',
          message: prompt,
          ...(delivery ? { streamingBehavior: delivery } : {}),
        }, {
          afterMs: 30_000,
          deferWhile: () => piCompactionInProgress,
        });
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
        const completion = pendingCompletion?.promise;
        const providerNativeCommandKnownBeforeTurnSettled = await Promise.race([
          providerNativeCommand,
          ...(completion
            ? [completion.then(
                () => false,
                () => false,
              )]
            : []),
        ]);
        if (providerNativeCommandKnownBeforeTurnSettled && activeTurn && !activeTurnStartObserved) {
          const state = await params.rpc.send({ type: 'get_state' }, 30_000)
            .then((response) => isRecord(response.data) ? response.data as PiRpcStateData : null)
            .catch(() => null);
          if (
            activeTurn
            && !activeTurnStartObserved
            && state !== null
            && state.isStreaming === false
            && state.isCompacting === false
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
          for (const { record, observedAtMs } of records) handleRuntimeRecordNow(record, observedAtMs);
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
    subscribeRuntimeEvents(handler: PiConversationEventHandler, replayStartupEvents?: boolean): () => void {
      return params.subscribeRuntimeEvents(handler, replayStartupEvents);
    },
    async cancelTurn(turnId, reason): Promise<boolean> {
      if (pendingCancellation) {
        throw new Error('Pi cancellation is already in progress');
      }
      const cancellation: PendingCancellation | null = activeTurn?.turnId === turnId
        || pendingPromptAdmission?.turnId === turnId
        ? {
          turnId,
          reason,
          finalBoundaryObserved: false,
          finalBoundaryAgentTurnId: null,
        }
        : null;
      if (!cancellation) return false;
      pendingCancellation = cancellation;
      try {
        await params.cancelBlockingExtensionUiRequests();
        await params.rpc.send({ type: 'abort' }, 30_000);
      } catch (error) {
        if (pendingCancellation === cancellation) pendingCancellation = null;
        if (isPiRpcClientDisposedError(error)) return true;
        if (
          cancellation.finalBoundaryObserved
          && activeTurn?.turnId === cancellation.turnId
        ) {
          settleTurnComplete(cancellation.finalBoundaryAgentTurnId);
        }
        throw error;
      }
      if (pendingCancellation === cancellation) pendingCancellation = null;
      settleTurnCancelled(cancellation.turnId, cancellation.reason);
      // An abort acknowledged while the exact prompt admission is still awaiting
      // its own acknowledgement fences that admission: its late prompt ACK may
      // still arrive, and it must settle the turn cancelled instead of running it.
      const pendingAdmission = pendingPromptAdmission;
      if (
        activeTurn === null
        && pendingAdmission?.turnId === cancellation.turnId
        && pendingAdmission.cancelledReason === null
      ) {
        pendingAdmission.cancelledReason = cancellation.reason;
      }
      return true;
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
      // Capture arrival before prompt admission can defer lifecycle/tool
      // processing behind its acknowledgement; replay is not a request clock.
      const observedAtMs = Date.now();
      const recordType = readPiRuntimeRecordType(record);
      if (recordType === 'compaction_start') piCompactionInProgress = true;
      if (recordType === 'compaction_end') piCompactionInProgress = false;
      const admission = pendingPromptAdmission;
      if (!admission) {
        handleRuntimeRecordNow(record, observedAtMs);
        return;
      }
      const result = admission.bufferedRecords.admit({ record, observedAtMs });
      if (result.status !== 'accepted' && admission.bufferFailure === null) {
        admission.bufferFailure = result;
        admission.bufferedRecords.dispose();
      }
    },
    handleProcessExit,
  };
}

export type PiSessionRuntime = AgentSessionRuntime;

export type PiExecutionRunConversationParams = Omit<PiRuntimeOperationsParams, 'sessionId' | 'models'>;

export type PiConversationRuntime = Pick<
  AgentSessionRuntime,
  'send' | 'cancel' | 'updateConfiguration' | 'compact' | 'dispose'
> & Readonly<{
  watch(listener: PiConversationEventHandler): Readonly<{ dispose(): void }>;
}>;

function createPiConversationRuntime(params: Readonly<{
  operations: PiRuntimeTurnOperations;
  permissionMode?: PiPermissionMode;
  logger: PluginLoggerService;
  resumeSessionSelector: string | null;
  resumeProviderSessionId: string | null;
  clearSubscribers: () => void;
}>): PiConversationRuntime {
  const launchPermissionPolicy = resolvePiEffectiveLaunchPermissionPolicy(params.permissionMode);
  let disposed = false;
  let activeCompaction: Pick<AgentSessionCompactRequest, 'compactionId' | 'trigger'> | null = null;
  function settleActiveCompaction(phase: 'cancelled' | 'failed'): void {
    if (!activeCompaction) return;
    const { compactionId, trigger } = activeCompaction;
    activeCompaction = null;
    const common = { kind: 'context-compaction' as const, emittedAtMs: Date.now(), compactionId, trigger };
    params.operations.publishRuntimeEvent(phase === 'failed'
      ? { ...common, phase, diagnostic: diagnostic('pi_compaction_failed', 'Pi compaction was interrupted') }
      : { ...common, phase });
  }
  const compactionSubscription = params.operations.subscribeRuntimeEvents((event) => {
    if (event.kind === 'runtime-ended') settleActiveCompaction('failed');
    if (
      event.kind === 'context-compaction'
      && event.compactionId === activeCompaction?.compactionId
      && ['completed', 'failed', 'cancelled', 'outcomeUnknown'].includes(event.phase)
    ) {
      activeCompaction = null;
    }
  }, false);

  const publishInputRejected = (request: AgentSessionSendRequest, reason: PluginDiagnosticData): void => {
    params.operations.publishRuntimeEvent({
      kind: 'input-rejected',
      emittedAtMs: Date.now(),
      inputIds: request.inputIds,
      diagnostic: reason,
      retryable: false,
    });
  };

  const publishInputAccepted = (request: AgentSessionSendRequest): void => {
    params.operations.publishRuntimeEvent({
      kind: 'input-accepted',
      emittedAtMs: Date.now(),
      inputIds: request.inputIds,
      delivery: request.delivery,
    });
  };

  const publishInputCustodyUnknown = (request: AgentSessionSendRequest, issue: PluginDiagnosticData): void => {
    params.operations.publishRuntimeEvent({
      kind: 'input-custody-unknown',
      emittedAtMs: Date.now(),
      inputIds: request.inputIds,
      issue,
    });
  };

  const publishInputDeliveryFailed = (request: AgentSessionSendRequest, issue: PluginDiagnosticData): void => {
    if (request.delivery.kind === 'steer') {
      params.operations.publishRuntimeEvent({
        kind: 'input-custody-unknown',
        emittedAtMs: Date.now(),
        inputIds: request.inputIds,
        issue,
      });
      return;
    }
    params.operations.publishRuntimeEvent({
      kind: 'input-delivery-failed',
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
          params.resumeSessionSelector && params.resumeProviderSessionId
            ? {
              selector: params.resumeSessionSelector,
              providerSessionId: params.resumeProviderSessionId,
            }
            : undefined,
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
            retryable: providerFailure.piRetryable,
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
        return {
          status: 'rejected',
          diagnostic: reason,
          retryable: providerFailure?.piRetryable ?? false,
        };
      }
    },
    async cancel(request, options) {
      if (options?.signal?.aborted) {
        return { status: 'unavailable', diagnostic: diagnostic('pi_cancel_aborted', 'Pi cancellation was aborted') };
      }
      try {
        const cancelled = await params.operations.cancelTurn(request.turnId, request.reason);
        return cancelled
          ? { status: 'requested', turnId: request.turnId }
          : { status: 'notRunning' };
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
      // Native tool restrictions are launch-only. Refuse the whole snapshot
      // before model/thinking effects so the host cannot retain unapplied intent.
      if (resolvePiEffectiveLaunchPermissionPolicy(update.permissionIntent.value ?? undefined) !== launchPermissionPolicy) {
        return {
          status: 'unsupported',
          diagnostic: diagnostic('pi_permission_change_requires_restart', 'Pi permission changes require restarting the native runtime'),
        };
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
      if (activeCompaction) {
        return { status: 'rejected', diagnostic: diagnostic('pi_compaction_in_progress', 'Pi compaction is already running'), retryable: true };
      }
      activeCompaction = request;
      try {
        await params.operations.compactContext(request);
        return { status: 'admitted' };
      } catch (error) {
        settleActiveCompaction('failed');
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
      settleActiveCompaction('cancelled');
      compactionSubscription();
      params.clearSubscribers();
      await params.operations.resetOrDisposeRuntime();
    },
  };
}

async function createPiConversationRuntimeOperations(
  params: Omit<PiRuntimeOperationsParams, 'sessionId'>,
  happierSessionId?: string,
): Promise<PiConversationRuntime> {
  const ownedSessionOpenLifecycle = params.eagerStart === true && !params.sessionOpenLifecycle
    ? createPiSessionOpenLifecycle({
      onLateCleanupError: (error) => {
        params.logger.warn('[PiRuntime] Late session-open resource cleanup failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      },
    })
    : null;
  const sessionOpenLifecycle = params.sessionOpenLifecycle ?? ownedSessionOpenLifecycle;
  let modelDiscoveryDirectory: ReturnType<typeof createSecureTempDirectorySync> | null = null;
  let runtimeOwnsResources = false;
  let ownedToolsExtension: PreparedPiHappierToolsExtension | null = null;
  try {
  const normalizedEnv = normalizeEnv(params.env);
  const requestAuthEnabled = hasPiRequestAuthProvider(normalizedEnv);
  if (requestAuthEnabled) {
    assertPiRequestAuthRuntimeConfigured(normalizedEnv);
  }
  let requestAuthProducerVersion: string | null = null;
  const systemToolResolution = params.services.exec.systemTools.resolve({
    toolId: 'pi-cli',
    purpose: 'Run the Pi RPC runtime',
    cwd: params.cwd,
    ...(sessionOpenLifecycle ? { signal: sessionOpenLifecycle.signal } : {}),
  });
  const resolved = sessionOpenLifecycle
    ? await sessionOpenLifecycle.waitFor(systemToolResolution, 'system-tool resolution')
    : await systemToolResolution;
  const executable = resolved.executable;
  if (requestAuthEnabled) {
    requestAuthProducerVersion = await requireSupportedPiRequestAuthVersion(
      params,
      executable,
      sessionOpenLifecycle ?? undefined,
    );
  }
  let happierToolsExtension = params.happierToolsExtension;
  if (!happierToolsExtension) {
    // The bridge observes extension input even when no host tools or MCP servers are configured.
    const preparation = preparePiHappierToolsExtension({
      directory: params.cwd,
    });
    ownedToolsExtension = sessionOpenLifecycle
      ? await sessionOpenLifecycle.waitFor(preparation, 'Happier input bridge preparation', async lateTools => await lateTools.dispose())
      : await preparation;
    happierToolsExtension = ownedToolsExtension;
  }
  let modelDiscoveryExtensionPath: string | undefined;
  if (params.models) {
    modelDiscoveryDirectory = createSecureTempDirectorySync({ prefix: 'happier-pi-models-' });
    modelDiscoveryExtensionPath = join(modelDiscoveryDirectory.path, 'model-discovery.mjs');
    await writeAtomicTextFile({
      path: modelDiscoveryExtensionPath,
      contents: buildPiModelDiscoveryExtensionSource({ background: true, output: 'stdout' }),
      mode: 0o600,
    });
  }
  const processSpawn = params.services.exec.clients.spawn(createPiExecSpec({
    ...params,
    happierToolsExtension,
    env: {
      ...normalizedEnv,
      ...(requestAuthProducerVersion
        ? { [PI_REQUEST_AUTH_PRODUCER_VERSION_ENV]: requestAuthProducerVersion }
        : {}),
    },
  }, executable, modelDiscoveryExtensionPath), sessionOpenLifecycle ? { signal: sessionOpenLifecycle.signal } : undefined);
  const handle = sessionOpenLifecycle
    ? await sessionOpenLifecycle.waitFor(
      processSpawn,
      'process startup',
      async (lateHandle) => await lateHandle.dispose(),
    )
    : await processSpawn;
  const subscribers = new Set<PiConversationEventHandler>();
  // Eager startup can emit conversation output before the host can attach its watcher.
  // Internal observers still receive events immediately; only the first consumer drains this history.
  let pendingStartupEvents: PiRuntimeEvent[] | null = [];
  let replayingStartupSubscriber: PiConversationEventHandler | null = null;
  let retainedAvailableCommandsEvent: PiRuntimeEvent | null = null;
  let retainedProviderSessionIdEvent: PiRuntimeEvent | null = null;
  let malformedRuntimeEventPublished = false;
  let terminalRuntimeEventPublished = false;
  let sequence = 0;
  const activeMcpCalls = new Map<string, Extract<PiRuntimeEvent, { kind: 'tool-call' }> | null>();
  const publishParsedRuntimeEvent = (event: PiRuntimeEvent): void => {
    if (terminalRuntimeEventPublished) return;
    if (event.kind === 'available-commands') retainedAvailableCommandsEvent = event;
    if (event.kind === 'provider-session-id') retainedProviderSessionIdEvent = event;
    if (event.kind === 'tool-call') {
      activeMcpCalls.set(event.toolCallId,
        activeMcpCalls.has(event.toolCallId) || !event.toolName.startsWith('mcp__') ? null : event);
    }
    if (event.kind === 'tool-result') activeMcpCalls.delete(event.toolCallId);
    if (event.kind === 'turn-complete' || event.kind === 'runtime-ended') activeMcpCalls.clear();
    pendingStartupEvents?.push(event);
    for (const subscriber of [...subscribers]) {
      if (subscribers.has(subscriber) && subscriber !== replayingStartupSubscriber) subscriber(event);
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
    const diagnosticEvent: PiRuntimeEvent = {
      kind: 'runtime-ended',
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
    };
    sequence += 1;
    publishParsedRuntimeEvent(diagnosticEvent);
  };
  const publishRuntimeEvent = (event: PiRuntimeEvent): void => {
    const observedEvent = { ...event, emittedAtMs: event.emittedAtMs ?? Date.now() };
    if (happierSessionId) {
      const parsed = AgentSessionRuntimeEventSchema.safeParse({
        ...observedEvent,
        sequence: sequence + 1,
        sessionId: happierSessionId,
      });
      if (!parsed.success) {
        publishMalformedRuntimeEventDiagnostic(event, parsed.error.issues);
        return;
      }
    }
    sequence += 1;
    publishParsedRuntimeEvent(observedEvent);
  };
  let operations: RuntimeOperationsWithRecordHandler | null = null;
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
      let response: PiExtensionUiResponse | undefined;
      try {
        if (request.method === 'confirm' && request.title.startsWith(PI_MCP_APPROVAL_CALL_PREFIX)) {
          // The dialog carries only a native correlation id. Tool authority and
          // input come from the preceding structured Pi execution event.
          const call = activeMcpCalls.get(request.title.slice(PI_MCP_APPROVAL_CALL_PREFIX.length));
          if (call) {
            const approval = await params.services.interactions.requestApproval({
              kind: 'approval', title: 'Allow Pi to use an MCP tool?',
              subject: { kind: 'tool', name: call.toolName, input: call.input },
              allowSessionPersistence: true,
            }, { signal: controller.signal });
            response = { type: 'extension_ui_response', id: request.id,
              confirmed: approval.status === 'approved' && activeMcpCalls.get(call.toolCallId) === call };
          } else {
            response = { type: 'extension_ui_response', id: request.id, confirmed: false };
          }
        } else {
          response = buildPiExtensionUiResponse(request, await params.services.interactions.askQuestions(
            buildPiExtensionUiQuestionRequest(request),
            { signal: controller.signal },
          ));
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          params.logger.warn('[PiRuntime] Extension dialog interaction failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      try {
        await rpc.write(response ?? { type: 'extension_ui_response', id: request.id, cancelled: true });
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
  const modelsSource = params.models
    ? createPiSessionModelsSource({
        readState: async () => (await rpc.send({ type: 'get_state' }, 30_000)).data,
        onError: (error) => {
          params.logger.warn('[PiRuntime] Model catalog refresh failed', {
            error: error instanceof Error ? error.message : String(error),
          });
        },
      })
    : null;
  let mcpStartupFailure: Error | null = null;
  let capabilityNoticePublication = Promise.resolve();
  rpc = createPiJsonStreamRpcClient({
    handle,
    onEvent(record) {
      const extensionUserInput = parsePiExtensionUserInput(record);
      if (extensionUserInput !== null) {
        // Submission provenance is supplied by Pi's input hook, never inferred from user echoes.
        publishRuntimeEvent({
          kind: 'transcript-message-committed',
          messageId: `provider-user-prompt:${randomUUID()}`,
          role: 'user',
          text: extensionUserInput,
        });
        return;
      }
      if (record.type === PI_MCP_CAPABILITY_NOTICE_RECORD_TYPE) {
        const parsed = SessionCapabilityNoticeV1Schema.safeParse(record.notice);
        if (!parsed.success) {
          mcpStartupFailure = new Error('Pi emitted an invalid MCP capability notice');
          return;
        }
        const notice = parsed.data;
        if (params.mcpServersStrictMode === true) {
          mcpStartupFailure = new Error(`Pi MCP startup failed (${notice.items.map(item => item.code).join(', ')})`);
        }
        capabilityNoticePublication = capabilityNoticePublication.then(async () => {
          if (params.publishCapabilityNotice) await params.publishCapabilityNotice(notice);
          else params.logger.warn('[PiRuntime] MCP servers could not start', {
            items: notice.items.map(({ name, code }) => ({ name, code })),
          });
        }).catch((error: unknown) => {
          mcpStartupFailure = error instanceof Error ? error : new Error('Pi MCP capability notice publication failed');
        });
        return;
      }
      const catalog = parsePiModelDiscoveryRecord(record);
      if (catalog) {
        modelsSource?.observeCatalog(catalog);
        return;
      }
      if (record.type === 'runtime_event') {
        if (!happierSessionId || !isRecord(record.event)) {
          publishMalformedRuntimeEventDiagnostic(record.event, [{
            message: 'Detached Pi runtimes do not accept Session-enveloped runtime events.',
          }]);
          return;
        }
        const { sequence: _sequence, sessionId: _sessionId, ...event } = record.event;
        publishRuntimeEvent(event as PiRuntimeEvent);
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
  let availableCommandsKnown = false;
  let availableCommandsRefresh: Promise<void> | null = null;
  let availableExtensionCommandNames: ReadonlySet<string> = new Set();
  const refreshAvailableCommands = (): Promise<void> => {
    if (availableCommandsKnown) return Promise.resolve();
    if (availableCommandsRefresh) return availableCommandsRefresh;
    availableCommandsKnown = false;
    const refresh = rpc.send({ type: 'get_commands' }, 30_000).then((response) => {
      const availableCommands = normalizePiAvailableCommands(response.data);
      availableExtensionCommandNames = readPiExtensionCommandNames(response.data);
      availableCommandsKnown = true;
      publishRuntimeEvent({
        kind: 'available-commands',
        emittedAtMs: Date.now(),
        commands: [...availableCommands],
      });
    }).catch((error: unknown) => {
      params.logger.warn('[PiRuntime] Command catalog refresh failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
    availableCommandsRefresh = refresh;
    void refresh.finally(() => {
      if (availableCommandsRefresh === refresh) availableCommandsRefresh = null;
    });
    return refresh;
  };
  operations = createRuntimeOperations({
    rpc,
    logger: params.logger,
    initialSessionId: params.initialSessionId ?? null,
    subscribeRuntimeEvents(handler, replayStartupEvents = true) {
      subscribers.add(handler);
      if (replayStartupEvents && pendingStartupEvents !== null && replayingStartupSubscriber === null) {
        replayingStartupSubscriber = handler;
        try {
          // Reentrant publication appends to this same startup history instead of overtaking it.
          for (let index = 0; pendingStartupEvents !== null && index < pendingStartupEvents.length; index += 1) {
            handler(pendingStartupEvents[index]!);
          }
          pendingStartupEvents = null;
        } catch (error) {
          subscribers.delete(handler);
          throw error;
        } finally {
          replayingStartupSubscriber = null;
        }
      } else {
        if (retainedProviderSessionIdEvent) handler(retainedProviderSessionIdEvent);
        if (retainedAvailableCommandsEvent) handler(retainedAvailableCommandsEvent);
      }
      return () => {
        subscribers.delete(handler);
      };
    },
    publishRuntimeEvent,
    async resolveProviderNativeCommand(prompt) {
      const name = readLeadingPiExtensionCommandName(prompt);
      if (name === null) return false;
      await refreshAvailableCommands();
      return availableCommandsKnown && availableExtensionCommandNames.has(name);
    },
    refreshCommands: () => { void refreshAvailableCommands(); },
    ...(happierSessionId ? { observeUsage(turnId: string | null, promptCacheLastUseAtMs?: number) {
      usageObservationChain = usageObservationChain.then(async () => {
        const response = await rpc.send({ type: 'get_session_stats' }, 30_000);
        const observedAtMs = Date.now();
        const event = projectPiSessionStatsUsage({
          stats: response.data,
          sessionId: happierSessionId,
          turnId,
          observationId: `pi-usage-${randomUUID()}`,
          observedAtMs,
          ...(promptCacheLastUseAtMs !== undefined ? { promptCache: { lastUseAtMs: promptCacheLastUseAtMs } } : {}),
        });
        if (event) {
          const { sessionId: _sessionId, ...conversationEvent } = event;
          publishRuntimeEvent(conversationEvent);
        }
      }).catch((error) => {
        params.logger.warn('[PiRuntime] Session usage refresh failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    } } : {}),
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
  const runtime = createPiConversationRuntime({
    operations,
    permissionMode: params.permissionMode,
    logger: params.logger,
    resumeSessionSelector: readString(params.resumeSessionSelector),
    resumeProviderSessionId: readString(params.resumeProviderSessionId),
    clearSubscribers: () => {
      activeMcpCalls.clear();
      modelsBinding?.dispose();
      modelsBinding = null;
      modelsSource?.dispose();
      unsubscribeProcessExit();
      subscribers.clear();
      pendingStartupEvents = null;
    },
  });
  if (params.eagerStart === true) {
    try {
      await operations.openSession(
        params.resumeSessionSelector && params.resumeProviderSessionId
          ? {
            selector: params.resumeSessionSelector,
            providerSessionId: params.resumeProviderSessionId,
          }
          : undefined,
        sessionOpenLifecycle ?? undefined,
      );
      await capabilityNoticePublication;
      if (mcpStartupFailure) throw mcpStartupFailure;
    } catch (error) {
      await runtime.dispose();
      throw error;
    }
  }
  runtimeOwnsResources = true;
  return {
    ...runtime,
    async dispose() {
      try { await runtime.dispose(); }
      finally {
        try { await ownedToolsExtension?.dispose(); }
        finally { modelDiscoveryDirectory?.cleanup(); }
      }
    },
  };
  } finally {
    if (!runtimeOwnsResources) {
      try { await ownedToolsExtension?.dispose(); }
      finally { modelDiscoveryDirectory?.cleanup(); }
    }
    ownedSessionOpenLifecycle?.dispose();
  }
}

/** Opens Pi without manufacturing a Happier Session envelope. */
export async function createPiExecutionRunConversation(
  params: PiExecutionRunConversationParams,
): Promise<PiConversationRuntime> {
  return await createPiConversationRuntimeOperations(params);
}

export async function createPiRuntimeOperations(params: PiRuntimeOperationsParams): Promise<PiSessionRuntime> {
  const { sessionId, ...conversationParams } = params;
  const conversation = await createPiConversationRuntimeOperations(conversationParams, sessionId);
  let sequence = 0;
  return {
    ...conversation,
    runtimeCapabilities: { sessionCapabilities: AGENT_DEFINITION.core.sessionCapabilities },
    watch(listener) {
      return conversation.watch((event) => {
        listener(AgentSessionRuntimeEventSchema.parse({
          ...event,
          sequence: ++sequence,
          sessionId,
          emittedAtMs: event.emittedAtMs ?? Date.now(),
        }));
      });
    },
    dispose: async () => await conversation.dispose(),
  };
}
