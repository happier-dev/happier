import type { Message } from '@/sync/domains/messages/messageTypes';
import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';

import { deriveExecutionRunSubagents } from './executionRuns/deriveExecutionRunSubagents';
import { deriveProviderSessionSubagents } from './providers';
import { deriveSubAgentSidechainSubagents } from './subAgentSidechains/deriveSubAgentSidechainSubagents';
import type { SessionSubagent, SessionSubagentActiveExecutionRunState } from './types';
import type { Session } from '@/sync/domains/state/storageTypes';
import { readSessionOwnerMetadataView } from '@/sync/domains/session/readSessionOwnerMetadataView';
import { readSessionRuntimeLostSinceMs } from '@/sync/domains/session/attention/runtimePresentation';

/**
 * A sidechain row's status is a pure reading of its tool-call state, and that state has exactly one
 * writer: the runtime that made the call. Once that runtime is gone, nothing can ever write the
 * result, so a row left mid-call keeps claiming work in progress for as long as the transcript
 * survives — which is forever.
 *
 * Retirement is applied here, at the roster merge, rather than inside the sidechain derivation:
 * that derivation is transcript truth and other readers depend on it saying what the transcript
 * says. Only rows with no other closing path are retired — an execution run has its own run record
 * to close it, and overruling that record from session liveness would be a second opinion about a
 * fact someone else owns.
 *
 * `runtimeLostSinceMs` is also the bound, not just the trigger: a row whose own evidence is newer
 * than the last time the runtime was seen is proof that the instant is stale rather than final, so
 * it is left alone.
 */
function retireSubagentsAfterRuntimeLoss(
    subagents: readonly SessionSubagent[],
    runtimeLostSinceMs: number | null,
): readonly SessionSubagent[] {
    if (runtimeLostSinceMs === null) return subagents;

    return subagents.map((subagent) => {
        if (subagent.kind !== 'subagent_sidechain') return subagent;
        if (subagent.status !== 'running') return subagent;

        const observedAtMs = subagent.timestamps.updatedAtMs ?? subagent.timestamps.startedAtMs ?? null;
        if (observedAtMs !== null && observedAtMs > runtimeLostSinceMs) return subagent;

        return { ...subagent, status: 'terminated' };
    });
}

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
    session: Pick<
        Session,
        'metadataLayoutVersion' | 'metadata' | 'ownerMetadataView' | 'active' | 'activeAt' | 'archivedAt' | 'presence'
    >;
    messages: readonly Message[];
    activeExecutionRuns?: readonly SessionSubagentActiveExecutionRunState[];
    nowMs?: number;
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

    const runtimeLostSinceMs = readSessionRuntimeLostSinceMs(
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
