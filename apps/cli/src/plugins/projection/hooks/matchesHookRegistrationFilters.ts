import type { HookEventEnvelopeV1 } from '@happier-dev/protocol';

import type { ResolvedHookRegistration } from '@/plugins/projection/registry/types';

function normalizeNonEmpty(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function readEnvelopeSessionIds(envelope: HookEventEnvelopeV1): readonly string[] {
  return [
    normalizeNonEmpty(envelope.happySessionId),
    normalizeNonEmpty(envelope.providerSessionId),
  ].filter((value): value is string => Boolean(value));
}

export function matchesHookRegistrationFilters(
  envelope: HookEventEnvelopeV1,
  registration: ResolvedHookRegistration,
): boolean {
  const definition = registration.definition;
  if (definition.category !== envelope.category) return false;
  if (definition.scope !== envelope.scope) return false;

  const filters = definition.filters;
  if (!filters) return true;

  if (normalizeNonEmpty(filters.providerId) && normalizeNonEmpty(filters.providerId) !== normalizeNonEmpty(envelope.providerId)) {
    return false;
  }

  if (normalizeNonEmpty(filters.backendId) && normalizeNonEmpty(filters.backendId) !== normalizeNonEmpty(envelope.backendId)) {
    return false;
  }

  if (normalizeNonEmpty(filters.backendTargetId) && normalizeNonEmpty(filters.backendTargetId) !== normalizeNonEmpty(envelope.backendTarget)) {
    return false;
  }

  if (normalizeNonEmpty(filters.sessionId)) {
    const sessionIds = readEnvelopeSessionIds(envelope);
    if (!sessionIds.includes(normalizeNonEmpty(filters.sessionId)!)) {
      return false;
    }
  }

  if (normalizeNonEmpty(filters.workspaceId) && normalizeNonEmpty(filters.workspaceId) !== normalizeNonEmpty(envelope.workspaceId)) {
    return false;
  }

  if (normalizeNonEmpty(filters.machineId) && normalizeNonEmpty(filters.machineId) !== normalizeNonEmpty(envelope.machineId)) {
    return false;
  }

  if (normalizeNonEmpty(filters.cwdPrefix)) {
    const cwd = normalizeNonEmpty(envelope.cwd);
    if (!cwd || !cwd.startsWith(normalizeNonEmpty(filters.cwdPrefix)!)) {
      return false;
    }
  }

  if (Array.isArray(filters.eventNames) && filters.eventNames.length > 0) {
    const eventNames = filters.eventNames.map((eventName) => normalizeNonEmpty(eventName)).filter((value): value is string => Boolean(value));
    if (!eventNames.includes(envelope.eventId)) {
      return false;
    }
  }

  return true;
}
