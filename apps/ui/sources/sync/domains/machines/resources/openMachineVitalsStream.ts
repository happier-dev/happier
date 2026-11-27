import { decodeBase64 } from '@happier-dev/protocol/crypto/base64';
import { isMachineLiveStreamTerminalReceiptV1, MachineLiveStreamReceiptV1Schema } from '@happier-dev/protocol/machines/peer/mediation/stream/receipts';
import type { MachineLiveStreamRelayEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import {
    MACHINE_VITALS_STREAM_FAMILY, MACHINE_VITALS_STREAM_SOURCES, MachineVitalsStreamUpdateV1Schema,
    type MachineVitalsStreamUpdateV1,
} from '@happier-dev/protocol/machines/vitals/machineVitalsRpcV1';

import { randomUUID } from '@/platform/randomUUID';
import { decodeUTF8 } from '@/encryption/text';
import { captureServerCredentialAccountScopeLifetime, resolveServerCredentialAccountScope } from '@/sync/domains/scope/serverCredentialAccountScope';
import { resolveServerScopedMachineLiveStreamRelaySocket } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineLiveStreamRelaySocket';
import { resolveMachineDaemonReadServerId } from '../useMachineDaemonReadTarget';
import { createMachineLiveStreamGrantRenewal, openMachineLiveStreamRelayClient, type MachineLiveStreamRelayClientInput } from '../peer/mediation/stream/relayClient';
import type { MachineVitalsReadInput } from './machineRpc';

type StreamOutcome = Readonly<{ kind: 'closed' | 'unsupported'; reasonCode: string }>;

export async function openMachineVitalsStream(input: MachineVitalsReadInput & Readonly<{
    onDispatched(): void;
    onUpdate(update: MachineVitalsStreamUpdateV1): void;
}>): Promise<StreamOutcome> {
    const { machineId, signal } = input;
    const resolution = await resolveServerCredentialAccountScope(resolveMachineDaemonReadServerId(input.serverId));
    if (signal?.aborted) return { kind: 'closed', reasonCode: 'viewer_closed' };
    if (resolution.kind !== 'bound' || (input.expectedAccountId && input.expectedAccountId !== resolution.scope.accountId)) {
        return { kind: 'closed', reasonCode: 'grant_missing' };
    }
    const account = captureServerCredentialAccountScopeLifetime(resolution);
    const transport = await resolveServerScopedMachineLiveStreamRelaySocket({
        machineId, serverId: account.scope.serverId, accountLifetime: account, signal,
    });
    const viewerSocketId = transport.socketId;
    if (signal?.aborted || !account.isCurrent() || !viewerSocketId) {
        await transport.disconnect();
        return { kind: 'closed', reasonCode: 'viewer_closed' };
    }

    const streamId = randomUUID();
    const send = (message: MachineLiveStreamRelayEnvelopeV1['message']) => transport.sendEnvelope({
        v: 1, sourceMachineId: machineId, targetMachineId: machineId, viewerSocketId, message,
    });
    const controller = new AbortController();
    const client: MachineLiveStreamRelayClientInput = {
        serverId: account.scope.serverId, expectedAccountId: account.scope.accountId,
        sourceMachineId: machineId, targetMachineId: machineId, viewerSocketId, streamId,
        streamFamily: MACHINE_VITALS_STREAM_FAMILY, sourceId: MACHINE_VITALS_STREAM_SOURCES[input.view],
        caps: {}, signal: controller.signal,
    };
    let finish!: (outcome: StreamOutcome) => void;
    const completed = new Promise<StreamOutcome>(resolve => { finish = resolve; });
    let ended = false;
    const close = (reasonCode: string, kind: StreamOutcome['kind'] = 'closed') => {
        if (ended) return;
        ended = true;
        controller.abort();
        renewal.close();
        finish({ kind, reasonCode });
    };
    const renewal = createMachineLiveStreamGrantRenewal(client, startRequest => send({ kind: 'renew', startRequest }),
        reasonCode => close(reasonCode));
    const stopObservingSocket = transport.onSocketIdChange(() => {
        if (transport.socketId !== viewerSocketId) close('viewer_socket_disconnected');
    });
    const stopListening = transport.onEnvelope(({ sourceMachineId, targetMachineId, message }) => {
        if (ended || sourceMachineId !== machineId || targetMachineId !== machineId) return;
        if (message.kind === 'control' && message.control.streamId === streamId) {
            const { control } = message;
            if (control.kind === 'grant_expiring') renewal.schedule(control.expiresAtMs);
            if (control.kind === 'stop' || control.kind === 'grant_refresh_denied' || control.kind === 'cap_exceeded') {
                close(control.reasonCode ?? 'stream_stopped');
            }
        } else if (message.kind === 'receipt') {
            const receipt = MachineLiveStreamReceiptV1Schema.safeParse(message.receipt);
            if (receipt.success && receipt.data.streamId === streamId && isMachineLiveStreamTerminalReceiptV1(receipt.data)) {
                close(receipt.data.reasonCode ?? 'stream_stopped');
            }
        } else if (message.kind === 'frame' && message.frame.streamId === streamId && message.frame.payloadKind === 'metadata') {
            let value: unknown;
            try { value = JSON.parse(decodeUTF8(decodeBase64(message.frame.payloadBase64))); }
            catch { close('invalid_response'); return; }
            const update = MachineVitalsStreamUpdateV1Schema.safeParse(value);
            if (!update.success) { close('invalid_response'); return; }
            send({ kind: 'control', control: { v: 1, kind: 'ack', streamId, nextSequence: message.frame.sequence + 1 } });
            input.onUpdate(update.data);
        }
    });
    const onAbort = () => close('viewer_closed');
    signal?.addEventListener('abort', onAbort, { once: true });
    const accountRetirement = account.onRetire(onAbort);
    const opening = openMachineLiveStreamRelayClient({
        ...client,
        onAuthorized: request => {
            if (ended) return;
            if (request.authorization) renewal.schedule(request.authorization.payload.exp);
            input.onDispatched();
        },
    });
    void opening.then(result => {
        if (result.ok) return;
        const reason = result.reasonCode;
        // Older daemons send unknown source families through Computer admission.
        // A missing Desktop or requester isolation there says nothing about Vitals access.
        close(reason, reason === 'capture_source_unavailable' || reason === 'live_stream_relay_start_unavailable'
            || reason === 'stream_unsupported' || reason === 'server_relay_disabled' || reason === 'relay_cap_missing'
            || reason === 'agent_isolation_unavailable' || reason === 'computer_display_unavailable'
            ? 'unsupported' : 'closed');
    }, () => close('live_stream_relay_start_failed'));
    try {
        return await completed;
    } finally {
        stopObservingSocket();
        signal?.removeEventListener('abort', onAbort);
        accountRetirement.dispose();
        // Observe late admission on the original transport and stop it before releasing the socket.
        void opening.then(result => {
            if (result.ok) send({ kind: 'control', control: { v: 1, kind: 'stop', streamId, reasonCode: 'viewer_closed' } });
        }).catch(() => {}).finally(() => {
            stopListening();
            void transport.disconnect().catch(() => {});
        });
    }
}
