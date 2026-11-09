import { normalizeSessionFollowFrontierV1, projectSessionFollowFrontierFromSourceV1, type SessionFollowFrontierV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowFrontierV1';
import type { SessionFollowDeliveredTurnStatus } from '@/storage/enums.generated';

/**
 * Persistence adapter between Session relation columns and Protocol's
 * one logical `SessionFollowFrontierV1`.
 *
 * The comparison, seeding and progress rules live in Protocol so the Session
 * Follow, reports-to and Account Voice frontiers stay one decision-maker; this module only
 * translates column shapes.
 */

/** The delivered columns this Home persists; nothing else describes progress. */
export type SessionFollowDeliveredColumns = Readonly<{
    deliveredTranscriptSeq: number;
    deliveredReadyEventSeq: number;
    deliveredAgentStateVersion: number;
    deliveredTurnId: string | null;
    deliveredTurnStatus: string | null;
}>;

/** The canonical source Session facts the frontier is projected from. */
export type SessionFollowSourceFrontierRow = Readonly<{
    seq: number;
    latestReadyEventSeq: number | null;
    agentStateVersion: number;
    latestTurnId: string | null;
    latestTurnStatus: string | null;
    active?: boolean;
}>;

export function readStoredSessionFollowFrontier(row: SessionFollowDeliveredColumns): SessionFollowFrontierV1 {
    return normalizeSessionFollowFrontierV1({
        transcriptSeq: row.deliveredTranscriptSeq,
        readyEventSeq: row.deliveredReadyEventSeq,
        agentStateVersion: row.deliveredAgentStateVersion,
        turn: { id: row.deliveredTurnId,
            status: row.deliveredTurnId !== null && row.deliveredTurnStatus === null ? 'stalled' : row.deliveredTurnStatus },
    });
}

export function readCurrentSourceSessionFollowFrontier(row: SessionFollowSourceFrontierRow): SessionFollowFrontierV1 {
    return projectSessionFollowFrontierFromSourceV1(row);
}

/**
 * Writes one deliverable turn fact into the existing pair: terminal and waiting
 * facts use the delivered-status enum; a stalled turn uses its exact id with a null
 * status. Both null means no consumed turn. No new presence cursor is needed.
 */
export function writeSessionFollowFrontierColumns(frontier: SessionFollowFrontierV1): {
    deliveredTranscriptSeq: number;
    deliveredReadyEventSeq: number;
    deliveredAgentStateVersion: number;
    deliveredTurnId: string | null;
    deliveredTurnStatus: SessionFollowDeliveredTurnStatus | null;
} {
    return {
        deliveredTranscriptSeq: frontier.transcriptSeq,
        deliveredReadyEventSeq: frontier.readyEventSeq,
        deliveredAgentStateVersion: frontier.agentStateVersion,
        deliveredTurnId: frontier.turn?.id ?? null,
        deliveredTurnStatus: frontier.turn?.status === 'stalled' ? null : frontier.turn?.status ?? null,
    };
}
