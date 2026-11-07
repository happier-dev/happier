import { describe, expect, it } from 'vitest';
import { readStoreListingReference } from '@/components/settings/plugins/model/storeListingSelection';
import { PluginStoreKindContributionV1Schema, projectPluginStoreKindDeclarationV1 } from '@happier-dev/protocol';
import { normalizePluginInstalledUiDeclarations } from '@/sync/domains/plugins/ui/projection';
import { createPluginPagePlacementFixture } from '@/dev/testkit/fixtures/pluginPageProjectionFixture';
import { APP_STORE_KIND, BOT_STORE_KIND, listStoreKindContributions, resolveStoreKindContribution } from './storeKindContributions';
import { unionPluginUiProjections, mergeInstalledPluginUiProjections } from '@/sync/domains/plugins/ui/projectionUnion';
import { PluginMachineExecutionOriginV1Schema } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';

const pluginId = 'example.themes';
const definition = PluginStoreKindContributionV1Schema.parse({ id: 'themes', title: 'Themes', viewId: 'catalog', operations: {
    list: 'list', read: 'read', installed: 'installed', prepare: 'prepare', acquire: 'acquire', manage: 'manage',
} });
const declaration = projectPluginStoreKindDeclarationV1({ pluginId, pluginVersion: '1.0.0', definition });
const model = normalizePluginInstalledUiDeclarations({}, undefined, undefined, undefined, undefined, [declaration]);

describe('Store kind contribution owner', () => {
    it('retains a third-party selection for its contributed parser and missing-plugin recovery', () => {
        const reference = { type: 'storeKind', kind: 'example.themes/themes', sourceId: 'themes', itemId: 'warm', version: '1.0.0' };
        expect(readStoreListingReference(reference)).toEqual(reference);
    });

    it('rejects unqualified plugin kinds and malformed item identity at route admission', () => {
        expect(readStoreListingReference({ type: 'storeKind', kind: 'themes', sourceId: 'themes', itemId: 'warm' })).toBeNull();
        expect(readStoreListingReference({ type: 'storeKind', kind: 'example.themes/themes', sourceId: '', itemId: 'warm' })).toBeNull();
    });

    it('keeps built-in Apps and cold contributions in one metadata directory', () => {
        expect(listStoreKindContributions(model)).toEqual([APP_STORE_KIND, BOT_STORE_KIND, {
            key: 'example.themes/themes', pluginId, definition,
        }]);
        expect(resolveStoreKindContribution('app', null)).toBe(APP_STORE_KIND);
        expect(resolveStoreKindContribution('bot', null)).toBe(BOT_STORE_KIND);
        expect(resolveStoreKindContribution('example.themes/themes', model)).toMatchObject({ definition, placement: null });
    });

    it('uses the admitted same-plugin app-page placement and preserves a selection when the plugin disappears', () => {
        const wrongTarget = createPluginPagePlacementFixture({ pluginId, localId: 'catalog', title: 'Project themes', targetKind: 'project' });
        const placement = createPluginPagePlacementFixture({ pluginId, localId: 'catalog', title: 'Themes', targetKind: 'app' });
        const projection = { ...model, surfacePlacementsById: { project: wrongTarget, app: placement } };
        expect(resolveStoreKindContribution('example.themes/themes', projection)).toMatchObject({ placement });
        const reference = { type: 'storeKind', kind: 'example.themes/themes', sourceId: 'themes', itemId: 'warm' };
        expect(resolveStoreKindContribution(reference.kind, null)).toBeNull();
        expect(readStoreListingReference(reference)).toEqual(reference);
    });

    it('retains Store declarations through installed/runtime union and withdraws disabled kinds', () => {
        const executionOrigin = PluginMachineExecutionOriginV1Schema.parse({ serverIdentityId: 'srv_store-server',
            sourceRef: { machineId: 'store-machine', pluginId, sourceCustody: { kind: 'development', registeredRootId: 'themes-root' } } });
        const runtime = normalizePluginInstalledUiDeclarations({}, undefined, {
            id: pluginId, displayName: 'Themes', version: '1.0.0', enabled: true, executionOrigin,
            occurrenceId: 'theme-runtime', source: { kind: 'path', locator: '/plugins/themes' },
        }, undefined, undefined, [{ ...declaration, occurrenceId: 'theme-runtime', executionOrigin }]);
        const member = { machineId: 'store-machine', serverId: 'server', serverIdentityId: 'srv_store-server',
            phase: 'current' as const, interactionEnabled: true, projection: runtime };
        expect(mergeInstalledPluginUiProjections([model], runtime)?.storeKindsById[declaration.id]).toMatchObject({ definition });
        const published = unionPluginUiProjections([member], new Map([[pluginId, executionOrigin]])).pluginUiProjection;
        expect(published?.storeKindsById[declaration.id]).toMatchObject({ definition });
        const disabled = { ...runtime, installedPackagesById: { [pluginId]: { ...runtime.installedPackagesById[pluginId]!, enabled: false } } };
        expect(unionPluginUiProjections([{ ...member, projection: disabled }], new Map([[pluginId, executionOrigin]])).pluginUiProjection
            ?.storeKindsById[declaration.id]).toBeUndefined();
    });
});
