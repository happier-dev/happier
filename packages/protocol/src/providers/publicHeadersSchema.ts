import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { normalizeProviderPublicHeaders } from './safety/headers.js';

export const ProviderPublicHeadersV1Schema = lazyZodSchema(() => z.pipe(z.record(z.string(), z.string()), z.transform((value, ctx) => {
  try {
    return normalizeProviderPublicHeaders(value);
  } catch (error) {
    ctx.issues.push({ code: 'custom', message: error instanceof Error ? error.message : 'Invalid public headers', input: ctx.value });
    return z.NEVER;
  }
})));
