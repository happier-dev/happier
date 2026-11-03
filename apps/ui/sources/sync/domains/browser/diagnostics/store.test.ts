import { describe, expect, it } from 'vitest';
import { BrowserDiagnosticEventV1Schema, type BrowserDiagnosticEventV1 } from '@happier-dev/protocol/browser/diagnostics/v1';
import { browserViewKey } from '@happier-dev/protocol/browser/view/key';
import { applyBrowserDiagnosticEvents, applyBrowserDiagnosticsSnapshotState, createBrowserDiagnosticsUiStore, selectBrowserDiagnosticsForView,
    selectBrowserDiagnosticEvents, selectBrowserDiagnosticRequest, selectBrowserDiagnosticRequests,
    selectBrowserDiagnosticStorageRows, selectBrowserDiagnosticResourceRows, serializeBrowserDiagnosticEvents } from './store';

it('filters and exports the admitted projection and resolves the selected request after an upsert', () => {
    const request = BrowserDiagnosticEventV1Schema.parse({ ...nativePageInfoEvent(), eventId: 'request', family: 'network', kind: 'network.finished',
        data: { requestId: 'safe-request', method: 'GET', status: 503, resourceType: 'Fetch', url: { origin: 'https://example.test', path: '/api', queryKeys: [] } },
        redaction: { level: 'metadataOnly', truncated: true } });
    const log = injectedConsoleEvent({ data: { level: 'warning', text: 'Unable to load' } });
    const projection = selectBrowserDiagnosticsForView(applyBrowserDiagnosticEvents(createBrowserDiagnosticsUiStore(), { events: [request, log] }), request);
    expect(selectBrowserDiagnosticEvents(projection, { family: 'network', search: '/API', statuses: [503], resourceTypes: ['Fetch'] })).toEqual([projection.events.find(event => event.eventId === 'request')]);
    expect(selectBrowserDiagnosticEvents(projection, { family: 'console', levels: ['error'] })).toEqual([]);
    expect(selectBrowserDiagnosticEvents(projection, { family: 'console', levels: ['warning'], search: 'unable' })).toHaveLength(1);
    const selected = selectBrowserDiagnosticRequest(projection, 'safe-request');
    expect(selected?.status).toBe(503);
    expect(JSON.parse(serializeBrowserDiagnosticEvents(selected?.events ?? []))).toMatchObject([{ data: request.data, redaction: { truncated: true } }]);
    expect(selectBrowserDiagnosticRequest(projection, 'missing')).toBeUndefined();
});

function rowProjection(events: readonly BrowserDiagnosticEventV1[]) {
    return selectBrowserDiagnosticsForView(applyBrowserDiagnosticEvents(createBrowserDiagnosticsUiStore(), { events }), nativePageInfoEvent());
}

it('pairs pushed request lifecycles and filters whole requests without losing their earlier metadata', () => {
    const event = (eventId: string, kind: BrowserDiagnosticEventV1['kind'], capturedAtMs: number, data: Record<string, unknown>) =>
        BrowserDiagnosticEventV1Schema.parse({ ...nativePageInfoEvent(), eventId, family: 'network', kind, capturedAtMs, data });
    const start = event('start', 'network.requestStarted', 2000, { requestId: 'r', method: 'POST', resourceType: 'Fetch',
        url: { origin: 'https://example.test', path: '/Upload', queryKeys: ['mode'] } });
    const response = event('response', 'network.response', 2100, { requestId: 'r', status: 503 });
    const finished = event('finished', 'network.finished', 2200, { requestId: 'r', durationMs: 200, responseBytes: 0 });
    const failure = event('failure', 'network.failed', 2300, { requestId: 'failed', errorText: 'net::ERR_ABORTED', durationMs: 0 });
    const ok = event('ok', 'network.finished', 2400, { requestId: 'ok', status: 200, url: '/ok' });
    const projection = rowProjection([finished, ok, start, failure, response]);
    const requests = selectBrowserDiagnosticRequests(projection);
    expect(requests).toHaveLength(3);
    expect(selectBrowserDiagnosticRequest(projection, 'r')).toMatchObject({ requestId: 'r', method: 'POST',
        url: 'https://example.test/Upload?mode', status: 503, failed: false, isFailure: true,
        durationMs: 200, sizeBytes: 0, type: 'Fetch', start: { eventId: 'start' },
        response: { eventId: 'response' }, finished: { eventId: 'finished' }, events: expect.any(Array) });
    expect(selectBrowserDiagnosticRequests(projection, { search: '  /UPLOAD ', failedOnly: true }).map(row => row.requestId)).toEqual(['r']);
    expect(selectBrowserDiagnosticRequests(projection, { failedOnly: true }).map(row => row.requestId)).toEqual(['r', 'failed']);
    expect(selectBrowserDiagnosticRequests(projection, { search: 'err_aborted' })[0]).toMatchObject({
        failed: true, isFailure: true, errorText: 'net::ERR_ABORTED', durationMs: 0, failure: { eventId: 'failure' } });
});

