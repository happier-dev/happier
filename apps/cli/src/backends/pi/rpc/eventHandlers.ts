import type { AgentMessage, AgentMessageHandler } from '@/agent/core';
import type { SurfacePrimarySessionRuntimeIssueInput } from '@/agent/runtime/session/errors/surfacePrimarySessionRuntimeIssue';
import type { ConnectedServiceRuntimeFailureClassification } from '@/daemon/connectedServices/runtimeAuth/types';
import { logger } from '@/ui/logger';
import { redactBugReportSensitiveText, type RuntimeEventV1 } from '@happier-dev/protocol';
import { randomUUID } from 'node:crypto';

import { mapPiRpcEventToAgentMessages } from './eventMapping';
import { asNonEmptyString, asRecord, type PendingRpcRequest } from './rpcSupport';
import type { PiRpcResponse } from './types';

export type PiRpcEventHandlerContext = Readonly<{
  disposed: boolean;
  messageHandlers: ReadonlySet<AgentMessageHandler>;
  pendingRequests: Map<string, PendingRpcRequest>;
  openPromptRequestIds: Set<string>;
  runtimeTurnState: PiRpcRuntimeTurnState;
  resolvePendingTurn: () => void;
  rejectPendingTurn: (error: Error) => void;
  notePendingTurnActivity: (event: Record<string, unknown>) => void;
  normalizeEvent?: (event: Record<string, unknown>) => Record<string, unknown>;
  keepPendingTurnAliveAfterRetryingAgentEnd: () => boolean;
  keepPendingTurnAliveAfterRecoverableAssistantError: () => boolean;
  schedulePendingTurnCompletion: () => boolean;
  surfacePrimarySessionRuntimeIssue?: (input: SurfacePrimarySessionRuntimeIssueInput) => void | Promise<void>;
  publishRuntimeEvent?: (event: RuntimeEventV1) => void;
  publishUsageStatsBestEffort: () => Promise<void>;
  happierSessionId?: string | null;
  activeSessionId?: string | null;
  currentModelProvider?: string | null;
  classifyRuntimeAuthFailure?: (error: unknown) => ConnectedServiceRuntimeFailureClassification | null;
  reportRuntimeAuthFailureForPendingTurn?: (classification: ConnectedServiceRuntimeFailureClassification) => boolean;
  onRuntimeAuthFailure?: (input: Readonly<{
    happierSessionId: string | null;
    activeSessionId: string | null;
    classification: ConnectedServiceRuntimeFailureClassification;
  }>) => void | Promise<void>;
}>;

export type PiRpcStderrHandlerContext = Pick<
  PiRpcEventHandlerContext,
  | 'disposed'
  | 'currentModelProvider'
  | 'classifyRuntimeAuthFailure'
  | 'reportRuntimeAuthFailureForPendingTurn'
>;

export type PiRpcRuntimeTurnState = {
  activeRuntimeTurnId: string | null;
  activeProviderTurnId: string | null;
  failedRuntimeTurnId: string | null;
  failedProviderTurnId: string | null;
};

export function createPiRpcRuntimeTurnState(): PiRpcRuntimeTurnState {
  return {
    activeRuntimeTurnId: null,
    activeProviderTurnId: null,
    failedRuntimeTurnId: null,
    failedProviderTurnId: null,
  };
}

const PI_RPC_STRUCTURED_LIMIT_MARKER_PATTERN =
  /\b(usage_limit_reached|usage_limit_exceeded|usagelimitreached|usagelimitexceeded|freeusagelimiterror|go_usage_limit|gousagelimiterror|account_rate_limit|rate_limit|rate_limit_error|ratelimit|ratelimiterror|resource_exhausted)\b/iu;
const PI_RPC_LIMIT_EXHAUSTION_TEXT_PATTERN =
  /\b(usage\s*limit|rate\s*limit|too many requests|resource[_\s-]*exhausted|limit reached|out of credits|credits exhausted)\b|\bquota(?:[_\s-]*(?:exceeded|exhausted|reached)|[_\s-]*limit[_\s-]*(?:exceeded|exhausted|reached))\b/u;
const PI_RPC_RATE_LIMIT_STATUS_TEXT_PATTERN =
  /\b(?:http|status|code|error)["']?\s*[:=]?\s*429\b|\b429\b.*\btoo many requests\b|\btoo many requests\b.*\b429\b/u;

function collectPiStderrRuntimeAuthMarkerText(value: unknown, output: string[]): void {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectPiStderrRuntimeAuthMarkerText(item, output);
    return;
  }
  const record = asRecord(value);
  if (!record) return;
  for (const nested of Object.values(record)) {
    collectPiStderrRuntimeAuthMarkerText(nested, output);
  }
}

