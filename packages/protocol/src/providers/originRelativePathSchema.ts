import { z } from 'zod';

import { normalizeProviderOriginRelativePathSyntax } from './safety/index.js';

export const ProviderOriginRelativePathSchema = z.string().transform((value, ctx) => {
  try {
    return normalizeProviderOriginRelativePathSyntax(value, { allowQuery: true });
  } catch (error) {
    ctx.addIssue({
      code: 'custom',
      message: error instanceof Error ? error.message : 'Invalid provider origin-relative path',
    });
    return z.NEVER;
  }
});

export type ProviderOriginRelativePath = z.infer<typeof ProviderOriginRelativePathSchema>;
