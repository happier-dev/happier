import type { SessionBroadcast, SocketRpcCallPayload, SocketRpcCallResponse, SocketRpcRequestPayload, Update } from '../types';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import { TEAM_CREDENTIAL_EXTERNAL_PROVIDER_OPERATION_RETIRE_EVENT_V1 } from '@happier-dev/protocol/teams/credentials/externalProviderApiV1';
import type { TeamCredentialExternalProviderOperationRetireV1, TeamCredentialExternalProviderOperationRetireResponseV1 } from '@happier-dev/protocol/teams';
import { EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1 } from '@happier-dev/protocol/sessions/external/operationActionsV1';
import { EXTERNAL_SESSION_SOURCE_UNAVAILABLE_OCCURRENCE_EVENT_V1 } from '@happier-dev/protocol/sessions/external/secureRefreshV1';
import { EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1 } from '@happier-dev/protocol/sessions/external/statusDemandV1';
import { MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1, MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1 } from '@happier-dev/protocol/sessions/control/machineSessionTerminalV1';
import { SESSION_SERVER_START_INGRESS_EVENT_V1 } from '@happier-dev/protocol/sessions/creation/sessionServerStartV1';
import { ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1 } from '@happier-dev/protocol/actions/operations/v1';
import { MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1 } from '@happier-dev/protocol/machines/operationProtocolCapabilitiesV1';
import { SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1 } from '@happier-dev/protocol/sessions/messages/sessionPendingMachineAdmissionV1';
import { SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2 } from '@happier-dev/protocol/sessions/messages/sessionPendingExecutionRunMachineAdmissionV2';
import type { SessionPendingExecutionRunEnqueueByMachineRequestV2, SessionPendingExecutionRunEnqueueByMachineResponseV2, ExternalSessionTranscriptInvalidationV1, ExternalSessionSourceUnavailableOccurrenceV1, ActionOperationRevisionEphemeralV1, ExternalSessionOperationSocketCommandV1, ExternalSessionOperationSocketResponseV1, ExternalSessionStatusDemandDaemonMessageV1, MachineLiveStreamWireEnvelopeV1, MachineUpdateMetadataRequest, MachineUpdateMetadataResponse, MachineSessionTerminalCaptureRequestV1, MachineSessionTerminalCaptureResponseV1, MachineSessionTerminalFinalizeRequestV1, MachineSessionTerminalFinalizeResponseV1, MachineUpdateOperationProtocolCapabilitiesRequestV1, MachineUpdateOperationProtocolCapabilitiesResponseV1, SessionPendingEnqueueByMachineRequestV1, SessionPendingEnqueueByMachineResponseV1, SessionServerStartIngressRequestV1, SessionServerStartIngressResponseV1, MachineTransferReceiveEnvelope, MachineTransferSendEnvelope, PeerTcpTunnelRelayEnvelope, TransferRelayV2SendEnvelope } from '@happier-dev/protocol';
import { MACHINE_LIVE_STREAM_SOCKET_EVENT } from '@happier-dev/protocol/machines/peer/mediation/stream/v1';
import { PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT } from '@happier-dev/protocol/machines/peer/mediation/tunnel/relay';
import { TRANSFER_RELAY_V2_SOCKET_EVENT } from '@happier-dev/protocol/transfers/relay/v2/socketEvents';

export interface ServerToDaemonEvents {
  update: (data: Update) => void;
  session: (data: SessionBroadcast) => void;
  [SOCKET_RPC_EVENTS.REQUEST]: (data: SocketRpcRequestPayload, callback: (response: unknown) => void) => void;
  [SOCKET_RPC_EVENTS.REGISTERED]: (data: { method: string }) => void;
  [SOCKET_RPC_EVENTS.UNREGISTERED]: (data: { method: string }) => void;
  [SOCKET_RPC_EVENTS.ERROR]: (data: { type: string; error: string }) => void;
  [SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE]: (data: MachineTransferReceiveEnvelope) => void;
  [TRANSFER_RELAY_V2_SOCKET_EVENT]: (data: TransferRelayV2SendEnvelope) => void;
  [PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT]: (data: PeerTcpTunnelRelayEnvelope) => void;
  [MACHINE_LIVE_STREAM_SOCKET_EVENT]: (data: MachineLiveStreamWireEnvelopeV1) => void;
  [EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1]: (data: ExternalSessionStatusDemandDaemonMessageV1) => void;
  auth: (data: { success: boolean; user: string }) => void;
  error: (data: { message: string }) => void;
}

