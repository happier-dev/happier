import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { createUnavailableRuntimeActionExecutor } from '@happier-dev/protocol/actions/executor/dispatch';
import { MachineLiveStreamDecodedEnvelopeV1Schema, type MachineLiveStreamRelayEnvelopeV1 } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { ComputerControlStatusResponseV1Schema, ComputerSelectedTargetResponseV1Schema, ComputerTargetsListResponseV1Schema } from '@happier-dev/protocol/computer/v1';

import type { ComputerScreenTransport } from '@/components/computer/useComputerScreenStream';
import type { ServerScopedMachineLiveStreamRelaySocket } from '@/sync/runtime/orchestration/serverScopedRpc/serverScopedMachineLiveStreamRelaySocket';
import { createComputerRuntimeActionExecutor, type ComputerMachineRpc } from '@/sync/domains/computer/actions/runtimeActionExecutor';
import type { ComputerActionExecute } from '@/sync/domains/computer/computerControlClient';
import { encodeBase64 } from '@/encryption/base64';

import { DEMO_MACHINE_ID, DEMO_RICH_SESSION_ID, DEMO_NOW_MS } from './constants';

export const DEMO_COMPUTER_FRAME_URL = '/static/demo/fieldwork-desktop.png';

async function readFieldworkFrame(signal?: AbortSignal): Promise<Uint8Array> {
    const response = await fetch(DEMO_COMPUTER_FRAME_URL, { signal });
    if (!response.ok) throw new Error(`Computer demo frame: HTTP ${response.status}`);
    return new Uint8Array(await response.arrayBuffer());
}

/**
 * Frame-scoped machine RPC and decoded relay carriers. Only transport is seeded: the production
 * control projection, ingestion, image decoder, picker and viewer consume their ordinary contracts.
 * No Account binding, relay grant, credential, timer or persistent Session state is created.
 */
export function buildDemoComputerWorld(readFrame = readFieldworkFrame) {
    const scope = { machineId: DEMO_MACHINE_ID, sessionId: DEMO_RICH_SESSION_ID };
    const target = { kind: 'window', displayId: ':0', pid: 101, windowId: 12 } as const;
    const identity = { target, sourceId: 'demo-computer-fieldwork' };
    const grants = { capture: 'granted', input: 'granted' } as const;
    const selection = ComputerSelectedTargetResponseV1Schema.parse({
        selectedTarget: target, sourceId: identity.sourceId, consentGranted: true, access: 'use',
        approvalDisplay: { machineDisplayName: 'MacBook Pro', requiresTargetSelection: false,
            appName: 'Fieldwork', target: { kind: 'window', title: 'Fieldwork · Checkout' } },
    });
    const targets = ComputerTargetsListResponseV1Schema.parse({
        targets: [{ target, title: 'Fieldwork · Checkout', appName: 'Fieldwork', width: 1440, height: 900 }], grants,
    });
    let current = true;
    let shared = true;
    let controller: 'agent' | 'human' | 'idle' = 'agent';
    let controlEpoch = 1;
    const readers = new Set<(envelope: MachineLiveStreamRelayEnvelopeV1) => void>();
    const machine: ComputerMachineRpc = async ({ actionId }) => {
        switch (actionId) {
            case 'computer.targets.list': return targets;
            case 'computer.target.get': return shared ? selection : {
                consentGranted: false, approvalDisplay: { machineDisplayName: 'MacBook Pro', requiresTargetSelection: true },
            };
            case 'computer.target.select': shared = true; return selection;
            case 'computer.control.status': return ComputerControlStatusResponseV1Schema.parse({
                ...identity, controller, controlEpoch, stopping: false, uncertain: false, grants,
            });
            case 'computer.control.interrupt':
                controller = 'human'; controlEpoch += 1;
                return { ...identity, status: 'interrupted', completion: 'known' };
            case 'computer.control.handBack':
                controller = 'idle'; controlEpoch += 1;
                return { ...identity, status: 'dispatched' };
            case 'computer.target.close':
                shared = false;
                return { ...identity, status: 'dispatched' };
            default: throw new Error(`Computer demo does not provide ${actionId}`);
        }
    };
    const runtime = createComputerRuntimeActionExecutor({ executeOnMachine: machine, fallback: createUnavailableRuntimeActionExecutor() });
    const execute: ComputerActionExecute = async (actionId, input, context) => {
        if (!current) return { ok: false, errorCode: 'action_account_scope_changed', error: 'action_account_scope_changed' };
        const spec = getActionSpec(actionId);
        const result = await runtime({ actionId, input: spec.inputSchema.parse(input), context });
        return { ok: true, result: spec.outputSchema ? spec.outputSchema.parse(result) : result };
    };
    const socket: ServerScopedMachineLiveStreamRelaySocket = {
        machineId: scope.machineId, scopeUserId: 'demo-computer-viewer', viewerId: 'demo-computer-viewer', socketId: 'demo-computer-socket',
        onSocketIdChange: () => () => {},
        onEnvelope: listener => { readers.add(listener); return () => { readers.delete(listener); }; },
        // A single source frame has no ongoing native input or producer loop to stop.
        sendEnvelope: () => {},
        disconnect: async () => {},
    };
    const transport: ComputerScreenTransport = {
        resolveSocket: async () => socket,
        openRelay: async input => {
            const bytes = await readFrame(input.signal);
            if (!current || input.signal?.aborted) return { ok: false, reasonCode: 'live_stream_relay_start_failed' };
            const frame = MachineLiveStreamDecodedEnvelopeV1Schema.parse({
                v: 1, sourceMachineId: scope.machineId, targetMachineId: scope.machineId,
                viewerSocketId: socket.socketId,
                message: { kind: 'frame', frame: { v: 1, streamId: input.streamId, sequence: 1, timestampMs: DEMO_NOW_MS,
                    payloadKind: 'image_keyframe', payloadEncoding: 'binary_base64', codecId: 'image.frame.v1',
                    payloadBase64: encodeBase64(bytes), payloadSizeBytes: bytes.byteLength } },
            });
            for (const reader of readers) reader(frame);
            return { ok: true, streamId: input.streamId };
        },
    };
    return { scope, execute, transport,
        dispose: () => { current = false; readers.clear(); },
    };
}
