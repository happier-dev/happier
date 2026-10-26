import type { Page } from '@playwright/test';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';

/**
 * The page's side of the relay's machine RPC route, observed at the network boundary: every
 * `rpc-call` the app sends over its relay WebSocket and the relay's acknowledgement. This is how a
 * test reads the production readiness proof (INV10: the coordinator's one read-only
 * `capabilities.describe`, through `machineRpcWithServerScope`) instead of inferring readiness
 * from a panel leaving the screen.
 *
 * A fault can answer an exact RPC route with a supplied acknowledgement, or answer a machine
 * method the way the relay answers when its socket never acknowledges the forwarded request
 * (`rpcHandler` forwards with a timeout and acknowledges `{ ok: false, error: 'operation has timed out' }`).
 * Every other frame passes through unchanged in both directions.
 *
 * Socket.IO over a WebSocket only: the app must be built with `EXPO_PUBLIC_HAPPIER_SOCKET_FORCE_WEBSOCKET=1`
 * so no call travels over the HTTP long-polling transport this route cannot see.
 */

export type RelayRpcAck = Readonly<{ ok?: unknown; error?: unknown; errorCode?: unknown; result?: unknown }>;

export type RelayMachineRpcCall = {
    readonly method: string;
    ack: RelayRpcAck | null;
    /** The acknowledgement came from the armed fault, not the relay. */
    injected: boolean;
};

export type RelayMachineRpcTap = Readonly<{
    calls: () => readonly RelayMachineRpcCall[];
    /** Answer every call whose method is `<machineId>:<method>` as an unresponsive machine; `null` disarms. */
    setUnresponsiveMethod: (method: string | null) => void;
    /** Answer one exact RPC route at the relay boundary; encrypted routes supply an encrypted result. */
    setMethodResponse: (response: Readonly<{ method: string; ack: RelayRpcAck }> | null) => void;
}>;

/** The relay's own acknowledgement when the forwarded request times out (socket.io's timeout error). */
export const RELAY_FORWARD_TIMEOUT_ACK = Object.freeze({ ok: false, error: 'operation has timed out' });

const SOCKET_IO_EVENT_WITH_ACK = /^42(?:\/[^,]*,)?(\d+)(\[[\s\S]*\])$/u;
const SOCKET_IO_ACK = /^43(?:\/[^,]*,)?(\d+)(\[[\s\S]*\])$/u;
const RELAY_SOCKET_PATH = '/v1/updates/';

export function parseRpcCallFrame(frame: string): Readonly<{ ackId: string; method: string }> | null {
    const match = SOCKET_IO_EVENT_WITH_ACK.exec(frame);
    if (!match) return null;
    const payload = safeJsonArray(match[2]!);
    if (payload?.[0] !== SOCKET_RPC_EVENTS.CALL) return null;
    const method = (payload[1] as { method?: unknown } | null)?.method;
    return typeof method === 'string' ? { ackId: match[1]!, method } : null;
}

export function parseAckFrame(frame: string): Readonly<{ ackId: string; ack: RelayRpcAck | null }> | null {
    const match = SOCKET_IO_ACK.exec(frame);
    if (!match) return null;
    const payload = safeJsonArray(match[2]!);
    if (!payload) return null;
    const first = payload[0];
    return { ackId: match[1]!, ack: first && typeof first === 'object' && !Array.isArray(first) ? first as RelayRpcAck : null };
}

export function buildAckFrame(ackId: string, ack: RelayRpcAck): string {
    return `43${ackId}${JSON.stringify([ack])}`;
}

function safeJsonArray(raw: string): unknown[] | null {
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

/** Attach before the first navigation: a route applies to WebSockets the page opens afterwards. */
export async function attachRelayMachineRpcTap(page: Page): Promise<RelayMachineRpcTap> {
    const calls: RelayMachineRpcCall[] = [];
    let unresponsiveMethod: string | null = null;
    let methodResponse: Readonly<{ method: string; ack: RelayRpcAck }> | null = null;
    const matchesUnresponsive = (method: string) => unresponsiveMethod !== null && method.endsWith(`:${unresponsiveMethod}`);

    await page.routeWebSocket((url) => url.pathname === RELAY_SOCKET_PATH, (ws) => {
        const server = ws.connectToServer();
        const pending = new Map<string, RelayMachineRpcCall>();
        ws.onMessage((message) => {
            const call = typeof message === 'string' ? parseRpcCallFrame(message) : null;
            if (call) {
                const record: RelayMachineRpcCall = { method: call.method, ack: null, injected: false };
                calls.push(record);
                if (methodResponse?.method === call.method) {
                    record.ack = methodResponse.ack;
                    record.injected = true;
                    ws.send(buildAckFrame(call.ackId, methodResponse.ack));
                    return;
                }
                if (matchesUnresponsive(call.method)) {
                    record.ack = RELAY_FORWARD_TIMEOUT_ACK;
                    record.injected = true;
                    ws.send(buildAckFrame(call.ackId, RELAY_FORWARD_TIMEOUT_ACK));
                    return;
                }
                pending.set(call.ackId, record);
            }
            server.send(message);
        });
        server.onMessage((message) => {
            const acked = typeof message === 'string' ? parseAckFrame(message) : null;
            const record = acked ? pending.get(acked.ackId) : undefined;
            if (acked && record) {
                record.ack = acked.ack;
                pending.delete(acked.ackId);
            }
            ws.send(message);
        });
    });

    return {
        calls: () => calls,
        setUnresponsiveMethod: (method) => {
            unresponsiveMethod = method;
        },
        setMethodResponse: (response) => {
            methodResponse = response;
        },
    };
}

/** The readiness proof's calls for one machine: `<machineId>:capabilities.describe`. */
export function readinessProofCalls(tap: RelayMachineRpcTap, machineId: string): readonly RelayMachineRpcCall[] {
    return tap.calls().filter((call) => call.method === `${machineId}:${RPC_METHODS.CAPABILITIES_DESCRIBE}`);
}