export interface DaemonToServerEvents {
  [TEAM_CREDENTIAL_EXTERNAL_PROVIDER_OPERATION_RETIRE_EVENT_V1]: (
    data: TeamCredentialExternalProviderOperationRetireV1,
    cb: (answer: TeamCredentialExternalProviderOperationRetireResponseV1) => void,
  ) => void;
  'machine-alive': (data: { machineId: string; time: number }) => void;
  'session-end': (data: { sid: string; time: number; exit?: any }) => void;
  [ACTION_OPERATION_REVISION_EPHEMERAL_EVENT_V1]: (data: ActionOperationRevisionEphemeralV1) => void;
  'external-session-transcript-invalidated': (data: ExternalSessionTranscriptInvalidationV1) => void;
  [EXTERNAL_SESSION_SOURCE_UNAVAILABLE_OCCURRENCE_EVENT_V1]: (data: ExternalSessionSourceUnavailableOccurrenceV1) => void;
  [EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1]: (
    data: ExternalSessionOperationSocketCommandV1,
    cb: (answer: ExternalSessionOperationSocketResponseV1) => void,
  ) => void;
  [MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1]: (
    data: MachineSessionTerminalCaptureRequestV1,
    cb: (answer: MachineSessionTerminalCaptureResponseV1) => void,
  ) => void;
  [MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1]: (
    data: MachineSessionTerminalFinalizeRequestV1,
    cb: (answer: MachineSessionTerminalFinalizeResponseV1) => void,
  ) => void;
  [MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1]: (
    data: MachineUpdateOperationProtocolCapabilitiesRequestV1,
    cb: (answer: MachineUpdateOperationProtocolCapabilitiesResponseV1) => void,
  ) => void;
  [SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1]: (
    data: SessionPendingEnqueueByMachineRequestV1,
    cb: (answer: SessionPendingEnqueueByMachineResponseV1) => void,
  ) => void;
  [SESSION_PENDING_EXECUTION_RUN_ENQUEUE_BY_MACHINE_EVENT_V2]: (
    data: SessionPendingExecutionRunEnqueueByMachineRequestV2,
    cb: (answer: SessionPendingExecutionRunEnqueueByMachineResponseV2) => void,
  ) => void;
  [SESSION_SERVER_START_INGRESS_EVENT_V1]: (
    data: SessionServerStartIngressRequestV1,
    cb: (answer: SessionServerStartIngressResponseV1) => void,
  ) => void;

  'machine-update-metadata': (
    data: MachineUpdateMetadataRequest,
    cb: (answer: MachineUpdateMetadataResponse) => void
  ) => void;

  'machine-update-state': (
    data: { machineId: string; daemonState: string; expectedVersion: number },
    cb: (
      answer:
        | { result: 'error' }
        | { result: 'version-mismatch'; version: number; daemonState: string }
        | { result: 'success'; version: number; daemonState: string }
    ) => void
  ) => void;

  [SOCKET_RPC_EVENTS.REGISTER]: (data: { method: string }) => void;
  [SOCKET_RPC_EVENTS.UNREGISTER]: (data: { method: string }) => void;
  [SOCKET_RPC_EVENTS.CALL]: (
    data: SocketRpcCallPayload,
    callback: (response: SocketRpcCallResponse) => void
  ) => void;
  [SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE]: (data: MachineTransferSendEnvelope) => void;
  [TRANSFER_RELAY_V2_SOCKET_EVENT]: (data: TransferRelayV2SendEnvelope) => void;
  [PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT]: (data: PeerTcpTunnelRelayEnvelope) => void;
  [MACHINE_LIVE_STREAM_SOCKET_EVENT]: (data: MachineLiveStreamWireEnvelopeV1) => void;
}
