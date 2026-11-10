import { describe, expect, it } from 'vitest';
import { PluginProjectionV2Schema } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { mergeProjectionSections } from './mergeProjectionSections';

describe('same-manifest narrow Search coverage', () => {
    const digest = '7'.repeat(64);
    const action = (id: string) => ({ id, pluginId: 'qa.search', title: id, occurrenceId: 'qa.search:7',
        scopes: ['global'], surfaces: ['ui'], placementBindings: [], execution: { target: 'daemon' }, dangerLevel: 'safe', available: true });
    const response = (loadedSections: readonly string[], actionIds: readonly string[], entryIds: readonly string[]) => ({
        supported: true as const, protocolVersion: 1 as const, projectionDigest: digest,
        projection: PluginProjectionV2Schema.parse({ v: 2, generation: 7,
            agentsById: loadedSections.includes('agentsById') ? { codex: { id: 'codex', title: 'Codex' } } : {},
            actionsById: Object.fromEntries(actionIds.map(id => [`qa.search/${id}`, action(id)])),
            familiesById: entryIds.length ? { pluginUi: { family: 'pluginUi', entriesById: Object.fromEntries(
                entryIds.map(id => [id, id === 'searchProvider' ? { id: 'searchProvider:qa.search:search', pluginId: 'qa.search',
                    contributionKind: 'searchProvider', occurrenceId: 'qa.search:7', descriptorId: 'search',
                    identity: { pluginId: 'qa.search', localId: 'search' }, action: { pluginId: 'qa.search', localId: 'query' } }
                    : { id, pluginId: 'qa.search', occurrenceId: 'qa.search:7', contributionKind: 'translations' }])) } } : {},
        }),
        deferredProjection: { manifest: { protocolVersion: 1 as const, deferredSections: true as const,
            projectionDigest: digest, sectionFrameVersion: 2 as const, sections: Object.fromEntries(['base', 'installedPackagesById', 'agentsById',
                'actionsById', 'familiesById.pluginUi', 'searchProviders'].map(id => [id, digest])) }, loadedSections },
    });
    it('preserves exact Search Actions when a concurrent Agent read finishes first', () => {
        const search = response(['base', 'installedPackagesById', 'searchProviders'], ['query'], ['searchProvider']);
        const agents = response(['base', 'installedPackagesById', 'agentsById'], [], []);
        for (const result of [mergeProjectionSections(search, agents), mergeProjectionSections(agents, search)]) {
            expect(Object.keys(result.projection.actionsById)).toEqual(['qa.search/query']);
            expect(result.projection.agentsById.codex?.title).toBe('Codex');
        }
    });
    it('expands Search to complete UI demand without a narrow result erasing complete coverage', () => {
        const search = response(['base', 'installedPackagesById', 'searchProviders'], ['query'], ['searchProvider']);
        const full = response(['base', 'installedPackagesById', 'actionsById', 'familiesById.pluginUi'],
            ['query', 'unrelated'], ['searchProvider', 'unrelated']);
        for (const result of [mergeProjectionSections(full, search), mergeProjectionSections(search, full)]) {
            expect(Object.keys(result.projection.actionsById)).toHaveLength(2);
            expect(Object.keys(result.projection.familiesById.pluginUi!.entriesById)).toHaveLength(2);
        }
    });
});