it('pairs socket events separately and reads a completed daemon upsert as one request', () => {
    const base = nativePageInfoEvent();
    const events = [
        { ...base, eventId: 'request', family: 'network', kind: 'network.requestStarted', data: { requestId: 'r', url: '/old' } },
        { ...base, eventId: 'request', family: 'network', kind: 'network.finished', capturedAtMs: 2400,
            data: { requestId: 'r', url: '/new', statusCode: 200, durationMs: 25, responseBytes: 123 } },
        { ...base, eventId: 'socket', family: 'network', kind: 'network.websocketOpened', data: { socketId: 's', url: '/socket', state: 'open' } },
    ].map(event => BrowserDiagnosticEventV1Schema.parse(event));
    expect(selectBrowserDiagnosticRequest(rowProjection(events), 'r')).toMatchObject({
        url: '/new', durationMs: 25, sizeBytes: 123, events: [expect.objectContaining({ eventId: 'request' })] });
    expect(selectBrowserDiagnosticRequests(rowProjection(events)).find(row => row.kind === 'socket')).toMatchObject({ url: '/socket', state: 'open' });
});

it('searches the latest storage inventories by key and admitted value and respects empty replacements', () => {
    const inventory = (eventId: string, capturedAtMs: number, storageType: string, keys: string[], entries: unknown[] = []) =>
        BrowserDiagnosticEventV1Schema.parse({ ...nativePageInfoEvent(), eventId, capturedAtMs, family: 'storage', kind: 'storage.keyInventory',
            data: { storageType, keys, entries, keyCount: keys.length, keysTruncated: false } });
    const events = [inventory('old', 2100, 'localStorage', ['stale']),
        inventory('new', 2200, 'localStorage', ['theme'], [{ key: 'theme', value: 'Dark', valueTruncated: true }]),
        inventory('session', 2300, 'sessionStorage', ['draft'])];
    expect(selectBrowserDiagnosticStorageRows(rowProjection(events), { search: ' DARK ' })).toEqual([
        expect.objectContaining({ storageType: 'localStorage', name: 'theme', value: 'Dark', valueTruncated: true, keyCount: 1, keysTruncated: false })]);
    expect(selectBrowserDiagnosticStorageRows(rowProjection(events), { search: 'DRAFT' }).map(row => row.name)).toEqual(['draft']);
    expect(selectBrowserDiagnosticStorageRows(rowProjection([...events, inventory('clear', 2400, 'localStorage', [])])).map(row => row.name)).toEqual(['draft']);
});

it('searches resources by URL and type using the latest snapshot, including an empty snapshot', () => {
    const snapshot = (eventId: string, capturedAtMs: number, entries: unknown[]) =>
        BrowserDiagnosticEventV1Schema.parse({ ...nativePageInfoEvent(), eventId, capturedAtMs, family: 'resources', kind: 'resources.snapshot', data: { entries } });
    const events = [snapshot('old', 2100, [{ name: '/stale.js' }]),
        snapshot('new', 2200, [{ name: 'https://example.test/App.js', initiatorType: 'script', durationMs: 0 }])];
    expect(selectBrowserDiagnosticResourceRows(rowProjection(events), { search: ' /APP.JS ' })[0]?.entry).toMatchObject({ durationMs: 0 });
    expect(selectBrowserDiagnosticResourceRows(rowProjection(events), { search: 'SCRIPT' })).toHaveLength(1);
    expect(selectBrowserDiagnosticResourceRows(rowProjection([...events, snapshot('clear', 2300, [])]))).toEqual([]);
});

it('projects admitted structured URLs, safe header bags, failure details and clipping', () => {
    const event = BrowserDiagnosticEventV1Schema.parse({ ...nativePageInfoEvent(), family: 'network', kind: 'network.response',
        fidelity: 'cdp', data: { requestId: 'request', method: 'GET', status: 200,
            url: { origin: 'https://example.test', path: '/api', queryKeys: ['search'] },
            headers: { 'content-type': 'application/json' }, errorText: 'net::ERR_FAILED' },
        redaction: { level: 'metadataOnly', truncated: true } });
    const projection = selectBrowserDiagnosticsForView(applyBrowserDiagnosticEvents(createBrowserDiagnosticsUiStore(), { events: [event] }), event);
    expect(projection.events[0]?.summary).toContain('https://example.test/api');
    expect(projection.events[0]?.detail?.fields).toEqual(expect.arrayContaining([
        { key: 'responseHeaders', value: 'content-type: application/json' }, { key: 'errorText', value: 'net::ERR_FAILED' },
    ]));
    expect(projection.events[0]).toMatchObject({ redaction: { truncated: true } });
});

