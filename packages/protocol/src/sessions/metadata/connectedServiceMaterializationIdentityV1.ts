import { z } from '../../zodRuntimePolicy.js';

export const CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_METADATA_KEY =
  'connectedServiceMaterializationIdentityV1' as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeMaterializationIdentityInput(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;

  const { createdAtMs: legacyCreatedAtMs, ...rest } = record;
  if ('createdAt' in rest) return rest;
  if (typeof legacyCreatedAtMs === 'number') {
    return {
      ...rest,
      createdAt: legacyCreatedAtMs,
    };
  }
  return rest;
}

export function createConnectedServiceMaterializationIdentityV1Schema(zod: typeof z) {
  return (<I extends z.core.$ZodType, O extends z.core.$ZodType>(input: I, output: O) => new zod.ZodMiniPipe({ type: 'pipe', in: input, out: output }) as z.ZodMiniPipe<I, O>)(zod.transform(normalizeMaterializationIdentityInput), zod.looseObject({
      v: zod.literal(1),
      id: zod
        .string().check(zod.trim(), zod.minLength(1), zod.maxLength(128), zod.regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)),
      createdAt: zod.number().check(zod.int(), zod.minimum(0)),
      source: zod.optional(zod.string().check(zod.trim(), zod.minLength(1), zod.maxLength(64))),
    }));
}

export const ConnectedServiceMaterializationIdentityV1Schema =
  createConnectedServiceMaterializationIdentityV1Schema(z);

export type ConnectedServiceMaterializationIdentityV1 =
  z.infer<typeof ConnectedServiceMaterializationIdentityV1Schema>;

export function readConnectedServiceMaterializationIdentityV1FromMetadata(
  metadata: unknown,
): ConnectedServiceMaterializationIdentityV1 | null {
  const record = asRecord(metadata);
  if (!record) return null;
  const parsed = ConnectedServiceMaterializationIdentityV1Schema.safeParse(
    record[CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_METADATA_KEY],
  );
  return parsed.success ? parsed.data : null;
}

export function writeConnectedServiceMaterializationIdentityV1ToMetadata<TMetadata extends Record<string, unknown>>(
  metadata: TMetadata,
  identity: ConnectedServiceMaterializationIdentityV1,
): TMetadata & {
  connectedServiceMaterializationIdentityV1: ConnectedServiceMaterializationIdentityV1;
} {
  return {
    ...metadata,
    [CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_METADATA_KEY]: identity,
  };
}
