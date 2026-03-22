import type { SessionSubagent } from './types';

export function deriveSessionActiveSubagents(subagents: readonly SessionSubagent[]): readonly SessionSubagent[] {
    return subagents.filter((subagent) => subagent.status === 'running');
}
