import type { HookEventEnvelopeV1 } from '@happier-dev/protocol';

import type { ResolvedActivatedHookRegistration } from '@/plugins/projection/registry/types';

type FilterableHookDefinition = Pick<
  ResolvedActivatedHookRegistration['definition'],
  'category' | 'scope' | 'filters'
>;

function normalizeNonEmpty(value: unknown): string | null {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return normalized.length > 0 ? normalized : null;
}

function readEnvelopeSessionIds(envelope: HookEventEnvelopeV1): readonly string[] {
  return [
    normalizeNonEmpty(envelope.happySessionId),
    normalizeNonEmpty(envelope.agentSessionId),
  ].filter((value): value is string => Boolean(value));
}

function readEnvelopeAgentId(envelope: HookEventEnvelopeV1): string | null {
  return normalizeNonEmpty((envelope as { agentId?: unknown }).agentId);
}

export function matchesHookRegistrationFilters(
  envelope: HookEventEnvelopeV1,
  registration: ResolvedActivatedHookRegistration,
): boolean {
  return matchesHookDefinitionFilters(envelope, registration.definition);
}

export function matchesHookDefinitionFilters(
  envelope: HookEventEnvelopeV1,
  definition: FilterableHookDefinition,
): boolean {
  if (definition.category !== envelope.category) return false;
  if (definition.scope !== envelope.scope) return false;

  const filters = definition.filters;
  if (!filters) return true;

  // Retired backend-vocabulary filters fail closed (they no longer exist on the schema).
  const legacyFilters = filters as { providerId?: unknown; backendId?: unknown; backendTargetId?: unknown };
  if (
    normalizeNonEmpty(legacyFilters.providerId)
    || normalizeNonEmpty(legacyFilters.backendId)
    || normalizeNonEmpty(legacyFilters.backendTargetId)
  ) {
    return false;
  }

  const agentIdFilter = normalizeNonEmpty(filters.agentId);
  if (agentIdFilter && agentIdFilter !== readEnvelopeAgentId(envelope)) {
    return false;
  }

  const runtimeTargetIdFilter = normalizeNonEmpty(filters.runtimeTargetId);
  if (runtimeTargetIdFilter && runtimeTargetIdFilter !== normalizeNonEmpty(envelope.backendTarget)) {
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
