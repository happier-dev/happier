import {
    BrowserCommandDispatchResultV1Schema,
    type BrowserCommandV1,
} from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

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
        dispatchBrowserCommand: vi.fn(async () => ({})),
        ...overrides,
    };
}

describe('browser sidecar CDP control adapter', () => {
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
            { type: 'unbound', browserSessionId: 'browser_session_1', viewId: 'view_1' },
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

        await expect(adapter.dispatchCommand({
            kind: 'createSession',
            commandId: 'command_create_session',
        })).resolves.toMatchObject({
            v: 1,
            commandId: 'command_create_session',
            status: 'failed',
            adapterKind: 'chromiumSidecar',
            error: { code: 'unsupported_command' },
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
