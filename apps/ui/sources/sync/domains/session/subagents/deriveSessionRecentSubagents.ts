import type { SessionSubagent } from './types';

export function deriveSessionRecentSubagents(subagents: readonly SessionSubagent[]): readonly SessionSubagent[] {
    return subagents.filter((subagent) => subagent.status !== 'running');
}
