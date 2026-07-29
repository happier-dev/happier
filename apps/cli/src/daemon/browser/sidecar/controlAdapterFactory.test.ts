import type { BrowserCommandV1 } from '@happier-dev/protocol';
import { describe, expect, it, vi } from 'vitest';

type FactoryModule = Readonly<{
    createBrowserSidecarCdpControlAdapterFactory?: (input: Readonly<{
        browserSessionId: string;
        sidecarId: string;
        endpointSource: Readonly<{ kind: 'devtoolsStderr'; stderr: string }> | Readonly<{ kind: 'explicit'; endpoint: string }>;
        connectTransport?: (endpoint: Readonly<{ url: string }>) => Promise<{
            transport: Readonly<{
                openPage(input: Readonly<{ url: string; focus: boolean }>): Promise<Readonly<{ targetId: string; sessionId?: string }>>;
                dispatchPageCommand(input: Readonly<{
                    targetId: string;
                    sessionId?: string;
                    method: string;
                    params?: Record<string, unknown>;
                }>): Promise<unknown>;
                dispatchBrowserCommand(input: Readonly<{
                    method: string;
                    params?: Record<string, unknown>;
                }>): Promise<unknown>;
            }>;
            dispose?: () => void | Promise<void>;
        }>;
    }>) => (input: Readonly<{ machineId: string }>) => Promise<FactoryResult> | FactoryResult;
}>;

type FactoryResult =
    | Readonly<{
        ok: true;
        adapter: Readonly<{
            adapterKind: 'chromiumSidecar';
            dispatchCommand(command: BrowserCommandV1): Promise<unknown> | unknown;
        }>;
        dispose?: () => void | Promise<void>;
    }>
    | Readonly<{
        ok: false;
        errorCode: 'cdp_unavailable';
        disabledReason: string;
    }>;

async function loadFactoryModule(): Promise<FactoryModule | null> {
    return import('./controlAdapterFactory') as Promise<FactoryModule | null>;
}

function openViewCommand(): Extract<BrowserCommandV1, { kind: 'openView' }> {
    return {
        kind: 'openView',
        commandId: 'command_open',
        browserSessionId: 'browser_session_factory',
        viewId: 'view_factory',
        platform: 'web',
        focus: true,
        target: {
            kind: 'externalUrl',
            targetId: 'target_factory',
            url: 'https://browser.example.test/factory',
        },
    };
}

describe('browser sidecar CDP control adapter factory', () => {
    it('returns cdp_unavailable without endpoint details when discovery fails', async () => {
        const mod = await loadFactoryModule();

        expect(mod?.createBrowserSidecarCdpControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarCdpControlAdapterFactory) return;

        const factory = mod.createBrowserSidecarCdpControlAdapterFactory({
            browserSessionId: 'browser_session_factory',
            sidecarId: 'sidecar_factory',
            endpointSource: {
                kind: 'explicit',
                endpoint: 'ws://example.com:9222/devtools/browser/secret-token',
            },
        });

        const result = await factory({ machineId: 'machine_1' });

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'cdp_unavailable',
        });
        expect(JSON.stringify(result)).not.toContain('ws://');
        expect(JSON.stringify(result)).not.toContain('secret-token');
    });

    it('returns cdp_unavailable without endpoint details when transport connection fails', async () => {
        const mod = await loadFactoryModule();

        expect(mod?.createBrowserSidecarCdpControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarCdpControlAdapterFactory) return;

        const connectTransport = vi.fn(async () => {
            throw new Error('connect failed at ws://127.0.0.1:9222/devtools/browser/secret-token');
        });
        const factory = mod.createBrowserSidecarCdpControlAdapterFactory({
            browserSessionId: 'browser_session_factory',
            sidecarId: 'sidecar_factory',
            endpointSource: {
                kind: 'devtoolsStderr',
                stderr: 'DevTools listening on ws://127.0.0.1:9222/devtools/browser/secret-token',
            },
            connectTransport,
        });

        const result = await factory({ machineId: 'machine_1' });

        expect(connectTransport).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            ok: false,
            errorCode: 'cdp_unavailable',
        });
        expect(JSON.stringify(result)).not.toContain('ws://');
        expect(JSON.stringify(result)).not.toContain('secret-token');
    });

    it('returns an executable adapter only after a private CDP transport is connected', async () => {
        const mod = await loadFactoryModule();

        expect(mod?.createBrowserSidecarCdpControlAdapterFactory).toBeTypeOf('function');
        if (!mod?.createBrowserSidecarCdpControlAdapterFactory) return;

        const dispose = vi.fn();
        const transport = {
            openPage: vi.fn(async () => ({
                targetId: 'target_secret',
                sessionId: 'session_secret',
            })),
            dispatchPageCommand: vi.fn(async () => ({})),
            dispatchBrowserCommand: vi.fn(async () => ({})),
        };
        const connectTransport = vi.fn(async () => ({ transport, dispose }));
        const factory = mod.createBrowserSidecarCdpControlAdapterFactory({
            browserSessionId: 'browser_session_factory',
            sidecarId: 'sidecar_factory',
            endpointSource: {
                kind: 'devtoolsStderr',
                stderr: 'DevTools listening on ws://127.0.0.1:9222/devtools/browser/secret-token',
            },
            connectTransport,
        });

        const result = await factory({ machineId: 'machine_1' });

        expect(connectTransport).toHaveBeenCalledOnce();
        expect(result).toMatchObject({
            ok: true,
            adapter: {
                adapterKind: 'chromiumSidecar',
            },
        });
        if (!result || typeof result !== 'object' || !('ok' in result) || result.ok !== true) return;

        const dispatched = await result.adapter.dispatchCommand(openViewCommand());

        expect(dispatched).toMatchObject({
            v: 1,
            commandId: 'command_open',
            status: 'dispatched',
            adapterKind: 'chromiumSidecar',
        });
        expect(transport.openPage).toHaveBeenCalledWith({
            url: 'https://browser.example.test/factory',
            focus: true,
        });
        expect(JSON.stringify(dispatched)).not.toContain('target_secret');
        expect(JSON.stringify(dispatched)).not.toContain('session_secret');

        await result.dispose?.();
        expect(dispose).toHaveBeenCalledOnce();
    });
});
