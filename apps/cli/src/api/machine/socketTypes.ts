import type { SocketRpcCallPayload, SocketRpcCallResponse, SocketRpcRequestPayload, Update } from '../types';
import { SOCKET_RPC_EVENTS } from '@happier-dev/protocol/socketRpc';
import {
  MACHINE_LIVE_STREAM_SOCKET_EVENT,
  PEER_TCP_TUNNEL_RELAY_SOCKET_EVENT,
  TRANSFER_RELAY_V2_SOCKET_EVENT,
  type ExternalSessionTranscriptDeltaEphemeral,
  type MachineLiveStreamRelayEnvelopeV1,
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
  auth: (data: { success: boolean; user: string }) => void;
  error: (data: { message: string }) => void;
}

export interface DaemonToServerEvents {
  'machine-alive': (data: { machineId: string; time: number }) => void;
  'session-end': (data: { sid: string; time: number; exit?: any }) => void;
  'direct-session-transcript-delta': (data: ExternalSessionTranscriptDeltaEphemeral) => void;

  'machine-update-metadata': (
    data: { machineId: string; metadata: string; expectedVersion: number },
    cb: (
      answer:
        | { result: 'error' }
        | { result: 'version-mismatch'; version: number; metadata: string }
        | { result: 'success'; version: number; metadata: string }
    ) => void
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