function readPiRuntimeAuthMarkerCode(value: unknown): string | null {
  if (typeof value === 'string') {
    return value.match(PI_RPC_STRUCTURED_LIMIT_MARKER_PATTERN)?.[0] ?? null;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const code = readPiRuntimeAuthMarkerCode(item);
      if (code) return code;
    }
    return null;
  }
  const record = asRecord(value);
  if (!record) return null;
  for (const nested of Object.values(record)) {
    const code = readPiRuntimeAuthMarkerCode(nested);
    if (code) return code;
  }
  return null;
}

function normalizePiRuntimeAuthStatusCode(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value) && value >= 100 && value <= 599) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[1-5]\d{2}$/u.test(trimmed)) return null;
  const status = Number(trimmed);
  return status >= 100 && status <= 599 ? status : null;
}

function isPiRuntimeAuthStatusCodeKey(key: string): boolean {
  return ['code', 'errorcode', 'httpstatus', 'status', 'statuscode'].includes(
    key.replace(/[_-]/gu, '').toLowerCase(),
  );
}

function readPiRuntimeAuthStatusCode(value: unknown): number | null {
  let fallback: number | null = null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const status = readPiRuntimeAuthStatusCode(item);
      if (status === 429) return status;
      fallback ??= status;
    }
    return fallback;
  }
  const record = asRecord(value);
  if (!record) return null;
  for (const [key, nested] of Object.entries(record)) {
    if (!isPiRuntimeAuthStatusCodeKey(key)) continue;
    const status = normalizePiRuntimeAuthStatusCode(nested);
    if (status === 429) return status;
    fallback ??= status;
  }
  for (const nested of Object.values(record)) {
    const status = readPiRuntimeAuthStatusCode(nested);
    if (status === 429) return status;
    fallback ??= status;
  }
  return fallback;
}

function looksLikeProviderLimitStderrLine(line: string): boolean {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    parsed = null;
  }

  const record = asRecord(parsed);
  if (record) {
    if (readPiRuntimeAuthStatusCode(record) === 429) return true;
    const parts: string[] = [];
    collectPiStderrRuntimeAuthMarkerText(record, parts);
    const markerText = parts.join(' ').toLowerCase();
    return PI_RPC_STRUCTURED_LIMIT_MARKER_PATTERN.test(markerText)
      || PI_RPC_LIMIT_EXHAUSTION_TEXT_PATTERN.test(markerText);
  }

  const normalized = line.toLowerCase();
  return PI_RPC_STRUCTURED_LIMIT_MARKER_PATTERN.test(line)
    || PI_RPC_LIMIT_EXHAUSTION_TEXT_PATTERN.test(normalized)
    || PI_RPC_RATE_LIMIT_STATUS_TEXT_PATTERN.test(normalized);
}

function buildPiStderrRuntimeAuthEvidence(
  line: string,
  provider: string | null,
): Record<string, unknown> {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(line) as unknown;
  } catch {
    parsed = null;
  }

  const record = asRecord(parsed);
  if (record) {
    const code = readPiRuntimeAuthMarkerCode(record)
      ?? asNonEmptyString(record.code ?? record.type ?? record.reason ?? record.name);
    const status = readPiRuntimeAuthStatusCode(record);
    const providerFallback = provider && !asNonEmptyString(record.provider ?? record.providerId)
      ? { provider }
      : {};
    return {
      ...providerFallback,
      ...record,
      ...(code ? { code } : {}),
      ...(status !== null ? { status } : {}),
      message: asNonEmptyString(record.message ?? record.errorMessage ?? record.error_message) ?? line,
    };
  }

  const code = readPiRuntimeAuthMarkerCode(line);
  const status = PI_RPC_RATE_LIMIT_STATUS_TEXT_PATTERN.test(line.toLowerCase()) ? 429 : null;
  return {
    ...(provider ? { provider } : {}),
    ...(code ? { code } : {}),
    ...(status ? { status } : {}),
    message: line,
  };
}

function reportRuntimeAuthFailure(
  context: PiRpcEventHandlerContext,
  classification: ConnectedServiceRuntimeFailureClassification,
): void {
  try {
    void Promise.resolve(context.onRuntimeAuthFailure?.({
      happierSessionId: context.happierSessionId ?? null,
      activeSessionId: context.activeSessionId ?? null,
      classification,
    })).catch((error) => {
      logger.debug('[pi] Runtime auth failure hook failed (non-fatal)', error);
    });
  } catch (error) {
    logger.debug('[pi] Runtime auth failure hook failed (non-fatal)', error);
  }
}

