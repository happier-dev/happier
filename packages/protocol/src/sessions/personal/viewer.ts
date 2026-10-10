import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod';

import { SessionFollowFactsV1Schema, type SessionFollowFactsV1 } from '../follow/accountFollow.js';
import { SessionPersonalAttentionProjectionV1Schema, type SessionPersonalAttentionProjectionV1 } from './attention.js';
import { SessionEffectiveNotificationV1Schema, type SessionEffectiveNotificationV1 } from './eventEligibility.js';
import { ViewerReadStateV1Schema, type ViewerReadStateV1 } from './readState.js';
import { SessionPersonalRelevanceV1Schema, type SessionPersonalRelevanceV1 } from './relevance.js';

/** Account-private read projection; each nested fact has its own closed schema. */
export const SessionViewerProjectionV1Schema = lazyZodSchema(() => z.object({
  readState: ViewerReadStateV1Schema,
  relevance: SessionPersonalRelevanceV1Schema,
  attention: SessionPersonalAttentionProjectionV1Schema,
  follow: SessionFollowFactsV1Schema,
  notification: SessionEffectiveNotificationV1Schema,
}).strict());

export type SessionViewerProjectionV1 = Readonly<{
  readState: ViewerReadStateV1;
  relevance: SessionPersonalRelevanceV1;
  attention: SessionPersonalAttentionProjectionV1;
  follow: SessionFollowFactsV1;
  notification: SessionEffectiveNotificationV1;
}>;
