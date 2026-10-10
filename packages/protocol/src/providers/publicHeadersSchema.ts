import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';

import { normalizeProviderPublicHeaders } from './safety/headers.js';

export const ProviderPublicHeadersV1Schema = lazyZodSchema(() => z.record(z.string(), z.string()).transform((value, ctx) => {
  try {
    return normalizeProviderPublicHeaders(value);
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid public headers' });
    return z.NEVER;
  }
}));
