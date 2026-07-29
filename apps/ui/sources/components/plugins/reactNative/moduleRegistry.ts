import type { PluginReactNativeSurfaceModule } from './PluginReactNativeSurface';

export type PluginReactNativeModuleRegistry = Readonly<{
    read: (cacheKey: string | undefined) => PluginReactNativeSurfaceModule | null;
    write: (cacheKey: string | undefined, module: PluginReactNativeSurfaceModule) => void;
    clear: () => void;
}>;

export function createPluginReactNativeModuleRegistry(): PluginReactNativeModuleRegistry {
    const modules = new Map<string, PluginReactNativeSurfaceModule>();
    return Object.freeze({
        read: (cacheKey) => cacheKey ? modules.get(cacheKey) ?? null : null,
        write: (cacheKey, module) => {
            if (cacheKey) {
                modules.set(cacheKey, module);
            }
        },
        clear: () => {
            modules.clear();
        },
    });
}

const installedPluginReactNativeModuleRegistry = createPluginReactNativeModuleRegistry();

export function getInstalledPluginReactNativeModuleRegistry(): PluginReactNativeModuleRegistry {
    return installedPluginReactNativeModuleRegistry;
}
