import { describe, expect, it } from 'vitest';
import { createTestResourceInvocationContext } from '@happier-dev/plugin-sdk/testing';
import type { Disposable } from '../lifecycle.js';

describe('Resource invocation test context', () => {
    it('reports unavailable host dependencies instead of admitting a successful read or observation', async () => {
        const options = createTestResourceInvocationContext();
        const ref = { pluginId: 'example.plugin', localId: 'read' };
        await expect(options.readAction(ref, {})).resolves.toMatchObject({
            ok: false, errorCode: 'plugin_test_service_unavailable',
        });
        expect(() => options.resources.describe('dependency')).toThrow(expect.objectContaining({ code: 'plugin_test_service_unavailable' }));
        await expect(options.resources.read('dependency')).rejects.toMatchObject({ code: 'plugin_test_service_unavailable' });
        await expect(options.resources.watch('dependency', () => {})).rejects.toMatchObject({ code: 'plugin_test_service_unavailable' });
        await expect(options.observeAction(ref, {}, () => {})).rejects.toMatchObject({ code: 'plugin_test_service_unavailable' });
    });

    it('preserves explicit host dependencies and their asynchronous installation and cleanup', async () => {
        const controller = new AbortController();
        const context = { kind: 'session', sessionId: 'session-a' } as const;
        const bytes = new TextEncoder().encode('dependency');
        let install: ((handle: Disposable) => void) | undefined;
        let disposed = false;
        const defaults = createTestResourceInvocationContext();
        const resources = { ...defaults.resources,
            async read() { return { kind: 'config' as const, contentType: 'text/plain', digest: 'dependency', bytes }; },
            async watch() { return await new Promise<Disposable>(resolve => { install = resolve; }); },
        };
        const readAction = async () => ({ ok: true as const, result: { dependency: true } });
        const observeAction = async () => ({ async dispose() { disposed = true; } });
        const options = createTestResourceInvocationContext({ signal: controller.signal, context, resources, readAction, observeAction });
        expect(options.context).toBe(context);
        expect(options.signal).toBe(controller.signal);
        expect((await options.resources.read('dependency')).bytes).toBe(bytes);
        const ref = { pluginId: 'example.plugin', localId: 'read' };
        await expect(options.readAction(ref, {})).resolves.toEqual({ ok: true, result: { dependency: true } });
        let installed = false;
        const pending = options.resources.watch('dependency', () => {}).then(handle => { installed = true; return handle; });
        await Promise.resolve();
        expect(installed).toBe(false);
        install?.(await options.observeAction(ref, {}, () => {}));
        await (await pending).dispose();
        expect(disposed).toBe(true);
    });
});
