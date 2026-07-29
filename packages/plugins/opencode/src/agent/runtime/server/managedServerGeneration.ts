import type { OpenCodeManagedServerSnapshot } from './runtimeContext.js';

/**
 * Redactable view of the host-issued managed-server incarnation. The provider may compare this
 * opaque value, but it must never derive incarnation from PID, timestamp, port, or base URL facts.
 */
export type OpenCodeManagedServerGenerationIdentity = Readonly<{
  id: string;
  baseUrl: string;
  pid: number;
  startedAtMs: number;
  port?: number;
  generationKey: string;
}>;

/** Convert the host snapshot into the foreground runtime's loggable comparison view. */
export function resolveOpenCodeManagedServerGenerationIdentity(
  snapshot: OpenCodeManagedServerSnapshot,
): OpenCodeManagedServerGenerationIdentity {
  const instanceId = typeof snapshot.instanceId === 'string' ? snapshot.instanceId.trim() : '';
  if (!instanceId) {
    throw new Error('OpenCode managed server snapshot is missing its host-issued instanceId');
  }
  const partial: Omit<OpenCodeManagedServerGenerationIdentity, 'generationKey'> = {
    id: snapshot.id,
    baseUrl: typeof snapshot.baseUrl === 'string' ? snapshot.baseUrl : '',
    pid: Number.isFinite(snapshot.pid) && (snapshot.pid ?? -1) > 0 ? (snapshot.pid as number) : -1,
    startedAtMs: Number.isFinite(snapshot.startedAt) ? (snapshot.startedAt as number) : 0,
    ...(Number.isFinite(snapshot.port) && (snapshot.port ?? -1) > 0 ? { port: snapshot.port as number } : {}),
  };
  return {
    ...partial,
    generationKey: instanceId,
  };
}

export function isSameOpenCodeManagedServerGeneration(
  a: OpenCodeManagedServerGenerationIdentity | null,
  b: OpenCodeManagedServerGenerationIdentity | null,
): boolean {
  if (!a || !b) return a === b;
  return a.generationKey === b.generationKey;
}

function describeBaseUrlForLog(baseUrl: string): string {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return '';
  }
}

/**
 * Sanitized, log-safe summary. The opaque instance id is truncated for compact logs; no
 * credential env values are ever included.
 */
export function describeOpenCodeManagedServerGenerationForLog(
  identity: OpenCodeManagedServerGenerationIdentity | null,
): Record<string, unknown> {
  if (!identity) return { present: false };
  return {
    id: identity.id,
    generationKey: identity.generationKey.slice(0, 12),
    baseUrl: describeBaseUrlForLog(identity.baseUrl),
    pid: identity.pid,
    startedAtMs: identity.startedAtMs,
    ...(identity.port !== undefined ? { port: identity.port } : {}),
  };
}
