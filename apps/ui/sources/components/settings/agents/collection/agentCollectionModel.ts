import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import type { MachineAgent, MachineAgentState } from '@/agents/machineAgents/machineAgentTypes';
import { resolveHappierCollectionInitialKey } from '@happier-dev/plugin-ui/presentation';

export type AgentCollectionRowStatus = MachineAgentState | 'disabled';

export type AgentCollectionRow = Readonly<{
    entry: ResolvedAgentCatalogEntry;
    status: AgentCollectionRowStatus;
    signIn: MachineAgent['signIn'] | null;
    /** Only a problem the user must fix (a signed-out installed agent) is flagged. */
    trouble: boolean;
}>;

export type AgentCollection = Readonly<{
    /** Agents present on the selected machine, including ones still being detected or without a CLI. */
    onMachine: readonly AgentCollectionRow[];
    /** Agents needing installation or unsupported on the selected machine. */
    available: readonly AgentCollectionRow[];
    /** Every agent, before the name filter. */
    total: number;
}>;

/**
 * Groups the catalog by the canonical inventory state. Account enablement is an independent
 * presentation preference; machine readiness is never re-derived from CLI or sign-in facts here.
 */
export function buildAgentCollection(params: Readonly<{
    entries: readonly ResolvedAgentCatalogEntry[];
    agents: readonly MachineAgent[];
    query: string;
}>): AgentCollection {
    const query = params.query.trim().toLocaleLowerCase();
    const onMachine: AgentCollectionRow[] = [];
    const available: AgentCollectionRow[] = [];
    const agentsById = new Map(params.agents.map((agent) => [agent.agentId, agent]));
    for (const entry of params.entries) {
        if (query && !entry.title.toLocaleLowerCase().includes(query)) continue;
        const agent = agentsById.get(entry.agentId);
        if (agent?.state === 'notInstalled' || agent?.state === 'unsupported') {
            available.push({ entry, status: agent.state, signIn: agent.signIn, trouble: false });
            continue;
        }
        const status: AgentCollectionRowStatus = entry.enabled === false
            ? 'disabled'
            : agent?.state ?? 'unknown';
        onMachine.push({ entry, status, signIn: agent?.signIn ?? null, trouble: status === 'needsSignIn' && agent?.stale !== true });
    }
    return { onMachine, available, total: params.entries.length };
}

/** The agent the detail route addresses, matched the way `createAgentSettingsRoute` builds it. */
export function resolveSelectedAgentCollectionId(
    entries: readonly ResolvedAgentCatalogEntry[],
    route: Readonly<{ agentId: string | null; pluginId: string | null }>,
): string | null {
    if (!route.agentId) return null;
    const match = entries.find((entry) => (route.pluginId
        ? entry.identity?.pluginId === route.pluginId && entry.identity.localId === route.agentId
        : entry.identity === null && entry.agentId === route.agentId));
    return match?.agentId ?? null;
}

/**
 * The agent a wide collection opens when its route names none: the one visited last while it is
 * still listed, else the first agent on the machine, else the first listed.
 */
export function resolveAgentCollectionLandingId(
    collection: AgentCollection,
    lastVisitedAgentId: string | null,
): string | null {
    const rows = [...collection.onMachine, ...collection.available];
    return resolveHappierCollectionInitialKey({ keys: rows.map((row) => row.entry.agentId), lastVisited: lastVisitedAgentId });
}
