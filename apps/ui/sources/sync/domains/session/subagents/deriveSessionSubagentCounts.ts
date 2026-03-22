import type { SessionSubagent } from './types';

export function deriveSessionSubagentCounts(subagents: readonly SessionSubagent[]) {
    let active = 0;
    let recent = 0;
    for (const subagent of subagents) {
        if (subagent.status === 'running') active += 1;
        else recent += 1;
    }
    return { active, recent, total: subagents.length } as const;
}
