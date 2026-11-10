import { z } from '../../zodRuntimePolicy.js';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { StrictJsonValueSchema } from '../../json/strictJsonValue.js';
import { RPC_METHODS } from '../../rpc/methods.js';

/** Only the incumbent prepared-capability HTTP phases may cross Machine RPC. */
export function resolvePreparedTransferRpcPhaseV1(path: string, httpMethod: string, body?: unknown): string | null {
  const upload = /^\/machine-transfers\/direct\/imports\/[^/?#]+\/(chunks\/(?:0|[1-9]\d*)|finalize|abort)$/.exec(path);
  if (upload) {
    if (upload[1]?.startsWith('chunks/') && httpMethod === 'PUT') return RPC_METHODS.DAEMON_TRANSFER_UPLOAD_CHUNK;
    if (upload[1] === 'finalize' && httpMethod === 'POST') return RPC_METHODS.DAEMON_TRANSFER_UPLOAD_FINALIZE;
    if (upload[1] === 'abort' && httpMethod === 'POST') return RPC_METHODS.DAEMON_TRANSFER_UPLOAD_ABORT;
    return null;
  }
  const download = /^\/machine-transfers\/direct\/(?!imports\/)[^/?#]+\/(open|chunks\/(?:0|[1-9]\d*)|complete)$/.exec(path);
  if (download?.[1] === 'open' && httpMethod === 'POST') return RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_INIT;
  if (download?.[1]?.startsWith('chunks/') && httpMethod === 'GET') return RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_CHUNK;
  if (download?.[1] === 'complete' && httpMethod === 'POST') return body && typeof body === 'object'
    && 'success' in body && body.success === false
    ? RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_ABORT : RPC_METHODS.DAEMON_TRANSFER_DOWNLOAD_FINALIZE;
  return null;
}

export const PreparedTransferRpcRequestV1Schema = lazyZodSchema(() => z.strictObject({
  t: z.literal('prepared_machine_transfer_v1'),
  path: z.string().check(z.minLength(1)),
  httpMethod: z.enum(['GET', 'POST', 'PUT']),
  authorizationToken: z.optional(z.string().check(z.minLength(1))),
  recipientPublicKeyBase64: z.optional(z.string().check(z.minLength(1))),
  body: z.optional(StrictJsonValueSchema),
}).check(z.refine(value => resolvePreparedTransferRpcPhaseV1(value.path, value.httpMethod, value.body) !== null), z.refine(value => value.path.startsWith('/machine-transfers/direct/imports/') || Boolean(value.authorizationToken))));
export type PreparedTransferRpcRequestV1 = z.infer<typeof PreparedTransferRpcRequestV1Schema>;

/** HTTP framing only; encrypted chunk and terminal bodies keep their incumbent strict schemas. */
export const PreparedTransferRpcResponseV1Schema = lazyZodSchema(() => z.strictObject({
  status: z.number().check(z.int(), z.minimum(100), z.maximum(599)),
  body: z.string(),
  contentType: z.optional(z.string()),
  sessionExpiresAt: z.optional(z.string()),
}));
export type PreparedTransferRpcResponseV1 = z.infer<typeof PreparedTransferRpcResponseV1Schema>;
