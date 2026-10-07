import { combineChangedFilesAttribution, type ChangedFilesTurnEvidenceScope } from '@happier-dev/protocol/sessions/changes/mergeTurnChangeSets';
import type { SessionChangeSet, TurnChangeSet } from '@happier-dev/protocol/sessions/changes/types';

/**
 * Scopes the latest turn's evidence through the canonical Changed Files combiner, so evidence
 * categories and the winning diff for a path are decided once in Protocol rather than per host.
 */
export function deriveLatestTurnScopedChangeSet(params: Readonly<{
    sessionId: string;
    repoRootPath?: string | null;
    latestTurnChangeSet: TurnChangeSet | null;
    evidenceScope?: ChangedFilesTurnEvidenceScope;
}>): SessionChangeSet | null {
    if (!params.latestTurnChangeSet) return null;
    return combineChangedFilesAttribution({
        sessionId: params.sessionId,
        repoRootPath: params.repoRootPath,
        turns: [params.latestTurnChangeSet],
        evidenceScope: params.evidenceScope ?? 'all',
        rolledBackTurnIds: [],
    });
}
