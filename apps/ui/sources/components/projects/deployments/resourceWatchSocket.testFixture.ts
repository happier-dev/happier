import { expect, vi } from 'vitest';
import { ExternalActionRequestEnvelopeV1Schema } from '@happier-dev/protocol/actions/externalActionApi';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import type { PluginUiResourceSubscriptionEventV1 } from '@happier-dev/protocol/plugins/ui/subscriptions';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import type { PluginUiHostReadReferenceV1 } from '@happier-dev/protocol/plugins/ui/client';
import * as scopedSocket from '@/sync/runtime/orchestration/serverScopedRpc/createEphemeralServerSocketClient';

type ResourceWatch = {
    invalidate(digest: string): void;
    pages(pages: Extract<PluginUiResourceSubscriptionEventV1, { kind: 'pages' }>['pages']): void;
    complete(): void;
    error(code: Extract<PluginUiResourceSubscriptionEventV1, { kind: 'error' }>['code'], diagnostics: string[]): void;
    refuse(code: string): void;
};

type ResourceWatchFixture = {
    actionId: string;
    digest(): string;
    holdOpen?: boolean;
    onOpen?(watch: ResourceWatch): void;
    onDisconnect?(): void;
};

export type SelectResourceWatchFixture = (resource: PluginUiHostReadReferenceV1) => ResourceWatchFixture;

export function installHostResourceWatchSocket(input: ResourceWatchFixture | SelectResourceWatchFixture) {
    return vi.spyOn(scopedSocket, 'createEphemeralServerSocketClient').mockImplementation(async () => {
        let deliver: ((value: unknown) => void) | undefined;
        let stop: (() => void) | undefined;
        let onDisconnect: (() => void) | undefined;
        const emitWithAck = async (event: string, packet: { requestId: string; params: { envelope: unknown } }) => {
            expect(event).toBe(SOCKET_RPC_EVENTS.CALL);
            const envelope = ExternalActionRequestEnvelopeV1Schema.parse(packet.params.envelope);
            if (envelope.resourceContinuation?.method !== RPC_METHODS.DAEMON_PLUGIN_UI_RESOURCE_WATCH_OPEN) {
                throw new Error('Expected a Resource watch open');
            }
            const watch = typeof input === 'function' ? input(envelope.resourceContinuation.params.resource) : input;
            const subscriptionId = envelope.resourceContinuation.params.subscriptionId;
            const requestId = packet.requestId;
            deliver?.({ requestId, selectedSocketId: 'daemon-socket' });
            const publish = (result: unknown) => deliver?.({ requestId, senderSocketId: 'daemon-socket', callId: 'a'.repeat(32),
                params: { v: 1, actionId: watch.actionId, requestId: envelope.requestId, execution: { ok: true, result } } });
            if (!watch.holdOpen) publish({ ok: true, subscriptionId, digest: watch.digest() });
            const publishEvent = (event: PluginUiResourceSubscriptionEventV1) => publish({ ok: true, status: 'event', event });
            onDisconnect = watch.onDisconnect;
            return await new Promise(resolve => {
                const refuse = (code: string) => resolve({ ok: false, errorCode: code, error: code });
                stop = () => refuse('cancelled');
                watch.onOpen?.({
                    refuse,
                    invalidate(digest) {
                        publishEvent({ version: 1, subscriptionId, kind: 'invalidated', digest });
                    },
                    pages(pages) {
                        publishEvent({ version: 1, subscriptionId, kind: 'pages', pages });
                    },
                    complete() {
                        publishEvent({ version: 1, subscriptionId, kind: 'complete', diagnostics: [] });
                    },
                    error(code, diagnostics) {
                        publishEvent({ version: 1, subscriptionId, kind: 'error', code, diagnostics });
                    },
                });
            });
        };
        return {
            connected: true, emitWithAck, timeout: () => ({ emitWithAck }), getSocketId: () => 'ui-socket',
            on(event, listener) { if (event === SOCKET_RPC_EVENTS.CONTINUATION) deliver = listener; },
            off(event) { if (event === SOCKET_RPC_EVENTS.CONTINUATION) deliver = undefined; },
            emit(event) { if (event === SOCKET_RPC_EVENTS.CANCEL) stop?.(); },
            disconnect() { onDisconnect?.(); },
        };
    });
}
