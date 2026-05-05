import { describe, expect, it } from 'vitest';

import {
  ScmHostingProviderContributionSchema,
  ScmHostingProviderKindSchema,
} from './scmHostingProviders.js';

describe('SCM hosting-provider plugin contribution schema', () => {
  it('defaults URL safety metadata for static provider descriptors', () => {
    const parsed = ScmHostingProviderContributionSchema.parse({
      id: 'scm.github',
      kind: 'github',
      displayName: 'GitHub',
      baseUrl: 'https://github.com',
    });

    expect(parsed.urlSafety.allowedSchemes).toEqual(['https:']);
  });

  it('rejects unknown provider declarations and scheme values without a trailing colon', () => {
    expect(ScmHostingProviderKindSchema.parse('unknown')).toBe('unknown');
    expect(ScmHostingProviderContributionSchema.safeParse({
      id: 'scm.unknown',
      kind: 'unknown',
      displayName: 'Unknown',
      baseUrl: 'https://example.com',
    }).success).toBe(false);

    expect(ScmHostingProviderContributionSchema.safeParse({
      id: 'scm.custom',
      kind: 'custom',
      displayName: 'Custom',
      baseUrl: 'https://example.com',
      urlSafety: {
        allowedSchemes: ['https'],
      },
    }).success).toBe(false);
  });
});
