import { z } from 'zod';

import { BrowserProfileStorageModeV1Schema } from '../profile/v1.js';

export const BrowserStoragePolicyV1Schema = z
  .object({
    mode: BrowserProfileStorageModeV1Schema,
    clearOnClose: z.boolean().default(true),
    downloadsPersistence: z.enum(['deny', 'prompt', 'persist']).default('prompt'),
  })
  .strict();
export type BrowserStoragePolicyV1 = z.infer<typeof BrowserStoragePolicyV1Schema>;
