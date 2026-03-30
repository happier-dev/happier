import type { SessionSubagent } from '../types';

export function applyExecutionRunControlCapabilities(
    subagents: readonly SessionSubagent[],
    params: Readonly<{
        canControlExecutionRuns: boolean;
    }>,
): readonly SessionSubagent[] {
    if (params.canControlExecutionRuns) return subagents;

    return subagents.map((subagent) => {
        if (subagent.kind !== 'execution_run') return subagent;
        if (!subagent.capabilities.canSend && !subagent.capabilities.canStop) return subagent;
        return {
            ...subagent,
            capabilities: {
                ...subagent.capabilities,
                canSend: false,
                canStop: false,
            },
        } satisfies SessionSubagent;
    });
}
