import type { PluginReactNativeSurfaceModule } from './PluginReactNativeSurface';

/**
 * An active-projection admission captured before an asynchronous module load.
 * The registry retains the token only while this exact cache key is current.
 */
export type PluginReactNativeModuleRegistryWriteFence = Readonly<{
    cacheKey: string;
    activeKeyToken: symbol;
}>;

export type PluginReactNativeModuleRegistry = Readonly<{
    read: (cacheKey: string | undefined) => PluginReactNativeSurfaceModule | null;
    /** Capture the key-local admission fact before beginning asynchronous work. */
    captureWriteFence: (cacheKey: string | undefined) => PluginReactNativeModuleRegistryWriteFence | null;
    /** Rejects a load that settled after its key's active projection retired. */
    write: (
        cacheKey: string | undefined,
        module: PluginReactNativeSurfaceModule,
        fence: PluginReactNativeModuleRegistryWriteFence,
    ) => boolean;
    /** Retain loaded modules only while an active scoped projection owns their key. */
    reconcileActiveCacheKeys: (cacheKeys: readonly string[]) => void;
}>;

export function createPluginReactNativeModuleRegistry(): PluginReactNativeModuleRegistry {
    const modules = new Map<string, PluginReactNativeSurfaceModule>();
    const activeKeyTokens = new Map<string, symbol>();
    return Object.freeze({
        read: (cacheKey) => cacheKey ? modules.get(cacheKey) ?? null : null,
        captureWriteFence: (cacheKey) => {
            if (!cacheKey) return null;
            const activeKeyToken = activeKeyTokens.get(cacheKey);
            return activeKeyToken
                ? Object.freeze({ cacheKey, activeKeyToken })
                : null;
        },
        write: (cacheKey, module, fence) => {
            if (
                !cacheKey
                || fence.cacheKey !== cacheKey
                || activeKeyTokens.get(cacheKey) !== fence.activeKeyToken
            ) {
                return false;
            }
            modules.set(cacheKey, module);
            return true;
        },
        reconcileActiveCacheKeys: (cacheKeys) => {
            const nextActiveKeyTokens = new Map<string, symbol>();
            for (const cacheKey of cacheKeys) {
                nextActiveKeyTokens.set(
                    cacheKey,
                    activeKeyTokens.get(cacheKey) ?? Symbol('plugin-ui-react-native-active-cache-key'),
                );
            }
            activeKeyTokens.clear();
            for (const [cacheKey, activeKeyToken] of nextActiveKeyTokens) {
                activeKeyTokens.set(cacheKey, activeKeyToken);
            }
            for (const cacheKey of modules.keys()) {
                if (!activeKeyTokens.has(cacheKey)) {
                    modules.delete(cacheKey);
                }
            }
        },
    });
}

const installedPluginReactNativeModuleRegistry = createPluginReactNativeModuleRegistry();

export function getInstalledPluginReactNativeModuleRegistry(): PluginReactNativeModuleRegistry {
    return installedPluginReactNativeModuleRegistry;
}
