import { describe, expect, it } from 'vitest';
import { createBrowserViewportOwner } from './viewport';
import type { BrowserSidecarCdpControlTransport, BrowserSidecarViewLifecycleSubscriber } from './controlAdapter';

describe('managed browser viewport owner', () => {
    it('reapplies the current preset after a failed transition changed part of the browser policy', async () => {
        const commands: Parameters<BrowserSidecarCdpControlTransport['dispatchPageCommand']>[0][] = [];
        let failMetrics = false;
        const owner = createBrowserViewportOwner({ resolvePageHandle: () => ({ targetId: 'target', sessionId: 'session' }),
            transport: { dispatchPageCommand: async command => {
                commands.push(command);
                if (command.method === 'Runtime.evaluate') return { result: { value: 'Chrome/142.0.7444.0' } };
                if (failMetrics && command.method === 'Emulation.setDeviceMetricsOverride') {
                    failMetrics = false;
                    throw new Error('CDP disconnected');
                }
                return {};
            } } });
        const view = { browserSessionId: 'browser', viewId: 'view' };
        try {
            await owner.setViewport(view, { width: 1000, height: 700, deviceScaleFactor: 1 });
            await owner.setEmulation(view, { kind: 'preset', presetId: 'phone' });
            failMetrics = true;
            await expect(owner.setEmulation(view, { kind: 'fitViewer' })).rejects.toThrow('CDP disconnected');
            // Failed geometry leaves the last applied selection visible, but UA and touch already changed.
            expect(owner.getViewport(view)?.emulation).toEqual({ kind: 'preset', presetId: 'phone' });
            await owner.setEmulation(view, { kind: 'preset', presetId: 'phone' });
            expect(commands.slice().reverse().find(command => command.method === 'Emulation.setUserAgentOverride')?.params)
                .toMatchObject({ userAgentMetadata: { platform: 'Android', model: 'Pixel 7', mobile: true } });
            expect(commands.slice().reverse().find(command => command.method === 'Emulation.setTouchEmulationEnabled')?.params)
                .toEqual({ enabled: true, maxTouchPoints: 5 });
            expect(commands.slice().reverse().find(command => command.method === 'Emulation.setDeviceMetricsOverride')?.params)
                .toMatchObject({ width: 412, height: 839, deviceScaleFactor: 2.625, mobile: true });
        } finally { owner.dispose(); }
    });

    it('keeps fixed device metrics and identity across viewer resize, then restores ordinary fit-viewer behavior', async () => {
        const commands: Parameters<BrowserSidecarCdpControlTransport['dispatchPageCommand']>[0][] = [];
        const owner = createBrowserViewportOwner({ resolvePageHandle: () => ({ targetId: 'target', sessionId: 'session' }),
            transport: { dispatchPageCommand: async command => {
                commands.push(command);
                return command.method === 'Runtime.evaluate' ? { result: { value: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/142.0.7444.0 Safari/537.36' } } : {};
            } } });
        const view = { browserSessionId: 'browser', viewId: 'view' };
        const viewer = { width: 1000, height: 700, deviceScaleFactor: 1 };
        try {
            await owner.setViewport(view, viewer);
            await owner.setEmulation(view, { kind: 'preset', presetId: 'phone' });
            expect(owner.getViewport(view)).toMatchObject({ width: 412, height: 839, deviceScaleFactor: 2.625,
                emulation: { kind: 'preset', presetId: 'phone' } });
            expect(commands.slice().reverse().find(command => command.method === 'Emulation.setDeviceMetricsOverride')?.params).toMatchObject({
                width: 412, height: 839, deviceScaleFactor: 2.625, mobile: true });
            expect(commands.slice().reverse().find(command => command.method === 'Emulation.setTouchEmulationEnabled')?.params).toEqual({ enabled: true, maxTouchPoints: 5 });
            expect(commands.slice().reverse().find(command => command.method === 'Emulation.setUserAgentOverride')?.params).toMatchObject({
                userAgent: expect.stringContaining('Chrome/142.0.7444.0 Mobile'),
                userAgentMetadata: { platform: 'Android', platformVersion: '14.0.0', model: 'Pixel 7', mobile: true } });
            const changes = commands.length;
            for (let i = 0; i < 20; i++) await owner.setViewport(view, { ...viewer, width: 800 });
            expect(commands).toHaveLength(changes); // Viewer resize cannot undo or reapply a deliberate preset.
            await owner.setEmulation(view, { kind: 'fitViewer' });
            expect(owner.getViewport(view)).toMatchObject({ ...viewer, width: 800, emulation: { kind: 'fitViewer' } });
            expect(commands.slice().reverse().find(command => command.method === 'Emulation.setTouchEmulationEnabled')?.params).toEqual({ enabled: false });
            expect(commands.slice().reverse().find(command => command.method === 'Emulation.setUserAgentOverride')?.params).toEqual({ userAgent: '' });
            await owner.setViewport(view, { ...viewer, height: 600 });
            expect(owner.getViewport(view)).toMatchObject({ ...viewer, height: 600 });
        } finally { owner.dispose(); }
    });

    it('applies only changed metrics and forgets them when the owned page is rebound', async () => {
        const commands: Parameters<BrowserSidecarCdpControlTransport['dispatchPageCommand']>[0][] = [];
        let lifecycle: BrowserSidecarViewLifecycleSubscriber = () => {};
        let reject = true;
        const owner = createBrowserViewportOwner({ resolvePageHandle: () => ({ targetId: 'target', sessionId: 'session' }),
            subscribeViewLifecycle: listener => { lifecycle = listener; return () => {}; },
            transport: { dispatchPageCommand: async command => {
                commands.push(command);
                if (reject) { reject = false; throw new Error('CDP disconnected'); }
                return {};
            } } });
        const view = { browserSessionId: 'browser', viewId: 'view' };
        const viewport = { width: 390, height: 844, deviceScaleFactor: 3 };
        try {
            await expect(owner.setViewport(view, viewport)).rejects.toThrow('CDP disconnected');
            await owner.setViewport(view, viewport);
            for (let i = 0; i < 20; i++) await owner.setViewport(view, { ...viewport });
            expect(commands).toHaveLength(2); // A failed command never suppresses the person's retry.
            await owner.setViewport(view, { ...viewport, deviceScaleFactor: 2 });
            expect(commands.at(-1)?.params).toEqual({ ...viewport, deviceScaleFactor: 2, mobile: false });
            lifecycle({ type: 'unbound', ...view });
            await owner.setViewport(view, viewport);
            expect(commands).toHaveLength(4);
        } finally { owner.dispose(); }
    });

});
