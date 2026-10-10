import type { Message } from "@happier-dev/session-core/messages";
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';

import { deriveExecutionRunSubagents } from './executionRuns/deriveExecutionRunSubagents';
import { deriveProviderSessionSubagents } from './providers';
import { deriveSubAgentSidechainSubagents } from './subAgentSidechains/deriveSubAgentSidechainSubagents';
import type { SessionSubagent, SessionSubagentActiveExecutionRunState } from './types';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionRuntimeLostSinceMs, isSessionOwnedActivityUnobserved } from '@/sync/domains/session/attention/runtimePresentation';

/** Lost observation changes live claims to unknown, without inventing a terminal outcome. */
function retireSubagentsAfterRuntimeLoss(
    subagents: readonly SessionSubagent[],
    runtimeLostSinceMs: number | null,
): readonly SessionSubagent[] {
    if (runtimeLostSinceMs === null) return subagents;

    return subagents.map((subagent) => {
        if (subagent.kind === 'execution_run') return subagent;
        if (subagent.status !== 'running') return subagent;

        const observedAtMs = subagent.timestamps.updatedAtMs ?? subagent.timestamps.startedAtMs ?? null;
        if (!isSessionOwnedActivityUnobserved(runtimeLostSinceMs, observedAtMs)) return subagent;

        return { ...subagent, status: 'unknown' };
    });
}

function sortSubagents(subagents: readonly SessionSubagent[]): readonly SessionSubagent[] {
    return [...subagents].sort((left, right) => {
        const leftRunning = left.isActive !== false && left.status === 'running' ? 0 : 1;
        const rightRunning = right.isActive !== false && right.status === 'running' ? 0 : 1;
        if (leftRunning !== rightRunning) return leftRunning - rightRunning;

        const leftUpdated = left.timestamps.updatedAtMs ?? 0;
        const rightUpdated = right.timestamps.updatedAtMs ?? 0;
        if (leftUpdated !== rightUpdated) return rightUpdated - leftUpdated;

        return left.id.localeCompare(right.id);
    });
}

export function deriveSessionSubagents(params: Readonly<{
    accountScope?: import('@/sync/domains/scope/serverAccountScope').ServerAccountScope | null;
    session: Pick<
        Session,
        'metadataLayoutVersion' | 'metadata' | 'ownerMetadataView' | 'active' | 'activeAt' | 'archivedAt' | 'presence'
    >;
    messages: readonly Message[];
    activeExecutionRuns?: readonly SessionSubagentActiveExecutionRunState[];
    nowMs?: number;
    runtimeLostSinceMs?: number | null;
}>): readonly SessionSubagent[] {
    const metadata = readSessionOwnerMetadataView(params.session);
    const rawFlavor = metadata?.flavor;
    // The runtime descriptor is the exact Session owner. A legacy flavor is
    // only a compatibility identity when no descriptor exists; allowing it to
    // win would lend a bundled Agent's labels and behavior to an external
    // Agent that happens to retain that old scalar field.
    const flavor = resolveAgentIdFromSessionMetadata(metadata)
        ?? (typeof rawFlavor === 'string' && rawFlavor.trim().length > 0 ? rawFlavor : null);

    const executionRuns = deriveExecutionRunSubagents({
        messages: params.messages,
        activeExecutionRuns: params.activeExecutionRuns,
    });
    const providerSubagents = deriveProviderSessionSubagents({
        accountScope: params.accountScope,
        flavor,
        metadata,
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

    const runtimeLostSinceMs = params.runtimeLostSinceMs !== undefined ? params.runtimeLostSinceMs : readSessionRuntimeLostSinceMs(
        params.session,
        typeof params.nowMs === 'number' && Number.isFinite(params.nowMs) ? params.nowMs : Date.now(),
    );

    // Retire before sorting: retirement moves a row out of the running group, and sorting a status
    // we are about to change would order the roster by a claim we no longer make.
    return sortSubagents(retireSubagentsAfterRuntimeLoss([
        ...executionRuns,
        ...providerSubagents,
        ...genericSubagentSidechains,
    ], runtimeLostSinceMs));
}
