import {
    SANITIZE_URL_PARITY_VECTORS,
    stripBrowserDiagnosticUrlValues,
} from '@happier-dev/protocol';
import { describe, expect, it } from 'vitest';

type InjectedPageModule = Readonly<{
    buildInjectedBrowserDiagnosticsScript?: (input: Readonly<{
        browserSessionId: string;
        viewId: string;
        navigationGeneration: number;
        collectorId: string;
        nonce: string;
        version: string;
        webPostMessageTargetOrigin?: string;
        desktopIpcDelivery?: boolean;
        ownerConsoleValueCapture?: boolean;
        ownerDiagnosticsValueCapture?: boolean;
    }>) => string;
    buildInjectedBrowserDiagnosticsEvalCommandScript?: (input: Readonly<{
        browserSessionId: string;
        collectorId: string;
        nonce: string;
        version: string;
        request: Readonly<{
            v: 1;
            evalRequestId: string;
            viewId: string;
            navigationGeneration: number;
            tier: 'injectedPage';
            expression: string;
            timeoutMs?: number;
            objectGroupId: string;
            diagnosticsInteractionEnabled: true;
        }>;
    }>) => string;
    buildInjectedBrowserDiagnosticsGetPropertiesCommandScript?: (input: Readonly<{
        browserSessionId: string;
        collectorId: string;
        nonce: string;
        version: string;
        request: Readonly<{
            v: 1;
            propertyRequestId: string;
            viewId: string;
            navigationGeneration: number;
            tier: 'injectedPage';
            objectId: string;
            objectGroupId: string;
            diagnosticsInteractionEnabled: true;
        }>;
    }>) => string;
    buildInjectedBrowserDiagnosticsReleaseObjectGroupCommandScript?: (input: Readonly<{
        browserSessionId: string;
        collectorId: string;
        nonce: string;
        version: string;
        request: Readonly<{
            v: 1;
            releaseRequestId: string;
            viewId: string;
            navigationGeneration: number;
            tier: 'injectedPage';
            objectGroupId: string;
            diagnosticsInteractionEnabled: true;
        }>;
    }>) => string;
    buildInjectedBrowserDiagnosticsElementPickerCommandScript?: (input: Readonly<{
        browserSessionId: string;
        collectorId: string;
        nonce: string;
        version: string;
        request: Readonly<{
            v: 1;
            pickerRequestId: string;
            viewId: string;
            navigationGeneration: number;
            tier: 'injectedPage';
            action: 'start' | 'cancel';
            diagnosticsInteractionEnabled: true;
        }>;
    }>) => string;
    parseInjectedBrowserDiagnosticsMessage?: (
        raw: string,
        expected: Readonly<{
            browserSessionId: string;
            viewId: string;
            navigationGeneration: number;
            collectorId: string;
            nonce: string;
        }>,
        options?: Readonly<{ consoleValueCapture?: boolean; valueCapture?: boolean }>,
    ) => Readonly<{
        ok: boolean;
        reasonCode?: string;
        events?: readonly (Readonly<Record<string, unknown>> & Readonly<{
            data: Record<string, unknown>;
            redaction: Readonly<{ level: string; truncated?: boolean }>;
        }>)[];
        evalResult?: Readonly<Record<string, unknown>>;
        propertiesResult?: Readonly<Record<string, unknown>>;
        releaseResult?: Readonly<Record<string, unknown>>;
        elementPickerResult?: Readonly<Record<string, unknown>>;
    }>;
}>;

async function loadInjectedPageModule(): Promise<InjectedPageModule | null> {
    const path = './injectedPage';
    return import(path).catch(() => null) as Promise<InjectedPageModule | null>;
}

const expectedCollector = {
    browserSessionId: 'browser_session_1',
    viewId: 'view_1',
    navigationGeneration: 2,
    collectorId: 'collector_1',
    nonce: 'nonce_1',
} as const;

function batch(overrides: Record<string, unknown> = {}): string {
    const event = {
        v: 1,
        eventId: 'evt_console_1',
        browserSessionId: expectedCollector.browserSessionId,
        viewId: expectedCollector.viewId,
        navigationGeneration: expectedCollector.navigationGeneration,
        capturedAtMs: 2_000,
        family: 'console',
        kind: 'console.entry',
        fidelity: 'injectedPage',
        trusted: false,
        collector: {
            collectorId: expectedCollector.collectorId,
            nonce: expectedCollector.nonce,
            version: '1.0.0',
        },
        data: {
            level: 'log',
            textPreview: 'ready',
        },
        redaction: {
            level: 'metadataOnly',
        },
    };
    return JSON.stringify({
        v: 1,
        kind: 'browser.diagnostics.events',
        browserSessionId: expectedCollector.browserSessionId,
        viewId: expectedCollector.viewId,
        navigationGeneration: expectedCollector.navigationGeneration,
        collector: {
            collectorId: expectedCollector.collectorId,
            nonce: expectedCollector.nonce,
            version: '1.0.0',
        },
        events: [event],
        ...overrides,
    });
}

type FakeWindowEventListener = (event?: unknown) => void;

type FakeDiagnosticsStorage = {
    readonly length: number;
    key?: (index: number) => string | null;
    getItem?: (key: string) => string | null;
};

type FakeDiagnosticsNavigator = {
    sendBeacon?: (url: string, data?: unknown) => boolean;
};

type FakeDiagnosticsWindow = {
    ReactNativeWebView: {
        postMessage: (message: string) => void;
    };
    location: {
        href: string;
    };
    localStorage: FakeDiagnosticsStorage;
    sessionStorage: FakeDiagnosticsStorage;
    navigator?: FakeDiagnosticsNavigator;
    fetch?: (input: unknown, init?: Record<string, unknown>) => Promise<unknown>;
    parent?: {
        postMessage: (message: string, targetOrigin: string) => void;
    };
    XMLHttpRequest?: FakeDiagnosticsXMLHttpRequestConstructor;
    WebSocket?: FakeDiagnosticsWebSocketConstructor;
    EventSource?: FakeDiagnosticsEventSourceConstructor;
    PerformanceObserver?: FakeDiagnosticsPerformanceObserverConstructor;
    __happierBrowserRuntime?: unknown;
    __happierBrowserDiagnostics?: unknown;
    addEventListener: (type: string, listener: FakeWindowEventListener) => void;
    removeEventListener: (type: string, listener: FakeWindowEventListener) => void;
};

type FakeDiagnosticsEventTarget = {
    addEventListener: (type: string, listener: FakeWindowEventListener) => void;
    removeEventListener: (type: string, listener: FakeWindowEventListener) => void;
    dispatchForTest: (type: string, event?: unknown) => void;
};

type FakeDiagnosticsWebSocketConstructor = {
    new (url: string, protocols?: string): FakeDiagnosticsWebSocket;
};

type FakeDiagnosticsWebSocket = FakeDiagnosticsEventTarget & {
    send: (data?: unknown) => void;
};

type FakeDiagnosticsEventSourceConstructor = {
    new (url: string): FakeDiagnosticsEventSource;
};

type FakeDiagnosticsEventSource = FakeDiagnosticsEventTarget & {
    readyState: number;
};

type FakeDiagnosticsPerformanceObserverConstructor = {
    new (callback: (list: { getEntries: () => readonly unknown[] }) => void): FakeDiagnosticsPerformanceObserver;
};

type FakeDiagnosticsPerformanceObserver = {
    observe: (options: { type: string; buffered?: boolean }) => void;
    disconnect: () => void;
    emitForTest: (entries: readonly unknown[]) => void;
    observedType?: string;
};

type FakeDiagnosticsXMLHttpRequestConstructor = {
    new (): FakeDiagnosticsXMLHttpRequest;
    readonly DONE?: number;
};

type FakeDiagnosticsXMLHttpRequest = {
    status: number;
    responseText?: string;
    open: (method: string, url: string) => void;
    send: (body?: unknown) => void;
    setRequestHeader?: (name: string, value: string) => void;
    getAllResponseHeaders?: () => string;
    addEventListener: (type: string, listener: FakeWindowEventListener) => void;
    removeEventListener: (type: string, listener: FakeWindowEventListener) => void;
    dispatchForTest: (type: string) => void;
};

type FakeDiagnosticsNode = {
    nodeType: number;
    children?: readonly FakeDiagnosticsNode[];
};

type FakeDiagnosticsDocument = {
    title: string;
    readyState: string;
    documentElement: FakeDiagnosticsNode;
    getElementsByTagName?: (tagName: string) => { readonly length: number };
};

type FakeDiagnosticsPerformance = {
    getEntriesByType: (type: string) => readonly unknown[];
};

