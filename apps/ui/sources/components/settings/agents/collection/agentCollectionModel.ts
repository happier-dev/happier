import type { ResolvedAgentCatalogEntry } from '@/agents/backendCatalog/agentCatalogProjection';
import type { MachineAgent, MachineAgentState } from '@/agents/machineAgents/machineAgentTypes';
import { CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1 } from '@happier-dev/protocol/agents/executionTargetV1';
import type { AcpBackendDefinitionV1 } from '@happier-dev/protocol/acp/catalog/settingsV1';

/** `installsOnFirstUse`: a registry agent not on this machine yet; a session's first start installs it. */
export type AgentCollectionRowStatus = MachineAgentState | 'disabled' | 'installsOnFirstUse';

/** An Account ACP definition listed with the agents (a registry agent), with its resolved catalog presentation. */
export type AgentCollectionDefinition = Readonly<{ definition: AcpBackendDefinitionV1; entry: ResolvedAgentCatalogEntry }>;

export type AgentCollectionRow = Readonly<{
    /** Unique in the collection: an agent id, or `definition:<id>` for a definition. */
    key: string;
    entry: ResolvedAgentCatalogEntry;
    /** Set for a registry agent: it opens its definition, not a catalog agent route. */
    definition?: AcpBackendDefinitionV1;
    status: AgentCollectionRowStatus;
    signIn: MachineAgent['signIn'] | null;
    /** Last verified sign-in trouble; pending refreshes do not resolve it. */
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
    /** Registry definitions (not command agents): listed beside the agents by their detected state (P9 F8). */
    definitions?: readonly AgentCollectionDefinition[];
    query: string;
}>): AgentCollection {
    const onMachine: AgentCollectionRow[] = [];
    const available: AgentCollectionRow[] = [];
    const agentsById = new Map(params.agents.map((agent) => [agent.agentId, agent]));
    // Configured custom ACP agents are listed once, in their own group with their editor.
    const entries = params.entries.filter((entry) => !isCustomAcpAgentEntry(entry));
    for (const entry of entries) {
        const agent = agentsById.get(entry.agentId);
        if (agent?.state === 'notInstalled' || agent?.state === 'unsupported') {
            available.push({ key: entry.agentId, entry, status: agent.state, signIn: agent.signIn, trouble: false });
            continue;
        }
        const status: AgentCollectionRowStatus = entry.enabled === false
            ? 'disabled'
            : agent?.state ?? 'unknown';
        onMachine.push({ key: entry.agentId, entry, status, signIn: agent?.signIn ?? null, trouble: status !== 'disabled' && agent?.signInTrouble === true });
    }
    const definitions = (params.definitions ?? []).filter(({ definition }) => !isCommandAgentDefinition(definition));
    const agentsByDefinition = new Map(params.agents.flatMap((agent) => (agent.definitionId ? [[agent.definitionId, agent] as const] : [])));
    for (const { definition, entry } of definitions) {
        const key = `definition:${definition.id}`;
        const agent = agentsByDefinition.get(definition.id);
        if (!agent || agent.state === 'notInstalled' || agent.state === 'unsupported') {
            available.push({ key, entry, definition, status: agent?.state === 'unsupported' ? 'unsupported' : 'installsOnFirstUse', signIn: agent?.signIn ?? null, trouble: false });
            continue;
        }
        const status: AgentCollectionRowStatus = entry.enabled === false ? 'disabled' : agent.state;
        onMachine.push({ key, entry, definition, status, signIn: agent.signIn, trouble: status !== 'disabled' && agent.signInTrouble === true });
    }
    return filterAgentCollectionByQuery({ onMachine, available, total: entries.length + definitions.length }, params.query);
}

/** Text search is a local lens; ordinary held facts stay available to the condition header. */
/**
 * What a row asks of the viewer, for the rail and the grid alike: a sign-in whenever the machine reports one
 * (verified trouble or not; amber needs you, lab phone-system p4), else a failure or an update; healthy rows say nothing.
 */
export function resolveAgentRowAttention(row: AgentCollectionRow): 'signIn' | 'failed' | 'update' | null {
    if (row.trouble || row.status === 'needsSignIn') return 'signIn';
    if (row.status === 'failed') return 'failed';
    return row.status === 'updateAvailable' ? 'update' : null;
}

export function filterAgentCollectionByQuery(collection: AgentCollection, query: string): AgentCollection {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return collection;
    const matches = (row: AgentCollectionRow) => row.entry.title.toLocaleLowerCase().includes(normalized);
    return { ...collection, onMachine: collection.onMachine.filter(matches), available: collection.available.filter(matches) };
}

/** "Custom agents" are the ones started from a command; a registry agent is an agent like the built-in ones. */
export function isCommandAgentDefinition(definition: AcpBackendDefinitionV1): boolean {
    return definition.launch.kind === 'command';
}

function isCustomAcpAgentEntry(entry: ResolvedAgentCatalogEntry): boolean {
    return entry.identity?.pluginId === CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.pluginId
        && entry.identity.localId === CUSTOM_ACP_AGENT_CONTRIBUTION_IDENTITY_V1.localId;
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
