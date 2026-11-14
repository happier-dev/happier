import type { ServerAccountScopeLifetime } from '../scope/serverAccountScope';

type Demand = Readonly<{ runIds?: readonly string[]; privateDefinitions?: true }>;
// Presentation demand shares the incumbent Account lifetime; retained rows never create demand.
const consumers = new WeakMap<ServerAccountScopeLifetime, Set<Demand>>();

function retain(lifetime: ServerAccountScopeLifetime | null, demand: Demand): () => void {
    if (!lifetime?.isCurrent()) return () => {};
    const demands = consumers.get(lifetime) ?? new Set<Demand>();
    consumers.set(lifetime, demands);
    demands.add(demand);
    const retirement = lifetime.onRetire(() => { demands.delete(demand); });
    return () => { retirement.dispose(); demands.delete(demand); };
}

export function retainAutomationRunHistoryDemand(lifetime: ServerAccountScopeLifetime | null,
    automationIds: readonly string[]): () => void {
    return automationIds.length ? retain(lifetime, { runIds: automationIds }) : () => {};
}

export function retainAutomationDefinitionDetailsDemand(lifetime: ServerAccountScopeLifetime | null): () => void {
    return retain(lifetime, { privateDefinitions: true });
}

export function readAutomationRunHistoryDemand(lifetime: ServerAccountScopeLifetime | null): readonly string[] {
    return lifetime?.isCurrent() ? [...new Set([...(consumers.get(lifetime) ?? [])].flatMap(demand => demand.runIds ?? []))] : [];
}

export function readAutomationDefinitionDetailsDemand(lifetime: ServerAccountScopeLifetime | null): boolean {
    return !!lifetime?.isCurrent() && [...(consumers.get(lifetime) ?? [])].some(demand => demand.privateDefinitions);
}
