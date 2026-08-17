import type { PluginReactNativeExecutableExport } from './loader';

/**
 * Projects the configured executable from a plugin module namespace. The
 * backend stays executable-shaped because it also loads client-runtime
 * entrypoints; surface startup is observed by the host after React commits.
 */
export function resolvePluginReactNativeExecutableExport(
    namespace: unknown,
    exportName: string,
): PluginReactNativeExecutableExport | null {
    const namespaceRecord = namespace && typeof namespace === 'object'
        ? namespace as Readonly<Record<string, unknown>>
        : null;
    const exported = namespaceRecord?.[exportName];
    if (typeof exported !== 'function') {
        return null;
    }

    return exported as PluginReactNativeExecutableExport;
}
