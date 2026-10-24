import { describe, expect, it } from 'vitest';

import { listPassiveSessionObservationProviders } from '@/backends/catalog';

describe('passive session observation providers', () => {
  it('sweeps only providers whose session listing has no side effects', async () => {
    const providers = await listPassiveSessionObservationProviders();

    expect(providers.map((provider) => [provider.providerId, provider.source.kind]).sort()).toEqual([
      ['claude', 'claudeConfig'],
      ['codex', 'codexHome'],
    ]);
  });
});
