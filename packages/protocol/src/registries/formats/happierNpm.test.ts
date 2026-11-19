import { describe, expect, it } from 'vitest';
import { createPluginCompatibilityProjectionV1 } from '../../plugins/availability/v1.js';
import { createMarketplaceNpmDiscoveryProjectionV1 } from '../../marketplace/marketplaceIndexV1.js';
import { COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1 } from '../../marketplace/expectedMarketplaceListingV1.js';
import { createRegistryHostV1 } from '../registryHostV1.js';
import { listRegistrySourcesV1 } from '../registrySourcesV1.js';
import { REGISTRY_ACTION_OUTPUT_SCHEMAS_V1 } from '../registryActionsV1.js';
import { RegistryItemV1Schema } from '../registryItemsV1.js';
import type { RegistryHttpV1 } from './registryFormatAdapterV1.js';

describe('happier npm real registry wiring', () => {
  it('browses without a daemon, preserves npm continuation, and reads the selected package version through the strict Action consumer', async () => {
    const version = '1.0.0', packageName = '@acme/community';
    const compatibility = createPluginCompatibilityProjectionV1({
      manifest: { schemaVersion: 2, id: 'acme.community', version, displayName: 'Community', runtime: { apiVersion: 1 },
        entrypoints: { daemon: './dist/index.js' }, hostAccess: { required: [], optional: [] }, contributes: {} },
      uiArtifacts: { version: 2, entries: [] },
    });
    const metadata = { name: packageName, version,
      dist: { integrity: 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==', tarball: 'https://registry.npmjs.org/community.tgz' },
      happier: { compatibilityProjection: compatibility, marketplaceDiscovery: createMarketplaceNpmDiscoveryProjectionV1({ compatibility, manifestDigest: `sha256:${'a'.repeat(64)}` }) } };
    const urls: string[] = [];
    const http: RegistryHttpV1 = {
      async getJson(url) { urls.push(url); return { ok: true, fetchedAt: 1, value: url.includes('/-/v1/search')
        ? { total: 201, objects: [{ package: { name: packageName, version, publisher: { username: 'acme' } } }] }
        : { name: packageName, versions: { [version]: metadata }, 'dist-tags': { latest: version } } }; },
      getText: async () => { throw new Error('Unexpected text fetch'); }, getBytes: async () => { throw new Error('Unexpected bytes fetch'); },
    };
    const readSources = async () => listRegistrySourcesV1({ record: { v: 2, sources: [], disabledSourceIds: [] }, pluginSources: [] });
    const host = createRegistryHostV1({ host: 'web', http, readSources });
    const listed = await host.execute('registries.items.list', { kind: 'plugin', sourceIds: [COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1], query: 'themes' });
    const result = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.list'].parse(listed);
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]?.items).toMatchObject([{ kind: 'plugin', itemId: packageName, title: 'Community', version }]);
    expect(result.pages[0]?.nextCursor).not.toBeNull();
    expect(urls).toHaveLength(2);
    expect(new URL(urls[0]!).searchParams.get('text')).toBe('keywords:happier-plugin themes');
    await host.execute('registries.items.list', { kind: 'plugin', sourceIds: [COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1],
      query: 'themes', cursor: result.pages[0]!.nextCursor });
    expect(new URL(urls[2]!).searchParams.get('from')).toBe('1');
    expect(new URL(urls[2]!).searchParams.get('text')).toBe('keywords:happier-plugin themes');
    const read = await host.execute('registries.items.read', { kind: 'plugin', sourceId: COMMUNITY_NPM_MARKETPLACE_SOURCE_ID_V1, itemId: packageName, version });
    const consumed = REGISTRY_ACTION_OUTPUT_SCHEMAS_V1['registries.items.read'].parse(JSON.parse(JSON.stringify(read)));
    expect(consumed.item.payload.kind).toBe('plugin');
    if (consumed.item.payload.kind !== 'plugin' || !('listing' in consumed.item.payload)) throw new Error('Expected npm plugin payload');
    expect(consumed.item.payload.listing.pluginId).toBe('acme.community');
    expect(consumed.item.summary.version).toBe(consumed.item.payload.listing.distribution.version);
    expect(RegistryItemV1Schema.safeParse({ ...consumed.item, summary: { ...consumed.item.summary, itemId: 'another-package' } }).success).toBe(false);
  });
});
