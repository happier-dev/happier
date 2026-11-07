import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '../json/storedReadSchema.js';

import { SessionOrganizationPlacementV1Schema } from '../sessions/creation/sessionSpawnNewResultV1.js';
import { EmbedStyleV1Schema } from './embedStyleV1.js';

/** Presentation and listing defaults; authority lives only in the parent grant. */
export const EmbedConfigV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(1),
  ui: z.strictObject({ attachments: z.boolean() }),
  newChat: z.nullable(z.strictObject({ enabled: z.boolean() })),
  organization: SessionOrganizationPlacementV1Schema,
  style: z.nullable(EmbedStyleV1Schema),
}));
export type EmbedConfigV1 = z.infer<typeof EmbedConfigV1Schema>;
export const StoredEmbedConfigV1Schema = createStoredReadSchema(EmbedConfigV1Schema);

/** Content-free wake on the authenticated token's existing socket room. */
export const ApiTokenEmbedConfigChangedV1Schema = lazyZodSchema(() => z.strictObject({
  type: z.literal('api-token-embed-config-changed'),
}));
