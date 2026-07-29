import { describe, expect, it, vi } from 'vitest';

import type { MarketplaceIndexQueryResultV1 } from '@happier-dev/protocol';

import { projectDaemonMarketplaceIndex } from './readPluginMarketplaceCatalog';

describe('projectDaemonMarketplaceIndex', () => {
    it('maps only the typed daemon projection and never fetches a catalog in the client', () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const result: MarketplaceIndexQueryResultV1 = {
            revision: 4,
            nextCursor: null,
            sources: [],
            diagnostics: [],
            items: [{
                pluginId: 'sample.plugin',
                publisher: { id: 'sample', displayName: 'Sample' },
                display: { title: 'Sample Plugin', description: 'Daemon-owned marketplace entry' },
                distribution: { kind: 'npm', registryOrigin: 'https://registry.npmjs.org', packageName: 'sample-plugin', version: '1.2.3', integrity: 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==' },
                manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
                compatibility: { happier: '>=1', platforms: ['web'] },
                summary: { contributions: ['agents'], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
                review: { status: 'approved', reviewedAt: '2026-07-13T00:00:00.000Z' },
                categories: ['agents'],
                media: [],
                updatePolicy: 'curated-auto',
                links: {},
                source: { id: 'curated', title: 'Happier curated', kind: 'curated', sourceUrl: 'https://marketplace.example.test/catalog.json' },
                freshness: { state: 'fresh', fetchedAtMs: 1 },
                admission: { curatedInstall: 'allowed', curatedUpdate: 'allowed', warning: false, mutatesInstalledTrust: false, disablesInstalledCode: false, directNpmRequiresFullReview: true },
                artifactAccess: { state: 'public', registryProfileId: null },
            }],
        };

        expect(projectDaemonMarketplaceIndex(result)).toEqual({
            sourceUrl: 'daemon:marketplace-index',
            title: '',
            description: null,
            entries: [{
                id: 'sample.plugin',
                sourceId: 'curated',
                sourceKind: 'curated',
                reviewStatus: 'approved',
                title: 'Sample Plugin',
                description: 'Daemon-owned marketplace entry',
                version: '1.2.3',
                installable: true,
                updateable: true,
            }],
        });
        expect(fetchSpy).not.toHaveBeenCalled();
        fetchSpy.mockRestore();
    });

    it('surfaces an exact community npm listing as unreviewed code eligible for the normal trust flow', () => {
        const community: MarketplaceIndexQueryResultV1['items'][number] = {
            pluginId: 'community.plugin',
            publisher: { id: 'community', displayName: 'Community Publisher' },
            display: { title: 'Community Plugin', description: 'Third-party plugin from npm' },
            distribution: {
                kind: 'npm',
                registryOrigin: 'https://registry.npmjs.org',
                packageName: 'community-plugin',
                version: '2.0.0',
                integrity: 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==',
            },
            manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            compatibility: { happier: '>=1', platforms: ['web'] },
            summary: { contributions: ['agents'], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
            review: { status: 'unreviewed', reviewedAt: null },
            categories: ['agents'],
            media: [],
            updatePolicy: 'manual',
            links: {},
            source: {
                id: 'marketplace:community-npm',
                title: 'Community npm',
                kind: 'community-npm',
                sourceUrl: 'https://registry.npmjs.org/-/v1/search?text=keywords:happier-plugin',
            },
            freshness: { state: 'fresh', fetchedAtMs: 1 },
            admission: {
                curatedInstall: 'full-review',
                curatedUpdate: 'not-applicable',
                warning: false,
                mutatesInstalledTrust: false,
                disablesInstalledCode: false,
                directNpmRequiresFullReview: true,
            },
            artifactAccess: { state: 'public', registryProfileId: null },
        };

        expect(projectDaemonMarketplaceIndex({
            revision: 1,
            nextCursor: null,
            sources: [],
            diagnostics: [],
            items: [community],
        }).entries).toEqual([{
            id: 'community.plugin',
            sourceId: 'marketplace:community-npm',
            sourceKind: 'community-npm',
            reviewStatus: 'unreviewed',
            title: 'Community Plugin',
            description: 'Third-party plugin from npm',
            version: '2.0.0',
            installable: true,
            updateable: true,
        }]);
    });

    it.each([
        ['stale', { freshness: { state: 'stale' as const, fetchedAtMs: 1, staleSinceMs: 1 } }],
        ['unapproved', { review: { status: 'blocked' as const, reviewedAt: null } }],
        ['non-curated', { source: { id: 'user', title: 'User source', kind: 'user' as const, sourceUrl: 'https://marketplace.example.test/catalog.json' } }],
    ])('does not surface a non-warning %s listing', (_label, override) => {
        const approved: MarketplaceIndexQueryResultV1['items'][number] = {
            pluginId: 'sample.plugin',
            publisher: { id: 'sample', displayName: 'Sample' },
            display: { title: 'Sample Plugin', description: 'Daemon-owned marketplace entry' },
            distribution: { kind: 'npm' as const, registryOrigin: 'https://registry.npmjs.org', packageName: 'sample-plugin', version: '1.2.3', integrity: 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==' },
            manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            compatibility: { happier: '>=1', platforms: ['web' as const] },
            summary: { contributions: ['agents'], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon' as const] },
            review: { status: 'approved' as const, reviewedAt: '2026-07-13T00:00:00.000Z' },
            categories: ['agents'], media: [], updatePolicy: 'curated-auto' as const, links: {},
            source: { id: 'curated', title: 'Happier curated', kind: 'curated' as const, sourceUrl: 'https://marketplace.example.test/catalog.json' },
            freshness: { state: 'fresh' as const, fetchedAtMs: 1 },
            admission: { curatedInstall: 'allowed' as const, curatedUpdate: 'allowed' as const, warning: false, mutatesInstalledTrust: false, disablesInstalledCode: false, directNpmRequiresFullReview: true },
            artifactAccess: { state: 'public' as const, registryProfileId: null },
            ...override,
        };
        const result: MarketplaceIndexQueryResultV1 = {
            revision: 1,
            nextCursor: null,
            sources: [],
            diagnostics: [],
            items: [approved],
        };

        expect(projectDaemonMarketplaceIndex(result).entries).toEqual([]);
    });

    it('retains a withdrawn curated listing as a non-installable warning without granting disable authority', () => {
        const withdrawn: MarketplaceIndexQueryResultV1['items'][number] = {
            pluginId: 'sample.withdrawn',
            publisher: { id: 'sample', displayName: 'Sample' },
            display: { title: 'Withdrawn Plugin', description: 'Previously curated plugin' },
            distribution: { kind: 'npm', registryOrigin: 'https://registry.npmjs.org', packageName: 'sample-withdrawn', version: '1.2.3', integrity: 'sha512-AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQ==' },
            manifestDigest: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            compatibility: { happier: '>=1', platforms: ['web'] },
            summary: { contributions: ['agents'], requiredHostAccess: [], optionalHostAccess: [], executableRealms: ['daemon'] },
            review: { status: 'withdrawn', reviewedAt: null },
            categories: ['agents'], media: [], updatePolicy: 'curated-auto', links: {},
            source: { id: 'curated', title: 'Happier curated', kind: 'curated', sourceUrl: 'https://marketplace.example.test/catalog.json' },
            freshness: { state: 'fresh', fetchedAtMs: 1 },
            admission: { curatedInstall: 'refused', curatedUpdate: 'refused', warning: true, mutatesInstalledTrust: false, disablesInstalledCode: false, directNpmRequiresFullReview: true },
            artifactAccess: { state: 'public', registryProfileId: null },
        };

        expect(projectDaemonMarketplaceIndex({
            revision: 1,
            nextCursor: null,
            sources: [],
            diagnostics: [],
            items: [withdrawn],
        }).entries).toEqual([{
            id: 'sample.withdrawn',
            sourceId: 'curated',
            sourceKind: 'curated',
            reviewStatus: 'withdrawn',
            title: 'Withdrawn Plugin',
            description: 'Previously curated plugin',
            version: '1.2.3',
            installable: false,
            updateable: false,
            warning: 'withdrawn',
        }]);
    });
});
