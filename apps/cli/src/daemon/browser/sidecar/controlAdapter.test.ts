import {
    BrowserCommandDispatchResultV1Schema,
    type BrowserCommandV1,
} from '@happier-dev/protocol/browser/control/v1';
import { describe, expect, it, vi } from 'vitest';
import { createBrowserSidecarCdpControlAdapter, type BrowserSidecarCdpEventSubscriber } from './controlAdapter';
import { createSurfaceInputControl } from '../../surfaces/inputControl';

type SidecarCdpPageHandle = Readonly<{
    targetId: string;
    sessionId?: string;
}>;

type SidecarCdpControlTransport = Readonly<{
    openPage(input: Readonly<{ url: string; focus: boolean }>): Promise<SidecarCdpPageHandle>;
    dispatchPageCommand(input: SidecarCdpPageHandle & Readonly<{
        method: string;
        params?: Record<string, unknown>;
    }>): Promise<unknown>;
    dispatchBrowserCommand(input: Readonly<{
        method: string;
        params?: Record<string, unknown>;
    }>): Promise<unknown>;
}>;

type SidecarViewLifecycleEvent = Readonly<{
    type: 'bound' | 'unbound';
    browserSessionId: string;
    viewId: string;
    sourceDestroyed?: boolean;
}>;

type SidecarControlAdapter = Readonly<{
    adapterKind: 'chromiumSidecar';
    ownsView(input: Readonly<{ browserSessionId: string; viewId: string }>): boolean;
    supportsOpenView(command: Extract<BrowserCommandV1, { kind: 'openView' }>): boolean;
    dispatchCommand(command: BrowserCommandV1): Promise<unknown>;
    subscribeViewLifecycle(listener: (event: SidecarViewLifecycleEvent) => void): () => void;
}>;

type ControlAdapterModule = Readonly<{
    createBrowserSidecarCdpControlAdapter?: (input: Readonly<{
        browserSessionId: string;
        sidecarId: string;
        transport: SidecarCdpControlTransport;
    }>) => SidecarControlAdapter;
}>;

async function loadControlAdapter(): Promise<ControlAdapterModule | null> {
    return import('./controlAdapter') as Promise<ControlAdapterModule | null>;
}

function externalOpenViewCommand(
    overrides: Partial<Extract<BrowserCommandV1, { kind: 'openView' }>> = {},
): Extract<BrowserCommandV1, { kind: 'openView' }> {
    const { focus = true, ...rest } = overrides;
    return {
        kind: 'openView',
        commandId: 'command_open',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        platform: 'web',
        focus,
        target: {
            kind: 'externalUrl',
            targetId: 'target_external_1',
            url: 'https://browser.example.test/start',
        },
        ...rest,
    };
}

function navigateCommand(
    overrides: Partial<Extract<BrowserCommandV1, { kind: 'navigate' }>> = {},
): Extract<BrowserCommandV1, { kind: 'navigate' }> {
    return {
        kind: 'navigate',
        commandId: 'command_navigate',
        browserSessionId: 'browser_session_1',
        viewId: 'view_1',
        url: 'https://browser.example.test/next',
        ...overrides,
    };
}

function createTransport(overrides: Partial<SidecarCdpControlTransport> = {}): SidecarCdpControlTransport {
    return {
        openPage: vi.fn(async () => ({
            targetId: 'cdp_target_secret',
            sessionId: 'cdp_session_secret',
        })),
        dispatchPageCommand: vi.fn(async (input) => {
            if (input.method === 'Page.getNavigationHistory') {
                return {
                    currentIndex: 1,
                    entries: [
                        { id: 10, url: 'https://browser.example.test/back' },
                        { id: 11, url: 'https://browser.example.test/current' },
                        { id: 12, url: 'https://browser.example.test/forward' },
                    ],
                };
            }
            return {};
        }),
        dispatchBrowserCommand: vi.fn(async input => input.method === 'Target.closeTarget' ? { success: true } : {}),
        ...overrides,
    };
}

