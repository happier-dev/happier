import type { AgentState } from '@/api/types';

function isStringKeyedRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Shallow-clone a string-keyed record into a null-prototype object.
 *
 * Null-prototype objects avoid `__proto__` mutation semantics and collisions with
 * Object.prototype keys when the record keys are not trusted.
 */
export function cloneStringKeyedRecordToNullProto<V>(value: Record<string, V> | null | undefined): Record<string, V>;
export function cloneStringKeyedRecordToNullProto<V = unknown>(value: unknown): Record<string, V> {
  const out = Object.create(null) as Record<string, V>;
  if (!isStringKeyedRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    out[key] = entry as V;
  }
  return out;
}

export function clonePlainObjectToNullProto(value: unknown): Record<string, unknown> | null {
  if (!isStringKeyedRecord(value)) return null;
  const out = Object.create(null) as Record<string, unknown>;
  for (const [key, entry] of Object.entries(value)) {
    out[key] = entry;
  }
  return out;
}

export function applyAgentStateRequestPushNotifiedAt(params: {
  state: AgentState;
  permissionId: string;
  notifiedAtMs: number;
}): AgentState {
  type RequestsRecord = NonNullable<AgentState['requests']>;
  const requests = cloneStringKeyedRecordToNullProto<RequestsRecord[string]>(params.state.requests);
  const existing = requests[params.permissionId] as unknown;
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) return params.state;
  const req = clonePlainObjectToNullProto(existing) ?? Object.create(null);

  const already = req['pushNotifiedAt'];
  if (typeof already === 'number' && Number.isFinite(already) && already > 0) return params.state;

  req['pushNotifiedAt'] = params.notifiedAtMs;
  requests[params.permissionId] = req as RequestsRecord[string];
  return { ...params.state, requests };
}
