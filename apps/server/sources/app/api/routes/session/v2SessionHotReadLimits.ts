import { parseIntEnv } from "@/config/env";

export const DEFAULT_V2_SESSION_LIST_INITIAL_ATTENTION_ROW_LIMIT = 100;
export const DEFAULT_SESSION_ROLLBACK_ELIGIBLE_TURN_RELATION_LIMIT = 50;

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
