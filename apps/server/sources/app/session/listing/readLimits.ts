import { parseIntEnv } from "@/config/env";
import { SESSION_LIST_PAGE_MAX_LIMIT } from '@happier-dev/protocol/sessions/listing/query';

export const DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT = 100;
export const DEFAULT_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT = 50;

/**
 * An initial response can examine one maximum response batch for each of its
 * two independent cursor families. A continuation serves only one family, so
 * it can spend both batches without increasing that existing request budget.
 */
export function resolveV2SessionListCandidateWindowLimit(continuation: boolean): number {
    return SESSION_LIST_PAGE_MAX_LIMIT * (continuation ? 2 : 1);
}

export function resolveV2SessionListInitialAttentionRowLimit(env: NodeJS.ProcessEnv = process.env): number {
    return parseIntEnv(
        env.HAPPIER_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT,
        DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT,
        { min: 1, max: 500 },
    );
}

export function resolveSessionRollbackEligibleTurnRelationLimit(env: NodeJS.ProcessEnv = process.env): number {
    return parseIntEnv(
        env.HAPPIER_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT,
        DEFAULT_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT,
        { min: 1, max: 500 },
    );
}
