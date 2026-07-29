import {
    createDefaultRepackScriptManagerBackend,
    type PluginReactNativeLoaderBackend,
} from './loader';
import { initializePluginReactNativeScriptManagerOnce } from './scriptManagerBoot';

/** Metro-native owner: keep the web dynamic-import backend outside Hermes. */
export function resolveDefaultReactNativeLoaderBackend(): PluginReactNativeLoaderBackend {
    initializePluginReactNativeScriptManagerOnce();
    return createDefaultRepackScriptManagerBackend();
}
