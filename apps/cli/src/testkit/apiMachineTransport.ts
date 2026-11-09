import { vi } from 'vitest';

import type { ApiMachineClient } from '@/api/apiMachine';
import type { MachineActionDirectTargetTransport } from '@/session/actions/cliActionDeps/types';
import { createApiSessionSocketStub } from './backends/apiSessionSocketHarness';

/** Installed local Machine RPC boundary beside an in-process Session transport. */
export function createLocalMachineActionTransportFixture(machineId: string): MachineActionDirectTargetTransport {
    return { machineId, invoke: async method => { throw new Error(`Unexpected local Machine RPC: ${method}`); } };
}

/** Socket.IO network boundary for the real Machine client and its composed owners. */
export function createApiMachineSocketFixture(options: {
    emitWithAck?: (event: string, payload: unknown) => Promise<unknown> | unknown;
} = {}) {
    return createApiSessionSocketStub({
        emitWithAck: async (event, payload) => {
            if (options.emitWithAck) return await options.emitWithAck(event, payload);
            if (event === 'machine-update-state' && payload && typeof payload === 'object') {
                return { result: 'success', version: 1,
                    daemonState: Reflect.get(payload, 'daemonState') };
            }
            if (event === 'machine-update-metadata' && payload && typeof payload === 'object') {
                return { result: 'success', version: 1,
                    metadata: Reflect.get(payload, 'metadata') };
            }
            return { result: 'success', version: 1 };
        },
    });
}

/** Keep background Account sockets from consuming the Machine reconnect sequence. */
export function bindApiMachineSocketSequenceMock(
    mockIo: ReturnType<typeof vi.fn>,
    sockets: readonly [ReturnType<typeof createApiMachineSocketFixture>, ...ReturnType<typeof createApiMachineSocketFixture>[]],
): void {
    const [firstSocket, ...remainingSockets] = sockets;
    const fallback = remainingSockets[remainingSockets.length - 1] ?? firstSocket;
    let nextMachineSocket = 0;
    mockIo.mockReset();
    mockIo.mockImplementation((_endpoint: unknown, options?: Readonly<{ auth?: Readonly<{ clientType?: string }> }>) => {
        if (options?.auth?.clientType === 'machine-scoped') return sockets[nextMachineSocket++] ?? fallback;
        return createApiMachineSocketFixture();
    });
}

/** Machine socket subscriptions and shutdown are the bootstrap transport boundary. */
export function createApiMachineTransportFixture() {
    return {
        onUpdate: vi.fn<ApiMachineClient['onUpdate']>(() => () => {}),
        onAccountSettingsVersionHint: vi.fn<ApiMachineClient['onAccountSettingsVersionHint']>(() => () => {}),
        onAccountProjectRowsChanged: vi.fn<ApiMachineClient['onAccountProjectRowsChanged']>(() => () => {}),
        onSessionFollowRulesChanged: vi.fn<ApiMachineClient['onSessionFollowRulesChanged']>(() => () => {}),
        onAutomationEventSourcesInvalidated: vi.fn<ApiMachineClient['onAutomationEventSourcesInvalidated']>(() => () => {}),
        onHealthCheckHeartbeatReceived: vi.fn<ApiMachineClient['onHealthCheckHeartbeatReceived']>(() => () => {}),
        onAutomationWorkInvalidated: vi.fn<ApiMachineClient['onAutomationWorkInvalidated']>(() => () => {}),
        onPendingSessionActivationHint: vi.fn<ApiMachineClient['onPendingSessionActivationHint']>(() => () => {}),
        onSessionDeletedChange: vi.fn<ApiMachineClient['onSessionDeletedChange']>(() => () => {}),
        onSessionChanged: vi.fn<ApiMachineClient['onSessionChanged']>(() => () => {}),
        onSessionAccessRevoked: vi.fn<ApiMachineClient['onSessionAccessRevoked']>(() => () => {}),
        onSessionAccessReset: vi.fn<ApiMachineClient['onSessionAccessReset']>(() => () => {}),
        onSessionTranscriptRevised: vi.fn<ApiMachineClient['onSessionTranscriptRevised']>(() => () => {}),
        onSessionArchivedStateChange: vi.fn<ApiMachineClient['onSessionArchivedStateChange']>(() => () => {}),
        onConnectionStateChange: vi.fn<ApiMachineClient['onConnectionStateChange']>(() => () => {}),
        onMachineTransferEnvelope: vi.fn<ApiMachineClient['onMachineTransferEnvelope']>(() => () => {}),
        onTransferRelayV2Envelope: vi.fn<ApiMachineClient['onTransferRelayV2Envelope']>(() => () => {}),
        onMachineLiveStreamRelayEnvelope: vi.fn<ApiMachineClient['onMachineLiveStreamRelayEnvelope']>(() => () => {}),
        onPeerTcpTunnelRelayEnvelope: vi.fn<ApiMachineClient['onPeerTcpTunnelRelayEnvelope']>(() => () => {}),
        shutdown: vi.fn<ApiMachineClient['shutdown']>(async () => {}),
    };
}