export function emitPiRpcMessage(
  messageHandlers: ReadonlySet<AgentMessageHandler>,
  message: AgentMessage,
): void {
  const safeMessage: AgentMessage =
    message.type === 'terminal-output'
      ? ({ ...message, data: redactBugReportSensitiveText(String(message.data ?? '')) } as AgentMessage)
      : message;

  for (const handler of messageHandlers) {
    try {
      handler(safeMessage);
    } catch (error) {
      logger.debug('[pi] Message handler failed (non-fatal)', error);
    }
  }
}

export function handlePiRpcResponse(
  context: PiRpcEventHandlerContext,
  emitMessage: (message: AgentMessage) => void,
  response: PiRpcResponse,
): void {
  const id = asNonEmptyString(response.id);
  if (!id) return;
  const pending = context.pendingRequests.get(id);
  if (!pending) {
    if (response.command === 'prompt' && !response.success && context.openPromptRequestIds.has(id)) {
      context.openPromptRequestIds.delete(id);
      const detail = asNonEmptyString(response.error) ?? 'Pi prompt failed';
      context.rejectPendingTurn(new Error(detail));
      void context.surfacePrimarySessionRuntimeIssue?.({
        provider: 'pi',
        cause: 'status_error',
        error: detail,
      });
      emitMessage({ type: 'status', status: 'error', detail });
    }
    return;
  }

  clearTimeout(pending.timeout);
  context.pendingRequests.delete(id);

  if (!response.success) {
    context.openPromptRequestIds.delete(id);
    pending.reject(new Error(asNonEmptyString(response.error) ?? `Pi RPC command failed: ${response.command}`));
    return;
  }
  if (pending.commandType === 'prompt') {
    context.openPromptRequestIds.add(id);
  }
  pending.resolve(response);
}

function readPiAssistantErrorMessage(event: Record<string, unknown>): string | null {
  if (event.type !== 'message_end') return null;
  const message = asRecord(event.message);
  if (!message || message.role !== 'assistant') return null;
  const stopReason = asNonEmptyString(message.stopReason ?? message.stop_reason);
  const errorMessage = asNonEmptyString(
    message.errorMessage ?? message.error_message ?? event.errorMessage ?? event.error_message,
  );
  if (stopReason !== 'error' && !errorMessage) return null;
  return errorMessage ?? 'Pi assistant message failed';
}

function createPiAssistantFailureError(
  detail: string,
  classification: ConnectedServiceRuntimeFailureClassification | null,
): Error {
  const error = new Error(detail);
  if (!classification) return error;
  return Object.assign(error, { runtimeAuthClassification: classification });
}

function handlePiAssistantFailureEvent(
  context: PiRpcEventHandlerContext,
  emitMessage: (message: AgentMessage) => void,
  event: Record<string, unknown>,
): void {
  const detail = readPiAssistantErrorMessage(event);
  if (!detail) return;
  const classification = context.classifyRuntimeAuthFailure?.(event) ?? null;
  // Pi's overflow/server-capacity recovery *begins* with an assistant
  // `message_end{stopReason:'error'}` and then self-heals via compaction, retry, or resumed tool
  // activity. Terminating the turn here re-creates the original stuck-after-compaction bug:
  // premature completion clears `turnInFlight`, and the next queued prompt collides with a
  // still-busy Pi. Capacity errors such as Codex `server_is_overloaded` are therefore owned by the
  // turn lifecycle (`agent_end`/willRetry, the compaction-resume grace, and the `get_state`
  // liveness probe) instead of this event. The recoverable error carries no surfaceable assistant
  // text, so suppressing the status here does not hide anything from the transcript.
  if (!classification) return;
  if (classification.kind === 'capacity') {
    reportRuntimeAuthFailure(context, classification);
    return;
  }
  emitMessage({ type: 'status', status: 'error', detail });
  const runtimeTurnState = context.runtimeTurnState;
  const activeRuntimeTurnId = runtimeTurnState.activeRuntimeTurnId ?? null;
  const activeProviderTurnId = runtimeTurnState.activeProviderTurnId ?? null;
  const failureError = createPiAssistantFailureError(detail, classification);
  void context.surfacePrimarySessionRuntimeIssue?.({
    provider: 'pi',
    ...(activeProviderTurnId ? { providerTurnId: activeProviderTurnId } : {}),
    cause: 'status_error',
    error: failureError,
    session: { sessionId: context.happierSessionId ?? undefined },
    sessionTurnId: activeRuntimeTurnId,
    publishRuntimeEvent: context.publishRuntimeEvent,
  });
  runtimeTurnState.failedRuntimeTurnId = activeRuntimeTurnId;
  runtimeTurnState.failedProviderTurnId = activeProviderTurnId;
  reportRuntimeAuthFailure(context, classification);
  context.rejectPendingTurn(failureError);
}

