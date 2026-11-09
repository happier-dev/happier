import { MarketplaceIndexSourceSnapshotV1Schema, deriveMarketplaceSourceId, createMarketplaceNpmDiscoveryProjectionV1, type MarketplaceNpmDiscoveryProjectionV1 } from '@happier-dev/protocol/marketplace';
import { createPluginCompatibilityProjectionV1, type PluginCompatibilityProjectionV1 } from '@happier-dev/protocol/plugins/availability/v1';
import { PluginManifestV2Schema } from '@happier-dev/protocol/plugins/manifest';
import type { PluginManifest } from '@happier-dev/protocol/plugins/manifest';
import type { PluginBotTemplateContributionV1 } from '@happier-dev/protocol/plugins/contributions/botTemplates';

export function createRegistryNpmPackageFixture(input: Readonly<{ packageName: string; pluginId: string; title: string; version: string;
    contributes?: PluginManifest['contributes'] }>): {
    name: string;
    version: string;
    dist: { integrity: string; tarball: string };
    happier: {
        compatibilityProjection: PluginCompatibilityProjectionV1;
        marketplaceDiscovery: MarketplaceNpmDiscoveryProjectionV1;
    };
} {
    const compatibility = createPluginCompatibilityProjectionV1({
        manifest: PluginManifestV2Schema.parse({ schemaVersion: 2, id: input.pluginId, version: input.version, displayName: input.title,
            runtime: { apiVersion: 1 }, entrypoints: { daemon: './dist/index.js' }, hostAccess: { required: [], optional: [] }, contributes: input.contributes ?? {} }),
        uiArtifacts: { version: 2, entries: [] },
    });
    return { name: input.packageName, version: input.version,
        dist: { integrity: 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==', tarball: 'https://registry.npmjs.org/plugin.tgz' },
        happier: { compatibilityProjection: compatibility,
            marketplaceDiscovery: createMarketplaceNpmDiscoveryProjectionV1({ compatibility, manifestDigest: 'sha256:' + 'a'.repeat(64) }) },
    };
}

/** Published catalog bytes, consumed by the real Registry format adapter. */
export function createRegistryPluginCatalogFixture(input: Readonly<{
    sourceUrl: string;
    kind?: 'curated' | 'user';
    entries?: readonly Readonly<{ pluginId: string; title: string; version?: string;
        botTemplates?: readonly PluginBotTemplateContributionV1[];
        review?: 'approved' | 'unreviewed' | 'blocked' | 'withdrawn' }>[];
}>) {
    return MarketplaceIndexSourceSnapshotV1Schema.parse({
        source: { id: deriveMarketplaceSourceId(input.sourceUrl), title: 'Catalog', kind: input.kind ?? 'user', sourceUrl: input.sourceUrl },
        freshness: { state: 'fresh', fetchedAtMs: 1 }, diagnostics: [],
        entries: (input.entries ?? [{ pluginId: 'sample.plugin', title: 'Sample Plugin' }]).map(entry => ({
            pluginId: entry.pluginId, publisher: { id: 'sample', displayName: 'Sample' },
            display: { title: entry.title, description: 'A catalog entry' },
            distribution: { kind: 'npm', registryOrigin: 'https://registry.npmjs.org', packageName: entry.pluginId.replaceAll('.', '-'), version: entry.version ?? '1.2.3',
                integrity: 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==' },
            manifestDigest: 'sha256:' + 'a'.repeat(64), compatibility: { happier: '>=1', platforms: ['web'] },
            summary: { contributions: entry.botTemplates ? ['botTemplates'] : ['agents'],
                ...(entry.botTemplates ? { botTemplates: entry.botTemplates } : {}), requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
            review: { status: entry.review ?? 'unreviewed', reviewedAt: entry.review === 'approved' ? '2026-10-12T00:00:00.000Z' : null },
            categories: ['agents'], media: [], updatePolicy: 'allowed', links: {},
        })),
    });
}
