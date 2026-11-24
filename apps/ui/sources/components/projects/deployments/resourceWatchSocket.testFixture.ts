import { expect, vi } from 'vitest';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import * as scopedSocket from '@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient';

export function installHostResourceWatchSocket(input: {
    actionId: string;
    digest(): string;
    onOpen?(watch: { invalidate(digest: string): void; refuse(code: string): void }): void;
    onDisconnect?(): void;
}) {
    return vi.spyOn(scopedSocket, 'createEphemeralServerSocketClient').mockImplementation(async () => {
        let deliver: ((value: unknown) => void) | undefined;
        let stop: (() => void) | undefined;
        let opened = false;
        const emitWithAck = async (event: string, packet: { requestId: string; params: { envelope: unknown } }) => {
            expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(packet.params.envelope);
            if (envelope.resourceContinuation?.method !== RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN) {
                throw new Error('Expected a Resource watch open');
            }
            const subscriptionId = envelope.resourceContinuation.params.subscriptionId;
            const requestId = packet.requestId;
            deliver?.({ requestId, selectedSocketId: 'daemon-socket' });
            const publish = (result: unknown) => deliver?.({ requestId, senderSocketId: 'daemon-socket', callId: 'a'.repeat(32),
                params: { v: 1, actionId: input.actionId, requestId: envelope.requestId, execution: { ok: true, result } } });
            publish({ ok: true, subscriptionId, digest: input.digest() });
            opened = true;
            return await new Promise(resolve => {
                const refuse = (code: string) => resolve({ ok: false, errorCode: code, error: code });
                stop = () => refuse('cancelled');
                input.onOpen?.({
                    refuse,
                    invalidate(digest) {
                        publish({ ok: true, status: 'event', event: { version: 1, subscriptionId, kind: 'invalidated', digest } });
                    },
                });
            });
        };
        return {
            connected: true, emitWithAck, timeout: () => ({ emitWithAck }), getSocketId: () => 'ui-socket',
            on(event, listener) { if (event === SOCKET_RPC_EVENTS.CONTINUATION) deliver = listener; },
            off(event) { if (event === SOCKET_RPC_EVENTS.CONTINUATION) deliver = undefined; },
            emit(event) { if (event === SOCKET_RPC_EVENTS.CANCEL) stop?.(); },
            disconnect() { if (opened) input.onDisconnect?.(); },
        };
    });
}