describe('browser sidecar CDP control adapter', () => {
    it('retains the confidential page binding when an in-flight replacement opens late', async () => {
        const control = createSurfaceInputControl();
        const transport = createTransport();
        const adapter = createBrowserSidecarCdpControlAdapter({
            browserSessionId: 'browser_session_1', sidecarId: 'sidecar_1', transport,
            resolveInputControl: () => control,
        });
        await adapter.dispatchCommand(externalOpenViewCommand());
        let finishOpen!: (page: SidecarCdpPageHandle) => void;
        vi.mocked(transport.openPage).mockImplementationOnce(() => new Promise(resolve => { finishOpen = resolve; }));
        const replacement = adapter.dispatchCommand(externalOpenViewCommand());
        await control.beginConfidentialityHold();
        finishOpen({ targetId: 'replacement_target', sessionId: 'replacement_session' });
        expect(await replacement).toMatchObject({ status: 'failed' });
        expect(adapter.resolvePageHandle({ browserSessionId: 'browser_session_1', viewId: 'view_1' })).toEqual({
            targetId: 'cdp_target_secret', sessionId: 'cdp_session_secret',
        });
        expect(transport.dispatchBrowserCommand).toHaveBeenCalledWith(expect.objectContaining({
            method: 'Target.closeTarget', params: { targetId: 'replacement_target' },
        }));
        expect(await adapter.dispatchCommand(externalOpenViewCommand())).toMatchObject({ status: 'failed' });
        expect(transport.openPage).toHaveBeenCalledTimes(2);
        adapter.dispose();
    });

    it('unbinds every owned view on disposal and rejects a pending open completion', async () => {
        let finishOpen: ((page: SidecarCdpPageHandle) => void) | undefined;
        const transport = createTransport();
        const adapter = createBrowserSidecarCdpControlAdapter({
            browserSessionId: 'browser_session_1', sidecarId: 'sidecar_1', transport,
        });
        const events: SidecarViewLifecycleEvent[] = [];
        adapter.subscribeViewLifecycle(event => events.push(event));
        await adapter.dispatchCommand(externalOpenViewCommand());
        vi.mocked(transport.openPage).mockImplementationOnce(() => new Promise(resolve => { finishOpen = resolve; }));
        const opening = adapter.dispatchCommand(externalOpenViewCommand({ viewId: 'pending' }));
        expect('dispose' in adapter).toBe(true);
        if (!('dispose' in adapter) || typeof adapter.dispose !== 'function') return;
        adapter.dispose();
        finishOpen?.({ targetId: 'late', sessionId: 'late' });
        expect(await opening).toMatchObject({ status: 'failed', error: { code: 'adapter_unavailable' } });
        expect(events).toEqual([
            { type: 'bound', browserSessionId: 'browser_session_1', viewId: 'view_1' },
            { type: 'unbound', browserSessionId: 'browser_session_1', viewId: 'view_1' },
        ]);
        expect(adapter.resolvePageHandle({ browserSessionId: 'browser_session_1', viewId: 'view_1' })).toBeNull();
        expect(adapter.supportsOpenView(externalOpenViewCommand())).toBe(false);
        adapter.dispose();
        expect(events).toHaveLength(2);
    });

    it.each([false, undefined])('does not retire a page or clear confidential observation on unproven close acknowledgement (%s)', async success => {
        const transport = createTransport({ dispatchBrowserCommand: vi.fn(async () => success === undefined ? {} : { success }) });
        const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'browser_session_1', sidecarId: 'sidecar_1', transport });
        const lifecycle: SidecarViewLifecycleEvent[] = [];
        adapter.subscribeViewLifecycle(event => lifecycle.push(event));
        await adapter.dispatchCommand(externalOpenViewCommand());
        expect(await adapter.dispatchCommand({ kind: 'closeView', commandId: 'close', browserSessionId: 'browser_session_1', viewId: 'view_1' }))
            .toMatchObject({ status: 'failed', error: { code: 'adapter_unavailable' } });
        expect(adapter.ownsView({ browserSessionId: 'browser_session_1', viewId: 'view_1' })).toBe(true);
        expect(lifecycle).toEqual([{ type: 'bound', browserSessionId: 'browser_session_1', viewId: 'view_1' }]);
        adapter.dispose();
        expect(lifecycle.at(-1)).toEqual({ type: 'unbound', browserSessionId: 'browser_session_1', viewId: 'view_1' });
    });
    it('publishes engine redirects, title/loading and document generations through the bound view', async () => {
        let listener: BrowserSidecarCdpEventSubscriber | undefined;
        const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'browser_session_1', sidecarId: 'sidecar_1',
            transport: { ...createTransport(), subscribeCdpEvents: callback => { listener = callback; return () => undefined; } },
        });
        const events: unknown[] = [];
        adapter.subscribeBrowserEvents(event => events.push(event));
        const opened = await adapter.dispatchCommand(externalOpenViewCommand());
        expect(opened).toMatchObject({ events: expect.arrayContaining([expect.objectContaining({ kind: 'navigationStateChanged', navigationGeneration: 0 })]) });
        listener?.({ method: 'Page.frameNavigated', sessionId: 'cdp_session_secret', params: { frame: { id: 'sub', parentId: 'main', loaderId: 'sub_loader', url: 'https://child.test/' } } });
        expect(adapter.getNavigationState({ browserSessionId: 'browser_session_1', viewId: 'view_1' })?.navigationGeneration).toBe(0);
        listener?.({ method: 'Page.frameNavigated', sessionId: 'cdp_session_secret', params: { frame: { id: 'main', loaderId: 'document_1', url: 'https://redirect.test/' } } });
        listener?.({ method: 'Target.targetInfoChanged', params: { targetInfo: { targetId: 'cdp_target_secret', title: 'Redirected', url: 'https://redirect.test/' } } });
        listener?.({ method: 'Page.frameStoppedLoading', sessionId: 'cdp_session_secret', params: { frameId: 'main' } });
        expect(events.at(-1)).toMatchObject({ kind: 'navigationStateChanged', currentUrl: 'https://redirect.test/', title: 'Redirected', loadingState: 'ready', navigationGeneration: 1 });
        listener?.({ method: 'Page.frameNavigated', sessionId: 'cdp_session_secret', params: { frame: { id: 'main', loaderId: 'document_2', url: 'https://redirect.test/' } } });
        expect(adapter.getNavigationState({ browserSessionId: 'browser_session_1', viewId: 'view_1' })?.navigationGeneration).toBe(2);
        await adapter.dispatchCommand({ kind: 'closeView', commandId: 'close', browserSessionId: 'browser_session_1', viewId: 'view_1' });
        const count = events.length;
        listener?.({ method: 'Page.frameNavigated', sessionId: 'cdp_session_secret', params: { frame: { id: 'main', loaderId: 'late', url: 'https://late.test/' } } });
        expect(events).toHaveLength(count);
    });
    it('does not regress a committed redirect when the bootstrap frame tree replies late', async () => {
        let listener!: BrowserSidecarCdpEventSubscriber;
        let releaseTree!: (tree: unknown) => void;
        let entered!: () => void;
        const started = new Promise<void>(resolve => { entered = resolve; });
        const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'browser_session_1', sidecarId: 'sidecar_1',
            transport: { ...createTransport(), subscribeCdpEvents: callback => { listener = callback; return () => undefined; },
                dispatchPageCommand: async command => {
                    if (command.method === 'Page.getFrameTree') { entered(); return new Promise(resolve => { releaseTree = resolve; }); }
                    return {};
                },
            },
        });
        const opening = adapter.dispatchCommand(externalOpenViewCommand());
        await started;
        listener({ method: 'Page.frameNavigated', sessionId: 'cdp_session_secret', params: { frame: { id: 'main', loaderId: 'redirect', url: 'https://redirect.test/' } } });
        releaseTree({ frameTree: { frame: { id: 'main', loaderId: 'initial', url: 'https://browser.example.test/start' } } });
        expect(await opening).toMatchObject({ status: 'dispatched' });
        expect(adapter.getNavigationState({ browserSessionId: 'browser_session_1', viewId: 'view_1' }))
            .toMatchObject({ currentUrl: 'https://redirect.test/', navigationGeneration: 1 });
    });
    it('retires the binding and closes the page when engine event bootstrap fails', async () => {
        const transport = { ...createTransport(), subscribeCdpEvents: () => () => undefined,
            dispatchPageCommand: async () => { throw new Error('CDP disconnected during bootstrap'); },
        };
        const adapter = createBrowserSidecarCdpControlAdapter({ browserSessionId: 'browser_session_1', sidecarId: 'sidecar_1', transport });
        const lifecycle: SidecarViewLifecycleEvent[] = [];
        adapter.subscribeViewLifecycle(event => lifecycle.push(event));
        expect(await adapter.dispatchCommand(externalOpenViewCommand())).toMatchObject({ status: 'failed' });
        expect(adapter.ownsView({ browserSessionId: 'browser_session_1', viewId: 'view_1' })).toBe(false);
        expect(lifecycle.map(event => event.type)).toEqual(['bound', 'unbound']);
        expect(transport.dispatchBrowserCommand).toHaveBeenCalledWith({ method: 'Target.closeTarget', params: { targetId: 'cdp_target_secret' } });
    });
    it('emits view-binding lifecycle on openView/closeView for diagnostics subscribers', async () => {
        const mod = await loadControlAdapter();

        expect(mod?.createBrowserSidecarCdpControlAdapter).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarCdpControlAdapter) return;

        const adapter = mod.createBrowserSidecarCdpControlAdapter({
            browserSessionId: 'browser_session_1',
            sidecarId: 'sidecar_1',
            transport: createTransport(),
        });

        const events: SidecarViewLifecycleEvent[] = [];
        const unsubscribe = adapter.subscribeViewLifecycle((event) => {
            events.push(event);
        });

        await adapter.dispatchCommand(externalOpenViewCommand());
        await adapter.dispatchCommand({
            kind: 'closeView',
            commandId: 'command_close',
            browserSessionId: 'browser_session_1',
            viewId: 'view_1',
        });

        expect(events).toEqual([
            { type: 'bound', browserSessionId: 'browser_session_1', viewId: 'view_1' },
            { type: 'unbound', browserSessionId: 'browser_session_1', viewId: 'view_1', sourceDestroyed: true },
        ]);

        unsubscribe();
        await adapter.dispatchCommand(externalOpenViewCommand({ viewId: 'view_2' }));
        expect(events).toHaveLength(2);
    });

    it('binds BrowserCommandV1 results while dispatching backed view commands through CDP transport', async () => {
        const mod = await loadControlAdapter();

        expect(mod?.createBrowserSidecarCdpControlAdapter).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarCdpControlAdapter) return;

        const transport = createTransport();
        const adapter = mod.createBrowserSidecarCdpControlAdapter({
            browserSessionId: 'browser_session_1',
            sidecarId: 'sidecar_1',
            transport,
        });

        await expect(adapter.dispatchCommand(externalOpenViewCommand())).resolves.toMatchObject({
            v: 1,
            commandId: 'command_open',
            status: 'dispatched',
            adapterKind: 'chromiumSidecar',
        });
        expect(adapter.ownsView({ browserSessionId: 'browser_session_1', viewId: 'view_1' })).toBe(true);

        const commands: BrowserCommandV1[] = [
            navigateCommand(),
            { kind: 'focusView', commandId: 'command_focus', browserSessionId: 'browser_session_1', viewId: 'view_1' },
            { kind: 'reload', commandId: 'command_reload', browserSessionId: 'browser_session_1', viewId: 'view_1' },
            { kind: 'goBack', commandId: 'command_back', browserSessionId: 'browser_session_1', viewId: 'view_1' },
            { kind: 'goForward', commandId: 'command_forward', browserSessionId: 'browser_session_1', viewId: 'view_1' },
            { kind: 'stop', commandId: 'command_stop', browserSessionId: 'browser_session_1', viewId: 'view_1' },
            { kind: 'closeView', commandId: 'command_close', browserSessionId: 'browser_session_1', viewId: 'view_1' },
        ];
        const results: unknown[] = [];
        for (const command of commands) {
            const result = await adapter.dispatchCommand(command);
            results.push(result);
            expect(result).toMatchObject({
                v: 1,
                commandId: command.commandId,
                status: 'dispatched',
                adapterKind: 'chromiumSidecar',
            });
            expect(BrowserCommandDispatchResultV1Schema.safeParse(result).success).toBe(true);
        }

        expect(transport.openPage).toHaveBeenCalledWith({
            url: 'https://browser.example.test/start',
            focus: true,
        });
        expect(vi.mocked(transport.dispatchPageCommand).mock.calls.map(([input]) => input.method)).toEqual([
            'Page.navigate',
            'Page.reload',
            'Page.getNavigationHistory',
            'Page.navigateToHistoryEntry',
            'Page.getNavigationHistory',
            'Page.navigateToHistoryEntry',
            'Page.stopLoading',
        ]);
        expect(vi.mocked(transport.dispatchBrowserCommand).mock.calls.map(([input]) => input.method)).toEqual([
            'Target.activateTarget',
            'Target.closeTarget',
        ]);
        expect(adapter.ownsView({ browserSessionId: 'browser_session_1', viewId: 'view_1' })).toBe(false);
        expect(JSON.stringify(results)).not.toContain('cdp_target_secret');
        expect(JSON.stringify(results)).not.toContain('cdp_session_secret');
        expect(JSON.stringify(results)).not.toContain('debugger');
    });

    it('fails closed for unsupported session lifecycle and stale or unowned views', async () => {
        const mod = await loadControlAdapter();

        expect(mod?.createBrowserSidecarCdpControlAdapter).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarCdpControlAdapter) return;

        const transport = createTransport();
        const adapter = mod.createBrowserSidecarCdpControlAdapter({
            browserSessionId: 'browser_session_1',
            sidecarId: 'sidecar_1',
            transport,
        });

        await expect(adapter.dispatchCommand(navigateCommand({ viewId: 'stale_view' }))).resolves.toMatchObject({
            v: 1,
            commandId: 'command_navigate',
            status: 'failed',
            adapterKind: 'chromiumSidecar',
            error: { code: 'view_not_found' },
        });
        expect(adapter.supportsOpenView({
            ...externalOpenViewCommand({ commandId: 'command_local_preview', viewId: 'view_local_preview' }),
            target: {
                kind: 'localServicePreview',
                targetId: 'preview_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
            },
        })).toBe(false);
        expect(transport.openPage).not.toHaveBeenCalled();
        expect(transport.dispatchPageCommand).not.toHaveBeenCalled();
        expect(transport.dispatchBrowserCommand).not.toHaveBeenCalled();
    });

    it('normalizes CDP transport failures to typed Browser command dispatch failures without leaking debugger details', async () => {
        const mod = await loadControlAdapter();

        expect(mod?.createBrowserSidecarCdpControlAdapter).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarCdpControlAdapter) return;

        const transport = createTransport({
            dispatchPageCommand: vi.fn(async () => {
                throw new Error('CDP failed at ws://127.0.0.1/devtools/page/cdp_target_secret with cdp_session_secret');
            }),
        });
        const adapter = mod.createBrowserSidecarCdpControlAdapter({
            browserSessionId: 'browser_session_1',
            sidecarId: 'sidecar_1',
            transport,
        });

        await adapter.dispatchCommand(externalOpenViewCommand());
        const result = await adapter.dispatchCommand(navigateCommand());

        expect(result).toMatchObject({
            v: 1,
            commandId: 'command_navigate',
            status: 'failed',
            adapterKind: 'chromiumSidecar',
            error: { code: 'adapter_unavailable' },
        });
        expect(BrowserCommandDispatchResultV1Schema.safeParse(result).success).toBe(true);
        expect(JSON.stringify(result)).not.toContain('ws://127.0.0.1');
        expect(JSON.stringify(result)).not.toContain('cdp_target_secret');
        expect(JSON.stringify(result)).not.toContain('cdp_session_secret');
    });
});
