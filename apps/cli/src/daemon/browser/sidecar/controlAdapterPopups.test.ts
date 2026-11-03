import { BrowserEventV1Schema, type BrowserEventV1 } from '@happier-dev/protocol/browser/events/v1';
import { describe, expect, it, vi } from 'vitest';
import { createSurfaceInputControl, type SurfaceInputControl } from '../../surfaces/inputControl';
import {
    createBrowserSidecarCdpControlAdapter,
    type BrowserSidecarCdpEventCapableTransport,
    type BrowserSidecarCdpEventNotification,
    type BrowserSidecarCdpEventSubscriber,
    type BrowserSidecarViewLifecycleEvent,
} from './controlAdapter';

function harness(attach?: () => Promise<unknown>, controls?: Map<string, SurfaceInputControl>) {
    const listeners = new Set<BrowserSidecarCdpEventSubscriber>();
    const events: BrowserEventV1[] = [];
    const lifecycle: BrowserSidecarViewLifecycleEvent[] = [];
    // CDP is the external Chromium boundary; all binding/event logic stays real.
    const transport: BrowserSidecarCdpEventCapableTransport = {
        openPage: vi.fn(async () => ({ targetId: 'opener-target', sessionId: 'opener-session' })),
        dispatchBrowserCommand: vi.fn(async command => {
            if (command.method === 'Target.attachToTarget') return attach ? attach() : { sessionId: `session:${command.params?.targetId}` };
            return command.method === 'Target.closeTarget' ? { success: true } : {};
        }),
        dispatchPageCommand: vi.fn(async command => {
            if (command.method === 'Page.getFrameTree') return { frameTree: { frame: { id: command.targetId, url: 'https://example.test/popup' } } };
            if (command.method === 'Runtime.evaluate') return { result: { value: 'complete' } };
            if (command.method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [{ id: 1, title: 'Popup' }] };
            return {};
        }),
        subscribeCdpEvents(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    };
    const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'browser', sidecarId: 'sidecar', transport,
        ...(controls ? { resolveInputControl: (view: { viewId: string }) => {
            let control = controls.get(view.viewId);
            if (!control) { control = createSurfaceInputControl(); controls.set(view.viewId, control); }
            return control;
        } } : {}) });
    adapter.subscribeBrowserEvents(event => events.push(BrowserEventV1Schema.parse(event)));
    adapter.subscribeViewLifecycle(event => lifecycle.push(event));
    async function open() {
        expect(await adapter.dispatchCommand({ kind: 'openView', commandId: 'open', focus: true, browserSessionId: 'browser', viewId: 'opener',
            platform: 'web', target: { kind: 'externalUrl', targetId: 'intent', url: 'https://example.test/' } })).toMatchObject({ status: 'dispatched' });
    }
    function emit(notification: BrowserSidecarCdpEventNotification) { for (const listener of [...listeners]) listener(notification); }
    function popup(targetId = 'popup-target', openerId = 'opener-target', url = 'https://example.test/popup') {
        emit({ method: 'Target.targetCreated', params: { targetInfo: { targetId, openerId, type: 'page', url } } });
    }
    return { adapter, transport, events, lifecycle, listeners, open, emit, popup };
}

