import { mergeTurnChangeSets, type SessionChangeSet, type TurnChangeSet } from '@happier-dev/protocol';

export function deriveLatestTurnScopedChangeSet(params: Readonly<{
    sessionId: string;
    latestTurnChangeSet: TurnChangeSet | null;
}>): SessionChangeSet | null {
    if (!params.latestTurnChangeSet) return null;
    return mergeTurnChangeSets({
        sessionId: params.sessionId,
        turns: [params.latestTurnChangeSet],
        rolledBackTurnIds: [],
    });
}
