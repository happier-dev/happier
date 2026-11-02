import { describe, expect, it } from 'vitest';
import { createBrowserAutomationControlService } from '@/sync/domains/browser/automation/controlService';
import { selectBrowserCopresence } from '@/sync/domains/browser/automation/copresence';
import { createInjectedPageAutomationOwner } from './injectedPageRuntime';
import { createWebIframeAutomationOwner } from './injectedPageRuntime';
import { JSDOM } from 'jsdom';

type InjectedAutomationCommandMessage = Readonly<{
    v: 1;
    kind: 'browser.injectedRuntime.command';
    runtimeId: string;
    collectorId: string;
    nonce: string;
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    commandId: string;
    capabilityVersion: string;
    module: 'automation';
    commandName: string;
    payload: Readonly<Record<string, unknown>>;
}>;

type AutomationRequest = Readonly<{
    v: 1;
    automationRequestId: string;
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    requestedBy: 'agent' | 'plugin' | 'system' | 'user';
    requesterRef: Readonly<{
        kind: string;
        id: string;
    }>;
    actionKind: string;
    timeoutMs: number;
    payload?: Readonly<Record<string, unknown>>;
}>;

type AutomationOwner = Readonly<{
    ownerId: string;
    authority: 'uiLocal' | 'daemon' | 'serverBroker';
    browserSessionId: string;
    viewId: string;
    navigationGeneration: number;
    adapterKind: string;
    fidelity: string;
    trustedInput: boolean;
    supportedActions: readonly string[];
    executeAction: (
        request: AutomationRequest,
        context: Readonly<{ signal: AbortSignal }>,
    ) => Promise<Readonly<{
        automationRequestId?: string;
        status: string;
        errorCode?: string;
        durationMs?: number;
    }>>;
}>;

type InjectedPageAutomationModule = Readonly<{
    buildInjectedBrowserAutomationCommandMessage?: (input: Readonly<{
        browserSessionId: string;
        viewId: string;
        navigationGeneration: number;
        collectorId: string;
        nonce: string;
        capabilityVersion: string;
        commandId: string;
        commandName: string;
        payload?: Readonly<Record<string, unknown>>;
    }>) => InjectedAutomationCommandMessage;
    buildInjectedBrowserAutomationCommandScript?: (input: Readonly<{
        browserSessionId: string;
        viewId: string;
        navigationGeneration: number;
        collectorId: string;
        nonce: string;
        capabilityVersion: string;
        commandId: string;
        commandName: string;
        payload?: Readonly<Record<string, unknown>>;
    }>) => string;
    parseInjectedBrowserAutomationResultMessage?: (
        raw: string,
        expected: Readonly<{
            runtimeId: string;
            browserSessionId: string;
            viewId: string;
            navigationGeneration: number;
            collectorId: string;
            nonce: string;
        }>,
    ) => Readonly<{
        ok: boolean;
        reasonCode?: string;
        result?: Readonly<Record<string, unknown>>;
    }>;
    createInjectedPageAutomationOwner?: (input: Readonly<{
        ownerId: string;
        browserSessionId: string;
        viewId: string;
        navigationGeneration: number;
        adapterKind: string;
        collectorId: string;
        nonce: string;
        capabilityVersion: string;
        supportedActions: readonly string[];
        transport: Readonly<{
            sendCommand: (command: InjectedAutomationCommandMessage, script: string) => void | Promise<void>;
            subscribeToResults: (listener: (raw: string) => void) => () => void;
        }>;
        nowMs: () => number;
    }>) => AutomationOwner;
    createWebIframeAutomationOwner?: (input: Readonly<{
        ownerId: string;
        browserSessionId: string;
        viewId: string;
        navigationGeneration: number;
        adapterKind: string;
        collectorId: string;
        nonce: string;
        capabilityVersion: string;
        supportedActions: readonly string[];
        targetWindow: Readonly<{
            postMessage: (message: string, targetOrigin: string) => void;
        }> | null;
        targetOrigin: string | null;
        subscribeToMessages: (listener: (raw: string) => void) => () => void;
        nowMs: () => number;
    }>) => AutomationOwner;
    createNativeWebViewAutomationOwner?: (input: Readonly<{
        ownerId: string;
        browserSessionId: string;
        viewId: string;
        navigationGeneration: number;
        adapterKind: string;
        collectorId: string;
        nonce: string;
        capabilityVersion: string;
        supportedActions: readonly string[];
        injectJavaScript: (script: string) => void;
        subscribeToMessages: (listener: (raw: string) => void) => () => void;
        nowMs: () => number;
    }>) => AutomationOwner;
}>;

