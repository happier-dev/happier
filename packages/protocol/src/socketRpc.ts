import { z } from 'zod';

import type { SocketRpcAuthorizationContext } from './rpc.js';
import { lazySchema } from './lazySchema.js';

export const SOCKET_RPC_EVENTS = {
  REGISTER: 'rpc-register',
  REGISTERED: 'rpc-registered',
  UNREGISTER: 'rpc-unregister',
  UNREGISTERED: 'rpc-unregistered',
  ERROR: 'rpc-error',
  CALL: 'rpc-call',
  REQUEST: 'rpc-request',
  CANCEL: 'rpc-cancel',
  MACHINE_TRANSFER_ENVELOPE: 'machine-transfer-envelope',
} as const;

export type SocketRpcEvent = (typeof SOCKET_RPC_EVENTS)[keyof typeof SOCKET_RPC_EVENTS];

/**
 * Opaque, short-lived transport correlation. The authenticated relay replaces
 * caller values before dispatch so one caller cannot cancel another's work.
 */
export const SocketRpcRequestIdSchema = lazySchema(() => z.string().trim().min(1).max(160));

export const SocketRpcCancellationPayloadSchema = lazySchema(() => z.object({
  requestId: SocketRpcRequestIdSchema,
}).strict());

export type SocketRpcCancellationPayload = z.infer<typeof SocketRpcCancellationPayloadSchema>;

export type SocketRpcRequestPayload = Readonly<{
  method: string;
  params: unknown;
  requestId?: string;
  authorization?: SocketRpcAuthorizationContext;
  transportResponseEnvelopeVersion?: 1;
}>;

export const SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1 = 1 as const;

/**
 * Default Socket.IO `maxHttpBufferSize` of the relay: the largest packet it accepts from a
 * client. A larger packet makes Socket.IO close the whole connection, so it is the boundary a
 * daemon reply must fit in. Operators can change the relay value with
 * HAPPIER_SOCKET_MAX_HTTP_BUFFER_SIZE.
 */
export const SOCKET_RPC_DEFAULT_MAX_HTTP_BUFFER_BYTES = 25_000_000;

/**
 * Bytes a reply packet adds around the reply payload: the Engine.IO/Socket.IO ack prefix (`43`),
 * the ack id at Socket.IO's numeric counter ceiling (2^53), and the argument array with the v1
 * transport envelope around an empty result. Base64 results contain no JSON-escaped characters.
 */
export const SOCKET_RPC_RESPONSE_PACKET_FRAMING_MAX_BYTES =
  `43${Number.MAX_SAFE_INTEGER + 1}${JSON.stringify([{ v: SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1, result: '' }])}`.length;

/** Largest reply payload that fits in one packet the relay accepts by default. */
export const SOCKET_RPC_DEFAULT_RESPONSE_MAX_BYTES =
  SOCKET_RPC_DEFAULT_MAX_HTTP_BUFFER_BYTES - SOCKET_RPC_RESPONSE_PACKET_FRAMING_MAX_BYTES;

export const SocketRpcTransportAcknowledgementV1Schema = lazySchema(() => z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('session.stop'),
    status: z.literal('stopped'),
  }).strict(),
]));

export type SocketRpcTransportAcknowledgementV1 =
  z.infer<typeof SocketRpcTransportAcknowledgementV1Schema>;

export const SocketRpcTransportResponseEnvelopeV1Schema = lazySchema(() => z.object({
  v: z.literal(SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1),
  result: z.unknown(),
  acknowledgement: SocketRpcTransportAcknowledgementV1Schema.optional(),
}).strict().refine(
  (value) => Object.prototype.hasOwnProperty.call(value, 'result'),
  { path: ['result'], message: 'result is required' },
));

export type SocketRpcTransportResponseEnvelopeV1 =
  z.infer<typeof SocketRpcTransportResponseEnvelopeV1Schema>;

export type SocketRpcTargetFailureV1 = Readonly<{
  type: 'socket-rpc-target-failure-v1';
  errorCode: string;
  error: string;
}>;