describe('browser sidecar popup adoption', () => {
    it('adopts an owned popup once, publishes its real binding and allows normal child control/close', async () => {
        const h = harness();
        await h.open();
        h.popup();
        h.popup();
        await vi.waitFor(() => expect(h.events.filter(event => event.kind === 'viewOpened')).toHaveLength(1));
        const opened = h.events.find(event => event.kind === 'viewOpened');
        if (!opened || opened.kind !== 'viewOpened') throw new Error('Missing popup event');
        expect(opened).toMatchObject({ browserSessionId: 'browser', openerViewId: 'opener', currentUrl: 'https://example.test/popup' });
        expect(h.adapter.resolvePageHandle(opened)).toEqual({ targetId: 'popup-target', sessionId: 'session:popup-target' });
        expect(h.lifecycle).toContainEqual({ type: 'bound', browserSessionId: 'browser', viewId: opened.viewId });
        expect(h.transport.dispatchBrowserCommand).toHaveBeenCalledWith({ method: 'Target.attachToTarget', params: { targetId: 'popup-target', flatten: true } });
        expect(await h.adapter.dispatchCommand({ kind: 'navigate', commandId: 'navigate-child', browserSessionId: 'browser', viewId: opened.viewId,
            url: 'https://example.test/next' })).toMatchObject({ status: 'dispatched' });
        expect(await h.adapter.dispatchCommand({ kind: 'closeView', commandId: 'close-child', browserSessionId: 'browser', viewId: opened.viewId })).toMatchObject({ status: 'dispatched' });
        expect(h.adapter.resolvePageHandle(opened)).toBeNull();
        expect(h.lifecycle).toContainEqual({ type: 'unbound', browserSessionId: 'browser', viewId: opened.viewId, sourceDestroyed: true });
        h.adapter.dispose();
    });

    it('keeps zero idle listeners and performs no CDP work for unrelated target arrivals', async () => {
        const h = harness();
        expect(h.listeners.size).toBe(0);
        await h.open();
        expect(h.listeners.size).toBe(1);
        const before = vi.mocked(h.transport.dispatchBrowserCommand).mock.calls.length;
        h.popup('foreign', 'unowned');
        h.emit({ method: 'Target.targetCreated', params: { targetInfo: { targetId: 'worker', openerId: 'opener-target', type: 'worker' } } });
        expect(vi.mocked(h.transport.dispatchBrowserCommand).mock.calls.length).toBe(before);
        await h.adapter.dispatchCommand({ kind: 'closeView', commandId: 'close', browserSessionId: 'browser', viewId: 'opener' });
        expect(h.listeners.size).toBe(0);
        h.adapter.dispose();
    });

    it.each(['close', 'dispose'] as const)('does not bind a late attachment after opener %s', async action => {
        let acknowledge!: (value: unknown) => void;
        const h = harness(() => new Promise(resolve => { acknowledge = resolve; }));
        await h.open();
        h.popup();
        expect(h.transport.dispatchBrowserCommand).toHaveBeenCalledWith({ method: 'Target.attachToTarget', params: { targetId: 'popup-target', flatten: true } });
        if (action === 'close') await h.adapter.dispatchCommand({ kind: 'closeView', commandId: 'close', browserSessionId: 'browser', viewId: 'opener' });
        else h.adapter.dispose();
        acknowledge({ sessionId: 'late-session' });
        await vi.waitFor(() => expect(h.transport.dispatchBrowserCommand).toHaveBeenCalledWith({ method: 'Target.detachFromTarget', params: { sessionId: 'late-session' } }));
        expect(h.events.some(event => event.kind === 'viewOpened')).toBe(false);
        expect(h.adapter.listViews?.('browser')).toEqual([]);
        h.adapter.dispose();
    });

    it('reports attachment failure without publishing a tab or leaking CDP errors', async () => {
        const h = harness(async () => { throw new Error('private CDP endpoint'); });
        await h.open();
        h.popup();
        await vi.waitFor(() => expect(h.events).toContainEqual(expect.objectContaining({ kind: 'adapterUnavailable', viewId: 'opener', reasonCode: 'popup_adoption_failed' })));
        expect(h.events.some(event => event.kind === 'viewOpened')).toBe(false);
        expect(h.adapter.listViews?.('browser')).toHaveLength(1);
        expect(JSON.stringify(h.events)).not.toContain('private CDP endpoint');
        h.adapter.dispose();
    });

    it('inherits the confidential opener hold before child capture becomes reachable', async () => {
        const controls = new Map<string, SurfaceInputControl>();
        const h = harness(undefined, controls);
        await h.open();
        await controls.get('opener')?.beginConfidentialityHold();
        h.popup('private-popup', 'opener-target', 'https://example.test/secret');
        await vi.waitFor(() => expect(h.events.some(event => event.kind === 'viewOpened')).toBe(true));
        const opened = h.events.find(event => event.kind === 'viewOpened');
        if (!opened || opened.kind !== 'viewOpened') throw new Error('Missing popup');
        expect(controls.get(opened.viewId)?.isObservationHeld()).toBe(true);
        expect(opened.currentUrl).toBeUndefined();
        expect(JSON.stringify(h.events)).not.toContain('/secret');
        h.adapter.dispose();
    });

    it('unbinds a popup closed by its page and adopts about:blank before its HTTP navigation', async () => {
        const h = harness();
        await h.open();
        h.popup('blank-popup', 'opener-target', 'about:blank');
        await vi.waitFor(() => expect(h.events.some(event => event.kind === 'viewOpened')).toBe(true));
        const opened = h.events.find(event => event.kind === 'viewOpened');
        if (!opened || !('viewId' in opened)) throw new Error('Missing popup');
        h.emit({ method: 'Target.targetDestroyed', params: { targetId: 'blank-popup' } });
        expect(h.adapter.resolvePageHandle(opened)).toBeNull();
        expect(h.events).toContainEqual(expect.objectContaining({ kind: 'viewClosed', viewId: opened.viewId }));
        h.adapter.dispose();
    });

    it('accepts the close acknowledgement when Chromium publishes destruction first', async () => {
        const h = harness();
        await h.open();
        vi.mocked(h.transport.dispatchBrowserCommand).mockImplementation(async command => {
            if (command.method === 'Target.closeTarget') {
                h.emit({ method: 'Target.targetDestroyed', params: { targetId: command.params?.targetId } });
                return { success: true };
            }
            return {};
        });
        expect(await h.adapter.dispatchCommand({ kind: 'closeView', commandId: 'close', browserSessionId: 'browser', viewId: 'opener' }))
            .toMatchObject({ status: 'dispatched' });
        expect(h.events.filter(event => event.kind === 'viewClosed')).toHaveLength(1);
        expect(h.lifecycle.filter(event => event.type === 'unbound')).toHaveLength(1);
        h.adapter.dispose();
    });
});
