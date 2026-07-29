import type { PluginReactNativeLoaderBackend } from './loader';
import { createReactNativeWebLoaderBackend } from './webLoaderBackend.web';

/** Web owner: installed reactNative-mode artifacts execute as guarded web modules. */
export function resolveDefaultReactNativeLoaderBackend(): PluginReactNativeLoaderBackend {
    return createReactNativeWebLoaderBackend();
}
