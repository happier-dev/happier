import { PluginError } from '../errors.js';
import type { PluginDynamicResourceInvocationOptionsV1 } from '../services/resources.js';

/**
 * Builds a dynamic Resource invocation for producer tests. Omitted context and
 * signal use a global context and a fresh, un-aborted lifetime. Account storage
 * is absent unless supplied.
 *
 * Host I/O is unavailable by default: Action reads return the ordinary failure
 * envelope; Resource operations and Action observation throw/reject PluginError
 * with code `plugin_test_service_unavailable`. Supply the real host boundary or
 * an explicit boundary fixture for dependencies exercised by a composed test.
 * Await Resource watch/observe installation before using or disposing its handle.
 */
export function createTestResourceInvocationContext(
    options: Partial<PluginDynamicResourceInvocationOptionsV1> = {},
): PluginDynamicResourceInvocationOptionsV1 {
    const code = 'plugin_test_service_unavailable';
    const message = 'Resource/Action host composition is outside this producer fixture';
    const unavailable = (): never => {
        throw new PluginError({ code, message });
    };
    return Object.freeze({
        ...options,
        signal: options.signal ?? new AbortController().signal,
        context: options.context ?? { kind: 'global' },
        resources: options.resources ?? {
            describe: unavailable,
            async read() { return unavailable(); },
            async watch() { return unavailable(); },
        },
        readAction: options.readAction ?? (async () => ({ ok: false, errorCode: code, error: message })),
        observeAction: options.observeAction ?? (async () => unavailable()),
    });
}
