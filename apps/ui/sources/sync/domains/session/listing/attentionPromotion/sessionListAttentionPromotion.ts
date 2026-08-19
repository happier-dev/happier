import type { SessionAttentionStandingPolicy } from '../../organization/attentionStanding';
import {
    normalizeSessionListAttentionPromotionMode,
    normalizeSessionListWorkingPlacementMode,
    type SessionListAttentionPromotionMode,
    type SessionListAttentionPromotionReason,
    type SessionListWorkingPlacementMode,
} from './sessionListAttentionPromotionTypes';

export const ATTENTION_PROMOTION_GROUP_KEY_V1 = 'attention-promotion-v1';

export type SessionListRetainedAttentionPlacement = Readonly<{
    key: string;
    reason: SessionListAttentionPromotionReason;
}>;

export type SessionListAttentionPromotionOptions = Readonly<{
    mode: SessionListAttentionPromotionMode;
    retainedPlacements?: ReadonlyArray<SessionListRetainedAttentionPlacement> | null;
    standingPolicy?: SessionAttentionStandingPolicy;
}>;

export type SessionListWorkingPlacementOptions = Readonly<{
    mode: SessionListWorkingPlacementMode;
}>;

export {
    normalizeSessionListAttentionPromotionMode,
    normalizeSessionListWorkingPlacementMode,
};
export type {
    SessionListAttentionPromotionMode,
    SessionListAttentionPromotionReason,
    SessionListWorkingPlacementMode,
};