export function handlePiRpcEvent(
  context: PiRpcEventHandlerContext,
  emitMessage: (message: AgentMessage) => void,
  event: Record<string, unknown>,
): void {
  const normalizedEvent = context.normalizeEvent?.(event) ?? event;
  context.notePendingTurnActivity(normalizedEvent);
  const runtimeTurnState = context.runtimeTurnState;
  const providerTurnId = asNonEmptyString(normalizedEvent.turnId ?? normalizedEvent.id);
  const sessionId = asNonEmptyString(context.happierSessionId);

  if (normalizedEvent.type === 'turn_start' && sessionId) {
    const turnId = randomUUID();
    runtimeTurnState.activeRuntimeTurnId = turnId;
    runtimeTurnState.activeProviderTurnId = providerTurnId;
    context.publishRuntimeEvent?.({
      kind: 'turn-start',
      sessionId,
      emittedAtMs: Date.now(),
      turnId,
      ...(providerTurnId ? { providerTurnId } : {}),
      startedBy: 'provider',
    });
  }

  if (normalizedEvent.type === 'turn_end' && sessionId) {
    const turnId = runtimeTurnState.activeRuntimeTurnId ?? randomUUID();
    const activeProviderTurnId = providerTurnId ?? runtimeTurnState.activeProviderTurnId ?? null;
    const failedRuntimeTurnId = runtimeTurnState.failedRuntimeTurnId ?? null;
    const failedProviderTurnId = runtimeTurnState.failedProviderTurnId ?? null;
    const failedTurnAlreadyTerminated =
      failedRuntimeTurnId === turnId &&
      (!failedProviderTurnId || !activeProviderTurnId || failedProviderTurnId === activeProviderTurnId);
    if (!failedTurnAlreadyTerminated) {
      context.publishRuntimeEvent?.({
        kind: 'turn-complete',
        sessionId,
        emittedAtMs: Date.now(),
        turnId,
        ...(activeProviderTurnId ? { providerTurnId: activeProviderTurnId } : {}),
      });
    }
    runtimeTurnState.activeRuntimeTurnId = null;
    runtimeTurnState.activeProviderTurnId = null;
    if (failedTurnAlreadyTerminated) {
      runtimeTurnState.failedRuntimeTurnId = null;
      runtimeTurnState.failedProviderTurnId = null;
    }
  }

  for (const msg of mapPiRpcEventToAgentMessages(normalizedEvent)) {
    emitMessage(msg);
  }

  handlePiAssistantFailureEvent(context, emitMessage, normalizedEvent);

  if (normalizedEvent.type === 'agent_end') {
    const scheduledCompletion =
      normalizedEvent.willRetry === true
        ? context.keepPendingTurnAliveAfterRetryingAgentEnd()
        : context.keepPendingTurnAliveAfterRecoverableAssistantError() || context.schedulePendingTurnCompletion();
    if (!scheduledCompletion) {
      emitMessage({ type: 'status', status: 'idle' });
      void context.publishUsageStatsBestEffort();
    }
  }

  if (normalizedEvent.type === 'message_update') {
    const assistant = asRecord(normalizedEvent.assistantMessageEvent);
    const assistantType = asNonEmptyString(assistant?.type);
    if (assistantType === 'thinking_start') {
      emitMessage({ type: 'event', name: 'thinking_update', payload: { thinking: true } });
    } else if (assistantType === 'thinking_end' || assistantType === 'text_start' || assistantType === 'text_delta') {
      emitMessage({ type: 'event', name: 'thinking_update', payload: { thinking: false } });
    }
  }
}

export function handlePiRpcStdoutLine(
  context: PiRpcEventHandlerContext,
  emitMessage: (message: AgentMessage) => void,
  line: string,
): void {
  const trimmed = line.trim();
  if (!trimmed) return;

  const parsed = (() => {
    try {
      return JSON.parse(trimmed) as unknown;
    } catch {
      emitMessage({ type: 'terminal-output', data: line });
      return null;
    }
  })();
  if (!parsed) return;

  const record = asRecord(parsed);
  if (!record) return;

  if (record.type === 'response') {
    handlePiRpcResponse(context, emitMessage, record as PiRpcResponse);
    return;
  }

  handlePiRpcEvent(context, emitMessage, record);
}

export function handlePiRpcStderrLine(
  context: PiRpcStderrHandlerContext,
  emitMessage: (message: AgentMessage) => void,
  line: string,
): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  emitMessage({ type: 'terminal-output', data: trimmed });

  if (context.disposed) return;

  if (!looksLikeProviderLimitStderrLine(trimmed)) return;

  const classification = context.classifyRuntimeAuthFailure?.(
    buildPiStderrRuntimeAuthEvidence(trimmed, asNonEmptyString(context.currentModelProvider)),
  ) ?? null;
  if (!classification || (classification.kind !== 'usage_limit' && classification.kind !== 'rate_limit')) return;
  context.reportRuntimeAuthFailureForPendingTurn?.(classification);
}
