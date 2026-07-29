import { describe, expect, it } from 'vitest';

type StoreModule = Readonly<{
    applyBrowserDiagnosticEvents?: (
        state: unknown,
            input: Readonly<{
                events: readonly Record<string, unknown>[];
                consoleValueCapture?: boolean;
                valueCapture?: boolean;
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

function injectedConsoleEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
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
    };
}

function nativePageInfoEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
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
    };
}

describe('browser diagnostics UI store', () => {
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

    it('preserves additive injected family local-owner values when value capture is enabled', async () => {
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
                valueCapture: true,
            },
        );

        // The store keeps full re-sanitized events in state; the projection summarizes them.
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

    it('does not project redacted text availability from untrusted diagnostics events as summaries', async () => {
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
                            level: 'error',
                            argCount: 1,
                            textAvailable: true,
                        },
                        redaction: {
                            level: 'valuesRedacted',
                        },
                    }),
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
            events: [
                expect.not.objectContaining({
                    summary: expect.any(String),
                }),
            ],
        });
    });

    it('surfaces length-capped console text to the local owner when value capture is enabled', async () => {
        const mod = await loadStoreModule();

        expect(mod?.createBrowserDiagnosticsUiStore).toBeTypeOf('function');
        expect(mod?.applyBrowserDiagnosticEvents).toBeTypeOf('function');
        expect(mod?.selectBrowserDiagnosticsForView).toBeTypeOf('function');
        if (!mod?.createBrowserDiagnosticsUiStore || !mod.applyBrowserDiagnosticEvents || !mod.selectBrowserDiagnosticsForView) return;

        const state = mod.applyBrowserDiagnosticEvents(
            mod.createBrowserDiagnosticsUiStore(),
            {
                consoleValueCapture: true,
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

    it('surfaces network headers/bodies and storage values to the local owner when value capture is enabled', async () => {
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
                valueCapture: true,
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

    it('drops console text in the store when value capture is NOT enabled (fail-closed default)', async () => {
        const mod = await loadStoreModule();
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
                            text: 'secret-store-line',
                        },
                        redaction: { level: 'none' },
                    }),
                ],
            },
        );

        const projection = mod.selectBrowserDiagnosticsForView(state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        });

        expect(JSON.stringify(projection)).not.toContain('secret-store-line');
    });

    it('strips query values from untrusted diagnostics URL summaries', async () => {
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
                        fidelity: 'injectedPage',
                        trusted: false,
                        collector: {
                            collectorId: 'collector_1',
                            nonce: 'nonce_1',
                            version: '1.0.0',
                        },
                        data: {
                            url: 'https://preview.example.test/app?token=secret#panel',
                        },
                    }),
                ],
            },
        );

        const projection = mod.selectBrowserDiagnosticsForView(state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        });

        expect(projection).toMatchObject({
            events: [
                expect.objectContaining({
                    summary: 'https://preview.example.test/app',
                }),
            ],
        });
        expect(JSON.stringify(projection)).not.toContain('secret');
        expect(JSON.stringify(projection)).not.toContain('token=');
    });

    it('redacts path-bearing non-http diagnostic URLs before storing or projecting them', async () => {
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
                        fidelity: 'previewProxy',
                        trusted: false,
                        data: {
                            url: 'data:text/plain,secret-page?token=secret#fragment',
                            path: 'blob:https://preview.example.test/secret-path?token=secret',
                        },
                    }),
                ],
            },
        );

        const projection = mod.selectBrowserDiagnosticsForView(state, {
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        });

        expect(JSON.stringify(state)).not.toContain('secret');
        expect(JSON.stringify(state)).not.toContain('token=');
        expect(JSON.stringify(projection)).not.toContain('secret');
        expect(JSON.stringify(projection)).not.toContain('token=');
        expect(state).toMatchObject({
            viewsByKey: {
                'browser_session_1\u0000view_1': {
                    events: [
                        expect.objectContaining({
                            data: expect.objectContaining({
                                url: 'data:',
                                path: 'blob:',
                            }),
                        }),
                    ],
                },
            },
        });
        expect(projection).toMatchObject({
            events: [
                expect.objectContaining({
                    summary: 'data:',
                }),
            ],
        });
    });

    it('does not retain raw untrusted text or URL query values in store state', async () => {
        const mod = await loadStoreModule();

        expect(mod?.createBrowserDiagnosticsUiStore).toBeTypeOf('function');
        expect(mod?.applyBrowserDiagnosticEvents).toBeTypeOf('function');
        if (!mod?.createBrowserDiagnosticsUiStore || !mod.applyBrowserDiagnosticEvents) return;

        const state = mod.applyBrowserDiagnosticEvents(
            mod.createBrowserDiagnosticsUiStore(),
            {
                events: [
                    nativePageInfoEvent({
                        eventId: 'evt_untrusted_page',
                        fidelity: 'previewProxy',
                        trusted: false,
                        data: {
                            url: 'https://preview.example.test/app?token=secret#panel',
                            path: '/api/items?previewToken=secret',
                            textPreview: 'token=secret',
                            errorCode: 'Failed https://preview.example.test/app?token=secret',
                        },
                    }),
                ],
            },
        );

        expect(JSON.stringify(state)).not.toContain('secret');
        expect(JSON.stringify(state)).not.toContain('token=');
        expect(JSON.stringify(state)).not.toContain('previewToken');
        expect(JSON.stringify(state)).not.toContain('textPreview');
        expect(JSON.stringify(state)).not.toContain('errorCode');
        expect(state).toMatchObject({
            viewsByKey: {
                'browser_session_1\u0000view_1': {
                    events: [
                        expect.objectContaining({
                            data: expect.objectContaining({
                                url: 'https://preview.example.test/app',
                                path: '/api/items',
                            }),
                        }),
                    ],
                },
            },
        });
    });

    it('retains redacted untrusted resource snapshot entries as metadata only', async () => {
        const mod = await loadStoreModule();

        expect(mod?.createBrowserDiagnosticsUiStore).toBeTypeOf('function');
        expect(mod?.applyBrowserDiagnosticEvents).toBeTypeOf('function');
        if (!mod?.createBrowserDiagnosticsUiStore || !mod.applyBrowserDiagnosticEvents) return;

        const state = mod.applyBrowserDiagnosticEvents(
            mod.createBrowserDiagnosticsUiStore(),
            {
                events: [
                    nativePageInfoEvent({
                        eventId: 'evt_resources_1',
                        family: 'resources',
                        kind: 'resources.snapshot',
                        fidelity: 'injectedPage',
                        trusted: false,
                        collector: {
                            collectorId: 'collector_1',
                            nonce: 'nonce_1',
                            version: '1.0.0',
                        },
                        data: {
                            entries: [
                                {
                                    name: 'https://cdn.example.test/app.js?token=secret#bundle',
                                    initiatorType: 'script',
                                    durationMs: 42,
                                },
                                {
                                    name: '/styles/main.css?cacheBust=secret',
                                    initiatorType: 'css',
                                    durationMs: 7,
                                },
                                {
                                    name: 'data:text/plain,secret-resource?token=secret#fragment',
                                    initiatorType: 'fetch',
                                    durationMs: 3,
                                },
                            ],
                        },
                        redaction: {
                            level: 'metadataOnly',
                        },
                    }),
                ],
            },
        );

        expect(JSON.stringify(state)).not.toContain('secret');
        expect(JSON.stringify(state)).not.toContain('token=');
        expect(JSON.stringify(state)).not.toContain('cacheBust');
        expect(state).toMatchObject({
            viewsByKey: {
                'browser_session_1\u0000view_1': {
                    events: [
                        expect.objectContaining({
                            data: {
                                entries: [
                                    {
                                        name: 'https://cdn.example.test/app.js',
                                        initiatorType: 'script',
                                        durationMs: 42,
                                    },
                                    {
                                        name: '/styles/main.css',
                                        initiatorType: 'css',
                                        durationMs: 7,
                                    },
                                    {
                                        name: 'data:',
                                        initiatorType: 'fetch',
                                        durationMs: 3,
                                    },
                                ],
                            },
                        }),
                    ],
                },
            },
        });
    });

    it('retains capped untrusted eval audit metadata without raw result values', async () => {
        const mod = await loadStoreModule();

        expect(mod?.createBrowserDiagnosticsUiStore).toBeTypeOf('function');
        expect(mod?.applyBrowserDiagnosticEvents).toBeTypeOf('function');
        if (!mod?.createBrowserDiagnosticsUiStore || !mod.applyBrowserDiagnosticEvents) return;

        const state = mod.applyBrowserDiagnosticEvents(
            mod.createBrowserDiagnosticsUiStore(),
            {
                events: [
                    injectedConsoleEvent({
                        eventId: 'evt_eval_requested_1',
                        kind: 'eval.requested',
                        data: {
                            evalRequestId: 'eval_1',
                            tier: 'injectedPage',
                            expressionPreview: `${'x'.repeat(4096)}secret-tail`,
                            expressionTruncated: true,
                            timeoutMs: 2_000,
                            objectGroupId: 'group_1',
                        },
                        redaction: {
                            level: 'valuesRedacted',
                        },
                    }),
                ],
            },
        );

        expect(JSON.stringify(state)).not.toContain('secret-tail');
        expect(state).toMatchObject({
            viewsByKey: {
                'browser_session_1\u0000view_1': {
                    events: [
                        expect.objectContaining({
                            data: {
                                evalRequestId: 'eval_1',
                                tier: 'injectedPage',
                                expressionPreview: 'x'.repeat(4096),
                                expressionTruncated: true,
                                timeoutMs: 2_000,
                                objectGroupId: 'group_1',
                            },
                        }),
                    ],
                },
            },
        });
    });

    it('does not project redacted untrusted network failures as summaries', async () => {
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
                        family: 'network',
                        kind: 'network.failed',
                        fidelity: 'injectedPage',
                        trusted: false,
                        collector: {
                            collectorId: 'collector_1',
                            nonce: 'nonce_1',
                            version: '1.0.0',
                        },
                        data: {
                            requestAvailable: true,
                            errorAvailable: true,
                        },
                        redaction: {
                            level: 'valuesRedacted',
                        },
                    }),
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
            events: [
                expect.not.objectContaining({
                    summary: expect.any(String),
                }),
            ],
        });
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

    it('preserves injected streaming, performance, and capability metadata while dropping payloads', async () => {
        const mod = await loadStoreModule();

        expect(mod?.createBrowserDiagnosticsUiStore).toBeTypeOf('function');
        if (!mod?.createBrowserDiagnosticsUiStore || !mod.applyBrowserDiagnosticEvents || !mod.selectBrowserDiagnosticsForView) return;

        const state = mod.applyBrowserDiagnosticEvents(
            mod.createBrowserDiagnosticsUiStore(),
            {
                events: [
                    injectedStreamingEvent('network.websocketOpened', {
                        socketId: 'ws_1',
                        url: 'wss://realtime.example.test/chat?token=secret',
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
