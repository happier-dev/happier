import { excludeRolledBackTurns } from '@happier-dev/protocol/sessions/changes/rollbacks';
import { mergeTurnChangeSets } from '@happier-dev/protocol/sessions/changes/mergeTurnChangeSets';
import { readSessionRollbackRangesV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/sessionRollbackRangesV1';

import type { TurnChangeSet } from '@happier-dev/protocol';

export function deriveSessionChangeSet(params: Readonly<{
    sessionId: string;
    repoRootPath?: string | null;
    metadata: unknown;
    turnChangeSets: readonly TurnChangeSet[];
}>): ReturnType<typeof mergeTurnChangeSets> | null {
    if (params.turnChangeSets.length === 0) return null;
    const rollbackRanges = readSessionRollbackRangesV1FromMetadata(params.metadata)?.ranges ?? [];
    const visibleTurns = excludeRolledBackTurns({
        turns: params.turnChangeSets,
        rollbackRanges,
    });
    const visibleTurnIds = new Set(visibleTurns.map((turn) => turn.turnId));
    const rolledBackTurnIds = params.turnChangeSets
        .filter((turn) => !visibleTurnIds.has(turn.turnId))
        .map((turn) => turn.turnId);
    return mergeTurnChangeSets({
        sessionId: params.sessionId,
        repoRootPath: params.repoRootPath,
        turns: visibleTurns,
        rolledBackTurnIds,
    });
}
