import type { DaemonReactNativeWebLoaderCapabilityV1 } from '@happier-dev/protocol';

/** Native bundles neither probe nor advertise the web-only dynamic module loader. */
export function resolveReactNativeWebLoaderCapability(_params?: Readonly<{
    resolveLoaderBackend?: () => unknown;
}>): DaemonReactNativeWebLoaderCapabilityV1 | null {
    return null;
}
