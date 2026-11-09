import { createPluginUiPrivatePresentationHost } from '@/components/plugins/surfaces/pluginUiPrivatePresentationHost';
import { BUNDLED_PLUGIN_BRAND_MARKS } from '@/sync/domains/plugins/availability/generatedBundledPluginUiArtifacts';
import type { createDemoPluginTransport } from './demoPluginTransport';
import type { SurfaceContext } from '@happier-dev/plugin-sdk/ui';

/** The ordinary app presenter, using the app publisher's bundled brand inventory. */
export function createDemoPluginPresentationHost(pluginId: string, host: ReturnType<typeof createDemoPluginTransport>,
    contributions?: SurfaceContext['targetedContributions']) {
    return createPluginUiPrivatePresentationHost(undefined, {
        pluginId,
        fallbackBrandDisplayName: 'Integration',
        resolveBrandTarget(targetId) {
            const mark = BUNDLED_PLUGIN_BRAND_MARKS.find(item => item.pluginId === targetId);
            const descriptor = contributions?.points.flatMap(point => point.protocols.flatMap(protocol => protocol.contributions))
                .find(item => item.contributor.pluginId === targetId)?.descriptor;
            const name = mark?.displayName ?? (descriptor && typeof descriptor === 'object' && !Array.isArray(descriptor)
                && typeof descriptor.displayName === 'string' ? descriptor.displayName : undefined);
            return name === undefined ? undefined : { displayName: name, installedPackage: {
                id: targetId, displayName: name, version: mark?.releaseVersion ?? '0.0.0', enabled: true,
                source: { kind: 'bundled', locator: targetId },
            } };
        },
        brandPresentationInput: { machineId: null, serverId: host.accountLifetime.scope.serverId,
            accountLifetime: host.accountLifetime, signal: host.signal, isCurrent: host.accountLifetime.isCurrent },
    });
}
