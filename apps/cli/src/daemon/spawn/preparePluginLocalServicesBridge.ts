import { randomBytes } from 'node:crypto';

import type { BackendTargetRefV2 } from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import type { acquireAuthoritativePluginRuntimeRegistryLease } from '@/plugins/runtime/reload/runtimeLease';

import { resolveBundledPluginIdForBackendTarget } from '../bundledBackendPluginMetadata';
import { createPluginLocalServicesBridgeAuthorization } from '../local/services/pluginBridgeAuthorization';
import { resolveEngineRuntimeContribution } from '@/agent/runtime/registry/engineRegistry/contributions';

type PluginRuntimeRegistry = Awaited<
    ReturnType<typeof acquireAuthoritativePluginRuntimeRegistryLease>
>['registry'];

function resolvePluginLocalServicesBridgePluginId(
    target: BackendTargetRefV2,
    acceptedRegistry: PluginRuntimeRegistry,
): string {
    const normalizedContributionId = target.backendId.trim();
    if (!normalizedContributionId) {
        return '';
    }
    const bundledPluginId = resolveBundledPluginIdForBackendTarget(target);
    if (bundledPluginId) {
        return bundledPluginId;
    }
    const pluginId = resolveEngineRuntimeContribution(
        acceptedRegistry.contributes,
        normalizedContributionId,
    )?.pluginId?.trim() ?? '';
    return pluginId || normalizedContributionId;
}

export async function preparePluginLocalServicesBridge(input: Readonly<{
    target: BackendTargetRefV2;
    acceptedRegistry: PluginRuntimeRegistry;
}>) {
    const token = randomBytes(32).toString('base64url');
    const pluginId = resolvePluginLocalServicesBridgePluginId(
        input.target,
        input.acceptedRegistry,
    );
    return await createPluginLocalServicesBridgeAuthorization({
        happyHomeDir: configuration.happyHomeDir,
        publicReleaseRing: configuration.publicReleaseRing,
        token,
        pluginId,
        contributionId: input.target.backendId,
    });
}
