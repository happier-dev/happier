import {
    DaemonBrowserControlDispatchRequestV1Schema,
    DaemonBrowserControlDispatchResponseV1Schema,
    type BrowserCommandDispatchResultV1,
    type BrowserCommandV1,
} from '@happier-dev/protocol';
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
 * Build the fire-and-forget `sendDaemonCommand` the control adapter consumes. The daemon applies the
 * command and emits the authoritative browser events back through the streamed/sidecar surface's own
 * event ingestion, so the transport does not feed the result back into the local reducer; the
 * optional `onResult` sink exists only for observability/testing.
 */
export function createBrowserDaemonControlCommandSender(
    input: Readonly<{
        machineId: string;
        serverId: string;
        onResult?: (result: BrowserDaemonControlDispatchClientResult) => void;
    }>,
): (command: BrowserCommandV1) => void {
    return (command) => {
        void dispatchBrowserDaemonControlCommandViaMachineRpc({
            machineId: input.machineId,
            serverId: input.serverId,
            command,
        }).then((result) => {
            input.onResult?.(result);
        }).catch(() => {
            input.onResult?.({ ok: false, reason: 'request_failed' });
        });
    };
}
