import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

import { SessionOrganizationPlacementV1Schema } from '../sessions/creation/sessionSpawnNewResultV1.js';
import { EmbedStyleV1Schema } from './embedStyleV1.js';

/** Presentation and listing defaults; authority lives only in the parent grant. */
export const EmbedConfigV1Schema = lazyZodSchema(() => z.object({
  v: z.literal(1),
  ui: z.object({ attachments: z.boolean() }).strict(),
  newChat: z.object({ enabled: z.boolean() }).strict().nullable(),
  organization: SessionOrganizationPlacementV1Schema,
  style: EmbedStyleV1Schema.nullable(),
}).strict());
export type EmbedConfigV1 = z.infer<typeof EmbedConfigV1Schema>;
export const StoredEmbedConfigV1Schema = createStoredReadSchema(EmbedConfigV1Schema);
