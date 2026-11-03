import { computePluginUiArtifactSha256DigestV1 } from '@happier-dev/protocol/plugins/ui';
import { createPluginContextualResourceReadClient, type PluginSurfaceResourceReadTransport } from '@/components/plugins/surfaces/pluginSurfaceResourceRead';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';
import { readPluginUiResourceProjection, type PluginUiProjectionModel } from '../ui/projection';
import { readPluginUiAccountExecutableOrigin, readPluginUiContributionOrigin } from '../ui/projectionOrigins';
import { readBundledPluginUiAppArtifactAssetBytes } from './bundledPluginUiArtifactAssetReader';
import type { BundledPluginPackagedResource } from './bundledPluginUiArtifactInventory';
import * as bundledPluginUiInventory from './generatedBundledPluginUiArtifacts';
import { acquirePluginSelectedPackageAssetLease, type PluginProtectedAccountPackageAssetSource } from './packageAssetLease';
import type { PluginAccountAvailabilityReader } from './reader';

/** Resource transport only. Locale choice and JSON interpretation belong to UI i18n. */
export function createPluginUiTranslationResourceByteReader(input: Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime;
    readCurrentProjection: () => PluginUiProjectionModel | null;
    resourceRead?: PluginSurfaceResourceReadTransport;
    bundledResources?: readonly BundledPluginPackagedResource[];
    packageAssets?: Readonly<{ reader: PluginAccountAvailabilityReader; source: PluginProtectedAccountPackageAssetSource }>;
}>) {
    return async (projection: PluginUiProjectionModel, pluginId: string, resourceId: string, callerSignal?: AbortSignal): Promise<Uint8Array | null> => {
        const resource = readPluginUiResourceProjection(projection.resourcesById, { pluginId, localId: resourceId });
        const installed = projection.installedPackagesById[pluginId];
        if (!resource || !installed?.enabled || installed.id !== pluginId || !installed.occurrenceId
            || resource.occurrenceId !== installed.occurrenceId || resource.resourceKind !== 'asset'
            || !resource.path || resource.contentType !== 'application/json') return null;
        const current = () => {
            const latest = input.readCurrentProjection();
            return input.accountLifetime.isCurrent() && !callerSignal?.aborted
                && latest?.installedPackagesById[pluginId] === installed
                && readPluginUiResourceProjection(latest?.resourcesById, { pluginId, localId: resourceId }) === resource;
        };
        if (!current()) return null;
        const controller = new AbortController();
        const retirement = input.accountLifetime.onRetire(() => controller.abort());
        const merged = mergeAbortSignals([controller.signal, callerSignal]);
        try {
            const accountOrigin = readPluginUiAccountExecutableOrigin(resource);
            if (accountOrigin) {
                if (!areServerAccountScopesEqual(accountOrigin, input.accountLifetime.scope)
                    || accountOrigin.custodyId !== installed.occurrenceId) return null;
                if (accountOrigin.sourceCustody.kind === 'bundled_first_party') {
                    const exact = (input.bundledResources ?? bundledPluginUiInventory.BUNDLED_PLUGIN_PACKAGED_RESOURCES ?? []).find(candidate =>
                        candidate.pluginId === pluginId && candidate.releaseVersion === installed.version
                        && candidate.resourceId === resourceId && (!resource.digest || candidate.digest === resource.digest));
                    if (!exact) return null;
                    const bytes = await readBundledPluginUiAppArtifactAssetBytes(exact.asset);
                    return current() && bytes && computePluginUiArtifactSha256DigestV1(bytes) === exact.digest ? bytes : null;
                }
                if (accountOrigin.sourceCustody.pluginId !== pluginId || accountOrigin.sourceCustody.version !== installed.version) return null;
                if (!input.packageAssets) return null;
                const { reader, source } = input.packageAssets;
                const admission = reader.readCurrentPackageAsset({ pluginId });
                if (admission.kind !== 'available' || admission.packageAsset.releaseVersion !== installed.version) return null;
                const descriptor = admission.packageAsset.descriptor.resources.find(candidate => candidate.resourceId === resourceId);
                if (!descriptor || descriptor.path !== resource.path || descriptor.mimeType !== resource.contentType
                    || (resource.digest && descriptor.digestSha256 !== resource.digest)) return null;
                const acquired = await acquirePluginSelectedPackageAssetLease({ reader, pluginId, source });
                if (acquired.kind !== 'available') return null;
                try {
                    const bytes = current() ? await acquired.lease.readDeclaredAsset(resource.path) : null;
                    return current() && acquired.lease.isCurrent() ? bytes : null;
                } finally { acquired.lease.dispose(); }
            }
            const origin = readPluginUiContributionOrigin(resource);
            if (!origin || origin.phase !== 'current' || !origin.interactionEnabled
                || origin.serverId !== input.accountLifetime.scope.serverId) return null;
            const client = createPluginContextualResourceReadClient({ pluginId, isCurrent: current, resource: {
                machineId: origin.machineId, serverId: origin.serverId, expectedCallerOccurrenceId: installed.occurrenceId,
                ...(input.resourceRead ? { read: input.resourceRead } : {}),
            } });
            const value = await client.readResource(resourceId, { signal: merged.signal });
            return current() && value.contentType === 'application/json'
                && (!resource.digest || value.digest === resource.digest) ? value.bytes : null;
        } catch {
            return null;
        } finally {
            retirement.dispose();
            merged.dispose();
        }
    };
}
