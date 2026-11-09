import { Buffer } from 'node:buffer';
import { MAX_MANAGED_SERVICE_REQUEST_BODY_BYTES } from '@/plugins/runtime/invocation/services/managedServiceRequestSize';

import type { RpcHandlerRegistrar } from '@/api/rpc/types';
import {
  parseManagedServiceEndpointProjectionV1,
  type ManagedServiceEndpointProjectionV1,
} from '@/plugins/runtime/invocation/services/managedServiceEndpointProjection';
import { asHostProtocolZod } from '@/plugins/runtime/protocolComposableZodAdapter';
import { ManagedServiceLocalIdSchema } from '@happier-dev/protocol/plugins/contribution-identity';
import { PluginSourceCustodyV1Schema } from '@happier-dev/protocol/plugins/runtime/sourceCustody';
import { ProviderRuntimeBindingBasisV1Schema } from '@happier-dev/protocol/providers/sessions/bindingMetadataV1';
import { SESSION_RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { z } from 'zod/mini';

import type {
  RunnerManagedProviderCustodyClaimV1,
} from './runnerManagedServicesCustody';

export const MANAGED_SERVICE_ENDPOINT_READ_RPC_METHODS = Object.freeze({
  OPEN: SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_OPEN_V1,
  NEXT: SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_NEXT_V1,
  CANCEL: SESSION_RPC_METHODS.SESSION_MANAGED_SERVICE_ENDPOINT_READ_CANCEL_V1,
});

const RequestIdSchema = z.string().check(z.uuid());
const ProjectionTokenSchema = z.string().check(z.regex(/^[a-f0-9]{64}$/u));
const ProjectionSchema = z.custom<ManagedServiceEndpointProjectionV1>(
  (value) => parseManagedServiceEndpointProjectionV1(value) !== null,
);
const CustodyIdentityPartSchema = z.string().check(z.minLength(1), z.maxLength(1_024), z.refine((value) => value === value.trim()));
const CustodyClaimSchema: z.ZodMiniType<RunnerManagedProviderCustodyClaimV1> =
  z.strictObject({
    v: z.literal(1),
    sessionId: CustodyIdentityPartSchema,
    runtimeBindingBasis: ProviderRuntimeBindingBasisV1Schema,
    pluginId: CustodyIdentityPartSchema,
    providerLocalId: CustodyIdentityPartSchema,
    occurrenceId: CustodyIdentityPartSchema,
    sourceCustody: asHostProtocolZod(PluginSourceCustodyV1Schema),
    manifestAuthority: z.enum(['external', 'bundled_first_party']),
    operationClaimId: CustodyIdentityPartSchema,
  });
const RequestHeadersSchema = z.record(
  z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  z.string().check(z.maxLength(8_192)),
).check(z.refine((headers) => Object.keys(headers).length <= 64), z.refine((headers) => Object.entries(headers).reduce(
    (total, [name, value]) => total
      + Buffer.byteLength(name)
      + Buffer.byteLength(value),
    0,
  ) <= 65_536));
const ResponseHeaderSchema = z.tuple([
  z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
  z.string().check(z.maxLength(8_192)),
]);
const PathAndQuerySchema = z.string().check(z.minLength(1), z.maxLength(16_384), z.refine((value) => value.startsWith('/') && !value.startsWith('//') && !value.includes('#')));
const HttpMethodSchema = z.enum([
  'GET',
  'HEAD',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'OPTIONS',
]);
const CanonicalBodyBase64Schema = z.string().check(z.maxLength(Math.ceil(MAX_MANAGED_SERVICE_REQUEST_BODY_BYTES / 3) * 4), z.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u), z.refine((value) => Buffer.from(value, 'base64').byteLength <= MAX_MANAGED_SERVICE_REQUEST_BODY_BYTES
    && Buffer.from(value, 'base64').toString('base64') === value, 'Expected at most 16 MiB of canonical padded Base64'));
const CanonicalChunkBase64Schema = z.string().check(z.maxLength(87_384), z.regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u), z.refine((value) => Buffer.from(value, 'base64').byteLength <= 64 * 1024
    && Buffer.from(value, 'base64').toString('base64') === value, 'Expected at most 64 KiB of canonical padded Base64'));
const PositiveTimeoutSchema = z.number().check(z.int(), z.minimum(1), z.maximum(2_147_483_647));
const HostManagedServiceLocalIdSchema = asHostProtocolZod(
  ManagedServiceLocalIdSchema,
);

