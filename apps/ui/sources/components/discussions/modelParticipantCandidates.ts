import { rankHappierQueryMatches } from '@happier-dev/plugin-ui/presentation';

/**
 * Which new-session model participants the picker offers (lab T3): one row per Agent the viewer
 * already uses, on the Machine of their latest session with it, so the list names concrete Agents
 * on human Machine names instead of one setup row per Machine. Every Machine stays reachable by
 * searching its name; with no session naming an Agent and Machine, each Machine keeps its setup row.
 * Projects the session listing and Machine inventory the picker already holds; it reads nothing.
 */
export type ModelParticipantCandidateRow =
    | Readonly<{ kind: 'agent'; agentId: string; machineId: string; machineName: string }>
    | Readonly<{ kind: 'machine'; machineId: string; machineName: string }>;

export function projectModelParticipantCandidates(input: Readonly<{
    /**
     * Launchable Machines in the picker's order, already named by the canonical display owner;
     * `reachable` when presence says the Machine answers now (unknown counts as not).
     */
    machines: readonly Readonly<{ id: string; name: string; reachable?: boolean }>[];
    sessions: readonly Readonly<{ agentId: string | null | undefined; machineId: string | null | undefined; lastActivityAt: number | null | undefined }>[];
    query: string;
    /** The Run's chosen setup target, already scoped to this Home's inventory. */
    preferredMachineId?: string | null;
    /** False while the first session page is still being read: no Machine fallback is offered yet. */
    sessionsSettled?: boolean;
    /** The Agent's display name, so a search can find it; defaults to its id. */
    agentLabel?: (agentId: string) => string;
    /** Observed/catalog model names from the ordinary Session model owner, never availability. */
    agentSearchText?: (agentId: string) => string;
}>): readonly ModelParticipantCandidateRow[] {
    const names = new Map(input.machines.map(machine => [machine.id, machine.name]));
    const reachable = new Set(input.machines.flatMap(machine => machine.reachable ? [machine.id] : []));
    // Per Agent: its newest session overall (orders the rows) and its newest on a Machine that answers
    // now (places the row there, so choosing it does not open setup on an unreachable Machine).
    const latest = new Map<string, { at: number; machineId: string; reachableAt: number; reachableMachineId: string | null }>();
    for (const session of input.sessions) {
        if (!session.agentId || !session.machineId || !names.has(session.machineId)) continue;
        const at = session.lastActivityAt ?? 0;
        const held = latest.get(session.agentId)
            ?? { at: -Infinity, machineId: session.machineId, reachableAt: -Infinity, reachableMachineId: null };
        if (at > held.at) { held.at = at; held.machineId = session.machineId; }
        if (reachable.has(session.machineId) && at > held.reachableAt) {
            held.reachableAt = at; held.reachableMachineId = session.machineId;
        }
        latest.set(session.agentId, held);
    }
    const agents = [...latest].sort((a, b) => b[1].at - a[1].at).map(([agentId, held]): ModelParticipantCandidateRow => {
        const machineId = input.preferredMachineId && names.has(input.preferredMachineId)
            ? input.preferredMachineId : held.reachableMachineId ?? held.machineId;
        return { kind: 'agent', agentId, machineId, machineName: names.get(machineId)! };
    });
    const machineRows = input.machines.map((machine): ModelParticipantCandidateRow => ({
        kind: 'machine', machineId: machine.id, machineName: machine.name,
    }));
    const needle = input.query.trim().toLocaleLowerCase();
    if (!needle) return agents.length > 0 || input.sessionsSettled === false ? agents : machineRows;
    const label = input.agentLabel ?? ((agentId: string) => agentId);
    const queryText = (row: ModelParticipantCandidateRow) => ({
        label: row.kind === 'agent' ? label(row.agentId) : row.machineName,
        subtitle: row.machineName,
        searchText: row.kind === 'agent' ? input.agentSearchText?.(row.agentId) : undefined,
    });
    return [
        ...rankHappierQueryMatches(agents, input.query, queryText),
        ...rankHappierQueryMatches(machineRows, input.query, queryText),
    ];
}
