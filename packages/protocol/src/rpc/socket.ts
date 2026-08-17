import { z } from 'zod';

import type { SocketRpcAuthorizationContext } from './index.js';

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

export const SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1 = 1 as const;

/**
 * Opaque, short-lived RPC correlation. The relay stamps a fresh value before it
 * reaches an RPC target, so a caller-local collision cannot cancel another
 * caller's request at that target.
 */
export const SocketRpcRequestIdSchema = z.string().trim().min(1).max(160);

export const SocketRpcCancellationPayloadSchema = z.object({
  requestId: SocketRpcRequestIdSchema,
}).strict();

export type SocketRpcCancellationPayload = z.infer<typeof SocketRpcCancellationPayloadSchema>;

export type SocketRpcRequestPayload = Readonly<{
  method: string;
  params: unknown;
  /**
   * Ephemeral transport correlation. Issuers use it to cancel their own
   * in-flight relay; the authenticated relay replaces it before target dispatch.
   */
  requestId?: string;
  authorization?: SocketRpcAuthorizationContext;
  timeoutMs?: number;
  transportResponseEnvelopeVersion?: typeof SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1;
}>;

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
}).strict().refine(
  (value) => Object.prototype.hasOwnProperty.call(value, 'result'),
  { message: 'result is required', path: ['result'] },
);

export type SocketRpcTransportResponseEnvelopeV1 =
  z.infer<typeof SocketRpcTransportResponseEnvelopeV1Schema>;
