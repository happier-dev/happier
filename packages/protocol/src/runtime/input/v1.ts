import { z } from 'zod';

import { HappierStructuredInputV1Schema } from './structuredInputV1.js';

export const RuntimeInputPayloadV1Schema = z.object({
  v: z.literal(1).default(1),
  text: z.string(),
  structuredInput: HappierStructuredInputV1Schema.optional(),
}).passthrough();

export type RuntimeInputPayloadV1 = z.infer<typeof RuntimeInputPayloadV1Schema>;

