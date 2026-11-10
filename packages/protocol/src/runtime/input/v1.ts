import { z } from '../../zodRuntimePolicy.js';

import { HappierStructuredInputV1Schema } from './structuredInputV1.js';

export const RuntimeInputPayloadV1Schema = z.looseObject({
  v: z._default(z.literal(1), 1),
  text: z.string(),
  structuredInput: z.optional(HappierStructuredInputV1Schema),
});

export type RuntimeInputPayloadV1 = z.infer<typeof RuntimeInputPayloadV1Schema>;

