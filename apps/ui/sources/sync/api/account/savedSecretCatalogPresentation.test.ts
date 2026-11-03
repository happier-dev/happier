import { describe, expect, it } from 'vitest';
import { SavedSecretCatalogEntryV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import { listSavedSecretSources, withSavedSecretProviderLabels } from './savedSecretCatalogPresentation';

const provider = { pluginId: 'happier.secret-source.onepassword', localId: 'onepassword' };
const row = { entry: SavedSecretCatalogEntryV1Schema.parse({
    ref: 'shared:example', source: 'shared_resource', relationship: 'owner', name: 'Example', kind: 'other',
    revision: 1, materialStatus: 'ready', storage: { kind: 'external', provider },
    capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
}) };
const declaration = { id: provider.pluginId, contributes: { secretSources: [{ id: provider.localId, title: '1Password' }] } } satisfies Pick<PluginPortableReleaseManifestV1, 'id'> & {
    contributes: Pick<PluginPortableReleaseManifestV1['contributes'], 'secretSources'>;
};

describe('Saved Secret provider presentation', () => {
    it('preserves cold declared vault capabilities without invoking a native source', () => {
        const capabilities = { list: true as const, store: true as const };
        const source = { ...declaration, contributes: { secretSources: [{ ...declaration.contributes.secretSources[0], capabilities }] } };
        expect(listSavedSecretSources([source])[0]).toMatchObject({ contribution: provider, capabilities });
    });
    it('labels retained external metadata without content and leaves its input unchanged', () => {
        const labeled = withSavedSecretProviderLabels([row], [declaration]);
        expect(labeled[0]?.entry.storage).toEqual({ kind: 'external', provider, providerLabel: '1Password' });
        expect(row.entry.storage).toEqual({ kind: 'external', provider });
        expect(SavedSecretCatalogEntryV1Schema.parse(labeled[0]?.entry).storage).toEqual(labeled[0]?.entry.storage);
    });

    it('matches both provider identifiers and leaves absent or ambiguous declarations unlabeled', () => {
        for (const declarations of [[], [{ ...declaration, id: 'com.example.other' }],
            [{ ...declaration, contributes: { secretSources: [{ id: 'other', title: 'Other source' }] } }],
            [declaration, { ...declaration, contributes: { secretSources: [{ id: provider.localId, title: 'Other source' }] } }]]) {
            expect(withSavedSecretProviderLabels([row], declarations)).toEqual([row]);
        }
        expect(withSavedSecretProviderLabels([row], [declaration, declaration])[0]?.entry.storage)
            .toEqual({ kind: 'external', provider, providerLabel: '1Password' });
    });

    it('preserves value and passkey descriptors without a provider label', () => {
        for (const kind of ['value', 'passkey'] as const) {
            const inline = { entry: { ...row.entry, storage: { kind } } };
            expect(withSavedSecretProviderLabels([inline], [declaration])).toEqual([inline]);
        }
    });
});
