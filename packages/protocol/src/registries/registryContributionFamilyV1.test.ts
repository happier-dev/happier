import { describe, expect, it } from 'vitest';
import { createPluginCompatibilityProjectionV1 } from '../plugins/availability/v1.js';
import { createMarketplaceNpmDiscoveryProjectionV1, deriveMarketplaceNpmDiscoveryKeywordsV1, MarketplaceIndexEntryV1Schema, MarketplaceNpmDiscoveryProjectionV1Schema, parseMarketplaceIndexSourceSnapshotV1 } from '../marketplace/marketplaceIndexV1.js';
import { PluginContributionFamilyV2Schema } from '../plugins/contributions/families.js';
import { PluginContributesV2Schema } from '../plugins/contributions/v2.js';
import { projectCommunityNpmListingV1 } from '../marketplace/communityNpmDiscoveryV1.js';
import { deriveMarketplaceSourceId } from '../marketplace/marketplaceSourceRegistryV1.js';
import { createRegistryHostV1 } from './registryHostV1.js';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from './registryActionsV1.js';
import type { RegistrySourceDescriptorV1 } from './registrySourcesV1.js';
import type { RegistryHttpV1 } from './formats/registryFormatAdapterV1.js';

const integrity = `sha512-${'A'.repeat(86)}==`;
function metadata(name: string, withSkills: boolean) {
  const compatibility = createPluginCompatibilityProjectionV1({ manifest: {
    schemaVersion: 2, id: `acme.${name}`, version: '1.0.0', displayName: name,
    runtime: { apiVersion: 1 }, hostAccess: { required: [], optional: [] },
    contributes: withSkills ? { skills: [{ id: 'review', directory: './skills/review' }] } : {},
  }, uiArtifacts: { version: 2, entries: [] } });
  return { name, version: '1.0.0', dist: { integrity, tarball: `https://registry.npmjs.org/${name}.tgz` },
    happier: { compatibilityProjection: compatibility, marketplaceDiscovery:
      createMarketplaceNpmDiscoveryProjectionV1({ compatibility, manifestDigest: `sha256:${'a'.repeat(64)}` }) } };
}
function source(format: 'happier-npm' | 'happier-catalog' | 'git'): RegistrySourceDescriptorV1 {
  return { id: format === 'happier-catalog' ? deriveMarketplaceSourceId('https://catalog.example/catalog.json') : 'selected', title: 'Selected', format, kinds: format === 'git' ? ['skill'] : ['plugin'],
    url: format === 'happier-npm' ? 'https://registry.npmjs.org' : 'https://catalog.example/catalog.json',
    enabled: true, addedAt: 0, origin: { kind: 'user' }, removable: true };
}
const forbidden = async (): Promise<never> => { throw new Error('List must not read content or acquire packages'); };

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
  it('narrows npm search, filters authoritative metadata and keeps raw continuation on an empty filtered page', async () => {
    const selected = source('happier-npm');
    const urls: string[] = [];
    const http: RegistryHttpV1 = { getText: forbidden, getBytes: forbidden, getJson: async url => {
      urls.push(url);
      const names = new URL(url).searchParams.get('from') === '1' ? ['relevant'] : ['unrelated'];
      const name = decodeURIComponent(new URL(url).pathname.slice(1));
      return { ok: true, fetchedAt: 1, value: url.includes('/-/v1/search')
        ? { total: 2, objects: names.map(name => ({ package: { name, version: '1.0.0', publisher: { username: 'acme' } } })) }
        : { name, versions: { '1.0.0': metadata(name, name === 'relevant') } } };
    } };
    const host = createRegistryHostV1({ host: 'web', http, readSources: async () => [selected] });
    const input = { kind: 'plugin', sourceIds: [selected.id], contributionFamily: 'skills', query: 'review' };
    const first = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', input));
    expect(first.pages[0]).toMatchObject({ status: { state: 'ok' }, items: [], nextCursor: '1' });
    expect(new URL(urls[0]!).searchParams.get('text')).toBe('keywords:happier-plugin keywords:happier-plugin-contribution-skills review');
    const second = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(await host.execute('registries.items.list', { ...input, cursor: '1' }));
    expect(second.pages[0]).toMatchObject({ items: [{ itemId: 'relevant' }], nextCursor: null });
    expect(urls).toHaveLength(4);
  });

  it('filters an indexed catalog before reporting its total and never reads targets', async () => {
    const selected = source('happier-catalog');
    const entries = ['unrelated', 'relevant'].map(name => MarketplaceIndexEntryV1Schema.parse({
      pluginId: `acme.${name}`, publisher: { id: 'acme', displayName: 'Acme' }, display: { title: name, description: null },
      distribution: { kind: 'npm', registryOrigin: 'https://registry.npmjs.org', packageName: name, version: '1.0.0', integrity },
      manifestDigest: `sha256:${'a'.repeat(64)}`, compatibility: { platforms: [] },
      summary: metadata(name, name === 'relevant').happier.marketplaceDiscovery.summary,
      review: { status: 'unreviewed', reviewedAt: null }, categories: [], media: [], updatePolicy: 'allowed', links: {},
    }));
    const urls: string[] = [];
    const host = createRegistryHostV1({ host: 'node', readSources: async () => [selected], http: {
      getText: forbidden, getBytes: forbidden, getJson: async url => { urls.push(url); return { ok: true, fetchedAt: 1, value: {
        source: { id: selected.id, title: selected.title, sourceUrl: selected.url, kind: 'user' },
        freshness: { state: 'fresh', fetchedAtMs: 1 }, entries, picks: [], diagnostics: [],
      } }; },
    } });
    expect(await host.fetchRequest({ op: 'list', sourceId: selected.id, kind: 'plugin', contributionFamily: 'skills' }))
      .toMatchObject({ op: 'list', page: { items: [{ itemId: 'acme.relevant' }], total: 1, nextCursor: null } });
    expect(urls).toEqual([selected.url]);
  });

  it('settles unsupported formats before any scan or transport', async () => {
    const selected = source('git');
    const host = createRegistryHostV1({ host: 'node', readSources: async () => [selected], http: {
      getJson: forbidden, getText: forbidden, getBytes: forbidden,
    } });
    expect(await host.fetchRequest({ op: 'list', sourceId: selected.id, kind: 'skill', contributionFamily: 'skills' }))
      .toMatchObject({ op: 'error', status: { state: 'newer_format' } });
  });
});
