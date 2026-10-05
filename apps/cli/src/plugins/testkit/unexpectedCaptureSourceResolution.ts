import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';

/** Unused fixture dependency: capture tests must use the real runtime registry. */
export const unexpectedCaptureSourceResolution: ResolvedExecutablePluginRuntimeRegistry['resolveCaptureSource'] = () => {
    throw new Error('Capture source resolution is outside this fixture; use the real runtime registry');
};
