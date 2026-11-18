import { describe, expect, it } from 'vitest';

import { buildPluginMarketplaceDiscoverIssues } from './pluginMarketplaceDiscoverIssues';
import type { PluginMarketplaceDiscoverSourceStatus } from '../readPluginMarketplaceCatalog';

const curatedUnreachable: PluginMarketplaceDiscoverSourceStatus = {
    id: 'happier-curated',
    title: 'Happier catalog',
    kind: 'curated',
    freshness: 'unavailable',
    diagnostics: [
        { id: 'source:happier-curated:marketplace_source_unavailable:0', sourceId: 'happier-curated', sourceTitle: 'Happier catalog', code: 'marketplace_source_unavailable', message: 'getaddrinfo ENOTFOUND marketplace.happier.dev' },
        { id: 'source:happier-curated:marketplace_source_unavailable:1', sourceId: 'happier-curated', sourceTitle: 'Happier catalog', code: 'marketplace_source_unavailable', message: 'getaddrinfo ENOTFOUND marketplace.happier.dev' },
    ],
};

describe('buildPluginMarketplaceDiscoverIssues', () => {
    it('gives a source one issue, however many ways the daemon reports it', () => {
        const issues = buildPluginMarketplaceDiscoverIssues({
            sourceStatuses: [curatedUnreachable, { ...curatedUnreachable, diagnostics: [] }],
            diagnostics: [],
        });
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ sourceId: 'happier-curated', sourceTitle: 'Happier catalog', reachable: false });
        // The repeated report collapses to one technical detail.
        expect(issues[0]!.details).toEqual([{ code: 'marketplace_source_unavailable', message: 'getaddrinfo ENOTFOUND marketplace.happier.dev' }]);
    });

    it('keeps a healthy source quiet and gathers index-wide diagnostics into one issue', () => {
        const issues = buildPluginMarketplaceDiscoverIssues({
            sourceStatuses: [{ id: 'npm', title: 'Community npm', kind: 'community-npm', freshness: 'fresh', diagnostics: [] }],
            diagnostics: [
                { id: 'index:index_partial:0', sourceId: null, sourceTitle: null, code: 'index_partial', message: 'shard 3 missing' },
                { id: 'index:index_stale:0', sourceId: null, sourceTitle: null, code: 'index_stale', message: 'older than 1h' },
            ],
        });
        expect(issues).toHaveLength(1);
        expect(issues[0]).toMatchObject({ sourceId: null });
        expect(issues[0]!.details.map((detail) => detail.code)).toEqual(['index_partial', 'index_stale']);
    });

    it('folds a page diagnostic that names a source into that source’s issue', () => {
        const issues = buildPluginMarketplaceDiscoverIssues({
            sourceStatuses: [{ ...curatedUnreachable, diagnostics: [] }],
            diagnostics: [curatedUnreachable.diagnostics[0]!],
        });
        expect(issues).toHaveLength(1);
        expect(issues[0]!.details).toHaveLength(1);
    });

    it('says a stale source is behind rather than unreachable', () => {
        const issues = buildPluginMarketplaceDiscoverIssues({
            sourceStatuses: [{ ...curatedUnreachable, freshness: 'stale', diagnostics: [] }],
            diagnostics: [],
        });
        expect(issues[0]).toMatchObject({ reachable: true });
    });
});
