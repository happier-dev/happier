import { asRecord, normalizeString } from './openCodeParsing.js';
import type { OpenCodeToolPart } from './providerActivity/createOpenCodeProviderActivityTracker.js';

export type OpenCodeServerRuntimeState = {
  providerSessionId: string | null;
  activeTurnId: string | null;
  turnInFlight: boolean;
  disposed: boolean;
  subscriptionAbort: AbortController | null;
  promptVariant: string | null;
  promptConfig: Readonly<Record<string, unknown>> | null;
  currentTurnObservedMessageIds: Set<string>;
  currentTurnObservedToolCallKeys: Set<string>;
  pendingProviderAutonomousBackgroundWake: {
    source: 'native-background-task' | 'oh-my-openagent-background-task';
    observedAtMs: number;
    messageId?: string | null;
  } | null;
};

export function createOpenCodeServerRuntimeState(): OpenCodeServerRuntimeState {
  return {
    providerSessionId: null,
    activeTurnId: null,
    turnInFlight: false,
    disposed: false,
    subscriptionAbort: null,
    promptVariant: null,
    promptConfig: null,
    currentTurnObservedMessageIds: new Set<string>(),
    currentTurnObservedToolCallKeys: new Set<string>(),
    pendingProviderAutonomousBackgroundWake: null,
  };
}

export function readStatusType(status: unknown): string {
  const record = asRecord(status);
  return normalizeString(record?.type);
}

export function createOpenCodeTurnId(): string {
  return `turn_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
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
  const status = normalizeString(asRecord(record.state)?.status);
  if (!sessionID || !callID || !tool || !status) return null;
  const messageID = normalizeString(record.messageID);
  return {
    sessionID,
    callID,
    tool,
    ...(messageID ? { messageID } : {}),
    state: {
      status,
      input: asRecord(record.state)?.input,
      output: asRecord(record.state)?.output,
      metadata: asRecord(record.state)?.metadata,
    },
  };
}

export function readOpenCodeToolCallKey(part: Pick<OpenCodeToolPart, 'sessionID' | 'callID'>): string {
  return `${part.sessionID}:${part.callID}`;
}

export function recordOpenCodeProviderAutonomousBackgroundWake(params: Readonly<{
  state: OpenCodeServerRuntimeState;
  source: 'native-background-task' | 'oh-my-openagent-background-task';
  messageId?: string | null;
}>): void {
  if (!params.state.providerSessionId || params.state.turnInFlight) return;
  params.state.pendingProviderAutonomousBackgroundWake = {
    source: params.source,
    observedAtMs: Date.now(),
    ...(params.messageId ? { messageId: params.messageId } : null),
  };
}
