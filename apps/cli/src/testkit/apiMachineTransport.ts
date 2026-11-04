import { vi } from 'vitest';

import type { ApiMachineClient } from '@/api/apiMachine';
import type { MachineActionDirectTargetTransport } from '@/session/actions/cliActionDeps/types';

/** Installed local Machine RPC boundary beside an in-process Session transport. */
export function createLocalMachineActionTransportFixture(machineId: string): MachineActionDirectTargetTransport {
    return { machineId, invoke: async method => { throw new Error(`Unexpected local Machine RPC: ${method}`); } };
}


/** Machine socket subscriptions and shutdown are the bootstrap transport boundary. */
export function createApiMachineTransportFixture() {
    return {
        onUpdate: vi.fn<ApiMachineClient['onUpdate']>(() => () => {}),
        onAccountSettingsVersionHint: vi.fn<ApiMachineClient['onAccountSettingsVersionHint']>(() => () => {}),
        onAccountProjectRowsChanged: vi.fn<ApiMachineClient['onAccountProjectRowsChanged']>(() => () => {}),
        onSessionFollowRulesChanged: vi.fn<ApiMachineClient['onSessionFollowRulesChanged']>(() => () => {}),
        onAutomationEventSourcesInvalidated: vi.fn<ApiMachineClient['onAutomationEventSourcesInvalidated']>(() => () => {}),
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
