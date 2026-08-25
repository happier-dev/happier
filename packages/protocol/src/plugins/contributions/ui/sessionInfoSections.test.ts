import { describe, expect, it } from 'vitest';

import { PluginContributionLocalIdSchema } from '../../contributionIdentity.js';
import { createPluginSessionInfoSectionRendererIdV1 } from './sessionInfoSections.js';

describe('Session-info contribution identities', () => {
  it('constructs the synthetic renderer identity inside the canonical local-id grammar', () => {
    const rendererId = createPluginSessionInfoSectionRendererIdV1('external-conversations');

    expect(rendererId).toBe('session-info-external-conversations');
    expect(PluginContributionLocalIdSchema.safeParse(rendererId).success).toBe(true);
  });
});