it('distinguishes supported quiet, degraded, retained disconnected and pushed recovery without stale history winning', () => {
    const ready = BrowserDiagnosticEventV1Schema.parse({ ...nativePageInfoEvent(), family: 'console',
        kind: 'diagnostics.available', fidelity: 'cdp', capturedAtMs: 2000, data: {} });
    let state = applyBrowserDiagnosticEvents(createBrowserDiagnosticsUiStore(), { events: [ready] });
    const read = () => selectBrowserDiagnosticsForView(state, ready);
    expect(read()).toMatchObject({ eventCount: 0, events: [], families: expect.arrayContaining([
        expect.objectContaining({ family: 'console', status: 'available' }),
    ]) });
    state = applyBrowserDiagnosticEvents(state, { events: [{ ...ready, eventId: 'degraded', kind: 'collector.degraded', capturedAtMs: 2100 }] });
    expect(read().families.find(family => family.family === 'console')?.status).toBe('stale');
    state = applyBrowserDiagnosticEvents(state, { events: [{ ...ready, eventId: 'recovered', capturedAtMs: 2200 }] });
    expect(read().families.find(family => family.family === 'console')?.status).toBe('available');
    state = applyBrowserDiagnosticEvents(state, { events: [{ ...ready, eventId: 'message', kind: 'console.entry', capturedAtMs: 2300, data: { text: 'hello' } }] });
    const disconnected = { browserSessionId: ready.browserSessionId, viewId: ready.viewId, navigationGeneration: ready.navigationGeneration,
        connection: 'disconnected' as const, reasonCode: 'request_failed', evictedEventCount: 5 };
    state = applyBrowserDiagnosticsSnapshotState(state, disconnected);
    expect(read()).toMatchObject({ status: 'stale', connection: 'disconnected', eventCount: 1, evictedEventCount: 5 });
    expect(applyBrowserDiagnosticsSnapshotState(state, disconnected)).toBe(state);
    const retained = state.viewsByKey[TEST_BROWSER_VIEW_KEY]?.events;
    state = applyBrowserDiagnosticsSnapshotState(state, { ...disconnected, connection: 'connected', reasonCode: undefined });
    expect(read().status).toBe('available');
    expect(state.viewsByKey[TEST_BROWSER_VIEW_KEY]?.events).toBe(retained);
});

it('keeps an independent injected collector healthy when the daemon connection fails', () => {
    const event = injectedConsoleEvent({ data: { level: 'log', text: 'local message' } });
    let state = applyBrowserDiagnosticEvents(createBrowserDiagnosticsUiStore(), { events: [event] });
    state = applyBrowserDiagnosticsSnapshotState(state, { ...event, connection: 'disconnected', reasonCode: 'request_failed' });
    expect(selectBrowserDiagnosticsForView(state, event)).toMatchObject({ status: 'available', families: expect.arrayContaining([
        expect.objectContaining({ family: 'console', status: 'available' }),
    ]) });
});

const TEST_BROWSER_VIEW_KEY = browserViewKey({
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
});

type StoreModule = Readonly<{
    applyBrowserDiagnosticEvents?: (
        state: unknown,
            input: Readonly<{
                events: readonly Record<string, unknown>[];
            }>,
    ) => unknown;
    createBrowserDiagnosticsUiStore?: () => unknown;
    selectBrowserDiagnosticsForView?: (
        state: unknown,
        input: Readonly<{
            browserSessionId: string;
            viewId: string;
        }>,
    ) => unknown;
}>;

async function loadStoreModule(): Promise<StoreModule | null> {
    const path = './store';
    return import(path).catch(() => null) as Promise<StoreModule | null>;
}

function injectedConsoleEvent(overrides: Record<string, unknown> = {}): BrowserDiagnosticEventV1 {
    return BrowserDiagnosticEventV1Schema.parse({
        v: 1,
        eventId: 'evt_console_1',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        navigationGeneration: 2,
        capturedAtMs: 2_000,
        family: 'console',
        kind: 'console.entry',
        fidelity: 'injectedPage',
        trusted: false,
        collector: {
            collectorId: 'collector_1',
            nonce: 'nonce_1',
            version: '1.0.0',
        },
        data: {
            level: 'log',
            argCount: 1,
            textAvailable: true,
        },
        redaction: {
            level: 'valuesRedacted',
        },
        ...overrides,
    });
}

