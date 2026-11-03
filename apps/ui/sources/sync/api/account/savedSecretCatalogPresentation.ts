import { buildQualifiedPluginContributionKey, type PluginContributionIdentityV1 } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginPortableReleaseManifestV1 } from '@happier-dev/protocol/plugins/availability';
import type { PluginSecretSourceContributionV1 } from '@happier-dev/protocol/plugins/contributions/public-types';
import type { SavedSecretCatalogResultV1 } from '@happier-dev/protocol/account/settings/savedSecretCatalogV1';
import type { PluginAccountInstalledPluginsAdmission } from '@/sync/domains/plugins/availability/reader';

type SecretSourceDeclaration = Pick<PluginPortableReleaseManifestV1, 'id'> & Readonly<{
    contributes: Pick<PluginPortableReleaseManifestV1['contributes'], 'secretSources'>;
    machineId?: string;
}>;

/** A secret source a Saved Secret can be linked to, from an admitted declaration; never a native read. */
export type SavedSecretSourceOption = Readonly<{ key: string; contribution: PluginContributionIdentityV1; title: string;
    capabilities?: PluginSecretSourceContributionV1['capabilities']; machineIds?: readonly string[] }>;

/** The declarations of plugins installed on this Account's Machines. */
export function installedSecretSourceDeclarations(installed: PluginAccountInstalledPluginsAdmission): readonly SecretSourceDeclaration[] {
    return installed.kind === 'available'
        ? installed.plugins.flatMap(plugin => plugin.installations.flatMap(installation => installation.declaration
            ? [{ ...installation.declaration, machineId: installation.materialization.machineId }] : []))
        : [];
}

/** One option per declared source; a source declared with two different titles is ambiguous and left out. */
export function listSavedSecretSources(declarations: readonly SecretSourceDeclaration[]): readonly SavedSecretSourceOption[] {
    const sources = new Map<string, SavedSecretSourceOption | null>();
    for (const declaration of declarations) {
        for (const source of declaration.contributes.secretSources ?? []) {
            const contribution = { pluginId: declaration.id, localId: source.id };
            const key = buildQualifiedPluginContributionKey(contribution);
            const known = sources.get(key);
            const machineIds = [...new Set([...(known?.machineIds ?? []), ...(declaration.machineId ? [declaration.machineId] : [])])];
            sources.set(key, known === undefined ? { key, contribution, title: source.title,
                ...(source.capabilities ? { capabilities: source.capabilities } : {}), ...(machineIds.length ? { machineIds } : {}) }
                : known !== null && known.title === source.title ? { ...known,
                    ...(machineIds.length ? { machineIds } : {}),
                    ...((known.capabilities || source.capabilities) ? { capabilities: {
                        ...(known.capabilities?.list || source.capabilities?.list ? { list: true as const } : {}),
                        ...(known.capabilities?.store || source.capabilities?.store ? { store: true as const } : {}),
                    } } : {}) } : null);
        }
    }
    return [...sources.values()].filter((source): source is SavedSecretSourceOption => source !== null);
}

/** Presentation uses declarations already admitted by Account availability, never secret material. */
export function withSavedSecretProviderLabels<T extends Readonly<{ entry: SavedSecretCatalogResultV1 }>>(
    resources: readonly T[],
    declarations: readonly SecretSourceDeclaration[],
): readonly T[] {
    const labels = new Map(listSavedSecretSources(declarations).map(source => [source.key, source.title]));
    return resources.map(resource => {
        if (resource.entry.materialStatus === 'resource_corrupt') return resource;
        const storage = resource.entry.storage;
        if (storage?.kind !== 'external') return resource;
        const providerLabel = labels.get(buildQualifiedPluginContributionKey(storage.provider));
        return providerLabel ? { ...resource, entry: { ...resource.entry, storage: { ...storage, providerLabel } } } : resource;
    });
}
