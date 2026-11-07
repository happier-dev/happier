import type { ServerAccountScopeLifetime } from '../scope/serverAccountScope';

// Retained history rows are reusable content, never read demand. Each presented
// consumer contributes only its current ids within the incumbent Account lifetime.
const consumers = new WeakMap<ServerAccountScopeLifetime, Set<readonly string[]>>();

export function retainAutomationRunHistoryDemand(
    lifetime: ServerAccountScopeLifetime | null,
    automationIds: readonly string[],
): () => void {
    if (!lifetime?.isCurrent() || automationIds.length === 0) return () => {};
    const demands = consumers.get(lifetime) ?? new Set<readonly string[]>();
    consumers.set(lifetime, demands);
    demands.add(automationIds);
    const retirement = lifetime.onRetire(() => { demands.delete(automationIds); });
    return () => {
        retirement.dispose();
        demands.delete(automationIds);
    };
}

export function readAutomationRunHistoryDemand(lifetime: ServerAccountScopeLifetime | null): readonly string[] {
    return lifetime?.isCurrent() ? [...new Set([...(consumers.get(lifetime) ?? [])].flat())] : [];
}
