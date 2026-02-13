import type { ProviderTraceEvent } from '../types';

import { payloadContainsSubstring } from './payloadContainsSubstring';

type ToolTraceEventV1 = ProviderTraceEvent;
type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as UnknownRecord;
}

function readStringField(record: UnknownRecord | null, keys: string[]): string | null {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

function normalizeToolName(toolName: unknown): string | null {
  if (typeof toolName !== 'string') return null;
  const trimmed = toolName.trim();
  if (!trimmed) return null;
  return trimmed.toLowerCase();
}

function keyParts(key: string): { kind: string; toolName: string | null } | null {
  // Examples:
  // - acp/opencode/tool-call/execute
  // - acp/opencode/tool-result/execute
  // - acp/opencode/permission-request/edit
  const parts = key.split('/').filter(Boolean);
  if (parts.length < 3) return null;
  const kind = parts[2];
  const toolName = parts.length >= 4 ? parts[3] : null;
  return { kind, toolName };
}

function getToolNameForEvent(event: ToolTraceEventV1): string | null {
  const payload = asRecord(event.payload);
  if (event.kind === 'tool-call') {
    return normalizeToolName(payload?.name);
  }
  if (event.kind === 'permission-request') {
    return normalizeToolName(payload?.toolName);
  }
  return null;
}

function getCallIdForEvent(event: ToolTraceEventV1): string | null {
  const payload = asRecord(event.payload);
  if (event.kind === 'tool-call') {
    return readStringField(payload, ['callId', 'id', 'toolCallId']);
  }
  if (event.kind === 'tool-result' || event.kind === 'tool-call-result') {
    // `tool_useId` is an old, inconsistent field observed in some legacy tool trace payloads.
    // Keep it as a compatibility fallback.
    return readStringField(payload, ['callId', 'tool_use_id', 'toolUseId', 'tool_useId']);
  }
  if (event.kind === 'permission-request') {
    return readStringField(payload, ['permissionId', 'toolCallId']);
  }
  return null;
}

function callIndexKey(event: ToolTraceEventV1, callId: string): string {
  return `${event.sessionId}/${callId}`;
}

function buildCallIdToToolNameIndex(events: ToolTraceEventV1[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of events) {
    if (e.kind !== 'tool-call' && e.kind !== 'permission-request') continue;
    const callId = getCallIdForEvent(e);
    const toolName = getToolNameForEvent(e);
    if (!callId || !toolName) continue;
    out.set(callIndexKey(e, callId), toolName);
  }
  return out;
}

function resolveToolNameForResultEvent(event: ToolTraceEventV1, index: Map<string, string>): string | null {
  const callId = getCallIdForEvent(event);
  if (!callId) return null;
  return index.get(callIndexKey(event, callId)) ?? null;
}

export function isImportedTraceEvent(event: ToolTraceEventV1): boolean {
  if (typeof event.localId === 'string' && event.localId.startsWith('acp-import:')) return true;
  const payload = asRecord(event.payload);
  const payloadId = readStringField(payload, ['id', 'eventId']);
  if (payloadId && payloadId.startsWith('import-')) return true;
  return false;
}

export function filterImportedTraceEvents(events: ToolTraceEventV1[]): ToolTraceEventV1[] {
  return events.filter((event) => !isImportedTraceEvent(event));
}

export function hasTraceForKey(events: ToolTraceEventV1[], key: string): boolean {
  const p = keyParts(key);
  if (!p) return false;
  const kind = p.kind;
  const toolName = normalizeToolName(p.toolName);

  const callIdIndex = buildCallIdToToolNameIndex(events);

  if (kind === 'tool-call') {
    if (!toolName) return events.some((e) => e.kind === 'tool-call');
    return events.some((e) => e.kind === 'tool-call' && getToolNameForEvent(e) === toolName);
  }

  if (kind === 'permission-request') {
    if (!toolName) return events.some((e) => e.kind === 'permission-request');
    return events.some((e) => e.kind === 'permission-request' && getToolNameForEvent(e) === toolName);
  }

  if (kind === 'tool-result') {
    const resultKinds = new Set(['tool-result', 'tool-call-result']);
    const hasAnyResult = events.some((e) => resultKinds.has(e.kind));
    if (!hasAnyResult) return false;
    if (!toolName) return true;

    // Correlate results to tool names via callId/tool_use_id mapping rather than assuming the presence of a tool-call is enough.
    return events.some((e) => resultKinds.has(e.kind) && resolveToolNameForResultEvent(e, callIdIndex) === toolName);
  }

  return false;
}

export function scenarioSatisfiedByTrace(events: ToolTraceEventV1[], scenario: {
  requiredFixtureKeys?: string[];
  requiredAnyFixtureKeys?: string[][];
  requiredTraceSubstrings?: string[];
}): boolean {
  for (const key of scenario.requiredFixtureKeys ?? []) {
    if (!hasTraceForKey(events, key)) return false;
  }
  for (const bucket of scenario.requiredAnyFixtureKeys ?? []) {
    if (!bucket.some((k) => hasTraceForKey(events, k))) return false;
  }
  for (const needle of scenario.requiredTraceSubstrings ?? []) {
    const ok = events.some((e) => payloadContainsSubstring(e.payload, needle));
    if (!ok) return false;
  }
  return true;
}

export function checkMaxTraceEvents(
  events: ToolTraceEventV1[],
  limits: { toolCalls?: number; toolResults?: number; permissionRequests?: number },
): { ok: true } | { ok: false; reason: string } {
  // These traces are based on "UI tool events" (tool-call/tool-result) and may include streaming updates
  // for the same callId. For deterministic e2e assertions we cap the number of *distinct* calls/results,
  // not raw event rows.
  const toolCallIds = new Set<string>();
  let toolCallsWithoutId = 0;
  for (const e of events) {
    if (e.kind !== 'tool-call') continue;
    const callId = getCallIdForEvent(e);
    if (!callId) {
      toolCallsWithoutId++;
      continue;
    }
    toolCallIds.add(callIndexKey(e, callId));
  }

  const toolResultIds = new Set<string>();
  let toolResultsWithoutId = 0;
  for (const e of events) {
    if (e.kind !== 'tool-result' && e.kind !== 'tool-call-result') continue;
    const callId = getCallIdForEvent(e);
    if (!callId) {
      toolResultsWithoutId++;
      continue;
    }
    toolResultIds.add(callIndexKey(e, callId));
  }

  const permissionRequestIds = new Set<string>();
  let permissionRequestsWithoutId = 0;
  for (const e of events) {
    if (e.kind !== 'permission-request') continue;
    const callId = getCallIdForEvent(e);
    if (!callId) {
      permissionRequestsWithoutId++;
      continue;
    }
    permissionRequestIds.add(callIndexKey(e, callId));
  }

  const toolCalls = toolCallIds.size + toolCallsWithoutId;
  const toolResults = toolResultIds.size + toolResultsWithoutId;
  const permissionRequests = permissionRequestIds.size + permissionRequestsWithoutId;

  if (typeof limits.toolCalls === 'number' && toolCalls > limits.toolCalls) {
    return { ok: false, reason: `Exceeded max toolCalls (${toolCalls} > ${limits.toolCalls})` };
  }
  if (typeof limits.toolResults === 'number' && toolResults > limits.toolResults) {
    return { ok: false, reason: `Exceeded max toolResults (${toolResults} > ${limits.toolResults})` };
  }
  if (typeof limits.permissionRequests === 'number' && permissionRequests > limits.permissionRequests) {
    return { ok: false, reason: `Exceeded max permissionRequests (${permissionRequests} > ${limits.permissionRequests})` };
  }

  return { ok: true };
}
