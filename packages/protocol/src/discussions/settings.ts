import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { AutonomousExchangeStateV1Schema } from '../sessions/messages/autonomousExchangeV1.js';
import { DiscussionIdSchema } from './references.js';

/** An absent override inherits the Account choice; null explicitly never pauses. */
export const DiscussionSettingsV1Schema = lazyZodSchema(() => z.strictObject({
  coordination: z.optional(z.strictObject({
    autonomousCheckIn: z.optional(z.strictObject({ afterTurns: AutonomousExchangeStateV1Schema.shape.afterTurns })),
  })),
}));
export type DiscussionSettingsV1 = z.infer<typeof DiscussionSettingsV1Schema>;
export const DiscussionSettingsV1StoredSchema = createStoredReadSchema(DiscussionSettingsV1Schema);
export const DiscussionSettingsSetRequestV1Schema = lazyZodSchema(() => z.strictObject({ settings: DiscussionSettingsV1Schema }));
export const DiscussionSettingsResponseV1Schema = lazyZodSchema(() => z.strictObject({
  discussionId: DiscussionIdSchema, settings: DiscussionSettingsV1Schema,
}));
export type DiscussionSettingsResponseV1 = z.infer<typeof DiscussionSettingsResponseV1Schema>;
