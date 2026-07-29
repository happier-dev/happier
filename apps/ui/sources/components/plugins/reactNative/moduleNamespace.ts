import type { PluginReactNativeExecutableExport } from './loader';

/**
 * Projects the configured executable from a plugin module namespace while
 * preserving the optional surface startup acknowledgment exported beside it.
 *
 * The loader backend contract intentionally remains executable-shaped because
 * it also loads non-surface client-runtime entrypoints. The acknowledgment is
 * carried on a wrapper only when present, so exports without an acknowledgment
 * retain their existing identity and behavior.
 */
export function resolvePluginReactNativeExecutableExport(
    namespace: unknown,
    exportName: string,
): PluginReactNativeExecutableExport | null {
    if (exportName === 'acknowledgeHostRuntime') {
        return null;
    }
    const namespaceRecord = namespace && typeof namespace === 'object'
        ? namespace as Readonly<Record<string, unknown>>
        : null;
    const exported = namespaceRecord?.[exportName];
    if (typeof exported !== 'function') {
        return null;
    }

    const acknowledgeHostRuntime = namespaceRecord?.acknowledgeHostRuntime;
    if (typeof acknowledgeHostRuntime !== 'function') {
        return exported as PluginReactNativeExecutableExport;
    }

    const executable = ((...args: never[]) =>
        Reflect.apply(exported, undefined, args)) as PluginReactNativeExecutableExport;
    Object.defineProperty(executable, 'acknowledgeHostRuntime', {
        configurable: false,
        enumerable: true,
        value: acknowledgeHostRuntime,
        writable: false,
    });
    return Object.freeze(executable);
}
