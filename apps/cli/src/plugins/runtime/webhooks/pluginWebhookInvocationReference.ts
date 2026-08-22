import { AsyncLocalStorage } from 'node:async_hooks';

import {
  AutomationEventAdmitInputV1Schema,
  AutomationEventAdmitResultV1Schema,
  PluginWebhookAutomationAdmissionUnresolvedV1Schema,
  PluginWebhookInvocationReferenceV1Schema,
  type PluginWebhookAutomationAdmissionUnresolvedV1,
  type PluginWebhookInvocationReferenceV1,
} from '@happier-dev/protocol';

type AutomationAdmissionUnresolvedStatusV1 = Readonly<{
  kind: 'refreshDefinition' | 'blocked';
  reason: 'definitionStale' | 'observationTargetChanged' | 'capacity' | 'temporarilyUnavailable' | 'occurrenceConflict';
}>;

type AutomationAdmissionUnresolvedCollectorV1 = {
  invalid: boolean;
  seenAutomationIds: Set<string>;
  unresolvedByAutomationId: Map<string, AutomationAdmissionUnresolvedStatusV1>;
};

type PluginWebhookInvocationScopeV1 = Readonly<{
  referenceWithoutLease: Omit<PluginWebhookInvocationReferenceV1, 'lease'>;
  readLease(): PluginWebhookInvocationReferenceV1['lease'] | null;
  signal: AbortSignal;
}>;

type ActivePluginWebhookInvocationScopeV1 = PluginWebhookInvocationScopeV1 & {
  active: boolean;
  automationAdmissionUnresolved: AutomationAdmissionUnresolvedCollectorV1;
};

const invocationStorage = new AsyncLocalStorage<ActivePluginWebhookInvocationScopeV1>();

function readActiveScopeV1(): ActivePluginWebhookInvocationScopeV1 | null {
  const scope = invocationStorage.getStore();
  if (!scope?.active || scope.signal.aborted || !scope.readLease()) return null;
  return scope;
}

export function readCurrentPluginWebhookInvocationReferenceV1(): PluginWebhookInvocationReferenceV1 | null {
  const scope = readActiveScopeV1();
  if (!scope) return null;
  const lease = scope.readLease();
  if (!lease) return null;
  const parsed = PluginWebhookInvocationReferenceV1Schema.safeParse({
    ...scope.referenceWithoutLease,
    lease,
  });
  return parsed.success ? parsed.data : null;
}

/**
 * Host-only cancellation custody for the active generic Webhook invocation.
 * Unlike the reference reader, this intentionally exposes an aborted signal
 * while the async scope is still active so a host admission path cannot fall
 * back to checkpointed-pull after its durable invocation has been cancelled.
 */
export function readCurrentPluginWebhookInvocationSignalV1(): AbortSignal | null {
  const scope = invocationStorage.getStore();
  return scope?.active ? scope.signal : null;
}

/**
 * Records an exact, already canonical Automation admission pair only while a
 * generic Webhook worker owns the current invocation. Plugin code cannot
 * access this host-private scope or author a summary directly.
 */
export function recordCurrentPluginWebhookAutomationAdmissionResultV1(params: Readonly<{
  input: unknown;
  result: unknown;
}>): void {
  const scope = readActiveScopeV1();
  if (!scope || scope.automationAdmissionUnresolved.invalid) return;
  const input = AutomationEventAdmitInputV1Schema.safeParse(params.input);
  const result = AutomationEventAdmitResultV1Schema.safeParse(params.result);
  if (!input.success || !result.success || input.data.definitions.length !== result.data.results.length) {
    scope.automationAdmissionUnresolved.invalid = true;
    return;
  }
  for (let index = 0; index < input.data.definitions.length; index += 1) {
    const automationId = input.data.definitions[index]!.automationId;
    const item = result.data.results[index]!;
    if (scope.automationAdmissionUnresolved.seenAutomationIds.has(automationId)) {
      // A summary has one exact result per Automation. A duplicate membership
      // would require inventing which authoritative result to retain.
      scope.automationAdmissionUnresolved.invalid = true;
      return;
    }
    scope.automationAdmissionUnresolved.seenAutomationIds.add(automationId);
    if (item.kind === 'refreshDefinition' || item.kind === 'blocked') {
      scope.automationAdmissionUnresolved.unresolvedByAutomationId.set(automationId, {
        kind: item.kind,
        reason: item.reason,
      });
    }
  }
  if (scope.automationAdmissionUnresolved.seenAutomationIds.size > 10_000) {
    scope.automationAdmissionUnresolved.invalid = true;
  }
}

/** Marks a partially executed or non-authoritative admission path unusable. */
export function invalidateCurrentPluginWebhookAutomationAdmissionResultV1(): void {
  const scope = readActiveScopeV1();
  if (scope) scope.automationAdmissionUnresolved.invalid = true;
}

export function readCurrentPluginWebhookAutomationAdmissionUnresolvedV1(): PluginWebhookAutomationAdmissionUnresolvedV1 | null {
  const scope = readActiveScopeV1();
  if (!scope || scope.automationAdmissionUnresolved.invalid) return null;
  const unresolved = Array.from(scope.automationAdmissionUnresolved.unresolvedByAutomationId.entries())
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  if (unresolved.length === 0) return null;
  const entries: Array<Readonly<{
    automationId: string;
    status: AutomationAdmissionUnresolvedStatusV1;
  }>> = [];
  for (const [automationId, status] of unresolved.slice(0, 100)) {
    const candidateEntries = [...entries, { automationId, status }];
    const candidate = {
      v: 1 as const,
      kind: 'automationAdmissionUnresolved' as const,
      totalCount: unresolved.length,
      entries: candidateEntries,
      omittedCount: unresolved.length - candidateEntries.length,
    };
    if (!PluginWebhookAutomationAdmissionUnresolvedV1Schema.safeParse(candidate).success) break;
    entries.push({ automationId, status });
  }
  if (entries.length === 0) return null;
  return PluginWebhookAutomationAdmissionUnresolvedV1Schema.parse({
    v: 1,
    kind: 'automationAdmissionUnresolved',
    totalCount: unresolved.length,
    entries,
    omittedCount: unresolved.length - entries.length,
  });
}

export async function runWithPluginWebhookInvocationReferenceV1<T>(
  scope: PluginWebhookInvocationScopeV1,
  operation: () => Promise<T>,
): Promise<T> {
  const activeScope: ActivePluginWebhookInvocationScopeV1 = {
    ...scope,
    active: true,
    automationAdmissionUnresolved: {
      invalid: false,
      seenAutomationIds: new Set(),
      unresolvedByAutomationId: new Map(),
    },
  };
  return await invocationStorage.run(activeScope, async () => {
    try {
      return await operation();
    } finally {
      activeScope.active = false;
    }
  });
}
