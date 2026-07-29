import {
    DaemonBrowserControlDispatchResponseV1Schema,
    type BrowserCommandV1,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { describe, expect, it, vi } from 'vitest';

import type { RpcHandler, RpcHandlerRegistrar } from '@/api/rpc/types';
import { createBrowserDaemonControlBroker } from '@/daemon/browser/control/broker';
import { createBrowserDaemonControlRoutes } from '@/daemon/browser/control/routes';
import type {
    BrowserDaemonControlAdapter,
    BrowserDaemonControlViewIdentity,
} from '@/daemon/browser/control/types';

import { registerDaemonBrowserControlHandler } from './daemonBrowserControl';

const BROWSER_SESSION_ID = 'browser_session_1';
const VIEW_ID = 'view_1';

function createCapturingRegistrar(): Readonly<{
    registrar: RpcHandlerRegistrar;
    invoke: (method: string, raw: unknown) => Promise<unknown>;
}> {
    const handlers = new Map<string, RpcHandler>();
    return {
        registrar: {
            registerHandler: (method, handler) => {
                handlers.set(method, handler as RpcHandler);
            },
        },
        invoke: async (method, raw) => {
            const handler = handlers.get(method);
            if (!handler) throw new Error(`No handler registered for ${method}`);
            return await handler(raw);
        },
    };
}

function createSidecarControlAdapter(input: Readonly<{
    onDispatch: (command: BrowserCommandV1) => void;
}>): BrowserDaemonControlAdapter {
    return {
        adapterKind: 'chromiumSidecar',
        ownsView: (identity: BrowserDaemonControlViewIdentity) => (
            identity.browserSessionId === BROWSER_SESSION_ID && identity.viewId === VIEW_ID
        ),
        supportsOpenView: () => false,
        dispatchCommand: (command) => {
            input.onDispatch(command);
            return {
                v: 1,
                commandId: command.commandId,
                status: 'dispatched',
                adapterKind: 'chromiumSidecar',
                events: [],
            };
        },
    };
}

describe('registerDaemonBrowserControlHandler', () => {
    // PRODUCTION-PATH cross-boundary: a chromiumSidecar view dispatches reload through the REAL
    // broker + routes the agent path also uses (MC-6), reaching the registered adapter — never a
    // `*_route_unavailable`/`adapter_unavailable` failure.
    it('routes a reload command through the shared control broker to the owning sidecar adapter', async () => {
        const dispatched: BrowserCommandV1[] = [];
        const broker = createBrowserDaemonControlBroker();
        broker.registerAdapter(createSidecarControlAdapter({ onDispatch: (command) => dispatched.push(command) }));
        const routes = createBrowserDaemonControlRoutes({ broker });

        const { registrar, invoke } = createCapturingRegistrar();
        registerDaemonBrowserControlHandler(registrar, { browserControl: routes });

        const command = {
            kind: 'reload',
            commandId: 'command_reload',
            browserSessionId: BROWSER_SESSION_ID,
            viewId: VIEW_ID,
        } satisfies BrowserCommandV1;
        const raw = await invoke(RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH, {
            machineId: 'machine_1',
            command,
        });

        const response = DaemonBrowserControlDispatchResponseV1Schema.parse(raw);
        expect(response.result).toMatchObject({
            commandId: 'command_reload',
            status: 'dispatched',
            adapterKind: 'chromiumSidecar',
        });
        expect(dispatched).toEqual([command]);
    });

    it('surfaces a typed view_not_found failure (not a transport throw) for an unowned view', async () => {
        const broker = createBrowserDaemonControlBroker();
        broker.registerAdapter(createSidecarControlAdapter({ onDispatch: () => undefined }));
        const routes = createBrowserDaemonControlRoutes({ broker });

        const { registrar, invoke } = createCapturingRegistrar();
        registerDaemonBrowserControlHandler(registrar, { browserControl: routes });

        const raw = await invoke(RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH, {
            machineId: 'machine_1',
            command: {
                kind: 'stop',
                commandId: 'command_stop',
                browserSessionId: BROWSER_SESSION_ID,
                viewId: 'view_other',
            } satisfies BrowserCommandV1,
        });

        const response = DaemonBrowserControlDispatchResponseV1Schema.parse(raw);
        expect(response.result).toMatchObject({
            commandId: 'command_stop',
            status: 'failed',
            error: { code: 'view_not_found' },
        });
    });

    it('throws an unavailable error when no control routes are wired (handler absent → method_not_found upstream)', async () => {
        const { registrar, invoke } = createCapturingRegistrar();
        registerDaemonBrowserControlHandler(registrar, { browserControl: null });

        await expect(invoke(RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH, {
            machineId: 'machine_1',
            command: {
                kind: 'reload',
                commandId: 'command_reload',
                browserSessionId: BROWSER_SESSION_ID,
                viewId: VIEW_ID,
            } satisfies BrowserCommandV1,
        })).rejects.toThrow('Browser control runtime is unavailable');
    });

    it('rejects a malformed command payload before reaching the broker', async () => {
        const dispatch = vi.fn();
        const routes = createBrowserDaemonControlRoutes({ broker: { dispatchCommand: dispatch } });
        const { registrar, invoke } = createCapturingRegistrar();
        registerDaemonBrowserControlHandler(registrar, { browserControl: routes });

        await expect(invoke(RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH, {
            machineId: 'machine_1',
            command: { kind: 'reload' },
        })).rejects.toThrow();
        expect(dispatch).not.toHaveBeenCalled();
    });
});
