import { Buffer } from 'node:buffer';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import {
  parseManagedServiceEndpointProjectionV1,
  type ManagedServiceEndpointProjectionV1,
} from '@/plugins/runtime/invocation/services/managedServiceEndpointProjection';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';
import {
  ManagedServiceLocalIdSchema,
  ProviderRuntimeBindingBasisV1Schema,
} from '@happier-dev/protocol';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc';
import { z } from 'zod';

import type {
  RunnerManagedProviderCustodyClaimV1,
} from './runnerManagedServicesCustody';

export const MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS = Object.freeze({
  OPEN: SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_OPEN_V1,
  NEXT: SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_NEXT_V1,
  CANCEL: SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_CANCEL_V1,
});

// Socket.IO acknowledgements require a finite timeout even though response
// body lifetime is owned by the caller, exact handle, and custody scope.
export const MANAGED_SERVICE_ENDPOINT_READ_NEXT_RPC_TIMEOUT_MS = 2_147_483_647;

const RequestIdSchema = z.string().uuid();
const ProjectionTokenSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ProjectionSchema = z.custom<ManagedServiceEndpointProjectionV1>(
  (value) => parseManagedServiceEndpointProjectionV1(value) !== null,
);
const CustodyIdentityPartSchema = z.string().min(1).max(1_024)
  .refine((value) => value === value.trim());
const CustodyClaimSchema: z.ZodType<RunnerManagedProviderCustodyClaimV1> =
  z.object({
    v: z.literal(1),
    sessionId: CustodyIdentityPartSchema,
    runtimeBindingBasis: ProviderRuntimeBindingBasisV1Schema,
    pluginId: CustodyIdentityPartSchema,
    providerLocalId: CustodyIdentityPartSchema,
    activationGeneration: CustodyIdentityPartSchema,
    immutableGenerationId: CustodyIdentityPartSchema,
    manifestAuthority: z.enum(['external', 'bundled_first_party']),
    operationClaimId: CustodyIdentityPartSchema,
  }).strict();
const RequestHeadersSchema = z.record(
  z.string().trim().min(1).max(128),
  z.string().max(8_192),
).refine((headers) => Object.keys(headers).length <= 64)
  .refine((headers) => Object.entries(headers).reduce(
    (total, [name, value]) => total
      + Buffer.byteLength(name)
      + Buffer.byteLength(value),
    0,
  ) <= 65_536);
