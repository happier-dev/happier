import { describe, expect, it } from 'vitest';
import { BrowserDiagnosticEventV1Schema } from '@happier-dev/protocol/browser/diagnostics/v1';

describe('daemon browser diagnostics routes', () => {
    it('serves a daemon-owned browser diagnostics snapshot', async () => {
        const mod = await import('./routes');

        expect(mod?.createBrowserDiagnosticsRoutes).toBeTypeOf('function');
        if (!mod?.createBrowserDiagnosticsRoutes) return;
        const { createBrowserDiagnosticsDaemonStore } = await import('./store');

        const routes = mod.createBrowserDiagnosticsRoutes({
            store: {
                ...createBrowserDiagnosticsDaemonStore({ machineId: 'machine_1' }),
                getSnapshot: () => ({
                    v: 1,
                    machineId: 'machine_1',
                    generatedAt: 1_000,
                    refreshState: 'idle',
                    events: [],
                    diagnostics: [],
                }),
            },
        });

        await expect(routes.getSnapshot()).resolves.toEqual({
            v: 1,
            machineId: 'machine_1',
            generatedAt: 1_000,
            refreshState: 'idle',
            events: [],
            diagnostics: [],
        });
    });
});

// The real store and routes remain composed; reads measure the visible acquisition cost.
it('reads one scoped history per open and pushes only changed view facts with no idle reads', async () => {
    const { createBrowserDiagnosticsDaemonStore } = await import('./store');
    const { createBrowserDiagnosticsRoutes } = await import('./routes');
    const store = createBrowserDiagnosticsDaemonStore({ machineId: 'machine', now: () => 42 });
    let reads = 0;
    let subscriptions = 0;
    const routes = createBrowserDiagnosticsRoutes({ store: { ...store, getViewSnapshot(view) {
        reads++; return store.getViewSnapshot(view);
    }, subscribeView(view, listener) {
        subscriptions++;
        const stop = store.subscribeView(view, listener);
        return () => { subscriptions--; stop(); };
    } } });
    const view = { browserSessionId: 'browser', viewId: 'view', navigationGeneration: 1 };
    const initial = await routes.readViewSnapshot(view);
    expect(reads).toBe(1);
    expect(initial.snapshot.events).toEqual([]);
    const controller = new AbortController();
    let settled = false;
    const pushed = routes.readViewSnapshot({ ...view, sinceRevision: initial.revision, signal: controller.signal })
        .then(result => { settled = true; return result; });
    const event = BrowserDiagnosticEventV1Schema.parse({ v: 1, ...view, eventId: 'event', capturedAtMs: 1,
        family: 'pageInfo' as const, kind: 'pageInfo.snapshot' as const, fidelity: 'nativeCallback' as const,
        trusted: true, redaction: { level: 'metadataOnly' }, data: { loading: false } });
    for (let n = 0; n < 10; n++) store.publishEvent({ ...event, browserSessionId: 'other', eventId: `other-${n}` });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(reads).toBe(1);
    store.publishEvent(event);
    const changed = await pushed;
    expect(subscriptions).toBe(0);
    expect(changed.snapshot.events).toEqual([expect.objectContaining({ eventId: 'event' })]);
    expect(reads).toBe(2);
    const pending = routes.readViewSnapshot({ ...view, sinceRevision: changed.revision, signal: controller.signal });
    for (let n = 0; n < 10; n++) store.publishEvent(event);
    await Promise.resolve();
    expect(reads).toBe(2);
    store.clearView(view);
    expect((await pending).snapshot.events).toEqual([]);
    expect(reads).toBe(3);
    const empty = await routes.readViewSnapshot(view);
    const cancelled = routes.readViewSnapshot({ ...view, sinceRevision: empty.revision, signal: controller.signal });
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    expect(subscriptions).toBe(0);
    expect(reads).toBe(4);
});
