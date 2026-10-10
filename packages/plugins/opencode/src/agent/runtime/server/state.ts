import { asRecord, normalizeString, readNonBlankOpaqueIdentifier } from './openCodeParsing.js';
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

/**
 * The provider session an event is addressed to. OpenCode minted this id and
 * the runtime compares it against the id it holds for its own session, so the
 * reader decides presence and returns the exact bytes.
 */
export function readEventSessionId(properties: Readonly<Record<string, unknown>>): string {
  return readNonBlankOpaqueIdentifier(properties.sessionID)
    ?? readNonBlankOpaqueIdentifier(asRecord(properties.session)?.id)
    ?? readNonBlankOpaqueIdentifier(asRecord(properties.part)?.sessionID)
    ?? readNonBlankOpaqueIdentifier(asRecord(properties.info)?.sessionID)
    ?? '';
}

export function readOpenCodeToolPart(value: unknown): OpenCodeToolPart | null {
  const record = asRecord(value);
  if (!record || normalizeString(record.type) !== 'tool') return null;
  // `sessionID`, `callID` and `messageID` are ids OpenCode minted and keys the
  // runtime correlates tool lifecycle on; `tool` and `status` are vocabulary.
  const sessionID = readNonBlankOpaqueIdentifier(record.sessionID) ?? '';
  const callID = readNonBlankOpaqueIdentifier(record.callID) ?? '';
  const tool = normalizeString(record.tool);
  const state = asRecord(record.state);
  const status = normalizeString(state?.status);
  if (!sessionID || !callID || !tool || !status) return null;
  const messageID = readNonBlankOpaqueIdentifier(record.messageID) ?? '';
  return {
    sessionID,
    callID,
    tool,
    ...(tool === 'task' || tool === 'subagent' ? { nativeChildLaunch: true as const } : {}),
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
