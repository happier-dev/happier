import { describe, expect, it } from 'vitest';
import { MarketplaceIndexEntryV1Schema } from '../marketplace/marketplaceIndexV1.js';
import { selectRegistryBotTemplateUpdatePointerV1 } from './registryBotTemplateUpdatePointerV1.js';

describe('registry bot template update pointer', () => {
  it.each([
    { updatePolicy: 'pinned', expectedVersion: '1.0.0' },
    { updatePolicy: 'allowed', expectedVersion: '2.0.0' },
  ] as const)('selects the offered release under $updatePolicy policy without changing source identity', ({ updatePolicy, expectedVersion }) => {
    const pointer = { sourceId: 'catalog', itemId: 'acme.templates', version: '1.0.0' };
    const listing = MarketplaceIndexEntryV1Schema.parse({
      pluginId: 'acme.templates', publisher: { id: 'acme', displayName: 'Acme' },
      display: { title: 'Templates', description: null },
      distribution: { kind: 'npm', registryOrigin: 'https://registry.npmjs.org', packageName: 'templates',
        version: '2.0.0', integrity: `sha512-${'A'.repeat(86)}==` },
      manifestDigest: `sha256:${'a'.repeat(64)}`, compatibility: { platforms: [] },
      summary: { contributions: ['botTemplates'], botTemplates: [{ id: 'review', path: './templates/review.json' }],
        requiredHostAccess: [], optionalHostAccess: [], executableRealms: [] },
      review: { status: 'unreviewed', reviewedAt: null }, categories: [], media: [], updatePolicy, links: {},
    });
    expect(selectRegistryBotTemplateUpdatePointerV1(pointer, listing)).toEqual({
      ...pointer, version: expectedVersion,
    });
    expect(pointer.version).toBe('1.0.0');
  });
});
