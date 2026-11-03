import { describe, expect, it } from 'vitest';
import { createPluginCompatibilityProjectionV1 } from '../plugins/availability/v1.js';
import { createMarketplaceNpmDiscoveryProjectionV1, deriveMarketplaceNpmDiscoveryKeywordsV1, MarketplaceNpmDiscoveryProjectionV1Schema, parseMarketplaceIndexSourceSnapshotV1 } from '../marketplace/marketplaceIndexV1.js';
import { PluginContributionFamilyV2Schema } from '../plugins/contributions/families.js';
import { PluginContributesV2Schema } from '../plugins/contributions/v2.js';
import { projectCommunityNpmListingV1 } from '../marketplace/communityNpmDiscoveryV1.js';

const integrity = `sha512-${'A'.repeat(86)}==`;

describe('registry contribution-family selection through Action and RPC', () => {
  it('projects cold template descriptors and search keywords from the manifest without reading release bodies', () => {
    expect([...PluginContributionFamilyV2Schema.options].sort()).toEqual(Object.keys(PluginContributesV2Schema.parse({})).sort());
    const botTemplates = [{ id: 'review', path: './templates/review.json' }];
    const compatibility = createPluginCompatibilityProjectionV1({ manifest: {
      schemaVersion: 2, id: 'acme.templates', version: '1.0.0', displayName: 'Templates',
      runtime: { apiVersion: 1 }, hostAccess: { required: [], optional: [] }, contributes: { botTemplates },
    }, uiArtifacts: { version: 2, entries: [] } });
    const projection = createMarketplaceNpmDiscoveryProjectionV1({ compatibility, manifestDigest: `sha256:${'a'.repeat(64)}` });
    expect(projection.summary).toMatchObject({ contributions: ['botTemplates'], botTemplates });
    expect(deriveMarketplaceNpmDiscoveryKeywordsV1(projection)).toEqual(['happier-plugin', 'happier-plugin-contribution-bottemplates']);
    const listing = projectCommunityNpmListingV1({ versionMetadata: {
      happier: { compatibilityProjection: compatibility, marketplaceDiscovery: projection },
    }, packageName: 'templates', version: '1.0.0', registryOrigin: 'https://registry.npmjs.org',
      integrity, publisher: { id: 'acme', displayName: 'Acme' } });
    expect(listing).toMatchObject({ status: 'listed', entry: { summary: { botTemplates } } });
    const additiveProjection = { ...projection, summary: { ...projection.summary,
      botTemplates: botTemplates.map(template => ({ ...template, futurePresentation: true })),
    } };
    expect(MarketplaceNpmDiscoveryProjectionV1Schema.safeParse(additiveProjection).success).toBe(false);
    expect(projectCommunityNpmListingV1({ versionMetadata: {
      happier: { compatibilityProjection: compatibility, marketplaceDiscovery: additiveProjection },
    }, packageName: 'templates', version: '1.0.0', registryOrigin: 'https://registry.npmjs.org',
      integrity, publisher: { id: 'acme', displayName: 'Acme' } }))
      .toMatchObject({ status: 'listed', entry: { summary: { botTemplates } } });
    if (listing.status !== 'listed') throw new Error('Expected the canonical published metadata to be listed');
    expect(parseMarketplaceIndexSourceSnapshotV1({
      source: { id: 'catalog', title: 'Catalog', sourceUrl: 'https://catalog.example/catalog.json', kind: 'user' },
      freshness: { state: 'fresh', fetchedAtMs: 1 }, diagnostics: [],
      entries: [{ ...listing.entry, summary: additiveProjection.summary }],
    }).entries[0]?.summary).toMatchObject({ botTemplates });
  });
});
