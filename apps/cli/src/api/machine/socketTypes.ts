import type { SocketRpcCallPayload, SocketRpcCallResponse, SocketRpcRequestPayload, Update } from '../types';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import {
  EXTERNAL_SESSION_OPERATION_SOCKET_EVENT_V1,
  EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1,
  MACHINE_SESSION_TERMINAL_CAPTURE_EVENT_V1,
  MACHINE_SESSION_TERMINAL_FINALIZE_EVENT_V1,
  MACHINE_UPDATE_OPERATION_PROTOCOL_CAPABILITIES_EVENT_V1,
  SESSION_PENDING_ENQUEUE_BY_MACHINE_EVENT_V1,
  SESSION_SERVER_START_INGRESS_EVENT_V1,
  MACHINE_LIVE_STREAM_SOCKET_EVENT,
  PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
  TRANSFER_RELAY_V2_SOCKET_EVENT,
  type ExternalSessionTranscriptInvalidationV1,
  type ExternalSessionOperationSocketCommandV1,
  type ExternalSessionOperationSocketResponseV1,
  type ExternalSessionStatusDemandDaemonMessageV1,
  type MachineLiveStreamRelayEnvelopeV1,
  type MachineUpdateMetadataRequest,
  type MachineUpdateMetadataResponse,
  type MachineSessionTerminalCaptureRequestV1,
  type MachineSessionTerminalCaptureResponseV1,
  type MachineSessionTerminalFinalizeRequestV1,
  type MachineSessionTerminalFinalizeResponseV1,
  type MachineUpdateOperationProtocolCapabilitiesRequestV1,
  type MachineUpdateOperationProtocolCapabilitiesResponseV1,
  type SessionPendingEnqueueByMachineRequestV1,
  type SessionPendingEnqueueByMachineResponseV1,
  type SessionServerStartIngressRequestV1,
  type SessionServerStartIngressResponseV1,
  type MachineTransferReceiveEnvelope,
  type MachineTransferSendEnvelope,
  type PeerTcpTunnelRelayEnvelope,
  type TransferRelayV2SendEnvelope,
} from '@happier-dev/protocol';

export interface ServerToDaemonEvents {
  update: (data: Update) => void;
  [SOCKET_RPC_EVENTS.REQUEST]: (data: SocketRpcRequestPayload, callback: (response: unknown) => void) => void;
  [SOCKET_RPC_EVENTS.REGISTERED]: (data: { method: string }) => void;
  [SOCKET_RPC_EVENTS.UNREGISTERED]: (data: { method: string }) => void;
  [SOCKET_RPC_EVENTS.ERROR]: (data: { type: string; error: string }) => void;
  [SOCKET_RPC_EVENTS.MACHINE_TRANSFER_ENVELOPE]: (data: MachineTransferReceiveEnvelope) => void;
  [TRANSFER_RELAY_V2_SOCKET_EVENT]: (data: TransferRelayV2SendEnvelope) => void;
  [PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT]: (data: PeerTcpTunnelRelayEnvelope) => void;
  [MACHINE_LIVE_STREAM_SOCKET_EVENT]: (data: MachineLiveStreamRelayEnvelopeV1) => void;
  [EXTERNAL_SESSION_STATUS_DEMAND_EVENT_V1]: (data: ExternalSessionStatusDemandDaemonMessageV1) => void;
  auth: (data: { success: boolean; user: string }) => void;
  error: (data: { message: string }) => void;
}

export interface DaemonToServerEvents {
  'machine-alive': (data: { machineId: string; time: number }) => void;
  'session-end': (data: { sid: string; time: number; exit?: any }) => void;
  'external-session-transcript-invalidated': (data: ExternalSessionTranscriptInvalidationV1) => void;
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
  [MACHINE_LIVE_STREAM_SOCKET_EVENT]: (data: MachineLiveStreamRelayEnvelopeV1) => void;
}
