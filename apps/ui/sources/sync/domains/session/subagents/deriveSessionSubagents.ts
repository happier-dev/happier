import type { Message } from '@/sync/domains/messages/messageTypes';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';

import { deriveExecutionRunSubagents } from './executionRuns/deriveExecutionRunSubagents';
import { deriveProviderSessionSubagents } from './providers';
import { deriveSubAgentSidechainSubagents } from './subAgentSidechains/deriveSubAgentSidechainSubagents';
import type { SessionSubagent, SessionSubagentActiveExecutionRunState } from './types';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';

function sortSubagents(subagents: readonly SessionSubagent[]): readonly SessionSubagent[] {
    return [...subagents].sort((left, right) => {
        const leftRunning = left.status === 'running' ? 0 : 1;
        const rightRunning = right.status === 'running' ? 0 : 1;
        if (leftRunning !== rightRunning) return leftRunning - rightRunning;

        const leftUpdated = left.timestamps.updatedAtMs ?? 0;
        const rightUpdated = right.timestamps.updatedAtMs ?? 0;
        if (leftUpdated !== rightUpdated) return rightUpdated - leftUpdated;

        return left.id.localeCompare(right.id);
    });
}

export function deriveSessionSubagents(params: Readonly<{
    session: Pick<Session, 'metadataLayoutVersion' | 'metadata' | 'ownerMetadataView'>;
    messages: readonly Message[];
    activeExecutionRuns?: readonly SessionSubagentActiveExecutionRunState[];
}>): readonly SessionSubagent[] {
    const metadata = readSessionOwnerMetadataView(params.session);
    const rawFlavor = metadata?.flavor;
    const flavor = typeof rawFlavor === 'string' && rawFlavor.trim().length > 0
        ? rawFlavor
        : resolveAgentIdFromSessionMetadata(metadata);

    const executionRuns = deriveExecutionRunSubagents({
        messages: params.messages,
        activeExecutionRuns: params.activeExecutionRuns,
    });
    const providerSubagents = deriveProviderSessionSubagents({
        flavor,
        messages: params.messages,
    });
    const excludedSidechainIds = new Set<string>();
    for (const subagent of [...executionRuns, ...providerSubagents]) {
        const sidechainId = subagent.transcript.sidechainId;
        if (sidechainId) excludedSidechainIds.add(sidechainId);
    }
    const genericSubagentSidechains = deriveSubAgentSidechainSubagents({
        messages: params.messages,
        flavor,
        excludedSidechainIds,
    });

    return sortSubagents([
        ...executionRuns,
        ...providerSubagents,
        ...genericSubagentSidechains,
    ]);
}
