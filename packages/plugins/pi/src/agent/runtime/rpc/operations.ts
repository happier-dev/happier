import { randomUUID } from 'node:crypto';

import type {
  ExecJsonStreamClientSpecV1,
  ExecClientHandleV1,
  JsonStreamClientV1,
  PluginContextV1,
  RuntimeCancelResultV1,
  RuntimeEventV1,
  RuntimeInputPayloadV1,
  RuntimeSendOptionsV1,
  RuntimeSendResultV1,
  SessionRuntimeConfigUpdateV1,
  SessionRuntimeV1,
} from '@happier-dev/plugin-sdk';
import {
  buildSessionRuntimeIssueV1,
  type RuntimePromptAcceptedCallbackV1,
  type RuntimePromptAcceptedInfoV1,
  RuntimeEventV1Schema,
} from '@happier-dev/plugin-sdk/experimental/runtime/session';
import { raceWithTimeout } from '@happier-dev/plugin-sdk/experimental/timeout';

import {
  PI_BROKER_LOAD_NONCE_ENV,
  PI_BROKER_PROVIDERS,
  PI_BROKER_SELECTIONS_ENV,
  parsePiBrokerSelections,
  verifyPiBrokerReadyForConnectedSession,
} from '../../auth/services/broker/index.js';
import { PI_THINKING_LEVEL_ENV, resolvePiThinkingLevelFromEnv } from '../../../protocol/thinking.js';
import { buildPiRpcArgs, readPiConnectedServiceIdFromEnv } from './args.js';
import { createPiJsonStreamRpcClient, type PiJsonStreamRpcClient } from './client.js';
import { projectPiRuntimeEvents, readPiProviderTurnId, readPiRuntimeRecordType } from './events.js';
import type { PiPermissionMode, PiRpcStateData } from './types.js';

const DEFAULT_PI_RPC_PROMPT_ACK_START_GRACE_MS = 2_500;

type PiRuntimeOperationsParams = Readonly<{
  ctx: PluginContextV1;
  cwd: string;
  env: Readonly<Record<string, string>>;
  permissionMode?: PiPermissionMode;
  initialSessionId?: string | null;
  resumeSessionId?: string | null;
  happierSessionId?: string | null;
  eagerStart?: boolean;
}>;

type RuntimeEventHandler = (event: RuntimeEventV1) => void;
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

type PiRuntimeTurnOperations = Readonly<{
  beginTurnLifecycle(): void;
  startOrLoadSession(opts?: Readonly<Record<string, unknown>>): Promise<string | null>;
  sendTurnPrompt(prompt: string, delivery?: 'followUp'): Promise<void>;
  steerInFlightTurn(message: string): Promise<void>;
  waitForTurnCompletion(opts?: Readonly<Record<string, unknown>>): Promise<void>;
  subscribeRuntimeEvents(handler: RuntimeEventHandler): () => void;
  cancelTurn(): Promise<void>;
  readSessionIdentity(): Readonly<{ sessionId: string | null }>;
  updateSessionRuntimeConfig(update: SessionRuntimeConfigUpdateV1): Promise<void>;
  resetOrDisposeRuntime(): Promise<void>;
}>;

type RuntimeOperationsWithRecordHandler = PiRuntimeTurnOperations & Readonly<{
  handleRuntimeRecord(record: Readonly<Record<string, unknown>>): void;
}>;

type PendingPromptAcceptance = {
  info: RuntimePromptAcceptedInfoV1;
  providerEvidenceObserved: boolean;
  submitted: boolean;
};

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function isPiRpcClientDisposedError(error: unknown): boolean {
  return error instanceof Error && error.message === 'Pi RPC client disposed';
}

function readRawString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function readJsonProviderErrorMessage(value: unknown): string | null {
  const record = isRecord(value) ? value : null;
  if (!record) return null;
  const nestedError = isRecord(record.error) ? record.error : null;
  return readString(nestedError?.message)
    ?? readString(nestedError?.errorMessage)
    ?? readString(nestedError?.error_message)
    ?? readString(record.message)
    ?? readString(record.errorMessage)
    ?? readString(record.error_message);
}

