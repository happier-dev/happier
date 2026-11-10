import { z } from '../zodRuntimePolicy.js';

import { normalizeProviderEndpointUrlSyntax } from './safety/url.js';

export function createProviderEndpointUrlSyntaxSchema(options: Readonly<{ allowQuery?: boolean }> = {}) {
  return z.pipe(z.string(), z.transform((raw, ctx) => {
    try {
      return normalizeProviderEndpointUrlSyntax(raw, options).normalizedUrl;
    } catch (error) {
      ctx.issues.push({
        code: 'custom',
        message: error instanceof Error ? error.message : 'Invalid provider endpoint URL', input: ctx.value });
      return z.NEVER;
    }
  }));
}

export const ProviderEndpointUrlSyntaxSchema = createProviderEndpointUrlSyntaxSchema({ allowQuery: false });
