import { z } from 'zod';

import { normalizeProviderEndpointUrlSyntax } from './safety/index.js';

export function createProviderEndpointUrlSyntaxSchema(options: Readonly<{ allowQuery?: boolean }> = {}) {
  return z.string().transform((raw, ctx) => {
    try {
      return normalizeProviderEndpointUrlSyntax(raw, options).normalizedUrl;
    } catch (error) {
      ctx.addIssue({
        code: 'custom',
        message: error instanceof Error ? error.message : 'Invalid provider endpoint URL',
      });
      return z.NEVER;
    }
  });
}

export const ProviderEndpointUrlSyntaxSchema = createProviderEndpointUrlSyntaxSchema({ allowQuery: false });