function readProviderErrorPreviewFromText(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  const jsonStart = text.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(text.slice(jsonStart));
      const parsedMessage = readJsonProviderErrorMessage(parsed);
      if (parsedMessage) return parsedMessage;
    } catch {
      // Non-JSON provider text still carries useful diagnostic context.
    }
  }
  return text;
}

function readAssistantContentText(value: unknown): string | null {
  const record = isRecord(value) ? value : null;
  if (!record || !Array.isArray(record.content)) return null;
  let text = '';
  for (const item of record.content) {
    const entry = isRecord(item) ? item : null;
    if (!entry || entry.type !== 'text') continue;
    const chunk = readRawString(entry.text);
    if (chunk !== null) text += chunk;
  }
  return text.length > 0 ? text : null;
}

function readPiAssistantErrorPreview(record: Readonly<Record<string, unknown>>): string | null {
  const message = isRecord(record.message) ? record.message : null;
  if (message?.role !== 'assistant') return null;
  const stopReason = readString(message.stopReason ?? message.stop_reason ?? record.stopReason ?? record.stop_reason);
  const candidates = [
    message.errorMessage,
    message.error_message,
    message.error,
    record.errorMessage,
    record.error_message,
    record.error,
    readAssistantContentText(message),
  ];
  const preview = candidates
    .map((candidate) => readString(candidate))
    .find((candidate): candidate is string => candidate !== null);
  if (!preview || (stopReason !== 'error' && !message.errorMessage && !message.error_message && !record.errorMessage)) {
    return null;
  }
  return readProviderErrorPreviewFromText(preview);
}

function readRuntimeInputText(input: RuntimeInputPayloadV1): string | null {
  return readString(input.text);
}

function readRuntimePromptAcceptedInfo(options: RuntimeSendOptionsV1 | undefined): RuntimePromptAcceptedInfoV1 {
  const localInputIds: string[] = [];
  const appendLocalInputId = (value: unknown) => {
    const localInputId = readString(value);
    if (!localInputId || localInputIds.includes(localInputId)) return;
    localInputIds.push(localInputId);
  };
  appendLocalInputId(options?.localInputId);
  for (const localInputId of options?.localInputIds ?? []) {
    appendLocalInputId(localInputId);
  }

  const userMessageSeqs: number[] = [];
  const appendUserMessageSeq = (value: unknown) => {
    if (!Number.isSafeInteger(value) || (value as number) < 0) return;
    if (userMessageSeqs.includes(value as number)) return;
    userMessageSeqs.push(value as number);
  };
  appendUserMessageSeq(options?.userMessageSeq);
  for (const userMessageSeq of options?.userMessageSeqs ?? []) {
    appendUserMessageSeq(userMessageSeq);
  }

  const primaryUserMessageSeq = options?.userMessageSeq;
  return {
    ...(localInputIds.length === 0 ? {} : { localInputIds }),
    userMessageSeq: Number.isSafeInteger(primaryUserMessageSeq) && (primaryUserMessageSeq as number) >= 0
      ? Math.trunc(primaryUserMessageSeq as number)
      : null,
    ...(userMessageSeqs.length === 0 ? {} : { userMessageSeqs }),
  };
}

function accepted(): RuntimeSendResultV1 {
  return { status: 'accepted' };
}

