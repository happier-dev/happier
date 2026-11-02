import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';

import { SessionFollowFactsV1Schema, type SessionFollowFactsV1 } from '../follow/accountFollow.js';
import { SessionPersonalAttentionProjectionV1Schema, type SessionPersonalAttentionProjectionV1 } from './attention.js';
import { SessionEffectiveNotificationV1Schema, type SessionEffectiveNotificationV1 } from './eventEligibility.js';
import { ViewerReadStateV1Schema, type ViewerReadStateV1 } from './readState.js';
import { SessionPersonalRelevanceV1Schema, type SessionPersonalRelevanceV1 } from './relevance.js';

/** Account-private read projection; additive outer facts are safely dropped, while each known nested fact stays closed. */
export const SessionViewerProjectionV1Schema = lazyZodSchema(() => z.object({
  readState: ViewerReadStateV1Schema,
  /** Own-Account organization assignments held by membership query pages. */
  tagIds: z.optional(z.readonly(z.array(z.string().check(z.minLength(1))))),
  latestFailureSeq: z.nullable(z.number().check(z.int(), z.gte(0))),
  relevance: SessionPersonalRelevanceV1Schema,
  attention: SessionPersonalAttentionProjectionV1Schema,
  follow: SessionFollowFactsV1Schema,
  notification: SessionEffectiveNotificationV1Schema,
}));

export type SessionViewerProjectionV1 = Readonly<{
  readState: ViewerReadStateV1;
  tagIds?: readonly string[];
  latestFailureSeq: number | null;
  relevance: SessionPersonalRelevanceV1;
  attention: SessionPersonalAttentionProjectionV1;
  follow: SessionFollowFactsV1;
  notification: SessionEffectiveNotificationV1;
}>;