type FakeDiagnosticsConsole = Record<'debug' | 'error' | 'info' | 'log' | 'warn', (...args: readonly unknown[]) => void>;

function executeInjectedDiagnosticsScript(
    script: string,
    options: Readonly<{
        afterRun?: (context: Readonly<{
            window: FakeDiagnosticsWindow;
            postedMessages: readonly string[];
            dispatchWindowEvent: (type: string) => void;
            console: FakeDiagnosticsConsole;
        }>) => void;
        locationHref?: string;
        XMLHttpRequest?: FakeDiagnosticsXMLHttpRequestConstructor;
        WebSocket?: FakeDiagnosticsWebSocketConstructor;
        EventSource?: FakeDiagnosticsEventSourceConstructor;
        PerformanceObserver?: FakeDiagnosticsPerformanceObserverConstructor;
        performanceEntries?: readonly unknown[];
        navigationEntries?: readonly unknown[];
        navigator?: FakeDiagnosticsNavigator;
        fetch?: (input: unknown, init?: Record<string, unknown>) => Promise<unknown>;
        localStorage?: FakeDiagnosticsStorage;
        sessionStorage?: FakeDiagnosticsStorage;
        document?: Partial<FakeDiagnosticsDocument>;
    }> = {},
): readonly string[] {
    const postedMessages: string[] = [];
    const listeners = new Map<string, Set<FakeWindowEventListener>>();
    const fakeWindow: FakeDiagnosticsWindow = {
        ReactNativeWebView: {
            postMessage: (message) => {
                postedMessages.push(message);
            },
        },
        location: {
            href: options.locationHref ?? 'https://example.test/dashboard?token=secret#panel',
        },
        localStorage: options.localStorage ?? {
            get length() {
                return 2;
            },
        },
        sessionStorage: options.sessionStorage ?? {
            get length() {
                return 1;
            },
        },
        ...(options.navigator ? { navigator: options.navigator } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        addEventListener: (type, listener) => {
            const typeListeners = listeners.get(type) ?? new Set<FakeWindowEventListener>();
            typeListeners.add(listener);
            listeners.set(type, typeListeners);
        },
        removeEventListener: (type, listener) => {
            listeners.get(type)?.delete(listener);
        },
        ...(options.XMLHttpRequest ? { XMLHttpRequest: options.XMLHttpRequest } : {}),
        ...(options.WebSocket ? { WebSocket: options.WebSocket } : {}),
        ...(options.EventSource ? { EventSource: options.EventSource } : {}),
        ...(options.PerformanceObserver ? { PerformanceObserver: options.PerformanceObserver } : {}),
    };
    const fakeDocument: FakeDiagnosticsDocument = {
        title: 'Dashboard with sensitive values unavailable to diagnostics',
        readyState: 'complete',
        documentElement: {
            nodeType: 1,
        },
        ...options.document,
    };
    const fakePerformance: FakeDiagnosticsPerformance = {
        getEntriesByType: (type) => {
            if (type === 'resource') return options.performanceEntries ?? [];
            if (type === 'navigation') return options.navigationEntries ?? [];
            return [];
        },
    };
    const fakeConsole: FakeDiagnosticsConsole = {
        debug: () => undefined,
        error: () => undefined,
        info: () => undefined,
        log: () => undefined,
        warn: () => undefined,
    };

    const runScript = new Function(
        'window',
        'document',
        'performance',
        'console',
        'setTimeout',
        'clearTimeout',
        'Promise',
        'URL',
        script,
    ) as (
        windowValue: FakeDiagnosticsWindow,
        documentValue: FakeDiagnosticsDocument,
        performanceValue: FakeDiagnosticsPerformance,
        consoleValue: FakeDiagnosticsConsole,
        setTimeoutValue: typeof setTimeout,
        clearTimeoutValue: typeof clearTimeout,
        promiseValue: PromiseConstructor,
        urlValue: typeof URL,
    ) => void;

    runScript(fakeWindow, fakeDocument, fakePerformance, fakeConsole, setTimeout, clearTimeout, Promise, URL);
    options.afterRun?.({
        window: fakeWindow,
        postedMessages,
        dispatchWindowEvent: (type) => {
            listeners.get(type)?.forEach((listener) => listener());
        },
        console: fakeConsole,
    });
    return postedMessages;
}

describe('injected browser diagnostics collector', () => {
    it('parses nonce-bound injected diagnostics batches into protocol events', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.parseInjectedBrowserDiagnosticsMessage) return;

        const parsed = mod.parseInjectedBrowserDiagnosticsMessage(batch(), expectedCollector);

        expect(parsed).toMatchObject({
            ok: true,
            events: [
                expect.objectContaining({
                    eventId: expect.stringMatching(/^injected:/),
                    fidelity: 'injectedPage',
                    trusted: false,
                }),
            ],
        });
    });

    it('rejects stale or wrong-nonce collector messages before they enter the diagnostics store', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.parseInjectedBrowserDiagnosticsMessage) return;

        expect(mod.parseInjectedBrowserDiagnosticsMessage(batch({
            collector: {
                collectorId: expectedCollector.collectorId,
                nonce: 'wrong_nonce',
                version: '1.0.0',
            },
        }), expectedCollector)).toEqual({
            ok: false,
            reasonCode: 'collector_mismatch',
        });

        expect(mod.parseInjectedBrowserDiagnosticsMessage(batch({
            navigationGeneration: 1,
        }), expectedCollector)).toEqual({
            ok: false,
            reasonCode: 'navigation_stale',
        });
    });

    it('strips query and fragment values from injected URL metadata before storage', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.parseInjectedBrowserDiagnosticsMessage) return;

        const parsed = mod.parseInjectedBrowserDiagnosticsMessage(batch({
            events: [
                {
                    v: 1,
                    eventId: 'evt_page_1',
                    browserSessionId: expectedCollector.browserSessionId,
                    viewId: expectedCollector.viewId,
                    navigationGeneration: expectedCollector.navigationGeneration,
                    capturedAtMs: 2_000,
                    family: 'pageInfo',
                    kind: 'pageInfo.snapshot',
                    fidelity: 'injectedPage',
                    trusted: false,
                    collector: {
                        collectorId: expectedCollector.collectorId,
                        nonce: expectedCollector.nonce,
                        version: '1.0.0',
                    },
                    data: {
                        url: 'https://example.test/dashboard?token=secret#section',
                    },
                    redaction: {
                        level: 'metadataOnly',
                    },
                },
            ],
        }), expectedCollector);

        expect(parsed).toMatchObject({
            ok: true,
            events: [
                expect.objectContaining({
                    data: expect.objectContaining({
                        url: 'https://example.test/dashboard',
                    }),
                }),
            ],
        });
    });

    it('keeps the injected blob URL sanitizer in parity with the protocol egress owner', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsScript).toBeTypeOf('function');
        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsScript || !mod.parseInjectedBrowserDiagnosticsMessage) return;

        for (const vector of SANITIZE_URL_PARITY_VECTORS) {
            const script = mod.buildInjectedBrowserDiagnosticsScript({
                ...expectedCollector,
                version: '1.0.0',
            });
            const postedMessages = executeInjectedDiagnosticsScript(script, {
                locationHref: vector,
                performanceEntries: [
                    {
                        name: vector,
                        initiatorType: 'script',
                        duration: 1,
                    },
                ],
                afterRun: ({ dispatchWindowEvent }) => {
                    dispatchWindowEvent('load');
                },
            });
            const rawEvents = postedMessages.flatMap((message) => {
                const raw = JSON.parse(message) as { events?: readonly (Readonly<Record<string, unknown>> & {
                    data?: Record<string, unknown>;
                })[] };
                return Array.isArray(raw.events) ? [...raw.events] : [];
            });
            const events = postedMessages.flatMap((message) => {
                const parsed = mod.parseInjectedBrowserDiagnosticsMessage?.(message, expectedCollector);
                expect(parsed).toMatchObject({ ok: true });
                return parsed?.events ? [...parsed.events] : [];
            });
            const rawSnapshot = rawEvents.find((event) => event.kind === 'pageInfo.snapshot');
            const rawResources = rawEvents.find((event) => event.kind === 'resources.snapshot');
            const snapshot = events.find((event) => event.kind === 'pageInfo.snapshot');
            const resources = events.find((event) => event.kind === 'resources.snapshot');

            expect(rawSnapshot?.data?.url).toBe(stripBrowserDiagnosticUrlValues(vector));
            expect((rawResources?.data?.entries as readonly Record<string, unknown>[] | undefined)?.[0]?.name)
                .toBe(stripBrowserDiagnosticUrlValues(vector));
            expect(snapshot?.data?.url).toBe(stripBrowserDiagnosticUrlValues(vector));
            expect((resources?.data?.entries as readonly Record<string, unknown>[] | undefined)?.[0]?.name)
                .toBe(stripBrowserDiagnosticUrlValues(vector));
        }
    });

    it('drops raw console and page error text from injected diagnostics before storage', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.parseInjectedBrowserDiagnosticsMessage) return;

        const parsed = mod.parseInjectedBrowserDiagnosticsMessage(batch({
            events: [
                {
                    v: 1,
                    eventId: 'evt_console_redacted_1',
                    browserSessionId: expectedCollector.browserSessionId,
                    viewId: expectedCollector.viewId,
                    navigationGeneration: expectedCollector.navigationGeneration,
                    capturedAtMs: 2_000,
                    family: 'console',
                    kind: 'console.entry',
                    fidelity: 'injectedPage',
                    trusted: false,
                    collector: {
                        collectorId: expectedCollector.collectorId,
                        nonce: expectedCollector.nonce,
                        version: '1.0.0',
                    },
                    data: {
                        level: 'error',
                        textPreview: 'token=secret',
                    },
                    redaction: {
                        level: 'metadataOnly',
                    },
                },
                {
                    v: 1,
                    eventId: 'evt_page_error_redacted_1',
                    browserSessionId: expectedCollector.browserSessionId,
                    viewId: expectedCollector.viewId,
                    navigationGeneration: expectedCollector.navigationGeneration,
                    capturedAtMs: 2_001,
                    family: 'pageError',
                    kind: 'pageError.thrown',
                    fidelity: 'injectedPage',
                    trusted: false,
                    collector: {
                        collectorId: expectedCollector.collectorId,
                        nonce: expectedCollector.nonce,
                        version: '1.0.0',
                    },
                    data: {
                        textPreview: 'password=secret',
                    },
                    redaction: {
                        level: 'metadataOnly',
                    },
                },
            ],
        }), expectedCollector);

        expect(parsed).toMatchObject({
            ok: true,
            events: [
                expect.objectContaining({
                    data: {
                        level: 'error',
                        textAvailable: true,
                    },
                    redaction: expect.objectContaining({
                        level: 'valuesRedacted',
                    }),
                }),
                expect.objectContaining({
                    data: {
                        textAvailable: true,
                    },
                    redaction: expect.objectContaining({
                        level: 'valuesRedacted',
                    }),
                }),
            ],
        });
        expect(JSON.stringify(parsed)).not.toContain('secret');
        expect(JSON.stringify(parsed)).not.toContain('password');
        expect(JSON.stringify(parsed)).not.toContain('token=');
    });

    it('preserves length-capped console text for the local owner when value capture is enabled', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.parseInjectedBrowserDiagnosticsMessage) return;

        const parsed = mod.parseInjectedBrowserDiagnosticsMessage(batch({
            events: [
                {
                    v: 1,
                    eventId: 'evt_console_owner_1',
                    browserSessionId: expectedCollector.browserSessionId,
                    viewId: expectedCollector.viewId,
                    navigationGeneration: expectedCollector.navigationGeneration,
                    capturedAtMs: 3_000,
                    family: 'console',
                    kind: 'console.entry',
                    fidelity: 'injectedPage',
                    trusted: false,
                    collector: {
                        collectorId: expectedCollector.collectorId,
                        nonce: expectedCollector.nonce,
                        version: '1.0.0',
                    },
                    data: {
                        level: 'log',
                        argCount: 1,
                        textAvailable: true,
                        text: 'visible owner console line',
                    },
                    redaction: {
                        level: 'none',
                    },
                },
            ],
        }), expectedCollector, { consoleValueCapture: true });

        expect(parsed).toMatchObject({
            ok: true,
            events: [
                expect.objectContaining({
                    data: expect.objectContaining({
                        level: 'log',
                        text: 'visible owner console line',
                    }),
                    redaction: expect.objectContaining({ level: 'none' }),
                }),
            ],
        });
    });

    it('still strips console text when value capture is NOT enabled (fail-closed default)', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.parseInjectedBrowserDiagnosticsMessage) return;

        const parsed = mod.parseInjectedBrowserDiagnosticsMessage(batch({
            events: [
                {
                    v: 1,
                    eventId: 'evt_console_default_1',
                    browserSessionId: expectedCollector.browserSessionId,
                    viewId: expectedCollector.viewId,
                    navigationGeneration: expectedCollector.navigationGeneration,
                    capturedAtMs: 3_001,
                    family: 'console',
                    kind: 'console.entry',
                    fidelity: 'injectedPage',
                    trusted: false,
                    collector: {
                        collectorId: expectedCollector.collectorId,
                        nonce: expectedCollector.nonce,
                        version: '1.0.0',
                    },
                    data: {
                        level: 'log',
                        argCount: 1,
                        textAvailable: true,
                        text: 'secret-owner-line',
                    },
                    redaction: { level: 'none' },
                },
            ],
        }), expectedCollector);

        expect(parsed.ok).toBe(true);
        expect(JSON.stringify(parsed)).not.toContain('secret-owner-line');
        if (parsed.ok && parsed.events) {
            expect(parsed.events[0]?.redaction.level).toBe('valuesRedacted');
            expect(parsed.events[0]?.data.text).toBeUndefined();
        }
    });

    it('emits length-capped console text from the in-page collector when owner value capture is set', async () => {
        const mod = await loadInjectedPageModule();
        expect(mod?.buildInjectedBrowserDiagnosticsScript).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsScript) return;

        const script = mod.buildInjectedBrowserDiagnosticsScript({
            ...expectedCollector,
            version: '1.0.0',
            webPostMessageTargetOrigin: 'https://owner.example.test',
            ownerConsoleValueCapture: true,
        });

        const longText = 'y'.repeat(5_000);
        const messages = executeInjectedDiagnosticsScript(script, {
            afterRun: ({ console: pageConsole }) => {
                pageConsole.log('hello owner', longText);
            },
        });

        const consoleMessage = messages
            .map((raw) => JSON.parse(raw) as { events?: { kind?: string; data?: { text?: string }; redaction?: { level?: string; truncated?: boolean } }[] })
            .flatMap((payload) => payload.events ?? [])
            .find((event) => event.kind === 'console.entry');

        expect(consoleMessage).toBeDefined();
        expect(typeof consoleMessage?.data?.text).toBe('string');
        expect(consoleMessage?.data?.text).toContain('hello owner');
        expect((consoleMessage?.data?.text ?? '').length).toBeLessThanOrEqual(4096);
        expect(consoleMessage?.redaction?.level).toBe('none');
        expect(consoleMessage?.redaction?.truncated).toBe(true);
    });

    it('omits console text from the in-page collector when owner value capture is unset', async () => {
        const mod = await loadInjectedPageModule();
        if (!mod?.buildInjectedBrowserDiagnosticsScript) return;

        const script = mod.buildInjectedBrowserDiagnosticsScript({
            ...expectedCollector,
            version: '1.0.0',
            webPostMessageTargetOrigin: 'https://owner.example.test',
        });

        const messages = executeInjectedDiagnosticsScript(script, {
            afterRun: ({ console: pageConsole }) => {
                pageConsole.log('do-not-capture-this');
            },
        });

        expect(JSON.stringify(messages)).not.toContain('do-not-capture-this');
        const consoleMessage = messages
            .map((raw) => JSON.parse(raw) as { events?: { kind?: string; data?: Record<string, unknown>; redaction?: { level?: string } }[] })
            .flatMap((payload) => payload.events ?? [])
            .find((event) => event.kind === 'console.entry');
        expect(consoleMessage?.data?.text).toBeUndefined();
        expect(consoleMessage?.redaction?.level).toBe('valuesRedacted');
    });

    it('drops raw injected network failure identifiers and error text before storage', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.parseInjectedBrowserDiagnosticsMessage) return;

        const parsed = mod.parseInjectedBrowserDiagnosticsMessage(batch({
            events: [
                {
                    v: 1,
                    eventId: 'evt_network_secret_1',
                    browserSessionId: expectedCollector.browserSessionId,
                    viewId: expectedCollector.viewId,
                    navigationGeneration: expectedCollector.navigationGeneration,
                    capturedAtMs: 2_002,
                    family: 'network',
                    kind: 'network.failed',
                    fidelity: 'injectedPage',
                    trusted: false,
                    collector: {
                        collectorId: expectedCollector.collectorId,
                        nonce: expectedCollector.nonce,
                        version: '1.0.0',
                    },
                    data: {
                        requestId: 'request_token_secret',
                        errorCode: 'Failed https://preview.example.test/app?token=secret',
                    },
                    redaction: {
                        level: 'metadataOnly',
                    },
                },
            ],
        }), expectedCollector);

        expect(parsed).toMatchObject({
            ok: true,
            events: [
                expect.objectContaining({
                    data: expect.objectContaining({
                        requestAvailable: true,
                        errorAvailable: true,
                    }),
                    redaction: expect.objectContaining({
                        level: 'valuesRedacted',
                    }),
                }),
            ],
        });
        expect(JSON.stringify(parsed)).not.toContain('secret');
        expect(JSON.stringify(parsed)).not.toContain('token');
        expect(JSON.stringify(parsed)).not.toContain('preview.example.test');
    });

    it('builds a nonce-bearing injected script with teardown and bounded payload hooks', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsScript).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsScript) return;

        const script = mod.buildInjectedBrowserDiagnosticsScript({
            ...expectedCollector,
            version: '1.0.0',
        });

        expect(script).toContain('"nonce":"nonce_1"');
        expect(script).toContain('__happierBrowserDiagnostics');
        expect(script).toContain('teardown');
        expect(script).toContain('256 * 1024');
        expect(script).not.toContain('errorCode: preview(error)');
        expect(script).not.toContain("postMessage(serialized, '*')");
    });

    it('delivers collector envelopes over the Wry window.ipc channel when desktopIpcDelivery is set', async () => {
        const mod = await loadInjectedPageModule();
        if (!mod?.buildInjectedBrowserDiagnosticsScript) return;

        // Without the flag the collector uses the web/RN transports only; the Wry ipc branch is opt-in.
        const webScript = mod.buildInjectedBrowserDiagnosticsScript({ ...expectedCollector, version: '1.0.0' });
        expect(webScript).not.toContain('"desktopIpcDelivery":true');

        const desktopScript = mod.buildInjectedBrowserDiagnosticsScript({
            ...expectedCollector,
            version: '1.0.0',
            desktopIpcDelivery: true,
        });
        expect(desktopScript).toContain('"desktopIpcDelivery":true');
        expect(desktopScript).toContain('window.ipc.postMessage');
    });

    it('installs diagnostics as one module of the shared injected browser runtime host', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsScript).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsScript) return;

        const script = mod.buildInjectedBrowserDiagnosticsScript({
            ...expectedCollector,
            version: '1.0.0',
        });

        expect(script).toContain('__happierBrowserRuntime');
        expect(script).toContain('modules.diagnostics');
        expect(script).not.toContain('var previous = window.__happierBrowserDiagnostics');

        executeInjectedDiagnosticsScript(script, {
            afterRun: ({ window }) => {
                const runtime = window.__happierBrowserRuntime as {
                    modules?: {
                        diagnostics?: unknown;
                    };
                    teardown?: () => void;
                } | undefined;
                expect(runtime?.modules?.diagnostics).toBe(window.__happierBrowserDiagnostics);
                expect(runtime?.teardown).toBeTypeOf('function');
            },
        });
    });

    it('emits schema-bound storage and element availability sentinels without page-owned values', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsScript).toBeTypeOf('function');
        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsScript || !mod.parseInjectedBrowserDiagnosticsMessage) return;

        const script = mod.buildInjectedBrowserDiagnosticsScript({
            ...expectedCollector,
            version: '1.0.0',
        });
        const postedMessages = executeInjectedDiagnosticsScript(script);
        const events = postedMessages.flatMap((message) => {
            const parsed = mod.parseInjectedBrowserDiagnosticsMessage?.(message, expectedCollector);
            expect(parsed).toMatchObject({ ok: true });
            return parsed?.events ? [...parsed.events] : [];
        });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                family: 'elements',
                kind: 'elements.snapshot',
                data: {},
                redaction: expect.objectContaining({
                    level: 'metadataOnly',
                }),
            }),
            expect.objectContaining({
                family: 'storage',
                kind: 'storage.availability',
                data: {},
                redaction: expect.objectContaining({
                    level: 'metadataOnly',
                }),
            }),
        ]));
        expect(JSON.stringify(events)).not.toContain('secret');
        expect(JSON.stringify(events)).not.toContain('token=');
    });

    it('inventories storage key/value entries for the local owner when value capture is enabled', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsScript).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsScript || !mod.parseInjectedBrowserDiagnosticsMessage) return;

        const localEntries: Record<string, string> = {
            theme: 'super-secret-value',
            lastRoute: 'another-secret-value',
        };
        const localKeys = Object.keys(localEntries);
        const localStorageMock: FakeDiagnosticsStorage & Record<string, string> = Object.assign(
            { ...localEntries },
            {
                get length() {
                    return localKeys.length;
                },
                key: (index: number) => localKeys[index] ?? null,
                getItem: (key: string) => localEntries[key] ?? null,
            },
        );

        const script = mod.buildInjectedBrowserDiagnosticsScript({
            ...expectedCollector,
            version: '1.0.0',
            ownerDiagnosticsValueCapture: true,
        });
        const postedMessages = executeInjectedDiagnosticsScript(script, {
            localStorage: localStorageMock,
            sessionStorage: Object.assign(
                { sessionKey: 'session-secret' },
                {
                    get length() {
                        return 1;
                    },
                    key: (index: number) => (index === 0 ? 'sessionKey' : null),
                    getItem: (key: string) => (key === 'sessionKey' ? 'session-secret' : null),
                },
            ),
        });
        const events = postedMessages.flatMap((message) => {
            const parsed = mod.parseInjectedBrowserDiagnosticsMessage?.(message, expectedCollector, { valueCapture: true });
            expect(parsed).toMatchObject({ ok: true });
            return parsed?.events ? [...parsed.events] : [];
        });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                family: 'storage',
                kind: 'storage.keyInventory',
                data: expect.objectContaining({
                    storageType: 'localStorage',
                    keyCount: 2,
                    keys: expect.arrayContaining(['theme', 'lastRoute']),
                    entries: expect.arrayContaining([
                        { key: 'theme', value: 'super-secret-value', valueTruncated: false },
                        { key: 'lastRoute', value: 'another-secret-value', valueTruncated: false },
                    ]),
                }),
                redaction: expect.objectContaining({ level: 'none' }),
            }),
            expect.objectContaining({
                family: 'storage',
                kind: 'storage.keyInventory',
                data: expect.objectContaining({
                    storageType: 'sessionStorage',
                    keys: ['sessionKey'],
                    entries: [{ key: 'sessionKey', value: 'session-secret', valueTruncated: false }],
                }),
            }),
        ]));
        // Agent/remote egress strips these owner-only values; this local parse keeps them for the owner.
        const serialized = JSON.stringify(events);
        expect(serialized).toContain('super-secret-value');
        expect(serialized).toContain('another-secret-value');
        expect(serialized).toContain('session-secret');
    });

    it('captures sendBeacon metadata (sanitized url + queued byte count) without the payload', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsScript).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsScript || !mod.parseInjectedBrowserDiagnosticsMessage) return;

        let beaconReached = false;
        const navigatorMock: FakeDiagnosticsNavigator = {
            sendBeacon: (_url: string, _data?: unknown) => {
                beaconReached = true;
                return true;
            },
        };

        const script = mod.buildInjectedBrowserDiagnosticsScript({ ...expectedCollector, version: '1.0.0' });
        const postedMessages = executeInjectedDiagnosticsScript(script, {
            navigator: navigatorMock,
            afterRun: ({ window }) => {
                const beacon = window.navigator?.sendBeacon;
                expect(beacon).toBeTypeOf('function');
                beacon?.('https://telemetry.example.test/collect?token=secret#frag', 'super-secret-payload');
                expect(beaconReached).toBe(true);
            },
        });
        const events = postedMessages.flatMap((message) => {
            const parsed = mod.parseInjectedBrowserDiagnosticsMessage?.(message, expectedCollector);
            expect(parsed).toMatchObject({ ok: true });
            return parsed?.events ? [...parsed.events] : [];
        });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                family: 'network',
                kind: 'network.sendBeacon',
                data: expect.objectContaining({
                    url: 'https://telemetry.example.test/collect',
                    bytesQueued: 'super-secret-payload'.length,
                    accepted: true,
                }),
                redaction: expect.objectContaining({ level: 'metadataOnly' }),
            }),
        ]));
        const serialized = JSON.stringify(events);
        expect(serialized).not.toContain('super-secret-payload');
        expect(serialized).not.toContain('token=secret');
    });

    it('emits a DOM structural snapshot (counts only, no page text or markup)', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsScript).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsScript || !mod.parseInjectedBrowserDiagnosticsMessage) return;

        const leaf: FakeDiagnosticsNode = { nodeType: 1, children: [] };
        const documentElement: FakeDiagnosticsNode = {
            nodeType: 1,
            children: [
                { nodeType: 1, children: [leaf, leaf] },
                { nodeType: 1, children: [] },
            ],
        };

        const script = mod.buildInjectedBrowserDiagnosticsScript({ ...expectedCollector, version: '1.0.0' });
        const postedMessages = executeInjectedDiagnosticsScript(script, {
            document: { documentElement, readyState: 'complete' },
        });
        const events = postedMessages.flatMap((message) => {
            const parsed = mod.parseInjectedBrowserDiagnosticsMessage?.(message, expectedCollector);
            expect(parsed).toMatchObject({ ok: true });
            return parsed?.events ? [...parsed.events] : [];
        });

        const snapshot = events.find((event) => event.kind === 'pageInfo.domSnapshot');
        expect(snapshot).toBeDefined();
        expect(snapshot).toMatchObject({
            family: 'pageInfo',
            kind: 'pageInfo.domSnapshot',
            redaction: expect.objectContaining({ level: 'metadataOnly' }),
        });
        const data = snapshot?.data as Record<string, unknown> | undefined;
        expect(typeof data?.elementCount).toBe('number');
        expect(typeof data?.maxDepth).toBe('number');
        expect(JSON.stringify(snapshot)).not.toContain('Dashboard with sensitive values');
    });

    it('captures XMLHttpRequest metadata without page-owned payloads or query values', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsScript).toBeTypeOf('function');
        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsScript || !mod.parseInjectedBrowserDiagnosticsMessage) return;

        class FakeXMLHttpRequest implements FakeDiagnosticsXMLHttpRequest {
            static readonly DONE = 4;

            status = 201;
            private readonly listeners = new Map<string, Set<FakeWindowEventListener>>();

            open(_method: string, _url: string): void {
                return undefined;
            }

            send(_body?: unknown): void {
                return undefined;
            }

            addEventListener(type: string, listener: FakeWindowEventListener): void {
                const typeListeners = this.listeners.get(type) ?? new Set<FakeWindowEventListener>();
                typeListeners.add(listener);
                this.listeners.set(type, typeListeners);
            }

            removeEventListener(type: string, listener: FakeWindowEventListener): void {
                this.listeners.get(type)?.delete(listener);
            }

            dispatchForTest(type: string): void {
                this.listeners.get(type)?.forEach((listener) => listener());
            }
        }

        const script = mod.buildInjectedBrowserDiagnosticsScript({
            ...expectedCollector,
            version: '1.0.0',
        });
        const postedMessages = executeInjectedDiagnosticsScript(script, {
            XMLHttpRequest: FakeXMLHttpRequest,
            afterRun: ({ window }) => {
                const Xhr = window.XMLHttpRequest;
                expect(Xhr).toBeTypeOf('function');
                if (!Xhr) return;
                const xhr = new Xhr();
                expect(xhr instanceof Xhr).toBe(true);
                expect(Xhr.DONE).toBe(4);
                xhr.open('POST', 'https://api.example.test/items?token=secret#fragment');
                xhr.send('secret request body');
                xhr.dispatchForTest('loadend');
            },
        });
        expect(JSON.stringify(postedMessages)).not.toContain('secret');
        expect(JSON.stringify(postedMessages)).not.toContain('token=');
        const events = postedMessages.flatMap((message) => {
            const parsed = mod.parseInjectedBrowserDiagnosticsMessage?.(message, expectedCollector);
            expect(parsed).toMatchObject({ ok: true });
            return parsed?.events ? [...parsed.events] : [];
        });

        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                family: 'network',
                kind: 'network.requestStarted',
                data: expect.objectContaining({
                    url: 'https://api.example.test/items',
                    method: 'POST',
                }),
                redaction: expect.objectContaining({
                    level: 'metadataOnly',
                }),
            }),
            expect.objectContaining({
                family: 'network',
                kind: 'network.finished',
                data: expect.objectContaining({
                    statusCode: 201,
                }),
                redaction: expect.objectContaining({
                    level: 'metadataOnly',
                }),
            }),
        ]));
        expect(JSON.stringify(events)).not.toContain('secret');
        expect(JSON.stringify(events)).not.toContain('token=');
        expect(JSON.stringify(events)).not.toContain('request body');
    });

    it('captures XMLHttpRequest headers and bounded bodies for the local owner only', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsScript).toBeTypeOf('function');
        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsScript || !mod.parseInjectedBrowserDiagnosticsMessage) return;

        class FakeXMLHttpRequest implements FakeDiagnosticsXMLHttpRequest {
            status = 202;
            responseText = '{"ok":true}';
            private readonly listeners = new Map<string, Set<FakeWindowEventListener>>();
            private readonly requestHeaders = new Map<string, string>();

            open(_method: string, _url: string): void {
                return undefined;
            }

            setRequestHeader(name: string, value: string): void {
                this.requestHeaders.set(name, value);
            }

            send(_body?: unknown): void {
                return undefined;
            }

            getAllResponseHeaders(): string {
                return [
                    'content-type: application/json',
                    'authorization: Bearer response-secret',
                    'sec-websocket-protocol: base64url.bearer.authorization.k8s.io.response-secret',
                    'x-request-id: res-1',
                ].join('\r\n');
            }

            addEventListener(type: string, listener: FakeWindowEventListener): void {
                const typeListeners = this.listeners.get(type) ?? new Set<FakeWindowEventListener>();
                typeListeners.add(listener);
                this.listeners.set(type, typeListeners);
            }

            removeEventListener(type: string, listener: FakeWindowEventListener): void {
                this.listeners.get(type)?.delete(listener);
            }

            dispatchForTest(type: string): void {
                this.listeners.get(type)?.forEach((listener) => listener());
            }
        }

        const script = mod.buildInjectedBrowserDiagnosticsScript({
            ...expectedCollector,
            version: '1.0.0',
            ownerDiagnosticsValueCapture: true,
        });
        const postedMessages = executeInjectedDiagnosticsScript(script, {
            XMLHttpRequest: FakeXMLHttpRequest,
            afterRun: ({ window }) => {
                const Xhr = window.XMLHttpRequest;
                expect(Xhr).toBeTypeOf('function');
                if (!Xhr) return;
                const xhr = new Xhr();
                xhr.open('POST', 'https://api.example.test/items?token=secret#fragment');
                xhr.setRequestHeader?.('content-type', 'application/json');
                xhr.setRequestHeader?.('authorization', 'Bearer request-secret');
                xhr.setRequestHeader?.('sec-websocket-protocol', 'base64url.bearer.authorization.k8s.io.request-secret');
                xhr.send('local-owner-request-body');
                xhr.dispatchForTest('loadend');
            },
        });
        const events = postedMessages.flatMap((message) => {
            const parsed = mod.parseInjectedBrowserDiagnosticsMessage?.(message, expectedCollector, { valueCapture: true });
            expect(parsed).toMatchObject({ ok: true });
            return parsed?.events ? [...parsed.events] : [];
        });

        const response = events.find((event) => event.kind === 'network.response');
        expect(response).toMatchObject({
            data: expect.objectContaining({
                method: 'POST',
                statusCode: 202,
                requestHeaders: { 'content-type': 'application/json' },
                responseHeaders: { 'content-type': 'application/json', 'x-request-id': 'res-1' },
                requestBodyText: 'local-owner-request-body',
                responseBodyText: '{"ok":true}',
            }),
            redaction: expect.objectContaining({ level: 'none' }),
        });
        expect(JSON.stringify(events)).not.toContain('request-secret');
        expect(JSON.stringify(events)).not.toContain('response-secret');
        expect(JSON.stringify(events)).not.toContain('sec-websocket-protocol');
        expect(JSON.stringify(events)).not.toContain('token=secret');
    });

    it('captures fetch headers and bounded bodies for the local owner only', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsScript).toBeTypeOf('function');
        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsScript || !mod.parseInjectedBrowserDiagnosticsMessage) return;

        const script = mod.buildInjectedBrowserDiagnosticsScript({
            ...expectedCollector,
            version: '1.0.0',
            ownerDiagnosticsValueCapture: true,
        });
        const postedMessages = executeInjectedDiagnosticsScript(script, {
            fetch: () => Promise.resolve({
                status: 203,
                headers: {
                    forEach(callback: (value: string, name: string) => void): void {
                        callback('application/json', 'content-type');
                        callback('Bearer response-secret', 'authorization');
                        callback('base64url.bearer.authorization.k8s.io.response-secret', 'sec-websocket-protocol');
                        callback('fetch-res-1', 'x-request-id');
                    },
                },
                clone() {
                    let didRead = false;
                    return {
                        body: {
                            getReader() {
                                return {
                                    read: () => {
                                        if (didRead) return Promise.resolve({ done: true });
                                        didRead = true;
                                        return Promise.resolve({
                                            done: false,
                                            value: new TextEncoder().encode('{"fetch":true}'),
                                        });
                                    },
                                };
                            },
                        },
                    };
                },
            }),
            afterRun: ({ window }) => {
                void window.fetch?.('https://api.example.test/fetch?token=secret#fragment', {
                    method: 'PUT',
                    headers: {
                        'content-type': 'application/json',
                        authorization: 'Bearer request-secret',
                        'sec-websocket-protocol': 'base64url.bearer.authorization.k8s.io.request-secret',
                    },
                    body: 'fetch-owner-request-body',
                });
            },
        });

        await new Promise((resolve) => setTimeout(resolve, 0));

        const events = postedMessages.flatMap((message) => {
            const parsed = mod.parseInjectedBrowserDiagnosticsMessage?.(message, expectedCollector, { valueCapture: true });
            expect(parsed).toMatchObject({ ok: true });
            return parsed?.events ? [...parsed.events] : [];
        });

        const response = events.find((event) => event.kind === 'network.response');
        expect(response).toMatchObject({
            data: expect.objectContaining({
                method: 'PUT',
                statusCode: 203,
                requestHeaders: { 'content-type': 'application/json' },
                responseHeaders: { 'content-type': 'application/json', 'x-request-id': 'fetch-res-1' },
                requestBodyText: 'fetch-owner-request-body',
                responseBodyText: '{"fetch":true}',
            }),
            redaction: expect.objectContaining({ level: 'none' }),
        });
        expect(JSON.stringify(events)).not.toContain('request-secret');
        expect(JSON.stringify(events)).not.toContain('response-secret');
        expect(JSON.stringify(events)).not.toContain('sec-websocket-protocol');
        expect(JSON.stringify(events)).not.toContain('token=secret');
    });

    it('captures only a bounded fetch response prefix without fully buffering via clone.text', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsScript).toBeTypeOf('function');
        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsScript || !mod.parseInjectedBrowserDiagnosticsMessage) return;

        const encoder = new TextEncoder();
        let textCallCount = 0;
        let readCallCount = 0;
        let cancelCallCount = 0;
        const script = mod.buildInjectedBrowserDiagnosticsScript({
            ...expectedCollector,
            version: '1.0.0',
            ownerDiagnosticsValueCapture: true,
        });
        const postedMessages = executeInjectedDiagnosticsScript(script, {
            fetch: () => Promise.resolve({
                status: 204,
                headers: {
                    forEach(callback: (value: string, name: string) => void): void {
                        callback('application/json', 'content-type');
                    },
                },
                clone() {
                    return {
                        body: {
                            getReader() {
                                return {
                                    read: () => {
                                        readCallCount += 1;
                                        return Promise.resolve({
                                            done: false,
                                            value: encoder.encode(`${'a'.repeat(4096)}SHOULD_NOT_APPEAR`),
                                        });
                                    },
                                    cancel: () => {
                                        cancelCallCount += 1;
                                        return Promise.resolve();
                                    },
                                };
                            },
                        },
                        text: () => {
                            textCallCount += 1;
                            return Promise.resolve('fully-buffered-response-should-not-be-read');
                        },
                    };
                },
            }),
            afterRun: ({ window }) => {
                void window.fetch?.('https://api.example.test/large', { method: 'GET' });
            },
        });

        await new Promise((resolve) => setTimeout(resolve, 0));

        const events = postedMessages.flatMap((message) => {
            const parsed = mod.parseInjectedBrowserDiagnosticsMessage?.(message, expectedCollector, { valueCapture: true });
            expect(parsed).toMatchObject({ ok: true });
            return parsed?.events ? [...parsed.events] : [];
        });

        const response = events.find((event) => event.kind === 'network.response');
        expect(response?.data.responseBodyText).toHaveLength(4096);
        expect(response?.data.responseBodyTruncated).toBe(true);
        expect(JSON.stringify(response)).not.toContain('SHOULD_NOT_APPEAR');
        expect(textCallCount).toBe(0);
        expect(readCallCount).toBe(1);
        expect(cancelCallCount).toBe(1);
    });

    it('redacts path-bearing non-http diagnostic URLs at collection time', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsScript).toBeTypeOf('function');
        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsScript || !mod.parseInjectedBrowserDiagnosticsMessage) return;

        const script = mod.buildInjectedBrowserDiagnosticsScript({
            ...expectedCollector,
            version: '1.0.0',
        });
        const postedMessages = executeInjectedDiagnosticsScript(script, {
            locationHref: 'data:text/html,secret-page?token=secret#fragment',
            performanceEntries: [
                {
                    name: 'data:text/javascript,secret-resource?token=secret#bundle',
                    initiatorType: 'script',
                    duration: 12,
                },
            ],
            afterRun: ({ dispatchWindowEvent }) => {
                dispatchWindowEvent('load');
            },
        });
        const events = postedMessages.flatMap((message) => {
            const parsed = mod.parseInjectedBrowserDiagnosticsMessage?.(message, expectedCollector);
            expect(parsed).toMatchObject({ ok: true });
            return parsed?.events ? [...parsed.events] : [];
        });

        expect(JSON.stringify(events)).not.toContain('secret');
        expect(JSON.stringify(events)).not.toContain('token=');
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                family: 'pageInfo',
                kind: 'pageInfo.snapshot',
                data: expect.objectContaining({
                    url: 'data:',
                }),
            }),
            expect.objectContaining({
                family: 'resources',
                kind: 'resources.snapshot',
                data: expect.objectContaining({
                    entries: [
                        expect.objectContaining({
                            name: 'data:',
                            initiatorType: 'script',
                            durationMs: 12,
                        }),
                    ],
                }),
            }),
        ]));
    });

    it('does not emit stale load diagnostics after collector teardown', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsScript).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsScript) return;

        const script = mod.buildInjectedBrowserDiagnosticsScript({
            ...expectedCollector,
            version: '1.0.0',
        });
        const postedMessages = executeInjectedDiagnosticsScript(script, {
            performanceEntries: [
                {
                    name: 'https://cdn.example.test/app.js',
                    initiatorType: 'script',
                    duration: 12,
                },
            ],
            afterRun: ({ window, postedMessages: messagesBeforeTeardown, dispatchWindowEvent }) => {
                const diagnostics = window.__happierBrowserDiagnostics as { teardown?: () => void } | undefined;
                expect(diagnostics?.teardown).toBeTypeOf('function');
                const messageCountBeforeLoad = messagesBeforeTeardown.length;
                diagnostics?.teardown?.();
                dispatchWindowEvent('load');
                expect(messagesBeforeTeardown).toHaveLength(messageCountBeforeLoad);
            },
        });

        expect(postedMessages.length).toBeGreaterThan(0);
    });

    it('rejects wildcard web postMessage target origins for iframe diagnostics', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsScript).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsScript) return;

        const buildScript = mod.buildInjectedBrowserDiagnosticsScript;
        expect(() => buildScript({
            ...expectedCollector,
            version: '1.0.0',
            webPostMessageTargetOrigin: '*',
        })).toThrow('explicit web postMessage target origin');
    });

    it('builds gated eval command scripts for the injected collector', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsEvalCommandScript).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsEvalCommandScript) return;

        const script = mod.buildInjectedBrowserDiagnosticsEvalCommandScript({
            browserSessionId: expectedCollector.browserSessionId,
            collectorId: expectedCollector.collectorId,
            nonce: expectedCollector.nonce,
            version: '1.0.0',
            request: {
                v: 1,
                evalRequestId: 'eval_1',
                viewId: expectedCollector.viewId,
                navigationGeneration: expectedCollector.navigationGeneration,
                tier: 'injectedPage',
                expression: '({ ok: true })',
                timeoutMs: 2_000,
                objectGroupId: 'group_1',
                diagnosticsInteractionEnabled: true,
            },
        });

        expect(script).toContain('__happierBrowserDiagnostics.evaluate');
        expect(script).toContain('"kind":"browser.diagnostics.evalRequest"');
        expect(script).toContain('"diagnosticsInteractionEnabled":true');
        expect(script).not.toContain('</script>');
    });

    it('parses nonce-bound eval results from the injected collector', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.parseInjectedBrowserDiagnosticsMessage) return;

        const parsed = mod.parseInjectedBrowserDiagnosticsMessage(JSON.stringify({
            v: 1,
            kind: 'browser.diagnostics.evalResult',
            browserSessionId: expectedCollector.browserSessionId,
            viewId: expectedCollector.viewId,
            navigationGeneration: expectedCollector.navigationGeneration,
            collector: {
                collectorId: expectedCollector.collectorId,
                nonce: expectedCollector.nonce,
                version: '1.0.0',
            },
            result: {
                v: 1,
                evalRequestId: 'eval_1',
                viewId: expectedCollector.viewId,
                navigationGeneration: expectedCollector.navigationGeneration,
                status: 'completed',
                tier: 'injectedPage',
                audited: true,
                result: {
                    type: 'object',
                    objectId: 'obj_1',
                    className: 'Object',
                    description: 'Object',
                    preview: [{ name: 'ok', valuePreview: 'true' }],
                },
            },
        }), expectedCollector);

        expect(parsed).toMatchObject({
            ok: true,
            evalResult: {
                status: 'completed',
                result: {
                    objectId: 'obj_1',
                    preview: [{ name: 'ok', valuePreview: 'true', truncated: false }],
                },
            },
        });
    });

    it('builds object-property and release command scripts for the injected collector', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsGetPropertiesCommandScript).toBeTypeOf('function');
        expect(mod?.buildInjectedBrowserDiagnosticsReleaseObjectGroupCommandScript).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsGetPropertiesCommandScript || !mod.buildInjectedBrowserDiagnosticsReleaseObjectGroupCommandScript) return;

        const getPropertiesScript = mod.buildInjectedBrowserDiagnosticsGetPropertiesCommandScript({
            browserSessionId: expectedCollector.browserSessionId,
            collectorId: expectedCollector.collectorId,
            nonce: expectedCollector.nonce,
            version: '1.0.0',
            request: {
                v: 1,
                propertyRequestId: 'props_1',
                viewId: expectedCollector.viewId,
                navigationGeneration: expectedCollector.navigationGeneration,
                tier: 'injectedPage',
                objectId: 'obj_1',
                objectGroupId: 'group_1',
                diagnosticsInteractionEnabled: true,
            },
        });
        const releaseScript = mod.buildInjectedBrowserDiagnosticsReleaseObjectGroupCommandScript({
            browserSessionId: expectedCollector.browserSessionId,
            collectorId: expectedCollector.collectorId,
            nonce: expectedCollector.nonce,
            version: '1.0.0',
            request: {
                v: 1,
                releaseRequestId: 'release_1',
                viewId: expectedCollector.viewId,
                navigationGeneration: expectedCollector.navigationGeneration,
                tier: 'injectedPage',
                objectGroupId: 'group_1',
                diagnosticsInteractionEnabled: true,
            },
        });

        expect(getPropertiesScript).toContain('__happierBrowserDiagnostics.getProperties');
        expect(getPropertiesScript).toContain('"kind":"browser.diagnostics.getPropertiesRequest"');
        expect(releaseScript).toContain('__happierBrowserDiagnostics.releaseObjectGroup');
        expect(releaseScript).toContain('"kind":"browser.diagnostics.releaseObjectGroupRequest"');
    });

    it('parses nonce-bound property and release results from the injected collector', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.parseInjectedBrowserDiagnosticsMessage) return;

        const propertiesParsed = mod.parseInjectedBrowserDiagnosticsMessage(JSON.stringify({
            v: 1,
            kind: 'browser.diagnostics.getPropertiesResult',
            browserSessionId: expectedCollector.browserSessionId,
            viewId: expectedCollector.viewId,
            navigationGeneration: expectedCollector.navigationGeneration,
            collector: {
                collectorId: expectedCollector.collectorId,
                nonce: expectedCollector.nonce,
                version: '1.0.0',
            },
            result: {
                v: 1,
                propertyRequestId: 'props_1',
                viewId: expectedCollector.viewId,
                navigationGeneration: expectedCollector.navigationGeneration,
                tier: 'injectedPage',
                status: 'completed',
                audited: true,
                objectId: 'obj_1',
                properties: [
                    {
                        name: 'longText',
                        value: {
                            type: 'string',
                            value: 'x'.repeat(65_536),
                        },
                        enumerable: true,
                    },
                ],
            },
        }), expectedCollector);
        const releaseParsed = mod.parseInjectedBrowserDiagnosticsMessage(JSON.stringify({
            v: 1,
            kind: 'browser.diagnostics.releaseObjectGroupResult',
            browserSessionId: expectedCollector.browserSessionId,
            viewId: expectedCollector.viewId,
            navigationGeneration: expectedCollector.navigationGeneration,
            collector: {
                collectorId: expectedCollector.collectorId,
                nonce: expectedCollector.nonce,
                version: '1.0.0',
            },
            result: {
                v: 1,
                releaseRequestId: 'release_1',
                viewId: expectedCollector.viewId,
                navigationGeneration: expectedCollector.navigationGeneration,
                tier: 'injectedPage',
                status: 'completed',
                audited: true,
                objectGroupId: 'group_1',
            },
        }), expectedCollector);

        expect(propertiesParsed).toMatchObject({
            ok: true,
            propertiesResult: {
                status: 'completed',
                properties: [
                    {
                        name: 'longText',
                        value: {
                            type: 'string',
                            value: 'x'.repeat(65_536),
                        },
                    },
                ],
            },
        });
        expect(releaseParsed).toMatchObject({
            ok: true,
            releaseResult: {
                status: 'completed',
                objectGroupId: 'group_1',
            },
        });
    });

    it('builds element-picker command scripts and parses selected element results', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsElementPickerCommandScript).toBeTypeOf('function');
        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsElementPickerCommandScript || !mod.parseInjectedBrowserDiagnosticsMessage) return;

        const script = mod.buildInjectedBrowserDiagnosticsElementPickerCommandScript({
            browserSessionId: expectedCollector.browserSessionId,
            collectorId: expectedCollector.collectorId,
            nonce: expectedCollector.nonce,
            version: '1.0.0',
            request: {
                v: 1,
                pickerRequestId: 'picker_1',
                viewId: expectedCollector.viewId,
                navigationGeneration: expectedCollector.navigationGeneration,
                tier: 'injectedPage',
                action: 'start',
                diagnosticsInteractionEnabled: true,
            },
        });
        const parsed = mod.parseInjectedBrowserDiagnosticsMessage(JSON.stringify({
            v: 1,
            kind: 'browser.diagnostics.elementPickerResult',
            browserSessionId: expectedCollector.browserSessionId,
            viewId: expectedCollector.viewId,
            navigationGeneration: expectedCollector.navigationGeneration,
            collector: {
                collectorId: expectedCollector.collectorId,
                nonce: expectedCollector.nonce,
                version: '1.0.0',
            },
            result: {
                v: 1,
                pickerRequestId: 'picker_1',
                viewId: expectedCollector.viewId,
                navigationGeneration: expectedCollector.navigationGeneration,
                tier: 'injectedPage',
                status: 'selected',
                audited: true,
                backendNodeRef: 'node_1',
                selectorPath: 'html > body > main:nth-of-type(1)',
                rect: {
                    x: 10,
                    y: 20,
                    width: 300,
                    height: 40,
                },
                accessibleName: 'Run',
            },
        }), expectedCollector);

        expect(script).toContain('__happierBrowserDiagnostics.elementPicker');
        expect(script).toContain('"kind":"browser.diagnostics.elementPickerRequest"');
        expect(parsed).toMatchObject({
            ok: true,
            elementPickerResult: {
                status: 'selected',
                backendNodeRef: 'node_1',
                selectorPath: 'html > body > main:nth-of-type(1)',
            },
        });
    });

    function makeFakeEventTarget(): {
        listeners: Map<string, Set<FakeWindowEventListener>>;
        addEventListener: (type: string, listener: FakeWindowEventListener) => void;
        removeEventListener: (type: string, listener: FakeWindowEventListener) => void;
        dispatchForTest: (type: string, event?: unknown) => void;
    } {
        const listeners = new Map<string, Set<FakeWindowEventListener>>();
        return {
            listeners,
            addEventListener: (type, listener) => {
                const typeListeners = listeners.get(type) ?? new Set<FakeWindowEventListener>();
                typeListeners.add(listener);
                listeners.set(type, typeListeners);
            },
            removeEventListener: (type, listener) => {
                listeners.get(type)?.delete(listener);
            },
            dispatchForTest: (type, event) => {
                listeners.get(type)?.forEach((listener) => listener(event));
            },
        };
    }

    function parseEvents(
        mod: InjectedPageModule,
        postedMessages: readonly string[],
    ): readonly Record<string, unknown>[] {
        return postedMessages.flatMap((message) => {
            const parsed = mod.parseInjectedBrowserDiagnosticsMessage?.(message, expectedCollector);
            expect(parsed).toMatchObject({ ok: true });
            return parsed?.events ? [...parsed.events] : [];
        });
    }

    it('captures WebSocket lifecycle counters without frame payloads', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsScript).toBeTypeOf('function');
        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsScript || !mod.parseInjectedBrowserDiagnosticsMessage) return;

        let createdSocket: (FakeDiagnosticsWebSocket & { listeners: Map<string, Set<FakeWindowEventListener>> }) | null = null;
        class FakeWebSocket {
            private readonly target = makeFakeEventTarget();
            readonly listeners = this.target.listeners;

            constructor(public readonly url: string, public readonly protocols?: string) {
                createdSocket = this;
            }

            addEventListener(type: string, listener: FakeWindowEventListener): void {
                this.target.addEventListener(type, listener);
            }

            removeEventListener(type: string, listener: FakeWindowEventListener): void {
                this.target.removeEventListener(type, listener);
            }

            dispatchForTest(type: string, event?: unknown): void {
                this.target.dispatchForTest(type, event);
            }

            send(_data?: unknown): void {
                return undefined;
            }
        }

        const script = mod.buildInjectedBrowserDiagnosticsScript({ ...expectedCollector, version: '1.0.0' });
        const postedMessages = executeInjectedDiagnosticsScript(script, {
            WebSocket: FakeWebSocket as unknown as FakeDiagnosticsWebSocketConstructor,
            afterRun: ({ window }) => {
                const Ctor = window.WebSocket;
                expect(Ctor).toBeTypeOf('function');
                if (!Ctor) return;
                // Subprotocol seeded with a token-smuggling value to prove it never egresses.
                const socket = new Ctor('wss://realtime.example.test/chat?token=secret#frag', 'base64url.bearer.authorization.k8s.io.secrettoken');
                socket.send('secret outbound frame');
                createdSocket?.dispatchForTest('open');
                createdSocket?.dispatchForTest('message', { data: 'secret inbound frame' });
                createdSocket?.dispatchForTest('close', { code: 1000, wasClean: true });
            },
        });

        const events = parseEvents(mod, postedMessages);
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                family: 'network',
                kind: 'network.websocketOpened',
                // The raw subprotocol value ('chat') must never be surfaced — presence/count only.
                data: expect.objectContaining({ url: 'wss://realtime.example.test/chat', hasProtocol: true, protocolCount: 1 }),
            }),
            expect.objectContaining({
                family: 'network',
                kind: 'network.websocketSummary',
                data: expect.objectContaining({ state: 'open', framesSent: 1, framesReceived: 1, messageCount: 1 }),
            }),
            expect.objectContaining({
                family: 'network',
                kind: 'network.websocketClosed',
                data: expect.objectContaining({ code: 1000, wasClean: true }),
            }),
        ]));
        expect(JSON.stringify(events)).not.toContain('secret');
        expect(JSON.stringify(events)).not.toContain('token=');
        expect(JSON.stringify(events)).not.toContain('outbound');
        expect(JSON.stringify(events)).not.toContain('inbound');
    });

    it('captures EventSource lifecycle counters without stream data', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsScript).toBeTypeOf('function');
        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsScript || !mod.parseInjectedBrowserDiagnosticsMessage) return;

        let createdSource: FakeEventSource | null = null;
        class FakeEventSource {
            private readonly target = makeFakeEventTarget();
            readyState = 1;

            constructor(public readonly url: string) {
                createdSource = this;
            }

            addEventListener(type: string, listener: FakeWindowEventListener): void {
                this.target.addEventListener(type, listener);
            }

            removeEventListener(type: string, listener: FakeWindowEventListener): void {
                this.target.removeEventListener(type, listener);
            }

            dispatchForTest(type: string, event?: unknown): void {
                this.target.dispatchForTest(type, event);
            }
        }

        const script = mod.buildInjectedBrowserDiagnosticsScript({ ...expectedCollector, version: '1.0.0' });
        const postedMessages = executeInjectedDiagnosticsScript(script, {
            EventSource: FakeEventSource as unknown as FakeDiagnosticsEventSourceConstructor,
            afterRun: ({ window }) => {
                const Ctor = window.EventSource;
                expect(Ctor).toBeTypeOf('function');
                if (!Ctor) return;
                new Ctor('https://events.example.test/stream?token=secret');
                createdSource?.dispatchForTest('open');
                createdSource?.dispatchForTest('message', { data: 'secret server event' });
                if (createdSource) createdSource.readyState = 2;
                createdSource?.dispatchForTest('error');
            },
        });

        const events = parseEvents(mod, postedMessages);
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                family: 'network',
                kind: 'network.eventSourceOpened',
                data: expect.objectContaining({ url: 'https://events.example.test/stream' }),
            }),
            expect.objectContaining({
                family: 'network',
                kind: 'network.eventSourceSummary',
                data: expect.objectContaining({ state: 'open', messageCount: 1 }),
            }),
            expect.objectContaining({
                family: 'network',
                kind: 'network.eventSourceClosed',
                data: expect.objectContaining({ state: 'closed' }),
            }),
        ]));
        expect(JSON.stringify(events)).not.toContain('secret');
        expect(JSON.stringify(events)).not.toContain('token=');
    });

    it('emits numeric performance vitals from PerformanceObserver entries', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsScript).toBeTypeOf('function');
        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsScript || !mod.parseInjectedBrowserDiagnosticsMessage) return;

        const observers: { type: string; emit: (entries: readonly unknown[]) => void }[] = [];
        class FakePerformanceObserver {
            constructor(private readonly callback: (list: { getEntries: () => readonly unknown[] }) => void) {}

            observe(observeOptions: { type: string; buffered?: boolean }): void {
                observers.push({
                    type: observeOptions.type,
                    emit: (entries) => this.callback({ getEntries: () => entries }),
                });
            }

            disconnect(): void {
                return undefined;
            }
        }

        const script = mod.buildInjectedBrowserDiagnosticsScript({ ...expectedCollector, version: '1.0.0' });
        const postedMessages = executeInjectedDiagnosticsScript(script, {
            PerformanceObserver: FakePerformanceObserver as unknown as FakeDiagnosticsPerformanceObserverConstructor,
            navigationEntries: [{ responseEnd: 320, domContentLoadedEventEnd: 900, loadEventEnd: 1500 }],
            afterRun: () => {
                observers.find((entry) => entry.type === 'largest-contentful-paint')?.emit([{ startTime: 1234.7 }]);
                observers.find((entry) => entry.type === 'layout-shift')?.emit([{ value: 0.05, hadRecentInput: false }]);
                observers.find((entry) => entry.type === 'longtask')?.emit([{ duration: 70 }, { duration: 80 }]);
            },
        });

        const events = parseEvents(mod, postedMessages);
        const vitals = events.filter((event) => event.kind === 'performance.vitals');
        expect(vitals.length).toBeGreaterThan(0);
        expect(events).toEqual(expect.arrayContaining([
            expect.objectContaining({
                family: 'performance',
                kind: 'performance.vitals',
                data: expect.objectContaining({ lcpMs: 1235 }),
                redaction: expect.objectContaining({ level: 'metadataOnly' }),
            }),
        ]));
        const latest = vitals[vitals.length - 1] as Record<string, unknown>;
        const latestData = latest.data as Record<string, unknown>;
        expect(latestData.longTaskCount).toBe(2);
        expect(latestData.longTaskTotalMs).toBe(150);
        expect(latestData.navResponseEndMs).toBe(320);
    });

    it('emits boolean-only capability probes in the pageInfo family', async () => {
        const mod = await loadInjectedPageModule();

        expect(mod?.buildInjectedBrowserDiagnosticsScript).toBeTypeOf('function');
        expect(mod?.parseInjectedBrowserDiagnosticsMessage).toBeTypeOf('function');
        if (!mod?.buildInjectedBrowserDiagnosticsScript || !mod.parseInjectedBrowserDiagnosticsMessage) return;

        const script = mod.buildInjectedBrowserDiagnosticsScript({ ...expectedCollector, version: '1.0.0' });
        const postedMessages = executeInjectedDiagnosticsScript(script);

        const events = parseEvents(mod, postedMessages);
        const capabilities = events.find((event) => event.kind === 'pageInfo.capabilities');
        expect(capabilities).toBeTruthy();
        expect(capabilities).toMatchObject({
            family: 'pageInfo',
            kind: 'pageInfo.capabilities',
            redaction: expect.objectContaining({ level: 'metadataOnly' }),
        });
        const capabilityData = (capabilities as Record<string, unknown>).data as Record<string, unknown>;
        for (const value of Object.values(capabilityData)) {
            expect(typeof value).toBe('boolean');
        }
    });
});