function rejected(diagnostic: string): RuntimeSendResultV1 {
  return { status: 'rejected', diagnostic };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function withPiBrokerLoadNonceForSpawn(env: Readonly<Record<string, string>>): Record<string, string> {
  const next = { ...env };
  const selections = parsePiBrokerSelections(next[PI_BROKER_SELECTIONS_ENV]);
  const hasBrokeredProvider = PI_BROKER_PROVIDERS.some((provider) => selections[provider]);
  if (hasBrokeredProvider) {
    next[PI_BROKER_LOAD_NONCE_ENV] = randomUUID();
  }
  return next;
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

function createPiExecSpec(params: PiRuntimeOperationsParams): ExecJsonStreamClientSpecV1 {
  const thinkingLevel = resolvePiThinkingLevelFromEnv(params.env);
  return {
    launch: {
      kind: 'agent-cli',
      agentId: 'pi',
      args: buildPiRpcArgs({
        permissionMode: params.permissionMode,
        thinkingLevel,
        resumeSessionId: params.resumeSessionId,
        connectedServiceId: readPiConnectedServiceIdFromEnv(params.env),
        env: params.env,
      }),
      cwd: params.cwd,
      env: {
        ...params.env,
        ...(thinkingLevel ? { [PI_THINKING_LEVEL_ENV]: thinkingLevel } : {}),
        NODE_ENV: 'production',
        DEBUG: '',
        CI: '1',
      },
    },
    transport: {
      kind: 'stdio',
      framing: { kind: 'strict-lf-json' },
    },
    protocol: { kind: 'json-stream' },
    lifecycle: {
      requestTimeoutMs: 30_000,
      maxStderrBytes: 4096,
    },
  };
}

function createRuntimeOperations(params: Readonly<{
  rpc: PiJsonStreamRpcClient;
  happierSessionId: string | null;
  initialSessionId: string | null;
  subscribeRuntimeEvents: (handler: RuntimeEventHandler) => () => void;
  publishRuntimeEvent: RuntimeEventPublisher;
}>): RuntimeOperationsWithRecordHandler {
  let sessionId = params.initialSessionId;
  let activeTurn: ActiveTurnState | null = null;
  let activeTurnStartObserved = false;
  let activeTurnAssistantMessageObserved = false;
  let activeTurnProviderErrorPreview: string | null = null;
  let promptAckFailureGraceActive = false;
  let settledTurnFailure: Error | null = null;
  let pendingCompletion: PendingCompletion | null = null;

  function beginTurn(agentTurnId: string | null = null): ActiveTurnState {
    const turn = Object.freeze({
      turnId: randomUUID(),
      agentTurnId,
    });
    activeTurn = turn;
    activeTurnStartObserved = false;
    activeTurnAssistantMessageObserved = false;
    activeTurnProviderErrorPreview = null;
    settledTurnFailure = null;
    pendingCompletion = createCompletion();
    if (params.happierSessionId) {
      params.publishRuntimeEvent({
        kind: 'turn-start',
        sessionId: params.happierSessionId,
        emittedAtMs: Date.now(),
        turnId: turn.turnId,
        ...(agentTurnId ? { agentTurnId } : {}),
        startedBy: 'provider',
      });
    }
    return turn;
  }

  function clearActiveTurn(): void {
    activeTurn = null;
    activeTurnStartObserved = false;
    activeTurnAssistantMessageObserved = false;
    activeTurnProviderErrorPreview = null;
    pendingCompletion = null;
  }

  function rejectActiveTurn(error: Error): void {
    pendingCompletion?.reject(error);
    clearActiveTurn();
  }

  function readOrBeginTurn(agentTurnId: string | null = null): ActiveTurnState {
    if (!activeTurn) return beginTurn(agentTurnId);
    if (agentTurnId && activeTurn.agentTurnId !== agentTurnId) {
      activeTurn = Object.freeze({
        turnId: activeTurn.turnId,
        agentTurnId,
      });
      if (params.happierSessionId) {
        params.publishRuntimeEvent({
          kind: 'turn-agent-id-observed',
          sessionId: params.happierSessionId,
          emittedAtMs: Date.now(),
          turnId: activeTurn.turnId,
          agentTurnId,
        });
      }
    }
    return activeTurn;
  }

  function settleTurnFailedForEmptyResponse(
    turn: ActiveTurnState,
    agentTurnId: string | null,
    completion: PendingCompletion | null,
  ): boolean {
    if (!params.happierSessionId || activeTurnAssistantMessageObserved) return false;
    const emittedAtMs = Date.now();
    const providerErrorPreview = activeTurnProviderErrorPreview;
    settledTurnFailure = new Error(providerErrorPreview
      ?? 'Pi completed the turn without returning an assistant message. Check provider credentials, model availability, and Pi logs.');
    params.publishRuntimeEvent({
      kind: 'turn-failed',
      sessionId: params.happierSessionId,
      emittedAtMs,
      turnId: turn.turnId,
      ...(agentTurnId ? { agentTurnId } : {}),
      issue: buildSessionRuntimeIssueV1({
        code: providerErrorPreview ? 'pi_provider_session_error' : 'pi_empty_provider_response',
        source: 'agent_session_error',
        occurredAt: emittedAtMs,
        agentId: 'pi',
        sanitizedPreview: providerErrorPreview
          ?? 'Pi completed the turn without returning an assistant message. Check provider credentials, model availability, and Pi logs.',
      }),
    });
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
    if (params.happierSessionId) {
      params.publishRuntimeEvent({
        kind: 'turn-complete',
        sessionId: params.happierSessionId,
        emittedAtMs: Date.now(),
        turnId: turn.turnId,
        ...(terminalProviderTurnId ? { agentTurnId: terminalProviderTurnId } : {}),
      });
    }
    settledTurnFailure = null;
    clearActiveTurn();
    completion?.resolve();
  }

  async function waitForAcceptedTurnStreamAfterPromptAckFailure(completion: PendingCompletion): Promise<boolean> {
    const deadline = Date.now() + DEFAULT_PI_RPC_PROMPT_ACK_START_GRACE_MS;
    while (Date.now() < deadline) {
      if (!pendingCompletion || pendingCompletion !== completion) {
        if (settledTurnFailure) throw settledTurnFailure;
        return true;
      }
      if (activeTurnStartObserved || activeTurnAssistantMessageObserved) {
        await completion.promise;
        if (settledTurnFailure) throw settledTurnFailure;
        return true;
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    }
    return false;
  }

  function handleRuntimeRecord(record: Readonly<Record<string, unknown>>): void {
    const type = readPiRuntimeRecordType(record);
    const agentTurnId = readPiProviderTurnId(record);
    if (type === 'turn_start' || type === 'agent_start') {
      readOrBeginTurn(agentTurnId);
      activeTurnStartObserved = true;
      return;
    }
    const turn = activeTurn;
    const providerErrorPreview = readPiAssistantErrorPreview(record);
    if (
      providerErrorPreview
      && !activeTurnProviderErrorPreview
      && (!promptAckFailureGraceActive || activeTurnStartObserved || activeTurnAssistantMessageObserved)
    ) {
      activeTurnProviderErrorPreview = providerErrorPreview;
    }
    const projectedEvents = projectPiRuntimeEvents(record, {
      sessionId: params.happierSessionId,
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
    if (
      promptAckFailureGraceActive
      && !activeTurnStartObserved
      && !activeTurnAssistantMessageObserved
      && (type === 'turn_end' || type === 'agent_end')
    ) {
      return;
    }
    if (type === 'turn_end') {
      if (agentTurnId) readOrBeginTurn(agentTurnId);
      settleTurnComplete(agentTurnId);
      return;
    }
    if (type === 'agent_end' && record.willRetry !== true) {
      settleTurnComplete(agentTurnId);
    }
  }

  return {
    beginTurnLifecycle() {
      beginTurn();
    },
    async startOrLoadSession(opts?: Readonly<Record<string, unknown>>): Promise<string | null> {
      const requestedResumeId = readString(opts?.resumeId) ?? readString(opts?.providerSessionId);
      if (sessionId) {
        if (requestedResumeId && requestedResumeId !== sessionId) {
          throw new Error(`Pi session mismatch (expected ${requestedResumeId}, got ${sessionId})`);
        }
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
      return sessionId;
    },
    async sendTurnPrompt(prompt: string, delivery?: 'followUp'): Promise<void> {
      readOrBeginTurn();
      const completion = pendingCompletion;
      try {
        await params.rpc.send({
          type: 'prompt',
          message: prompt,
          ...(delivery ? { streamingBehavior: delivery } : {}),
        }, 30_000);
      } catch (error) {
        const promptError = error instanceof Error ? error : new Error(String(error));
        if (completion) {
          promptAckFailureGraceActive = true;
          try {
            if (await waitForAcceptedTurnStreamAfterPromptAckFailure(completion)) {
              return;
            }
          } finally {
            promptAckFailureGraceActive = false;
          }
        }
        rejectActiveTurn(promptError);
        throw promptError;
      }
    },
    async steerInFlightTurn(message: string): Promise<void> {
      await params.rpc.send({ type: 'prompt', message, streamingBehavior: 'steer' }, 30_000);
    },
    async waitForTurnCompletion(opts?: Readonly<Record<string, unknown>>): Promise<void> {
      const completion = pendingCompletion;
      if (!completion) return;
      await withTimeout(completion.promise, opts);
    },
    subscribeRuntimeEvents(handler: RuntimeEventHandler): () => void {
      return params.subscribeRuntimeEvents(handler);
    },
    async cancelTurn(): Promise<void> {
      try {
        await params.rpc.send({ type: 'abort' }, 30_000);
      } catch (error) {
        if (isPiRpcClientDisposedError(error)) return;
        throw error;
      }
    },
    readSessionIdentity() {
      return { sessionId };
    },
    async updateSessionRuntimeConfig(update: Readonly<Record<string, unknown>>): Promise<void> {
      const modelId = readString(update.modelId) ?? readString(update.model);
      if (modelId) {
        const [provider, ...modelParts] = modelId.split('/');
        await params.rpc.send({
          type: 'set_model',
          provider: modelParts.length > 0 ? provider : 'default',
          modelId: modelParts.length > 0 ? modelParts.join('/') : modelId,
        }, 30_000);
      }
      const configOption = isRecord(update.configOption) ? update.configOption : null;
      if (configOption?.id === 'piThinkingLevel' || configOption?.id === 'reasoning_effort') {
        const level = readString(configOption.value);
        if (level) await params.rpc.send({ type: 'set_thinking_level', level }, 30_000);
      }
    },
    async resetOrDisposeRuntime(): Promise<void> {
      pendingCompletion?.reject(new Error('Pi runtime disposed'));
      clearActiveTurn();
      settledTurnFailure = null;
      await params.rpc.dispose();
    },
    handleRuntimeRecord,
  };
}

function createPiSessionRuntime(params: Readonly<{
  operations: PiRuntimeTurnOperations;
  resumeSessionId: string | null;
  clearSubscribers: () => void;
}>): SessionRuntimeV1 {
  let promptAcceptedCallback: RuntimePromptAcceptedCallbackV1 | null = null;
  const pendingPromptAcceptances: PendingPromptAcceptance[] = [];
  const flushProviderAcceptedPrompts = (): void => {
    const accepted = pendingPromptAcceptances.filter((pending) =>
      pending.submitted && pending.providerEvidenceObserved);
    for (const pending of accepted) {
      const index = pendingPromptAcceptances.indexOf(pending);
      if (index >= 0) pendingPromptAcceptances.splice(index, 1);
      promptAcceptedCallback?.(pending.info);
    }
  };
  const observeProviderAcceptanceEvidence = (): void => {
    const pending = pendingPromptAcceptances.find((candidate) => !candidate.providerEvidenceObserved);
    if (!pending) return;
    pending.providerEvidenceObserved = true;
    flushProviderAcceptedPrompts();
  };
  const enqueuePromptAcceptance = (info: RuntimePromptAcceptedInfoV1): PendingPromptAcceptance => {
    const pending = {
      info,
      providerEvidenceObserved: false,
      submitted: false,
    };
    pendingPromptAcceptances.push(pending);
    return pending;
  };
  const markPromptSubmitted = (pending: PendingPromptAcceptance): void => {
    pending.submitted = true;
    flushProviderAcceptedPrompts();
  };
  const removePendingPromptAcceptance = (pending: PendingPromptAcceptance): void => {
    const index = pendingPromptAcceptances.indexOf(pending);
    if (index >= 0) pendingPromptAcceptances.splice(index, 1);
  };
  const providerEvidenceSubscription = params.operations.subscribeRuntimeEvents((event) => {
    if (
      event.kind === 'message-delta'
      || event.kind === 'tool-call'
      || event.kind === 'tool-result'
      || event.kind === 'tool-progress'
      || event.kind === 'turn-agent-id-observed'
      || event.kind === 'turn-progress'
      || event.kind === 'turn-complete'
      || event.kind === 'turn-failed'
      || event.kind === 'turn-cancelled'
    ) {
      observeProviderAcceptanceEvidence();
    }
  });
  const submitPromptWithAcceptanceTracking = async (
    info: RuntimePromptAcceptedInfoV1,
    submit: () => Promise<void>,
  ): Promise<void> => {
    const pending = enqueuePromptAcceptance(info);
    try {
      await submit();
      markPromptSubmitted(pending);
    } catch (error) {
      removePendingPromptAcceptance(pending);
      throw error;
    }
  };

  return {
    identity: {
      read: () => ({
        providerSessionId: params.operations.readSessionIdentity().sessionId,
      }),
    },
    events: {
      subscribe: (handler) => params.operations.subscribeRuntimeEvents(handler),
    },
    async send(input: RuntimeInputPayloadV1, options?: RuntimeSendOptionsV1): Promise<RuntimeSendResultV1> {
      const prompt = readRuntimeInputText(input);
      if (!prompt) {
        return rejected('Pi runtime input did not include text');
      }
      if (options?.signal?.aborted === true) {
        return rejected('Pi runtime input was aborted before delivery');
      }
      await params.operations.startOrLoadSession(
        params.resumeSessionId ? { resumeId: params.resumeSessionId } : undefined,
      );
      const acceptedInfo = readRuntimePromptAcceptedInfo(options);
      if (options?.deliverAs === 'steer') {
        await submitPromptWithAcceptanceTracking(acceptedInfo, async () => {
          await params.operations.steerInFlightTurn(prompt);
        });
        return accepted();
      }
      await submitPromptWithAcceptanceTracking(acceptedInfo, async () => {
        await params.operations.sendTurnPrompt(
          prompt,
          options?.deliverAs === 'followUp' ? 'followUp' : undefined,
        );
      });
      return accepted();
    },
    async cancel(): Promise<RuntimeCancelResultV1> {
      await params.operations.cancelTurn();
      return { status: 'cancelled' };
    },
    permissions: { capability: 'static' },
    updateConfig: async (update) => {
      await params.operations.updateSessionRuntimeConfig(update);
    },
    setOnPromptAcceptedByProvider: (handler) => {
      promptAcceptedCallback = handler;
    },
    dispose: async () => {
      providerEvidenceSubscription();
      pendingPromptAcceptances.length = 0;
      promptAcceptedCallback = null;
      params.clearSubscribers();
      await params.operations.resetOrDisposeRuntime();
    },
  };
}

export async function createPiRuntimeOperations(params: PiRuntimeOperationsParams): Promise<SessionRuntimeV1> {
  const normalizedEnv = normalizeEnv(params.env);
  const spawnEnv = withPiBrokerLoadNonceForSpawn(normalizedEnv);
  const happierSessionId = readString(params.happierSessionId);
  const handle = await params.ctx.agentRuntime.exec.spawnClient(createPiExecSpec({
    ...params,
    env: spawnEnv,
  }));
  // Connected sessions auth via the Happier Pi broker extension (the materializer wrote it into the
  // agent dir's `extensions/` auto-load dir + emitted the broker env). Fail-closed BEFORE the first
  // prompt: confirm the extension exists, the daemon bridge is reachable, and the extension actually
  // LOADED (it pings the daemon on activation). No-op for native + direct-API-key sessions. The marker
  // credential is non-functional without the extension, so a failed preflight must fail the session
  // rather than silently fall back to native/upstream auth.
  const brokerReadiness = await verifyPiBrokerReadyForConnectedSession(spawnEnv);
  if (!brokerReadiness.ready) {
    await handle.dispose({ code: 'PI_BROKER_NOT_READY', message: brokerReadiness.reason }).catch(() => {});
    throw new Error(`Pi connected-service broker not ready: ${brokerReadiness.reason}`);
  }
  const subscribers = new Set<RuntimeEventHandler>();
  let malformedRuntimeEventPublished = false;
  const publishParsedRuntimeEvent = (event: RuntimeEventV1): void => {
    for (const subscriber of subscribers) {
      subscriber(event);
    }
  };
  const publishMalformedRuntimeEventDiagnostic = (
    event: unknown,
    issues: ReadonlyArray<Readonly<{ code: string; path: readonly PropertyKey[]; message: string }>>,
  ): void => {
    params.ctx.logger.warn('[PiRuntime] rejected malformed RuntimeEventV1 payload', { issues });
    if (malformedRuntimeEventPublished) return;
    malformedRuntimeEventPublished = true;
    const eventKind = isRecord(event) && typeof event.kind === 'string' ? event.kind : null;
    const diagnostic = RuntimeEventV1Schema.safeParse({
      kind: 'backend-error',
      sessionId: happierSessionId,
      emittedAtMs: Math.max(0, Math.trunc(Date.now())),
      error: {
        message: 'Pi emitted a malformed runtime event; event was rejected at the adapter boundary',
        code: 'malformed_runtime_event',
        cause: {
          eventKind,
          issues: issues.slice(0, 5).map((issue) => ({
            code: issue.code,
            path: issue.path.map((segment) => (typeof segment === 'symbol' ? segment.toString() : segment)),
            message: issue.message,
          })),
        },
      },
    });
    if (diagnostic.success) publishParsedRuntimeEvent(diagnostic.data);
  };
  const publishRuntimeEvent: RuntimeEventPublisher = (event): void => {
    const parsed = RuntimeEventV1Schema.safeParse(event);
    if (parsed.success) {
      publishParsedRuntimeEvent(parsed.data);
      return;
    }
    publishMalformedRuntimeEventDiagnostic(event, parsed.error.issues);
  };
  let operations: RuntimeOperationsWithRecordHandler | null = null;
  const rpc = createPiJsonStreamRpcClient({
    handle,
    onEvent(record) {
      if (record.type === 'runtime_event') {
        publishRuntimeEvent(record.event);
        return;
      }
      operations?.handleRuntimeRecord(record);
    },
  });
  operations = createRuntimeOperations({
    rpc,
    happierSessionId,
    initialSessionId: params.initialSessionId ?? null,
    subscribeRuntimeEvents(handler) {
      subscribers.add(handler);
      return () => {
        subscribers.delete(handler);
      };
    },
    publishRuntimeEvent,
  });
  if (params.eagerStart === true) {
    await operations.startOrLoadSession(
      params.resumeSessionId ? { resumeId: params.resumeSessionId } : undefined,
    );
  }
  return createPiSessionRuntime({
    operations,
    resumeSessionId: readString(params.resumeSessionId),
    clearSubscribers: () => subscribers.clear(),
  });
}
