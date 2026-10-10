import { isMemoryExternalTranscriptSearchHitV1 } from '@happier-dev/protocol/memory/memorySearch';
import type { ConversationSearchHit } from '@/sync/domains/search/searchConversations';
import type { ExternalSessionBrowseCandidate } from './useExternalSessionBrowseCandidates';

/** Shared native identity adaptation for History and the activated scan surface. */
export function projectConversationSearchCandidates(
    hits: readonly ConversationSearchHit[],
    scope: Readonly<{ machineId: string; agentId: string; sourceKey: string }>,
): ExternalSessionBrowseCandidate[] {
    return hits.flatMap<ExternalSessionBrowseCandidate>(row => {
        if (row.machineId !== scope.machineId) return [];
        if (row.mode === 'standard') return row.sourceKey === scope.sourceKey && row.agentId === scope.agentId
            ? [{ ...row.candidate, searchMode: 'standard' }] : [];
        if (!isMemoryExternalTranscriptSearchHitV1(row.hit) || row.hit.source.sourceKey !== scope.sourceKey
            || row.hit.source.agentId !== scope.agentId) return [];
        return [{ remoteSessionId: row.hit.source.nativeSessionId, updatedAtMs: row.hit.createdAtToMs,
            candidateKey: JSON.stringify([row.machineId, row.hit.source.agentId, row.hit.source.sourceKey, row.hit.source.nativeSessionId, row.hit.sourceItemId]),
            searchMode: 'indexed', match: { snippet: row.hit.summary, sourceItemId: row.hit.sourceItemId } }];
    });
}
