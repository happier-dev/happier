import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { BotTemplateDraftRefV1Schema, BotTemplateReleaseSourceV1Schema, BotTemplateVersionV1Schema } from './botTemplateV1.js';

/** Recipient-private lineage; release content remains in the accepted-base Artifact. */
export const BotTemplateInstanceV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  source: BotTemplateReleaseSourceV1Schema,
  acceptedVersion: BotTemplateVersionV1Schema,
  acceptedBase: BotTemplateDraftRefV1Schema,
  skillIds: z.record(z.string().check(z.minLength(1)), z.string().check(z.minLength(1))),
  mcpServerIds: z.record(z.string().check(z.minLength(1)), z.string().check(z.minLength(1))),
  follow: z.boolean(),
  skippedVersion: z.optional(BotTemplateVersionV1Schema),
}));
export type BotTemplateInstanceV1 = z.infer<typeof BotTemplateInstanceV1Schema>;

const StoredBotTemplateInstanceV1Schema = createStoredReadSchema(BotTemplateInstanceV1Schema);

/** Reads the raw work.templateInstance value; missing or malformed state is absent. */
export function readBotTemplateInstanceV1(value: unknown): BotTemplateInstanceV1 | null {
  const parsed = StoredBotTemplateInstanceV1Schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
