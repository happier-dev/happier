import { DaemonBrowserControlDispatchRequestV1Schema, DaemonBrowserControlDispatchResponseV1Schema, DaemonBrowserViewListRequestV1Schema, DaemonBrowserViewListResponseV1Schema, type BrowserDaemonViewV1, type BrowserCommandDispatchResultV1, type BrowserCommandV1 } from '@happier-dev/protocol/browser/control/v1';
import type { BrowserEventV1 } from '@happier-dev/protocol/browser/events/v1';
import { isRpcMethodNotFoundResult, RPC_METHODS } from '@happier-dev/protocol/rpc';

import { machineRpcWithServerScope } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineRpc';

/**
 * UI→daemon BrowserCommandV1 transport (W2-A-1 / A3).
 *
 * A daemon-authoritative view (`chromiumSidecar`/`streamedBrowserSurface`) is owned by the daemon
 * control broker, so its navigate/reload/stop/close/setTarget commands cannot be applied locally —
 * the control reducer emits a `daemonCommand` effect and calls `sendDaemonCommand`. This module is
 * that transport: it routes the command over the owner-scoped (account+machine) machine RPC to the
 * SAME `createBrowserDaemonControlRoutes` broker the agent execution-run path uses (MC-6 — one
 * daemon control owner, no parallel path). The user-initiated `ui` path is never approval-floored;
 * the agent path stays floored at the action surface.
 */

export type BrowserDaemonControlDispatchClientInput = Readonly<{
    machineId: string;
    serverId: string;
    command: BrowserCommandV1;
    signal?: AbortSignal;
}>;

export type BrowserDaemonControlDispatchClientResult =
    | Readonly<{ ok: true; result: BrowserCommandDispatchResultV1 }>
    | Readonly<{ ok: false; reason: 'unavailable' | 'invalid_response' | 'request_failed' }>;

/** Session-filtered discovery from the same daemon owner as navigation and automation. */
export async function listBrowserDaemonViewsViaMachineRpc(input: Readonly<{
    machineId: string; serverId: string; browserSessionId: string; signal?: AbortSignal;
}>): Promise<Readonly<{ ok: true; views: readonly BrowserDaemonViewV1[] }>
    | Readonly<{ ok: false; reason: 'invalid_response' | 'request_failed' }>> {
    if (input.signal?.aborted) return { ok: false, reason: 'request_failed' };
    try {
        const payload = DaemonBrowserViewListRequestV1Schema.parse({ machineId: input.machineId,
            browserSessionId: input.browserSessionId });
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({ machineId: input.machineId,
            serverId: input.serverId, method: RPC_METHODS.DAEMON_BROWSER_VIEW_LIST, payload,
            ...(input.signal ? { signal: input.signal } : {}) });
        const parsed = DaemonBrowserViewListResponseV1Schema.safeParse(raw);
        return parsed.success ? { ok: true, views: parsed.data.views } : { ok: false, reason: 'invalid_response' };
    } catch { return { ok: false, reason: 'request_failed' }; }
}

export async function dispatchBrowserDaemonControlCommandViaMachineRpc(
    input: BrowserDaemonControlDispatchClientInput,
): Promise<BrowserDaemonControlDispatchClientResult> {
    if (input.signal?.aborted) {
        return { ok: false, reason: 'request_failed' };
    }
    try {
        const payload = DaemonBrowserControlDispatchRequestV1Schema.parse({
            machineId: input.machineId,
            command: input.command,
        });
        const raw = await machineRpcWithServerScope<unknown, typeof payload>({
            machineId: input.machineId,
            serverId: input.serverId,
            method: RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH,
            payload,
            ...(input.signal ? { signal: input.signal } : {}),
        });
        if (isRpcMethodNotFoundResult(raw)) {
            return { ok: false, reason: 'unavailable' };
        }
        const parsed = DaemonBrowserControlDispatchResponseV1Schema.safeParse(raw);
        return parsed.success
            ? { ok: true, result: parsed.data.result }
            : { ok: false, reason: 'invalid_response' };
    } catch {
        return { ok: false, reason: 'request_failed' };
    }
}

/**
 * Build the result-bearing `sendDaemonCommand` the control adapter consumes. The daemon applies the
 * command. Its validated authoritative response events feed the surface's canonical event reducer;
 * the optional `onResult` sink remains observability only.
 */
export type BrowserDaemonControlCommandSender = (
    command: BrowserCommandV1,
    onEvents?: (events: readonly BrowserEventV1[]) => void,
) => Promise<BrowserDaemonControlDispatchClientResult>;

export function createBrowserDaemonControlCommandSender(
    input: Readonly<{
        machineId: string;
        serverId: string;
        onResult?: (result: BrowserDaemonControlDispatchClientResult) => void;
    }>,
): BrowserDaemonControlCommandSender {
    return async (command, onEvents) => {
        const result = await dispatchBrowserDaemonControlCommandViaMachineRpc({
            machineId: input.machineId,
            serverId: input.serverId,
            command,
        });
        if (result.ok && result.result.status === 'dispatched') onEvents?.(result.result.events);
        input.onResult?.(result);
        return result;
    };
}