type DiagnosticsModule = Readonly<{
    buildInjectedBrowserDiagnosticsScript?: (input: Readonly<{
        browserSessionId: string;
        viewId: string;
        navigationGeneration: number;
        collectorId: string;
        nonce: string;
        version: string;
    }>) => string;
}>;

const runtimeIdentity = {
    runtimeId: 'browser_session_1:browser_view_1:3',
    browserSessionId: 'browser_session_1',
    viewId: 'browser_view_1',
    navigationGeneration: 3,
    collectorId: 'collector_1',
    nonce: 'nonce_1',
    capabilityVersion: '1.0.0',
} as const;

it('projects nonce-bound target progress while the in-app action is active and clears it on completion', async () => {
    const listeners = new Set<(raw: string) => void>();
    const service = createBrowserAutomationControlService({ nowMs: Date.now });
    const owner = createInjectedPageAutomationOwner({ ...runtimeIdentity, ownerId: 'owner', adapterKind: 'localPreview',
        supportedActions: ['click'], nowMs: Date.now, transport: { sendCommand: () => undefined,
            subscribeToResults: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; } } });
    service.registerOwner(owner);
    const action = service.executeAction(createAutomationRequest({ actionKind: 'click', timeoutMs: 5_000 }));
    const target = { x: 0.5, y: 0.25, width: 0.2, height: 0.1 };
    const presence = () => selectBrowserCopresence({ snapshot: service.getSnapshot(), view: runtimeIdentity });
    try {
        for (const listener of [...listeners]) listener(runtimeResultMessage({ phase: 'target', activeTarget: target }));
        expect(presence()).toMatchObject({ kind: 'agent', activity: 'click', target });
        for (const listener of [...listeners]) listener(runtimeResultMessage({ phase: 'target', activeTarget: { ...target, x: 2 } }));
        expect(presence()).toMatchObject({ target });
        for (const listener of [...listeners]) listener(runtimeResultMessage());
        expect(await action).toMatchObject({ status: 'succeeded' });
        expect(presence()).toMatchObject({ kind: 'idle' });
    } finally { service.closeView(runtimeIdentity); }
});

async function loadAutomationModule(): Promise<InjectedPageAutomationModule | null> {
    const path = './injectedPageRuntime';
    return import(path).catch(() => null) as Promise<InjectedPageAutomationModule | null>;
}

async function loadDiagnosticsModule(): Promise<DiagnosticsModule | null> {
    const path = '../diagnostics/injectedPage';
    return import(path).catch(() => null) as Promise<DiagnosticsModule | null>;
}

function createAutomationRequest(overrides: Partial<AutomationRequest> = {}): AutomationRequest {
    return {
        v: 1,
        automationRequestId: 'automation_request_1',
        browserSessionId: runtimeIdentity.browserSessionId,
        viewId: runtimeIdentity.viewId,
        navigationGeneration: runtimeIdentity.navigationGeneration,
        requestedBy: 'agent',
        requesterRef: {
            kind: 'session',
            id: 'session_1',
        },
        actionKind: 'snapshot',
        timeoutMs: 1_000,
        ...overrides,
    };
}

function runtimeResultMessage(
    overrides: Partial<Readonly<Record<string, unknown>>> = {},
): string {
    return JSON.stringify({
        v: 1,
        kind: 'browser.injectedRuntime.result',
        runtimeId: runtimeIdentity.runtimeId,
        collectorId: runtimeIdentity.collectorId,
        nonce: runtimeIdentity.nonce,
        browserSessionId: runtimeIdentity.browserSessionId,
        viewId: runtimeIdentity.viewId,
        navigationGeneration: runtimeIdentity.navigationGeneration,
        commandId: 'automation_request_1',
        capabilityVersion: runtimeIdentity.capabilityVersion,
        module: 'automation',
        ok: true,
        fidelity: 'injectedPage',
        trusted: false,
        stale: false,
        durationMs: 7,
        data: {
            matched: true,
        },
        ...overrides,
    });
}

