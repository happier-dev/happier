import { excludeRolledBackTurns, mergeTurnChangeSets, readSessionRollbackRangesV1FromMetadata } from '@happier-dev/protocol';

import type { TurnChangeSet } from '@happier-dev/protocol';

export function deriveSessionChangeSet(params: Readonly<{
    sessionId: string;
    metadata: unknown;
    turnChangeSets: readonly TurnChangeSet[];
}>): ReturnType<typeof mergeTurnChangeSets> | null {
    if (params.turnChangeSets.length === 0) return null;
    const rollbackRanges = readSessionRollbackRangesV1FromMetadata(params.metadata)?.ranges ?? [];
    const visibleTurns = excludeRolledBackTurns({
        turns: params.turnChangeSets,
        rollbackRanges,
    });
    const rolledBackTurnIds = params.turnChangeSets
        .filter((turn) => !visibleTurns.some((visible) => visible.turnId === turn.turnId))
        .map((turn) => turn.turnId);
    return mergeTurnChangeSets({
        sessionId: params.sessionId,
        turns: visibleTurns,
        rolledBackTurnIds,
    });
}
