import { describe, expect, it, vi } from 'vitest';

import type { BackgroundServiceContext } from '@happier-dev/plugin-sdk/background-services';
import { createBackgroundServiceRunnerHost } from './backgroundServices';

function registration(
    runner: Parameters<typeof createBackgroundServiceRunnerHost>[0]['registrations'][number]['runner'],
) {
    return Object.freeze({
        pluginId: 'acme.indexer',
        pluginVersion: '1.0.0',
        generation: 'generation-one',
        localId: 'retired-during-context-creation',
        runner,
    });
}

function inertBackgroundContext(input: Readonly<{
    pluginId: string;
    pluginVersion: string;
    localId: string;
    signal: AbortSignal;
}>): BackgroundServiceContext {
    return Object.freeze({
        plugin: Object.freeze({ id: input.pluginId, version: input.pluginVersion }),
        contribution: Object.freeze({ id: input.localId, qualifiedId: input.localId }),
        surface: 'background' as const,
        signal: input.signal,
        // The test asserts that this context never crosses the runner boundary.
        services: Object.freeze({}) as BackgroundServiceContext['services'],
    });
}

describe('background service runner host currentness', () => {
    it('does not enter a runner retired while its context is being created', async () => {
        const runner = vi.fn(async () => {});
        const complete = vi.fn();
        let host!: ReturnType<typeof createBackgroundServiceRunnerHost>;
        host = createBackgroundServiceRunnerHost({
            registrations: [registration(runner)],
            createContext(input) {
                host.retire([input.pluginId]);
                return Object.freeze({
                    context: inertBackgroundContext(input),
                    complete,
                });
            },
        });

        host.start();
        await host.settle(['acme.indexer']);
        await host.dispose();

        expect(runner).not.toHaveBeenCalled();
        expect(complete).toHaveBeenCalledOnce();
    });

    it('does not diagnose an unavailable context after its generation retires', async () => {
        const runner = vi.fn(async () => {});
        const diagnostics = vi.fn();
        let host!: ReturnType<typeof createBackgroundServiceRunnerHost>;
        host = createBackgroundServiceRunnerHost({
            registrations: [registration(runner)],
            createContext(input) {
                host.retire([input.pluginId]);
                return Object.freeze({
                    unavailable: Object.freeze({
                        code: 'plugin_host_access_service_unavailable',
                        hostAccessId: 'network',
                        status: 'unavailable' as const,
                    }),
                });
            },
            onDiagnostic: diagnostics,
        });

        host.start();
        await host.settle(['acme.indexer']);

        expect(runner).not.toHaveBeenCalled();
        expect(diagnostics).not.toHaveBeenCalled();
    });

    it('reports an unavailable context while its generation is current', async () => {
        const runner = vi.fn(async () => {});
        const diagnostics = vi.fn();
        const host = createBackgroundServiceRunnerHost({
            registrations: [registration(runner)],
            createContext() {
                return Object.freeze({
                    unavailable: Object.freeze({
                        code: 'plugin_host_access_service_unavailable',
                        hostAccessId: 'network',
                        status: 'unavailable' as const,
                    }),
                });
            },
            onDiagnostic: diagnostics,
        });

        host.start();
        await host.settle(['acme.indexer']);

        expect(runner).not.toHaveBeenCalled();
        expect(diagnostics).toHaveBeenCalledWith(expect.objectContaining({
            code: 'background_service_unavailable',
            pluginId: 'acme.indexer',
        }));
    });
});