describe('injected-page browser automation runtime', () => {
    it.each([false, true])('keeps the saved composer across overlapping agent pointer actions (different frames: %s)', async differentFrames => {
        const dom = new JSDOM('<textarea></textarea><iframe></iframe><iframe></iframe>', { url: 'https://host.test' });
        try {
            const composer = dom.window.document.querySelector('textarea')!;
            const frame = dom.window.document.querySelector('iframe')!;
            const listeners = new Set<(raw: string) => void>();
            const makeOwner = (hostFrame: HTMLIFrameElement) => createWebIframeAutomationOwner({ ...runtimeIdentity, ownerId: 'overlap', adapterKind: 'localPreview',
                supportedActions: ['click'], nowMs: Date.now, hostFrame,
                targetOrigin: 'https://preview.test', targetWindow: { postMessage: () => { hostFrame.focus(); } },
                subscribeToMessages: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
            });
            const owner = makeOwner(frame);
            const secondOwner = differentFrames ? makeOwner(dom.window.document.querySelectorAll('iframe')[1]!) : owner;
            composer.focus();
            const first = owner.executeAction(createAutomationRequest({ actionKind: 'click' }), { signal: new AbortController().signal });
            const second = secondOwner.executeAction(createAutomationRequest({ actionKind: 'click', automationRequestId: 'second' }), { signal: new AbortController().signal });
            for (const receive of [...listeners]) receive(runtimeResultMessage({ commandId: 'second' }));
            expect(await second).toMatchObject({ status: 'succeeded' });
            expect(dom.window.document.activeElement).toBe(composer);
            for (const receive of [...listeners]) receive(runtimeResultMessage());
            expect(await first).toMatchObject({ status: 'succeeded' });
            expect(dom.window.document.activeElement).toBe(composer);
            expect(listeners.size).toBe(0);
        } finally { dom.window.close(); }
    });
    it.each(['agent', 'user'] as const)('preserves composer focus for %s pointer actions only', async requestedBy => {
        const dom = new JSDOM('<textarea></textarea><iframe></iframe><button>Other host control</button>', { url: 'https://host.test' });
        try {
            const document = dom.window.document;
            const composer = document.querySelector('textarea')!;
            const frame = document.querySelector('iframe')!;
            let receive: ((raw: string) => void) | undefined;
            const owner = createWebIframeAutomationOwner({ ...runtimeIdentity, ownerId: 'focus', adapterKind: 'localPreview',
                supportedActions: ['click'], nowMs: Date.now, hostFrame: frame,
                targetOrigin: 'https://preview.test', targetWindow: { postMessage: () => { frame.focus(); } },
                subscribeToMessages: listener => { receive = listener; return () => { receive = undefined; }; },
            });
            composer.focus();
            const pending = owner.executeAction(createAutomationRequest({ actionKind: 'click', requestedBy }), { signal: new AbortController().signal });
            expect(document.activeElement).toBe(frame);
            receive?.(runtimeResultMessage());
            expect(await pending).toMatchObject({ status: 'succeeded' });
            expect(document.activeElement?.tagName).toBe(requestedBy === 'agent' ? 'TEXTAREA' : 'IFRAME');
            composer.focus();
            const next = owner.executeAction(createAutomationRequest({ actionKind: 'click', requestedBy }), { signal: new AbortController().signal });
            const other = document.querySelector('button')!;
            other.focus();
            receive?.(runtimeResultMessage());
            await next;
            expect(document.activeElement).toBe(other);
        } finally { dom.window.close(); }
    });
    it('builds and parses automation commands through the shared injected runtime module', async () => {
        const mod = await loadAutomationModule();

        expect(mod?.buildInjectedBrowserAutomationCommandMessage).toBeTypeOf('function');
        expect(mod?.buildInjectedBrowserAutomationCommandScript).toBeTypeOf('function');
        expect(mod?.parseInjectedBrowserAutomationResultMessage).toBeTypeOf('function');
        if (
            !mod?.buildInjectedBrowserAutomationCommandMessage
            || !mod.buildInjectedBrowserAutomationCommandScript
            || !mod.parseInjectedBrowserAutomationResultMessage
        ) return;

        const command = mod.buildInjectedBrowserAutomationCommandMessage({
            ...runtimeIdentity,
            commandId: 'automation_request_1',
            commandName: 'click',
            payload: {
                locator: {
                    kind: 'css',
                    value: '#run',
                },
            },
        });
        const script = mod.buildInjectedBrowserAutomationCommandScript({
            ...runtimeIdentity,
            commandId: 'automation_request_1',
            commandName: 'click',
            payload: {
                locator: {
                    kind: 'css',
                    value: '#run',
                },
            },
        });
        const parsed = mod.parseInjectedBrowserAutomationResultMessage(runtimeResultMessage(), runtimeIdentity);
        const wrongNonce = mod.parseInjectedBrowserAutomationResultMessage(runtimeResultMessage({
            nonce: 'wrong_nonce',
        }), runtimeIdentity);
        const staleNavigation = mod.parseInjectedBrowserAutomationResultMessage(runtimeResultMessage({
            runtimeId: 'browser_session_1:browser_view_1:2',
            navigationGeneration: 2,
        }), runtimeIdentity);

        expect(command).toMatchObject({
            kind: 'browser.injectedRuntime.command',
            module: 'automation',
            runtimeId: runtimeIdentity.runtimeId,
            collectorId: runtimeIdentity.collectorId,
            nonce: runtimeIdentity.nonce,
            commandName: 'click',
        });
        expect(script).toContain('__happierBrowserRuntime');
        expect(script).toContain('modules.automation');
        expect(script).not.toContain('__happierBrowserAutomation');
        expect(parsed).toMatchObject({
            ok: true,
            result: {
                commandId: 'automation_request_1',
                ok: true,
                fidelity: 'injectedPage',
                trusted: false,
            },
        });
        expect(wrongNonce).toEqual({
            ok: false,
            reasonCode: 'collector_mismatch',
        });
        expect(staleNavigation).toEqual({
            ok: false,
            reasonCode: 'navigation_stale',
        });
    });

    it('creates an injected-page owner that resolves nonce-bound runtime results from a transport', async () => {
        const mod = await loadAutomationModule();

        expect(mod?.createInjectedPageAutomationOwner).toBeTypeOf('function');
        if (!mod?.createInjectedPageAutomationOwner) return;

        let now = 5_000;
        const sentCommands: Array<Readonly<{ command: InjectedAutomationCommandMessage; script: string }>> = [];
        const listeners = new Set<(raw: string) => void>();
        const owner = mod.createInjectedPageAutomationOwner({
            ownerId: 'owner_iframe_1',
            browserSessionId: runtimeIdentity.browserSessionId,
            viewId: runtimeIdentity.viewId,
            navigationGeneration: runtimeIdentity.navigationGeneration,
            adapterKind: 'localPreview',
            collectorId: runtimeIdentity.collectorId,
            nonce: runtimeIdentity.nonce,
            capabilityVersion: runtimeIdentity.capabilityVersion,
            supportedActions: ['snapshot', 'click'],
            nowMs: () => now,
            transport: {
                sendCommand: (command, script) => {
                    sentCommands.push({ command, script });
                },
                subscribeToResults: (listener) => {
                    listeners.add(listener);
                    return () => {
                        listeners.delete(listener);
                    };
                },
            },
        });

        const resultPromise = owner.executeAction(createAutomationRequest({
            automationRequestId: 'automation_request_click_1',
            actionKind: 'click',
            payload: {
                locator: {
                    kind: 'css',
                    value: '#run',
                },
            },
        }), { signal: new AbortController().signal });

        expect(sentCommands).toHaveLength(1);
        expect(sentCommands[0]?.command).toMatchObject({
            commandId: 'automation_request_click_1',
            module: 'automation',
            commandName: 'click',
        });
        expect(sentCommands[0]?.script).toContain('__happierBrowserRuntime');
        expect(sentCommands[0]?.script).not.toContain('__happierBrowserAutomation');

        now += 7;
        listeners.forEach((listener) => {
            listener(runtimeResultMessage({
                commandId: 'automation_request_click_1',
                durationMs: 7,
            }));
        });

        await expect(resultPromise).resolves.toMatchObject({
            automationRequestId: 'automation_request_click_1',
            status: 'succeeded',
            durationMs: 7,
        });
        expect(listeners).toHaveLength(0);
    });

    it('adapts web iframe postMessage and native WebView injection to the shared automation owner', async () => {
        const mod = await loadAutomationModule();

        expect(mod?.createWebIframeAutomationOwner).toBeTypeOf('function');
        expect(mod?.createNativeWebViewAutomationOwner).toBeTypeOf('function');
        if (!mod?.createWebIframeAutomationOwner || !mod.createNativeWebViewAutomationOwner) return;

        const iframeMessages: Array<Readonly<{ message: string; targetOrigin: string }>> = [];
        const iframeListeners = new Set<(raw: string) => void>();
        const iframeOwner = mod.createWebIframeAutomationOwner({
            ownerId: 'owner_web_iframe_1',
            browserSessionId: runtimeIdentity.browserSessionId,
            viewId: runtimeIdentity.viewId,
            navigationGeneration: runtimeIdentity.navigationGeneration,
            adapterKind: 'localPreview',
            collectorId: runtimeIdentity.collectorId,
            nonce: runtimeIdentity.nonce,
            capabilityVersion: runtimeIdentity.capabilityVersion,
            supportedActions: ['snapshot'],
            targetWindow: {
                postMessage: (message, targetOrigin) => {
                    iframeMessages.push({ message, targetOrigin });
                },
            },
            targetOrigin: 'https://preview.example.test',
            subscribeToMessages: (listener) => {
                iframeListeners.add(listener);
                return () => {
                    iframeListeners.delete(listener);
                };
            },
            nowMs: () => 6_000,
        });

        const iframeResult = iframeOwner.executeAction(createAutomationRequest({
            automationRequestId: 'automation_request_iframe_1',
        }), { signal: new AbortController().signal });

        expect(iframeMessages).toHaveLength(1);
        expect(iframeMessages[0]?.targetOrigin).toBe('https://preview.example.test');
        expect(JSON.parse(iframeMessages[0]?.message ?? '{}')).toMatchObject({
            kind: 'browser.injectedRuntime.command',
            module: 'automation',
            commandId: 'automation_request_iframe_1',
        });

        iframeListeners.forEach((listener) => {
            listener(runtimeResultMessage({
                commandId: 'automation_request_iframe_1',
            }));
        });
        await expect(iframeResult).resolves.toMatchObject({
            status: 'succeeded',
        });

        const injectedScripts: string[] = [];
        const nativeListeners = new Set<(raw: string) => void>();
        const nativeOwner = mod.createNativeWebViewAutomationOwner({
            ownerId: 'owner_native_webview_1',
            browserSessionId: runtimeIdentity.browserSessionId,
            viewId: runtimeIdentity.viewId,
            navigationGeneration: runtimeIdentity.navigationGeneration,
            adapterKind: 'hostedPlugin',
            collectorId: runtimeIdentity.collectorId,
            nonce: runtimeIdentity.nonce,
            capabilityVersion: runtimeIdentity.capabilityVersion,
            supportedActions: ['snapshot'],
            injectJavaScript: (script) => {
                injectedScripts.push(script);
            },
            subscribeToMessages: (listener) => {
                nativeListeners.add(listener);
                return () => {
                    nativeListeners.delete(listener);
                };
            },
            nowMs: () => 7_000,
        });

        const nativeResult = nativeOwner.executeAction(createAutomationRequest({
            automationRequestId: 'automation_request_native_1',
            actionKind: 'snapshot',
        }), { signal: new AbortController().signal });

        expect(injectedScripts).toHaveLength(1);
        expect(injectedScripts[0]).toContain('__happierBrowserRuntime');
        expect(injectedScripts[0]).toContain('modules.automation');
        expect(injectedScripts[0]).not.toContain('__happierBrowserAutomation');

        nativeListeners.forEach((listener) => {
            listener(runtimeResultMessage({
                commandId: 'automation_request_native_1',
            }));
        });
        await expect(nativeResult).resolves.toMatchObject({
            status: 'succeeded',
        });
    });

    it('installs automation on the same injected runtime host as diagnostics', async () => {
        const diagnostics = await loadDiagnosticsModule();

        expect(diagnostics?.buildInjectedBrowserDiagnosticsScript).toBeTypeOf('function');
        if (!diagnostics?.buildInjectedBrowserDiagnosticsScript) return;

        const script = diagnostics.buildInjectedBrowserDiagnosticsScript({
            ...runtimeIdentity,
            version: runtimeIdentity.capabilityVersion,
        });

        expect(script).toContain('__happierBrowserRuntime');
        expect(script).toContain('modules.diagnostics');
        expect(script).toContain('modules.automation');
        expect(script).not.toContain('__happierBrowserAutomation');
    });
});
