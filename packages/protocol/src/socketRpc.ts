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

/** Engine.IO heartbeat of the relay: it pings every interval and drops a client whose pong is late. */
export const SOCKET_RPC_PING_INTERVAL_MS = 15_000;
export const SOCKET_RPC_PING_TIMEOUT_MS = 45_000;

/**
 * Slowest daemon → relay uplink a single reply packet must survive.
 *
 * The pong a client owes after a ping is queued behind any packet it is already uploading, so a
 * packet that takes longer than SOCKET_RPC_PING_TIMEOUT_MS to upload makes the relay close the
 * whole socket ("ping timeout") well below maxHttpBufferSize. Depending on where the upload falls
 * in the ping cycle it has between SOCKET_RPC_PING_TIMEOUT_MS and SOCKET_RPC_PING_INTERVAL_MS +
 * SOCKET_RPC_PING_TIMEOUT_MS; only the first is guaranteed. Field evidence: an operator daemon
 * delivered 11.03 MB `scm.status.snapshot` replies for a week and lost its socket on every
 * 12–17 MB one. This floor is the slowest uplink that still carries those 11.03 MB within the
 * heartbeat deadline (~1.96 Mbit/s). Daemons on faster links can raise their ceiling with
 * HAPPIER_RPC_RESPONSE_MAX_BYTES.
 */
export const SOCKET_RPC_MIN_SUPPORTED_UPLINK_BYTES_PER_SECOND = Math.floor(11_030_000 / (SOCKET_RPC_PING_TIMEOUT_MS / 1_000));

/** Largest packet that finishes uploading before the relay's pong deadline at `uplinkBytesPerSecond`. */
export function resolveSocketRpcHeartbeatPacketMaxBytes(params: Readonly<{
  pingTimeoutMs: number;
  uplinkBytesPerSecond: number;
}>): number {
  return Math.floor((params.pingTimeoutMs / 1_000) * params.uplinkBytesPerSecond);
}

/**
 * Largest reply payload one packet can carry by default without the relay dropping the socket:
 * the smaller of its packet limit and what the supported uplink uploads before the pong deadline.
 */
export const SOCKET_RPC_DEFAULT_RESPONSE_MAX_BYTES = Math.min(
  SOCKET_RPC_DEFAULT_MAX_HTTP_BUFFER_BYTES,
  resolveSocketRpcHeartbeatPacketMaxBytes({
    pingTimeoutMs: SOCKET_RPC_PING_TIMEOUT_MS,
    uplinkBytesPerSecond: SOCKET_RPC_MIN_SUPPORTED_UPLINK_BYTES_PER_SECOND,
  }),
) - SOCKET_RPC_RESPONSE_PACKET_FRAMING_MAX_BYTES;

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
