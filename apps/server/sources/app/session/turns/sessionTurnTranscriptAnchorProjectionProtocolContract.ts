export const SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION =
    "20260810210000_contract_session_turn_anchor_projection";
export const SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_KEY =
    "session.turn.transcript-anchor-projection.final-contract.v1";
export const SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_VALUE =
    SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION;

type MigrationContractDatabase = Readonly<{
    $queryRawUnsafe(query: string): Promise<unknown>;
    simpleCache: Readonly<{
        findUnique(args: Readonly<{
            where: Readonly<{ key: string }>;
            select: Readonly<{ value: true }>;
        }>): Promise<Readonly<{ value: string }> | null>;
    }>;
    sessionTurn: Readonly<{
        count(args: Readonly<{
            where: Readonly<{
                transcriptAnchorProjectionVersion: Readonly<{ not: 1 }>;
            }>;
        }>): Promise<number>;
    }>;
}>;

function isFinishedContractMigrationRow(value: unknown): boolean {
    return typeof value === "object"
        && value !== null
        && "migration_name" in value
        && value.migration_name === SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION;
}

// Public external transcript projection is a post-CONTRACT capability. The
// final marker is written only by the explicit final-contract operator after
// its external writer-floor admission and factual audit. The migration ledger
// records that CONTRACT then applied; neither fact alone activates the route.
// The zero-v0 count prevents a restarted predecessor writer from silently
// reactivating it.
let sessionTurnTranscriptAnchorProjectionProtocolActive = false;

export function isSessionTurnTranscriptAnchorProjectionProtocolActive(): boolean {
    return sessionTurnTranscriptAnchorProjectionProtocolActive;
}

export async function initializeSessionTurnTranscriptAnchorProjectionProtocolActivation(
    database: MigrationContractDatabase,
): Promise<boolean> {
    sessionTurnTranscriptAnchorProjectionProtocolActive = false;
    try {
        const rows = await database.$queryRawUnsafe(
            "SELECT migration_name FROM _prisma_migrations "
            + `WHERE migration_name = '${SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_CONTRACT_MIGRATION}' `
            + "AND finished_at IS NOT NULL AND rolled_back_at IS NULL",
        );
        const contractApplied = Array.isArray(rows) && rows.some(isFinishedContractMigrationRow);
        if (!contractApplied) return false;

        const finalMarker = await database.simpleCache.findUnique({
            where: { key: SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_KEY },
            select: { value: true },
        });
        if (
            finalMarker?.value
            !== SESSION_TURN_TRANSCRIPT_ANCHOR_PROJECTION_FINAL_CONTRACT_MARKER_VALUE
        ) {
            return false;
        }

        const legacyRows = await database.sessionTurn.count({
            where: { transcriptAnchorProjectionVersion: { not: 1 } },
        });
        sessionTurnTranscriptAnchorProjectionProtocolActive = legacyRows === 0;
    } catch {
        // The final operator marker, migration ledger, and current table state
        // are all required evidence. An expanded-only database remains
        // externally fail-closed.
    }
    return sessionTurnTranscriptAnchorProjectionProtocolActive;
}

export function resetSessionTurnTranscriptAnchorProjectionProtocolActivationForTests(): void {
    sessionTurnTranscriptAnchorProjectionProtocolActive = false;
}
