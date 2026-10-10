import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

/** Unrelated runtime fixtures must not silently activate a native adapter. */
export const unexpectedProjectNativeAdapterResolution: ResolvedExecutablePluginRuntimeRegistry['resolveProjectNativeAdapter'] = async () => {
    throw new Error('Unexpected project-native adapter resolution in this fixture');
};