const ResponseHeaderSchema = z.tuple([
  z.string().trim().min(1).max(128),
  z.string().max(8_192),
]);
const PathAndQuerySchema = z.string().min(1).max(16_384).refine(
  (value) => value.startsWith('/') && !value.startsWith('//') && !value.includes('#'),
);
const HttpMethodSchema = z.enum([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);
const CanonicalBodyBase64Schema = z.string().max(22_369_624).regex(
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
).refine(
  (value) => Buffer.from(value, 'base64').byteLength <= 16 * 1024 * 1024
    && Buffer.from(value, 'base64').toString('base64') === value,
  'Expected at most 16 MiB of canonical padded Base64',
);
const CanonicalChunkBase64Schema = z.string().max(87_384).regex(
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
).refine(
  (value) => Buffer.from(value, 'base64').byteLength <= 64 * 1024
    && Buffer.from(value, 'base64').toString('base64') === value,
  'Expected at most 64 KiB of canonical padded Base64',
);
const PositiveTimeoutSchema = z.number().int().min(1).max(2_147_483_647);
const HostManagedServiceLocalIdSchema = asHostProtocolZod(
  ManagedServiceLocalIdSchema,
);

const ExactHandleRouteSchema = z.object({
  kind: z.literal('exactHandle'),
  claim: CustodyClaimSchema,
  serviceId: HostManagedServiceLocalIdSchema,
}).strict();
const EndpointProjectionOpenRouteSchema = z.object({
  kind: z.literal('endpointProjection'),
  projection: ProjectionSchema,
}).strict();
const EndpointProjectionContinuationRouteSchema = z.object({
  kind: z.literal('endpointProjection'),
  projectionToken: ProjectionTokenSchema,
}).strict();

export const ManagedServiceEndpointReadOpenRequestV1Schema = z.union([
  z.object({
    v: z.literal(1),
    requestId: RequestIdSchema,
    route: EndpointProjectionOpenRouteSchema,
    pathAndQuery: PathAndQuerySchema,
    headers: RequestHeadersSchema,
  }).strict(),
  z.object({
    v: z.literal(1),
    requestId: RequestIdSchema,
    route: ExactHandleRouteSchema,
    pathAndQuery: PathAndQuerySchema,
    headers: RequestHeadersSchema,
    method: HttpMethodSchema.optional(),
    bodyBase64: CanonicalBodyBase64Schema.optional(),
    timeoutMs: PositiveTimeoutSchema.optional(),
  }).strict(),
]);

export const ManagedServiceEndpointReadOpenResultV1Schema = z.discriminatedUnion('status', [
  z.object({
    v: z.literal(1),
    requestId: RequestIdSchema,
    status: z.literal('opened'),
    response: z.object({
      status: z.number().int().min(200).max(599),
      statusText: z.string().max(1_024),
      headers: z.array(ResponseHeaderSchema).max(128).refine(
        (headers) => headers.reduce(
          (total, [name, value]) => total
            + Buffer.byteLength(name)
            + Buffer.byteLength(value),
          0,
        ) <= 65_536,
      ),
      hasBody: z.boolean(),
    }).strict(),
  }).strict(),
  z.object({
    v: z.literal(1),
    requestId: RequestIdSchema,
    status: z.literal('unavailable'),
  }).strict(),
]);

export const ManagedServiceEndpointReadNextRequestV1Schema = z.object({
  v: z.literal(1),
  requestId: RequestIdSchema,
  route: z.union([
    EndpointProjectionContinuationRouteSchema,
    ExactHandleRouteSchema,
  ]),
}).strict();

export const ManagedServiceEndpointReadNextResultV1Schema = z.discriminatedUnion('status', [
  z.object({
    v: z.literal(1),
    requestId: RequestIdSchema,
    status: z.literal('chunk'),
    dataBase64: CanonicalChunkBase64Schema,
  }).strict(),
  z.object({
    v: z.literal(1),
    requestId: RequestIdSchema,
    status: z.literal('end'),
  }).strict(),
  z.object({
    v: z.literal(1),
    requestId: RequestIdSchema,
    status: z.literal('unavailable'),
  }).strict(),
]);

export const ManagedServiceEndpointReadCancelRequestV1Schema =
  ManagedServiceEndpointReadNextRequestV1Schema;

export const ManagedServiceEndpointReadCancelResultV1Schema = z.object({
  v: z.literal(1),
  requestId: RequestIdSchema,
  status: z.literal('cancelled'),
  cancelled: z.boolean(),
}).strict();

export type ManagedServiceEndpointReadOpenRequestV1 = z.infer<
  typeof ManagedServiceEndpointReadOpenRequestV1Schema
>;
export type ManagedServiceEndpointReadOpenResultV1 = z.infer<
  typeof ManagedServiceEndpointReadOpenResultV1Schema
>;
export type ManagedServiceEndpointReadNextRequestV1 = z.infer<
  typeof ManagedServiceEndpointReadNextRequestV1Schema
>;
export type ManagedServiceEndpointReadNextResultV1 = z.infer<
  typeof ManagedServiceEndpointReadNextResultV1Schema
>;
export type ManagedServiceEndpointReadCancelRequestV1 = z.infer<
  typeof ManagedServiceEndpointReadCancelRequestV1Schema
>;
export type ManagedServiceEndpointReadCancelResultV1 = z.infer<
  typeof ManagedServiceEndpointReadCancelResultV1Schema
>;

export type RunnerManagedServiceEndpointReadPort = Readonly<{
  open(
    request: ManagedServiceEndpointReadOpenRequestV1,
    signal?: AbortSignal,
  ): Promise<ManagedServiceEndpointReadOpenResultV1>;
  next(
    request: ManagedServiceEndpointReadNextRequestV1,
    signal?: AbortSignal,
  ): Promise<ManagedServiceEndpointReadNextResultV1>;
  cancel(
    request: ManagedServiceEndpointReadCancelRequestV1,
  ): Promise<ManagedServiceEndpointReadCancelResultV1>;
}>;

export function registerRunnerManagedServiceEndpointReadRpcHandlers(
  rpc: RpcHandlerRegistrar,
  port: RunnerManagedServiceEndpointReadPort,
): void {
  rpc.registerHandler(
    MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.OPEN,
    async (raw, context) => await port.open(
      ManagedServiceEndpointReadOpenRequestV1Schema.parse(raw),
      context?.signal,
    ),
  );
  rpc.registerHandler(
    MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.NEXT,
    async (raw, context) => await port.next(
      ManagedServiceEndpointReadNextRequestV1Schema.parse(raw),
      context?.signal,
    ),
  );
  rpc.registerHandler(
    MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS.CANCEL,
    async (raw) => await port.cancel(
      ManagedServiceEndpointReadCancelRequestV1Schema.parse(raw),
    ),
  );
}