const ExactHandleRouteSchema = z.strictObject({
  kind: z.literal('exactHandle'),
  claim: CustodyClaimSchema,
  serviceId: HostManagedServiceLocalIdSchema,
});
const EndpointProjectionOpenRouteSchema = z.strictObject({
  kind: z.literal('endpointProjection'),
  projection: ProjectionSchema,
});
const EndpointClientEnvironmentRouteSchema = z.strictObject({
  kind: z.literal('endpointClientEnvironment'),
  projection: ProjectionSchema,
  environmentKey: z.string().check(z.trim(), z.minLength(1), z.maxLength(128), z.regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)),
});
const EndpointProjectionContinuationRouteSchema = z.strictObject({
  kind: z.literal('endpointProjection'),
  projectionToken: ProjectionTokenSchema,
});

export const ManagedServiceEndpointReadOpenRequestV1Schema = z.union([
  z.strictObject({
    v: z.literal(1),
    requestId: RequestIdSchema,
    route: EndpointClientEnvironmentRouteSchema,
  }),
  z.strictObject({
    v: z.literal(1),
    requestId: RequestIdSchema,
    route: EndpointProjectionOpenRouteSchema,
    pathAndQuery: PathAndQuerySchema,
    headers: RequestHeadersSchema,
    interactive: z.optional(z.literal(true)),
  }),
  z.strictObject({
    v: z.literal(1),
    requestId: RequestIdSchema,
    route: ExactHandleRouteSchema,
    pathAndQuery: PathAndQuerySchema,
    headers: RequestHeadersSchema,
    interactive: z.optional(z.literal(true)),
    method: z.optional(HttpMethodSchema),
    bodyBase64: z.optional(CanonicalBodyBase64Schema),
    timeoutMs: z.optional(PositiveTimeoutSchema),
  }),
]);

export const ManagedServiceEndpointReadOpenResultV1Schema = z.discriminatedUnion('status', [
  z.strictObject({
    v: z.literal(1),
    requestId: RequestIdSchema,
    status: z.literal('clientEnvironment'),
    environment: z.record(
      z.string().check(z.trim(), z.minLength(1), z.maxLength(128)),
      z.string().check(z.maxLength(8_192)),
    ).check(z.refine((environment) => Object.keys(environment).length <= 1)),
  }),
  z.strictObject({
    v: z.literal(1),
    requestId: RequestIdSchema,
    status: z.literal('opened'),
    response: z.strictObject({
      status: z.number().check(z.int(), z.minimum(200), z.maximum(599)),
      statusText: z.string().check(z.maxLength(1_024)),
      headers: z.array(ResponseHeaderSchema).check(z.maxLength(128), z.refine((headers) => headers.reduce(
          (total, [name, value]) => total
            + Buffer.byteLength(name)
            + Buffer.byteLength(value),
          0,
        ) <= 65_536)),
      hasBody: z.boolean(),
    }),
  }),
  z.strictObject({
    v: z.literal(1),
    requestId: RequestIdSchema,
    status: z.literal('unavailable'),
  }),
]);

export const ManagedServiceEndpointReadNextRequestV1Schema = z.strictObject({
  v: z.literal(1),
  requestId: RequestIdSchema,
  route: z.union([
    EndpointProjectionContinuationRouteSchema,
    ExactHandleRouteSchema,
  ]),
});

export const ManagedServiceEndpointReadNextResultV1Schema = z.discriminatedUnion('status', [
  z.strictObject({
    v: z.literal(1),
    requestId: RequestIdSchema,
    status: z.literal('chunk'),
    dataBase64: CanonicalChunkBase64Schema,
  }),
  z.strictObject({
    v: z.literal(1),
    requestId: RequestIdSchema,
    status: z.literal('end'),
  }),
  z.strictObject({
    v: z.literal(1),
    requestId: RequestIdSchema,
    status: z.literal('unavailable'),
  }),
]);

export const ManagedServiceEndpointReadCancelRequestV1Schema =
  ManagedServiceEndpointReadNextRequestV1Schema;

export const ManagedServiceEndpointReadCancelResultV1Schema = z.strictObject({
  v: z.literal(1),
  requestId: RequestIdSchema,
  status: z.literal('cancelled'),
  cancelled: z.boolean(),
});

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
