import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

import { normalizeProviderOriginRelativePathSyntax } from './safety/url.js';

export const ProviderOriginRelativePathSchema = lazyZodSchema(() => z.pipe(z.string(), z.transform((value, ctx) => {
  try {
    return normalizeProviderOriginRelativePathSyntax(value, { allowQuery: true });
  } catch (error) {
    ctx.issues.push({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Invalid provider origin-relative path', input: ctx.value });
    return z.NEVER;
  }
})));

export type ProviderOriginRelativePath = z.infer<typeof ProviderOriginRelativePathSchema>;
