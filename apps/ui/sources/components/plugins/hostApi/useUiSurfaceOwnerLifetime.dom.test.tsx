// @vitest-environment jsdom
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createActionExecutorBoundaryFixture } from '@/dev/testkit/fixtures/actionExecutorBoundary';
import { createPluginSurfaceActionControls } from '../surfaces/pluginSurfaceActionControls';
import { createCanonicalPluginReactNativeHostApiAdapter } from '../reactNative/hostApi';
import { createPluginSurfaceHostApi } from '../surfaces/createPluginSurfaceHostApi';
import { createPluginSurfaceContextFixture } from '@/dev/testkit/fixtures/pluginSurfaceContextFixture';
import { useUiSurfaceOwnerLifetime } from './useUiSurfaceOwnerLifetime';

it('retains the current API through StrictMode replay and fences only the exact replaced or unmounted adapter', async () => {
    const requestSurface = {
        pluginId: 'acme.detail', contributionId: 'detail', surfaceId: 'detail', sessionId: 'session-1', placement: 'sessionPane' as const,
        platform: 'web' as const, channel: 'internal' as const, resourceScope: [], diagnostics: [],
    };
    const host = createPluginSurfaceHostApi({ surfaceContext: requestSurface });
    expect(host.installedMethods).toContain('context');
    const createAdapter = () => createCanonicalPluginReactNativeHostApiAdapter({
        surface: createPluginSurfaceContextFixture(), requestSurface,
        handleRequest: host.handleRequest, installedMethods: host.installedMethods,
    });
    const first = createAdapter();
    const second = createAdapter();
    function Owner(props: Readonly<{ adapter: ReturnType<typeof createAdapter> }>) {
        useUiSurfaceOwnerLifetime(props.adapter);
        return null;
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    try {
        await React.act(async () => { root.render(<React.StrictMode><Owner adapter={first} /></React.StrictMode>); });
        await expect(first.api.context()).resolves.toMatchObject({ target: expect.any(Object) });
        await React.act(async () => { root.render(<React.StrictMode><Owner adapter={second} /></React.StrictMode>); });
        await expect(first.api.context()).rejects.toMatchObject({ code: 'stale_surface' });
        await expect(second.api.context()).resolves.toMatchObject({ target: expect.any(Object) });
    } finally {
        await React.act(async () => { root.unmount(); });
        container.remove();
    }
    await expect(second.api.context()).rejects.toMatchObject({ code: 'stale_surface' });
});

it('removes a retired native Action control without notifying mounted observers during insertion cleanup', async () => {
    const requestSurface = {
        pluginId: 'acme.detail', contributionId: 'detail', surfaceId: 'detail', placement: 'appSurface' as const,
        platform: 'web' as const, channel: 'internal' as const, resourceScope: [], diagnostics: [],
    };
    const lifetime = new AbortController();
    const executor = createActionExecutor(createActionExecutorBoundaryFixture({}));
    const controls = createPluginSurfaceActionControls({
        pluginId: requestSurface.pluginId, surfaceId: requestSurface.surfaceId,
        hostAction: executor, signal: lifetime.signal, isCurrent: () => true,
        captureCurrentBinding: () => () => true,
    });
    const host = createPluginSurfaceHostApi({ surfaceContext: requestSurface,
        handlers: { actionControl: controls.handleRequest } });
    const adapter = createCanonicalPluginReactNativeHostApiAdapter({
        surface: createPluginSurfaceContextFixture(), requestSurface,
        handleRequest: host.handleRequest, installedMethods: host.installedMethods,
    });
    let preparationSignal: AbortSignal | undefined;
    let finishPreparation: (() => void) | undefined;
    let beforeDisposal: Readonly<{ current: boolean; controls: number; aborted: boolean | undefined }> | undefined;
    function Owner() {
        React.useLayoutEffect(() => () => {
            beforeDisposal = { current: adapter.isCurrent(), controls: controls.getSnapshot().length,
                aborted: preparationSignal?.aborted };
        }, []);
        useUiSurfaceOwnerLifetime(adapter);
        return null;
    }
    function Observer() {
        const snapshot = React.useSyncExternalStore(controls.subscribe, controls.getSnapshot, controls.getSnapshot);
        return <output>{snapshot.length}</output>;
    }
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const previousError = console.error;
    const errors = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => previousError(...args));
    try {
        await React.act(async () => {
            root.render(<><Observer /><Owner /></>);
            await adapter.api.actionControl({ action: 'projects.compute.exec', presentation: { title: 'Create task' } },
                { prepare: async ({ signal }) => {
                    preparationSignal = signal;
                    await new Promise<void>(resolve => { finishPreparation = resolve; });
                    return null;
                }, onSettled: () => {} });
        });
        expect(container.textContent).toBe('1');
        let pressing: Promise<void> | undefined;
        await React.act(async () => { pressing = controls.press(controls.getSnapshot()[0]!.id); });
        expect(preparationSignal?.aborted).toBe(false);
        await React.act(async () => { root.render(<><Observer /></>); });
        expect(beforeDisposal).toEqual({ current: false, controls: 1, aborted: false });
        expect(preparationSignal?.aborted).toBe(true);
        finishPreparation?.();
        await pressing;
        expect(container.textContent).toBe('0');
        await expect(adapter.api.context()).rejects.toMatchObject({ code: 'stale_surface' });
        expect(errors.mock.calls.flat().filter(value => String(value).includes('useInsertionEffect must not schedule updates'))).toEqual([]);
    } finally {
        await React.act(async () => { root.unmount(); });
        errors.mockRestore();
        finishPreparation?.();
        adapter.dispose();
        host.dispose?.();
        lifetime.abort();
        container.remove();
    }
});
