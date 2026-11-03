import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PluginManifestV2LoadSchema } from '@happier-dev/protocol/plugins/manifest';
import { PluginMachineMaterializationV1Schema } from '@happier-dev/protocol/plugins/availability';
import { SavedSecretCatalogEntryV1Schema } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import { projectBundledPluginUiDeclaration, projectBundledPluginUiFirstPaintDeclaration } from '../../../../../../cli/scripts/build-owned/bundledPlugins/uiDeclarations.mjs';
import { installedSecretSourceDeclarations, withSavedSecretProviderLabels } from '@/sync/api/account/savedSecretCatalogPresentation';
import { createPluginAccountAvailabilityReader } from './reader';

const manifest = PluginManifestV2LoadSchema.parse(JSON.parse(readFileSync(new URL(
    '../../../../../../cli/assets/bundled-plugin-manifests/onepassword.json', import.meta.url), 'utf8')));
const full = await projectBundledPluginUiDeclaration({ packageName: '@happier-dev/plugins-onepassword',
    packageVersion: manifest.version, manifest, artifactGraphs: [] });
const firstPaint = await projectBundledPluginUiFirstPaintDeclaration(full);
const provider = { pluginId: manifest.id, localId: 'onepassword' };
const scope = { serverId: 'srv_fixture', accountId: 'account-a' };

function installed(sourceClass = 'bundledFirstParty', version = manifest.version) {
    const materializations = Array.from({ length: 8 }, (_, index) => PluginMachineMaterializationV1Schema.parse({
        serverIdentityId: 'srv_fixture', machineId: `machine-${index}`, materializationId: `daemon-selected:${manifest.id}`,
        pluginId: manifest.id, version, sourceClass, portableRelease: false, uiArtifacts: [], enabled: true,
        trustState: 'trusted', observedAt: 1,
    }));
    return createPluginAccountAvailabilityReader({ scope, hostBundledUi: [firstPaint], snapshot: {
        availabilityCursor: 1, intentReads: [], materializations,
        snapshots: materializations.map(materialization => ({ serverIdentityId: materialization.serverIdentityId,
            machineId: materialization.machineId, materializations: [materialization] })),
    } }).readInstalledPlugins();
}

describe('bundled native Saved Secret source availability', () => {
    it('retains value-free source discovery in the bundled first-paint declaration', () => {
        expect(firstPaint.presentationManifest.contributes.secretSources).toEqual([
            { id: 'onepassword', title: '1Password', capabilities: { list: true, store: true } },
        ]);
    });

    it('projects the bundled declaration for all eight Machine installations and labels retained catalog rows', () => {
        const declarations = installedSecretSourceDeclarations(installed());
        expect(declarations).toHaveLength(8);
        expect(declarations.every(declaration => declaration.contributes.secretSources?.[0]?.title === '1Password')).toBe(true);
        const entry = SavedSecretCatalogEntryV1Schema.parse({ ref: 'shared:example', source: 'shared_resource',
            relationship: 'owner', name: 'Example', kind: 'other', revision: 1, materialStatus: 'ready',
            storage: { kind: 'external', provider },
            capabilities: { use: true, rename: true, rotate: true, manageAccess: true, delete: true },
        });
        expect(withSavedSecretProviderLabels([{ entry }], declarations)[0]?.entry.storage)
            .toEqual({ kind: 'external', provider, providerLabel: '1Password' });
    });

    it('does not borrow app-bundled metadata for a local plugin or a different installed version', () => {
        expect(installedSecretSourceDeclarations(installed('localPath'))).toEqual([]);
        expect(installedSecretSourceDeclarations(installed('bundledFirstParty', '99.0.0'))).toEqual([]);
    });
});
