import {
    getInstalledPluginReactNativeBundleCache,
    type PluginReactNativeBundleCache,
} from './bundleCache';
import {
    getInstalledPluginUiExecutableModuleHost,
    type PluginUiExecutableModuleHost,
} from './executableModuleHost';
import {
    getInstalledPluginReactNativeModuleRegistry,
    type PluginReactNativeModuleRegistry,
} from './moduleRegistry';
import { resolvePluginUiArtifactInvalidation } from '@/sync/domains/plugins/ui/artifactInvalidation';
import type { PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

export type PluginUiReactNativeRuntimeInvalidationTargets = Readonly<{
    cache: PluginReactNativeBundleCache;
    executableHost?: Pick<PluginUiExecutableModuleHost, 'invalidatePlugin' | 'replaceAuthority'>;
    surfaceModules?: Pick<PluginReactNativeModuleRegistry, 'clear'>;
}>;

export async function applyPluginUiReactNativeRuntimeProjectionInvalidation(input: Readonly<{
    previous: PluginUiProjectionModel;
    next: PluginUiProjectionModel;
    targets: PluginUiReactNativeRuntimeInvalidationTargets;
}>): Promise<void> {
    const invalidation = resolvePluginUiArtifactInvalidation(input.previous, input.next);
    if (invalidation.projectionGenerationChanged) {
        await input.targets.executableHost?.replaceAuthority(null);
        input.targets.cache.evictForProjectionGenerationReplacement(input.next.generation);
        input.targets.surfaceModules?.clear();
    } else {
        for (const pluginId of invalidation.changedPluginIds) {
            input.targets.cache.evictForPluginDisable(pluginId);
            if (input.targets.executableHost) {
                await input.targets.executableHost.invalidatePlugin(pluginId);
            }
        }
        if (invalidation.changedPluginIds.length > 0) {
            input.targets.surfaceModules?.clear();
        }
    }
}

export function applyInstalledAppShellPluginUiReactNativeRuntimeProjectionInvalidation(
    previous: PluginUiProjectionModel,
    next: PluginUiProjectionModel,
): Promise<void> {
    return applyPluginUiReactNativeRuntimeProjectionInvalidation({
        previous,
        next,
        targets: {
            cache: getInstalledPluginReactNativeBundleCache(),
            executableHost: getInstalledPluginUiExecutableModuleHost(),
            surfaceModules: getInstalledPluginReactNativeModuleRegistry(),
        },
    });
}

export function applyInstalledPluginUiReactNativeRuntimeProjectionInvalidation(
    previous: PluginUiProjectionModel,
    next: PluginUiProjectionModel,
): Promise<void> {
    return applyPluginUiReactNativeRuntimeProjectionInvalidation({
        previous,
        next,
        targets: {
            cache: getInstalledPluginReactNativeBundleCache(),
            surfaceModules: getInstalledPluginReactNativeModuleRegistry(),
        },
    });
}
