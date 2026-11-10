import type { Socket } from 'socket.io-client';
import type { ManagedConnectionTransport } from '@happier-dev/connection-supervisor';
import { emitWithAckCancellable } from '@happier-dev/sync-client';
import { SESSION_CONSUMPTION_REPLACE_EVENT, SessionConsumptionReplaceAckV1Schema, type SessionConsumptionReplaceV1 } from '@happier-dev/protocol/sessions';
import { fireAndForget } from '@/utils/system/fireAndForget';

/** The connection-local declaration boundary, shared by managed sync and scoped Session consumers. */
export async function replaceSessionConsumption(input: Readonly<{
    socket: Parameters<typeof emitWithAckCancellable>[0]['socket'];
    declaration: SessionConsumptionReplaceV1;
    signal: AbortSignal;
}>): Promise<Readonly<{
    liveSessionIds: readonly string[];
    fullyAdmitted: boolean;
}>> {
    const result = await emitWithAckCancellable({ socket: input.socket, event: SESSION_CONSUMPTION_REPLACE_EVENT,
        payload: input.declaration, timeoutMs: null, signal: input.signal });
    const parsed = SessionConsumptionReplaceAckV1Schema.safeParse(result);
    if (!parsed.success) throw new Error('session_consumption_invalid_ack');
    if (!parsed.data.ok) throw new Error(`session_consumption_${parsed.data.error}`);
    const requestedLive = new Set(input.declaration.liveSessionIds);
    const liveSessionIds = parsed.data.liveSessionIds.filter(id => requestedLive.has(id));
    const admittedLive = new Set(liveSessionIds);
    const admittedDurable = new Set(parsed.data.durableSessionIds);
    return {
        liveSessionIds,
        fullyAdmitted: input.declaration.liveSessionIds.every(id => admittedLive.has(id))
            && input.declaration.durableSessionIds.every(id => admittedDurable.has(id)),
    };
}

/** Captures the authenticated transport lifetime; replacement disposes every source subscription. */
export function attachManagedSessionConsumptionSocket(input: Readonly<{
    serverId: string;
    socket: Socket;
    transport: Pick<ManagedConnectionTransport, 'isConnected' | 'onConnected' | 'onDisconnected'>;
    onLiveConsumptionAdmitted?: (sessionIds: readonly string[]) => void;
}>): () => void {
    let disposed = false;
    let detach: (() => void) | undefined;
    const fail = (error: unknown) => {
        if (disposed) return;
        const failure = error instanceof Error ? error : new Error('session_consumption_unavailable');
        console.warn('[session-consumption]', failure.message);
    };
    // Keep socket construction out of the storage/Voice/sync module cycle.
    fireAndForget(import('./sessionLiveConsumption').then(({ createSessionConsumptionProjection }) => {
        if (disposed) return;
        const projection = createSessionConsumptionProjection(input.serverId);
        let controller = new AbortController();
        let request = 0;
        let admittedLive = new Set<string>();
        const send = () => {
            if (disposed || !input.transport.isConnected()) return;
            const declaration = projection.read();
            const requestId = ++request;
            const signal = controller.signal;
            fireAndForget((async () => {
                const result = await replaceSessionConsumption({ socket: input.socket, declaration, signal });
                if (disposed || signal.aborted || requestId !== request || !input.transport.isConnected()) return;
                const next = new Set(result.liveSessionIds);
                const increased = [...next].filter(id => !admittedLive.has(id));
                admittedLive = next;
                if (increased.length > 0) input.onLiveConsumptionAdmitted?.(increased);
                if (!result.fullyAdmitted) {
                    fail(new Error('session_consumption_partial_admission'));
                }
            })(), { onError: error => { if (!signal.aborted && requestId === request) fail(error); } });
        };
        const disconnected = () => {
            ++request;
            controller.abort();
            controller = new AbortController();
            admittedLive.clear();
        };
        const offProjection = projection.subscribe(send);
        const offConnected = input.transport.onConnected(send);
        const offDisconnected = input.transport.onDisconnected(disconnected);
        detach = () => { disconnected(); offProjection(); offConnected(); offDisconnected(); projection.dispose(); };
        send();
    }), { onError: fail });
    return () => { disposed = true; detach?.(); };
}
