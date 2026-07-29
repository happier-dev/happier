import { z } from 'zod';

export const SOCKET_RPC_EVENTS = {
  REGISTER: 'rpc-register',
  REGISTERED: 'rpc-registered',
  UNREGISTER: 'rpc-unregister',
  UNREGISTERED: 'rpc-unregistered',
  ERROR: 'rpc-error',
  CALL: 'rpc-call',
  REQUEST: 'rpc-request',
  MACHINE_TRANSFER_ENVELOPE: 'machine-transfer-envelope',
} as const;

export type SocketRpcEvent = (typeof SOCKET_RPC_EVENTS)[keyof typeof SOCKET_RPC_EVENTS];

export const SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1 = 1 as const;

export const SocketRpcTransportAcknowledgementV1Schema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('session.stop'),
    status: z.literal('stopped'),
  }).strict(),
]);

export type SocketRpcTransportAcknowledgementV1 =
  z.infer<typeof SocketRpcTransportAcknowledgementV1Schema>;

export const SocketRpcTransportResponseEnvelopeV1Schema = z.object({
  v: z.literal(SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1),
  result: z.unknown(),
  acknowledgement: SocketRpcTransportAcknowledgementV1Schema.optional(),
}).strict();

export type SocketRpcTransportResponseEnvelopeV1 =
  z.infer<typeof SocketRpcTransportResponseEnvelopeV1Schema>;
