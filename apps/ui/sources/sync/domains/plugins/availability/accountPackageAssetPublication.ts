import type { PluginProjectionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { createPackageAssetArchiveV1 } from '@happier-dev/protocol/plugins/availability';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';

import { createPluginContextualResourceReadClient, type PluginSurfaceResourceReadTransport } from '@/components/plugins/surfaces/pluginSurfaceResourceRead';
import {
    publishActivePluginAccountPackageAssets,
    type ActivePluginAccountHostedArtifactPublisher,
    type ActivePluginAccountPackageAssetsPublishResult,
} from '@/sync/api/plugins/availability/activePluginAccountHostedArtifactRead';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { mergeAbortSignals } from '@/utils/runtime/abortSignals';

import type { PluginAccountAvailabilityReader } from './reader';

export type PluginAccountPackageAssetPublicationInput = Readonly<{
    pluginId: string;
    reader: PluginAccountAvailabilityReader;
    accountLifetime: ActiveServerAccountScopeLifetime;
    projection: PluginProjectionV2;
    daemon: Readonly<{ serverId: string | null; serverIdentityId: string; machineId: string }>;
    isCurrent: () => boolean;
    signal?: AbortSignal;
}>;

export type PluginAccountPackageAssetPublicationDependencies = Readonly<{
    resourceRead?: PluginSurfaceResourceReadTransport;
    publisher?: Pick<ActivePluginAccountHostedArtifactPublisher, 'publishPackageAssets'>;
}>;

function readPublicationSource(input: PluginAccountPackageAssetPublicationInput) {
    if (!input.accountLifetime.isCurrent() || !input.isCurrent() || input.signal?.aborted) return null;
    if (input.daemon.serverId !== input.accountLifetime.scope.serverId) return null;
    const admitted = input.reader.readCurrentHostedPackageAssetPublicationTarget({ pluginId: input.pluginId });
    if (admitted.kind !== 'available') return null;
    const installed = input.projection.installedPackagesById[input.pluginId];
    if (!installed?.enabled || installed.id !== input.pluginId || !installed.immutableGenerationId || !installed.occurrenceId || installed.source.kind === 'path'
        || installed.version !== admitted.target.release.version) return null;
    const inventory = input.reader.readMaterializations();
    if (inventory.kind !== 'available') return null;
    // Filter only by the supplied origin, never by whichever candidate is
    // newest, trusted or content-matched. Ambiguous origin stays unavailable.
    const exact = inventory.materializations.filter((materialization) => (
        materialization.serverIdentityId === input.daemon.serverIdentityId
        && materialization.machineId === input.daemon.machineId
        && materialization.pluginId === input.pluginId
    ));
    if (exact.length !== 1) return null;
    const materialization = exact[0]!;
    if (!materialization.enabled || !materialization.portableRelease || materialization.trustState !== 'trusted'
        || materialization.version !== admitted.target.release.version) return null;
    const classification = input.reader.classifyRelease(materialization);
    if (classification.validation.kind !== 'admitted' || classification.releaseContent !== 'matched') return null;
    return {
        target: admitted.target,
        materializationId: materialization.materializationId,
        installedGeneration: installed.immutableGenerationId,
        occurrenceId: installed.occurrenceId,
    };
}

function samePublicationSource(
    left: ReturnType<typeof readPublicationSource>,
    right: ReturnType<typeof readPublicationSource>,
): boolean {
    if (!left || !right) return left === right;
    return left.installedGeneration === right.installedGeneration && left.occurrenceId === right.occurrenceId
        && left.materializationId === right.materializationId
        && left.target.release.version === right.target.release.version
        && left.target.descriptor.archiveDigestSha256 === right.target.descriptor.archiveDigestSha256;
}

/**
 * The present-client producer for declared package assets. Availability owns
 * hosting admission; the exact selected daemon owns Resource reads; Protocol
 * owns archive construction/integrity; the Account publisher owns envelopes
 * and transport. Rendering never calls this producer or falls back to a daemon.
 */
export async function acquireAndPublishPluginAccountPackageAssets(
    input: PluginAccountPackageAssetPublicationInput,
    dependencies: PluginAccountPackageAssetPublicationDependencies = {},
): Promise<ActivePluginAccountPackageAssetsPublishResult | void> {
    const source = readPublicationSource(input);
    if (!source) return;
    const sourceIsCurrent = () => samePublicationSource(source, readPublicationSource(input));

    const cancellation = new AbortController();
    const merged = mergeAbortSignals([cancellation.signal, input.signal]);
    const signal = merged.signal;
    const retirement = input.accountLifetime.onRetire(() => cancellation.abort());
    const unsubscribe = input.reader.subscribe(() => {
        if (!sourceIsCurrent()) cancellation.abort();
    });
    const isCurrent = () => !signal?.aborted && sourceIsCurrent();
    try {
        const client = createPluginContextualResourceReadClient({
            pluginId: input.pluginId,
            resource: {
                machineId: input.daemon.machineId,
                serverId: input.daemon.serverId,
                expectedCallerOccurrenceId: source.occurrenceId,
                ...(dependencies.resourceRead ? { read: dependencies.resourceRead } : {}),
            },
            isCurrent,
        });
        const files = new Map<string, Uint8Array>();
        for (const resource of source.target.descriptor.resources) {
            if (!isCurrent()) return;
            const read = await client.readResource(resource.resourceId, { signal });
            if (!isCurrent() || read.contentType !== resource.mimeType
                || read.digest !== resource.digestSha256 || read.bytes.byteLength !== resource.byteSize) return;
            files.set(resource.path, read.bytes);
        }
        const archive = createPackageAssetArchiveV1({
            manifest: source.target.normalizedManifest,
            files: [...files].map(([path, bytes]) => ({ path, bytes })),
        });
        if (!archive || !sameStrictJsonValue(archive.descriptor, source.target.descriptor) || !isCurrent()) return;
        const publish = dependencies.publisher?.publishPackageAssets ?? publishActivePluginAccountPackageAssets;
        const result = await publish({ accountLifetime: input.accountLifetime, release: source.target.release, archive, signal });
        return isCurrent() ? result : undefined;
    } catch {
        // Failure never fabricates a hosted link or status. The canonical
        // projection also owns response-loss recovery after a real commit.
        return;
    } finally {
        unsubscribe();
        retirement.dispose();
        merged.dispose();
    }
}

/** One mounted attempt per material source/admission change; no automatic retry. */
export function observePluginAccountPackageAssetPublication(
    input: PluginAccountPackageAssetPublicationInput,
    dependencies: PluginAccountPackageAssetPublicationDependencies = {},
): () => void {
    let previous: ReturnType<typeof readPublicationSource> = null;
    let acquisition: AbortController | null = null;
    const update = () => {
        const next = readPublicationSource(input);
        if (samePublicationSource(previous, next)) return;
        previous = next;
        acquisition?.abort();
        acquisition = null;
        if (!next) return;
        const controller = new AbortController();
        acquisition = controller;
        const merged = mergeAbortSignals([controller.signal, input.signal]);
        void acquireAndPublishPluginAccountPackageAssets({ ...input, signal: merged.signal }, dependencies)
            .finally(() => merged.dispose());
    };
    const unsubscribe = input.reader.subscribe(update);
    update();
    return () => {
        acquisition?.abort();
        unsubscribe();
    };
}
