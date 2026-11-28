import { z } from 'zod';

import { lazySchema } from '../lazySchema.js';
import { PendingLocalIdSchema } from './pendingLocalId.js';

export const SessionMessagePresenceRequestSchema = lazySchema(() => z.object({
  localIds: z.array(PendingLocalIdSchema).min(1),
}));

export const SessionMessagePresenceResponseSchema = lazySchema(() => z.object({
  absentLocalIds: z.array(PendingLocalIdSchema),
}));
