import type { SessionSubagent } from '../types';

export function deriveSessionSubagentSidechainIds(subagents: readonly SessionSubagent[]): readonly string[] {
    const sidechainIds = new Set<string>();
    for (const subagent of subagents) {
        const sidechainId = subagent.transcript.sidechainId;
        if (!sidechainId) continue;
        sidechainIds.add(sidechainId);
    }
    return Array.from(sidechainIds.values());
}