function nativePageInfoEvent(overrides: Record<string, unknown> = {}): BrowserDiagnosticEventV1 {
    return BrowserDiagnosticEventV1Schema.parse({
        v: 1,
        eventId: 'evt_page_1',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        navigationGeneration: 2,
        capturedAtMs: 2_100,
        family: 'pageInfo',
        kind: 'pageInfo.snapshot',
        fidelity: 'nativeCallback',
        trusted: true,
        data: {
            url: 'https://example.test/',
            loading: false,
        },
        redaction: {
            level: 'metadataOnly',
        },
        ...overrides,
    });
}

describe('browser diagnostics UI store', () => {
    it('retains every admitted event and detail beyond the former client caps', async () => {
        const { selectBrowserDiagnosticsForView } = await import('./store');
        const events = Array.from({ length: 1001 }, (_, index) => injectedConsoleEvent({
            eventId: `event_${index}`, capturedAtMs: index,
        }));
        const keys = Array.from({ length: 201 }, (_, index) => `key_${index}`);
        events.push(injectedConsoleEvent({ eventId: 'storage', family: 'storage', kind: 'storage.keyInventory',
            data: { storageType: 'localStorage', keyCount: keys.length, keys, keysTruncated: false } }));
        const state = applyBrowserDiagnosticEvents(createBrowserDiagnosticsUiStore(), { events });
        const projection = selectBrowserDiagnosticsForView(state, { browserSessionId: 'browser_session_1', viewId: 'view_1' });
        expect(projection.eventCount).toBe(1002);
        expect(projection.events.find(event => event.eventId === 'storage')?.detail?.keys).toEqual(keys);
    });

    it('preserves the owner values already admitted by the diagnostics boundary', () => {
        const event = injectedConsoleEvent({ data: { level: 'log', textAvailable: true, text: 'https://example.test/?token=owner-value' },
            redaction: { level: 'none' } });
        const state = applyBrowserDiagnosticEvents(createBrowserDiagnosticsUiStore(), { events: [event] });
        expect(state.viewsByKey[TEST_BROWSER_VIEW_KEY]?.events[0]?.data.text).toBe('https://example.test/?token=owner-value');
    });

    it('compares accepted data without serializing unknown values or depending on object key order', () => {
        const state = applyBrowserDiagnosticEvents(createBrowserDiagnosticsUiStore(), {
            events: [nativePageInfoEvent({ data: { url: 'https://example.test/', loading: false, custom: 1n } })],
        });
        expect(applyBrowserDiagnosticEvents(state, {
            events: [nativePageInfoEvent({ data: { custom: 1n, loading: false, url: 'https://example.test/' } })],
        })).toBe(state);
    });
    it('retains accepted event and view identities when a snapshot repeats, but publishes changed data', () => {
        const event = nativePageInfoEvent();
        const state = applyBrowserDiagnosticEvents(createBrowserDiagnosticsUiStore(), { events: [event] });
        let publications = 0;
        let current = state;
        for (let index = 0; index < 20; index += 1) {
            const next = applyBrowserDiagnosticEvents(current, { events: [{ ...event, data: { url: 'https://example.test/', loading: false } }] });
            if (next !== current) publications += 1;
            current = next;
        }
        expect(publications).toBe(0);
        expect(current).toBe(state);
        const changed = applyBrowserDiagnosticEvents(current, { events: [nativePageInfoEvent({ data: { url: 'https://example.test/next', loading: false } })] });
        expect(changed).not.toBe(state);
        expect(changed.viewsByKey[TEST_BROWSER_VIEW_KEY]?.events).toHaveLength(1);
    });
    it('normalizes injected and native callback diagnostics per browser view', async () => {
        const mod = await loadStoreModule();

        expect(mod?.createBrowserDiagnosticsUiStore).toBeTypeOf('function');
        expect(mod?.applyBrowserDiagnosticEvents).toBeTypeOf('function');
        expect(mod?.selectBrowserDiagnosticsForView).toBeTypeOf('function');
        if (!mod?.createBrowserDiagnosticsUiStore || !mod.applyBrowserDiagnosticEvents || !mod.selectBrowserDiagnosticsForView) return;

        const state = mod.applyBrowserDiagnosticEvents(
            mod.createBrowserDiagnosticsUiStore(),
            {
                events: [
                    injectedConsoleEvent(),
                    nativePageInfoEvent(),
                ],
            },
        );

        const projection = mod.selectBrowserDiagnosticsForView(state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        });

        expect(projection).toMatchObject({
            status: 'available',
            sourceKind: 'browserDiagnostics',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 2,
            eventCount: 2,
            trusted: false,
            fidelity: 'injectedPage',
            events: [
                expect.objectContaining({
                    eventId: 'evt_console_1',
                    family: 'console',
                    fidelity: 'injectedPage',
                    trusted: false,
                }),
                expect.objectContaining({
                    eventId: 'evt_page_1',
                    family: 'pageInfo',
                    fidelity: 'nativeCallback',
                    trusted: true,
                }),
            ],
        });
        expect(projection).toMatchObject({
            families: expect.arrayContaining([
                expect.objectContaining({
                    family: 'console',
                    status: 'available',
                    fidelity: 'injectedPage',
                    trusted: false,
                }),
                expect.objectContaining({
                    family: 'pageInfo',
                    status: 'available',
                    fidelity: 'nativeCallback',
                    trusted: true,
                }),
                expect.objectContaining({
                    family: 'proxyTunnel',
                    status: 'unavailable',
                    fidelity: 'unavailable',
                    reasonCode: 'unsupported_fidelity',
                }),
            ]),
        });
    });

    it('projects admitted injected family local-owner values', async () => {
        const mod = await loadStoreModule();

        expect(mod?.createBrowserDiagnosticsUiStore).toBeTypeOf('function');
        expect(mod?.applyBrowserDiagnosticEvents).toBeTypeOf('function');
        expect(mod?.selectBrowserDiagnosticsForView).toBeTypeOf('function');
        if (!mod?.createBrowserDiagnosticsUiStore || !mod.applyBrowserDiagnosticEvents || !mod.selectBrowserDiagnosticsForView) return;

        const base = {
            v: 1,
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 2,
            fidelity: 'injectedPage' as const,
            trusted: false,
            collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
            redaction: { level: 'metadataOnly' as const },
        };

        const state = mod.applyBrowserDiagnosticEvents(
            mod.createBrowserDiagnosticsUiStore(),
            {
                events: [
                    {
                        ...base,
                        eventId: 'evt_beacon_1',
                        capturedAtMs: 3_000,
                        family: 'network',
                        kind: 'network.sendBeacon',
                        data: { requestId: 'beacon_1', url: 'https://telemetry.test/collect', bytesQueued: 17, accepted: true },
                    },
                    {
                        ...base,
                        eventId: 'evt_storage_keys_1',
                        capturedAtMs: 3_100,
                        family: 'storage',
                        kind: 'storage.keyInventory',
                        data: {
                            storageType: 'localStorage',
                            keyCount: 2,
                            keysTruncated: false,
                            keys: ['theme', 'lastRoute'],
                            entries: [
                                { key: 'theme', value: 'dark', valueTruncated: false },
                                { key: 'lastRoute', value: '/settings', valueTruncated: false },
                            ],
                        },
                    },
                    {
                        ...base,
                        eventId: 'evt_dom_1',
                        capturedAtMs: 3_200,
                        family: 'pageInfo',
                        kind: 'pageInfo.domSnapshot',
                        data: { nodeCount: 100, elementCount: 80, maxDepth: 12, readyState: 'complete' },
                    },
                ],
            },
        );

        // The store keeps admitted events in state; the projection summarizes them.
        const storedEvents = Object.values(
            (state as { viewsByKey: Record<string, { events: readonly { eventId: string; data: Record<string, unknown> }[] }> }).viewsByKey,
        ).flatMap((view) => [...view.events]);
        const storedById = (id: string) => storedEvents.find((event) => event.eventId === id)?.data;

        expect(storedById('evt_beacon_1')).toMatchObject({ url: 'https://telemetry.test/collect', bytesQueued: 17, accepted: true });
        expect(storedById('evt_storage_keys_1')).toMatchObject({
            storageType: 'localStorage',
            keyCount: 2,
            keys: ['theme', 'lastRoute'],
            entries: [
                { key: 'theme', value: 'dark', valueTruncated: false },
                { key: 'lastRoute', value: '/settings', valueTruncated: false },
            ],
        });
        expect(storedById('evt_dom_1')).toMatchObject({ elementCount: 80, maxDepth: 12, nodeCount: 100 });

        const projection = mod.selectBrowserDiagnosticsForView(state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        }) as { events: readonly { eventId: string; summary?: string }[] };
        const summaryById = (id: string) => projection.events.find((event) => event.eventId === id)?.summary;
        expect(summaryById('evt_storage_keys_1')).toContain('localStorage');
        expect(summaryById('evt_dom_1')).toContain('elementCount');
        expect(summaryById('evt_beacon_1')).toContain('telemetry.test');
    });

    it('starts a fresh event window when a newer navigation generation arrives', async () => {
        const mod = await loadStoreModule();

        expect(mod?.createBrowserDiagnosticsUiStore).toBeTypeOf('function');
        expect(mod?.applyBrowserDiagnosticEvents).toBeTypeOf('function');
        expect(mod?.selectBrowserDiagnosticsForView).toBeTypeOf('function');
        if (!mod?.createBrowserDiagnosticsUiStore || !mod.applyBrowserDiagnosticEvents || !mod.selectBrowserDiagnosticsForView) return;

        const initial = mod.applyBrowserDiagnosticEvents(
            mod.createBrowserDiagnosticsUiStore(),
            { events: [injectedConsoleEvent()] },
        );
        const next = mod.applyBrowserDiagnosticEvents(initial, {
            events: [nativePageInfoEvent({
                eventId: 'evt_page_new',
                navigationGeneration: 3,
            })],
        });

        const projection = mod.selectBrowserDiagnosticsForView(next, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        });

        expect(projection).toMatchObject({
            navigationGeneration: 3,
            eventCount: 1,
            events: [
                expect.objectContaining({ eventId: 'evt_page_new' }),
            ],
        });
    });

    it('projects explicit family diagnostics unavailable events as unavailable state', async () => {
        const mod = await loadStoreModule();

        expect(mod?.createBrowserDiagnosticsUiStore).toBeTypeOf('function');
        expect(mod?.applyBrowserDiagnosticEvents).toBeTypeOf('function');
        expect(mod?.selectBrowserDiagnosticsForView).toBeTypeOf('function');
        if (!mod?.createBrowserDiagnosticsUiStore || !mod.applyBrowserDiagnosticEvents || !mod.selectBrowserDiagnosticsForView) return;

        const state = mod.applyBrowserDiagnosticEvents(
            mod.createBrowserDiagnosticsUiStore(),
            {
                events: [
                    nativePageInfoEvent({
                        eventId: 'evt_storage_unavailable',
                        family: 'storage',
                        kind: 'diagnostics.unavailable',
                        fidelity: 'unavailable',
                        trusted: false,
                        data: {},
                        redaction: {
                            level: 'unavailable',
                        },
                        unavailableReason: 'collector_unavailable',
                    }),
                ],
            },
        );

        const projection = mod.selectBrowserDiagnosticsForView(state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        });

        expect(projection).toMatchObject({
            families: expect.arrayContaining([
                expect.objectContaining({
                    family: 'storage',
                    status: 'unavailable',
                    fidelity: 'unavailable',
                    trusted: false,
                    reasonCode: 'collector_unavailable',
                }),
            ]),
        });
    });



    it('projects the admitted owner console text', async () => {
        const mod = await loadStoreModule();

        expect(mod?.createBrowserDiagnosticsUiStore).toBeTypeOf('function');
        expect(mod?.applyBrowserDiagnosticEvents).toBeTypeOf('function');
        expect(mod?.selectBrowserDiagnosticsForView).toBeTypeOf('function');
        if (!mod?.createBrowserDiagnosticsUiStore || !mod.applyBrowserDiagnosticEvents || !mod.selectBrowserDiagnosticsForView) return;

        const state = mod.applyBrowserDiagnosticEvents(
            mod.createBrowserDiagnosticsUiStore(),
            {
                events: [
                    injectedConsoleEvent({
                        data: {
                            level: 'log',
                            argCount: 1,
                            textAvailable: true,
                            text: 'owner-visible-console-line',
                        },
                        redaction: { level: 'none' },
                    }),
                ],
            },
        );

        const projection = mod.selectBrowserDiagnosticsForView(state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        }) as { events: readonly { kind: string; detail?: { fields?: readonly { key: string; value: unknown }[] } }[] };

        const consoleEvent = projection.events.find((event) => event.kind === 'console.entry');
        expect(consoleEvent?.detail?.fields?.some((field) => field.key === 'text' && field.value === 'owner-visible-console-line')).toBe(true);
    });

    it('projects admitted network headers, bodies and storage values', async () => {
        const mod = await loadStoreModule();

        expect(mod?.createBrowserDiagnosticsUiStore).toBeTypeOf('function');
        expect(mod?.applyBrowserDiagnosticEvents).toBeTypeOf('function');
        expect(mod?.selectBrowserDiagnosticsForView).toBeTypeOf('function');
        if (!mod?.createBrowserDiagnosticsUiStore || !mod.applyBrowserDiagnosticEvents || !mod.selectBrowserDiagnosticsForView) return;

        const base = {
            v: 1,
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 2,
            fidelity: 'injectedPage' as const,
            trusted: false,
            collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
            redaction: { level: 'none' as const },
        };

        const state = mod.applyBrowserDiagnosticEvents(
            mod.createBrowserDiagnosticsUiStore(),
            {
                events: [
                    {
                        ...base,
                        eventId: 'evt_network_owner_values',
                        capturedAtMs: 3_000,
                        family: 'network',
                        kind: 'network.response',
                        data: {
                            requestId: 'req_1',
                            method: 'POST',
                            url: 'https://api.test/items',
                            statusCode: 201,
                            requestHeaders: { 'content-type': 'application/json' },
                            responseHeaders: { 'x-request-id': 'res-1' },
                            requestBodyText: 'owner request body',
                            responseBodyText: 'owner response body',
                            requestBodyTruncated: false,
                            responseBodyTruncated: false,
                        },
                    },
                    {
                        ...base,
                        eventId: 'evt_storage_owner_values',
                        capturedAtMs: 3_100,
                        family: 'storage',
                        kind: 'storage.keyInventory',
                        data: {
                            storageType: 'localStorage',
                            keyCount: 1,
                            keys: ['theme'],
                            keysTruncated: false,
                            entries: [{ key: 'theme', value: 'dark', valueTruncated: false }],
                        },
                    },
                ],
            },
        );

        const projection = mod.selectBrowserDiagnosticsForView(state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        }) as { events: readonly { eventId: string; detail?: { fields?: readonly { key: string; value: unknown }[]; storageEntries?: readonly { key: string; value: string }[] } }[] };
        const network = projection.events.find((event) => event.eventId === 'evt_network_owner_values');
        const storage = projection.events.find((event) => event.eventId === 'evt_storage_owner_values');

        expect(network?.detail?.fields?.some((field) => field.key === 'requestBodyText' && field.value === 'owner request body')).toBe(true);
        expect(network?.detail?.fields?.some((field) => field.key === 'responseHeaders' && String(field.value).includes('x-request-id'))).toBe(true);
        expect(storage?.detail?.storageEntries).toEqual([{ key: 'theme', value: 'dark', valueTruncated: false }]);
    });















    function injectedStreamingEvent(
        kind: string,
        data: Record<string, unknown>,
        overrides: Record<string, unknown> = {},
    ): Record<string, unknown> {
        return {
            v: 1,
            eventId: `evt_${kind}`,
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 2,
            capturedAtMs: 2_500,
            family: kind.startsWith('performance') ? 'performance' : kind.startsWith('pageInfo') ? 'pageInfo' : 'network',
            kind,
            fidelity: 'injectedPage',
            trusted: false,
            collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
            data,
            redaction: { level: 'metadataOnly' },
            ...overrides,
        };
    }

    it('projects admitted streaming, performance and capability metadata', async () => {
        const mod = await loadStoreModule();

        expect(mod?.createBrowserDiagnosticsUiStore).toBeTypeOf('function');
        if (!mod?.createBrowserDiagnosticsUiStore || !mod.applyBrowserDiagnosticEvents || !mod.selectBrowserDiagnosticsForView) return;

        const state = mod.applyBrowserDiagnosticEvents(
            mod.createBrowserDiagnosticsUiStore(),
            {
                events: [
                    injectedStreamingEvent('network.websocketOpened', {
                        socketId: 'ws_1',
                        url: 'wss://realtime.example.test/chat',
                        hasProtocol: true,
                        protocolCount: 1,
                    }),
                    injectedStreamingEvent('network.websocketSummary', {
                        socketId: 'ws_1',
                        state: 'open',
                        framesSent: 3,
                        framesReceived: 4,
                        bytesSent: 100,
                        bytesReceived: 200,
                        messageCount: 7,
                    }, { eventId: 'evt_ws_summary', capturedAtMs: 2_600 }),
                    injectedStreamingEvent('performance.vitals', {
                        lcpMs: 1200,
                        clsScore: 0.05,
                        inpMs: 80,
                    }, { eventId: 'evt_perf', capturedAtMs: 2_700 }),
                    injectedStreamingEvent('pageInfo.capabilities', {
                        serviceWorker: true,
                        webgl: false,
                        webrtc: false,
                    }, { eventId: 'evt_caps', capturedAtMs: 2_800 }),
                ],
            },
        );

        const projection = mod.selectBrowserDiagnosticsForView(state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        });

        expect(JSON.stringify(projection)).not.toContain('secret');
        expect(JSON.stringify(projection)).not.toContain('token=');

        expect(projection).toMatchObject({
            families: expect.arrayContaining([
                expect.objectContaining({ family: 'performance', status: 'available', fidelity: 'injectedPage' }),
            ]),
            events: expect.arrayContaining([
                expect.objectContaining({
                    eventId: 'evt_ws_summary',
                    family: 'network',
                    kind: 'network.websocketSummary',
                    summary: expect.stringContaining('framesSent: 3'),
                }),
                expect.objectContaining({
                    eventId: 'evt_perf',
                    family: 'performance',
                    kind: 'performance.vitals',
                    summary: expect.stringContaining('lcpMs: 1200'),
                }),
                expect.objectContaining({
                    eventId: 'evt_caps',
                    family: 'pageInfo',
                    kind: 'pageInfo.capabilities',
                    summary: expect.stringContaining('serviceWorker: yes'),
                }),
            ]),
        });
    });

    it('projects typed per-family detail (network scalars, storage key list, resource entries, performance metrics)', async () => {
        const mod = await loadStoreModule();

        expect(mod?.createBrowserDiagnosticsUiStore).toBeTypeOf('function');
        expect(mod?.applyBrowserDiagnosticEvents).toBeTypeOf('function');
        expect(mod?.selectBrowserDiagnosticsForView).toBeTypeOf('function');
        if (!mod?.createBrowserDiagnosticsUiStore || !mod.applyBrowserDiagnosticEvents || !mod.selectBrowserDiagnosticsForView) return;

        const base = {
            v: 1,
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
            navigationGeneration: 2,
            redaction: { level: 'metadataOnly' as const },
        };

        const state = mod.applyBrowserDiagnosticEvents(mod.createBrowserDiagnosticsUiStore(), {
            events: [
                {
                    ...base,
                    eventId: 'evt_net_resp',
                    capturedAtMs: 4_000,
                    family: 'network',
                    kind: 'network.response',
                    fidelity: 'cdp',
                    trusted: true,
                    data: { method: 'GET', url: 'https://example.test/api', statusCode: 200, durationMs: 42, responseBytes: 1024 },
                },
                {
                    ...base,
                    eventId: 'evt_storage_keys',
                    capturedAtMs: 4_100,
                    family: 'storage',
                    kind: 'storage.keyInventory',
                    fidelity: 'injectedPage',
                    trusted: false,
                    collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
                    data: { storageType: 'localStorage', keyCount: 2, keysTruncated: false, keys: ['theme', 'lastRoute'] },
                },
                {
                    ...base,
                    eventId: 'evt_resources',
                    capturedAtMs: 4_200,
                    family: 'resources',
                    kind: 'resources.snapshot',
                    fidelity: 'injectedPage',
                    trusted: false,
                    collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
                    data: { entries: [{ name: 'app.js', initiatorType: 'script', durationMs: 12 }] },
                },
                {
                    ...base,
                    eventId: 'evt_perf',
                    capturedAtMs: 4_300,
                    family: 'performance',
                    kind: 'performance.vitals',
                    fidelity: 'injectedPage',
                    trusted: false,
                    collector: { collectorId: 'collector_1', nonce: 'nonce_1', version: '1.0.0' },
                    data: { lcpMs: 1200, clsScore: 0.05, inpMs: 80 },
                },
            ],
        });

        const projection = mod.selectBrowserDiagnosticsForView(state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        }) as {
            events: readonly {
                eventId: string;
                detail?: {
                    fields: readonly { key: string; value: string | number | boolean }[];
                    keys?: readonly string[];
                    entries?: readonly { name?: string; initiatorType?: string; durationMs?: number }[];
                };
            }[];
        };
        const detailById = (id: string) => projection.events.find((event) => event.eventId === id)?.detail;

        expect(detailById('evt_net_resp')?.fields).toEqual(
            expect.arrayContaining([
                { key: 'method', value: 'GET' },
                { key: 'statusCode', value: 200 },
                { key: 'durationMs', value: 42 },
                { key: 'responseBytes', value: 1024 },
            ]),
        );

        expect(detailById('evt_storage_keys')?.keys).toEqual(['theme', 'lastRoute']);
        expect(detailById('evt_storage_keys')?.fields).toEqual(
            expect.arrayContaining([{ key: 'storageType', value: 'localStorage' }, { key: 'keyCount', value: 2 }]),
        );

        expect(detailById('evt_resources')?.entries).toEqual([
            { name: 'app.js', initiatorType: 'script', durationMs: 12 },
        ]);

        expect(detailById('evt_perf')?.fields).toEqual(
            expect.arrayContaining([
                { key: 'lcpMs', value: 1200 },
                { key: 'clsScore', value: 0.05 },
                { key: 'inpMs', value: 80 },
            ]),
        );

        // The typed detail must never leak smuggled values: it is built from the already-sanitized
        // event data, so a secret stuffed into an untrusted event's data never reaches the projection.
        expect(JSON.stringify(projection)).not.toContain('secret');
    });
});
