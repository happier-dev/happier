import { Platform } from 'react-native';

import type { PluginNativeArtifactResourceRegistrar } from './nativeArtifactResource';
import { createExpoPluginNativeArtifactResourceRegistrar as createNativeRegistrar } from './nativeArtifactResourceRegistrar.native';
import { createExpoPluginNativeArtifactResourceRegistrar as createWebRegistrar } from './nativeArtifactResourceRegistrar.web';

/**
 * Platform-neutral owner entry for Artifact/cache composition. Callers must
 * use this entry rather than importing a native implementation directly.
 */
export function createExpoPluginNativeArtifactResourceRegistrar(): PluginNativeArtifactResourceRegistrar {
    return Platform.OS === 'web' ? createWebRegistrar() : createNativeRegistrar();
}
