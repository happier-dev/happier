import { asRecord, normalizeString } from './openCodeParsing.js';
import type { OpenCodeToolPart } from './foregroundToolTracker.js';

export type OpenCodeServerRuntimeState = {
  providerSessionId: string | null;
  activeTurnId: string | null;
  turnInFlight: boolean;
  disposed: boolean;
  subscriptionAbort: AbortController | null;
  subscriptionReconnectTimer: ReturnType<typeof setTimeout> | null;
  promptVariant: string | null;
  promptConfig: Readonly<Record<string, unknown>> | null;
  currentTurnObservedMessageIds: Set<string>;
  currentTurnObservedToolCallKeys: Set<string>;
  currentTurnPublishedToolCallKeys: Set<string>;
  currentTurnPublishedToolResultKeys: Set<string>;
  currentTurnProviderUserMessageId: string | null;
  currentTurnProviderUserMessageIds: Set<string>;
  currentTurnProviderPromptTexts: Set<string>;
  currentTurnPromptSubmittedAtMs: number | null;
  currentTurnPromptAcceptedAtMs: number | null;
  currentTurnIdleObserved: boolean;
  currentTurnTerminalAssistantMessageIds: Set<string>;
  currentTurnPublishedAssistantMessageIds: Set<string>;
  emittedAssistantMessageIds: Set<string>;
};

export function createOpenCodeServerRuntimeState(): OpenCodeServerRuntimeState {
  return {
    providerSessionId: null,
    activeTurnId: null,
    turnInFlight: false,
    disposed: false,
    subscriptionAbort: null,
    subscriptionReconnectTimer: null,
    promptVariant: null,
    promptConfig: null,
    currentTurnObservedMessageIds: new Set<string>(),
    currentTurnObservedToolCallKeys: new Set<string>(),
    currentTurnPublishedToolCallKeys: new Set<string>(),
    currentTurnPublishedToolResultKeys: new Set<string>(),
    currentTurnProviderUserMessageId: null,
    currentTurnProviderUserMessageIds: new Set<string>(),
    currentTurnProviderPromptTexts: new Set<string>(),
    currentTurnPromptSubmittedAtMs: null,
    currentTurnPromptAcceptedAtMs: null,
    currentTurnIdleObserved: false,
    currentTurnTerminalAssistantMessageIds: new Set<string>(),
    currentTurnPublishedAssistantMessageIds: new Set<string>(),
    emittedAssistantMessageIds: new Set<string>(),
  };
}

export function readStatusType(status: unknown): string {
  const record = asRecord(status);
  return normalizeString(record?.type);
}

export function claimOpenCodeActiveTurnForTerminalEvent(
  state: OpenCodeServerRuntimeState,
): string | null {
  if (!state.turnInFlight || !state.activeTurnId) return null;
  const turnId = state.activeTurnId;
  state.turnInFlight = false;
  state.activeTurnId = null;
  return turnId;
}

export function readProviderEvent(event: unknown): Readonly<{
  type: string;
  properties: Readonly<Record<string, unknown>>;
}> {
  const eventRecord = asRecord(event);
  const payload = asRecord(eventRecord?.payload) ?? eventRecord;
  const type = normalizeString(payload?.type);
  const properties = asRecord(payload?.properties) ?? {};
  return { type, properties };
}

export function readEventSessionId(properties: Readonly<Record<string, unknown>>): string {
  return normalizeString(properties.sessionID)
    || normalizeString(asRecord(properties.session)?.id)
    || normalizeString(asRecord(properties.part)?.sessionID)
    || normalizeString(asRecord(properties.info)?.sessionID);
}

export function readOpenCodeToolPart(value: unknown): OpenCodeToolPart | null {
  const record = asRecord(value);
  if (!record || normalizeString(record.type) !== 'tool') return null;
  const sessionID = normalizeString(record.sessionID);
  const callID = normalizeString(record.callID);
  const tool = normalizeString(record.tool);
  const state = asRecord(record.state);
  const status = normalizeString(state?.status);
  if (!sessionID || !callID || !tool || !status) return null;
  const messageID = normalizeString(record.messageID);
  return {
    sessionID,
    callID,
    tool,
    ...(messageID ? { messageID } : {}),
    state: {
      status,
      input: state?.input,
      output: state?.output,
      title: normalizeString(state?.title) || undefined,
      metadata: state?.metadata,
    },
  };
}

export function readOpenCodeToolCallKey(part: Pick<OpenCodeToolPart, 'sessionID' | 'callID'>): string {
  return `${part.sessionID}:${part.callID}`;
}
