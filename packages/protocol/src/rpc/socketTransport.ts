import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';

export const SOCKET_RPC_EVENTS = {
  REGISTER: 'rpc-register',
  REGISTERED: 'rpc-registered',
  REGISTERED_BATCH: 'rpc-registered-batch',
  UNREGISTER: 'rpc-unregister',
  UNREGISTERED: 'rpc-unregistered',
  ERROR: 'rpc-error',
  CALL: 'rpc-call',
  REQUEST: 'rpc-request',
  CANCEL: 'rpc-cancel',
  CONTINUATION: 'rpc-continuation',
  MACHINE_TRANSFER_ENVELOPE: 'machine-transfer-envelope',
} as const;

export type SocketRpcEvent = (typeof SOCKET_RPC_EVENTS)[keyof typeof SOCKET_RPC_EVENTS];

export const SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1 = 1 as const;

/**
 * Opaque, short-lived RPC correlation. The relay stamps a fresh value before it
 * reaches an RPC target, so a caller-local collision cannot cancel another
 * caller's request at that target.
 */
export const SocketRpcRequestIdSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1), z.maxLength(160)));

export const SocketRpcCancellationPayloadSchema = lazyZodSchema(() => z.strictObject({
  requestId: SocketRpcRequestIdSchema,
}));

export type SocketRpcCancellationPayload = z.infer<typeof SocketRpcCancellationPayloadSchema>;

export const SocketRpcTransportAcknowledgementV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('session.stop'),
    status: z.literal('stopped'),
  }),
]));

export type SocketRpcTransportAcknowledgementV1 =
  z.infer<typeof SocketRpcTransportAcknowledgementV1Schema>;

export const SocketRpcTransportResponseEnvelopeV1Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(SOCKET_RPC_TRANSPORT_RESPONSE_ENVELOPE_VERSION_V1),
  result: z.unknown(),
  acknowledgement: z.optional(SocketRpcTransportAcknowledgementV1Schema),
}).check(z.refine((value) => Object.prototype.hasOwnProperty.call(value, 'result'), { message: 'result is required', path: ['result'] })));

export type SocketRpcTransportResponseEnvelopeV1 =
  z.infer<typeof SocketRpcTransportResponseEnvelopeV1Schema>;

/** The relay's caller acknowledgement for one target response (envelope v1 or a bare result). */
export function projectSocketRpcTargetAcknowledgementV1(response: unknown): Readonly<{
  ok: true; result: unknown; transportAcknowledgement?: SocketRpcTransportAcknowledgementV1;
}> {
  const envelope = SocketRpcTransportResponseEnvelopeV1Schema.safeParse(response);
  return {
    ok: true,
    result: envelope.success ? envelope.data.result : response,
    ...(envelope.success && envelope.data.acknowledgement ? { transportAcknowledgement: envelope.data.acknowledgement } : {}),
  };
}
