import { z } from 'zod';
import { lazySchema } from '../lazySchema.js';

export const CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_METADATA_KEY =
  'connectedServiceMaterializationIdentityV1' as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/**
 * The dev tree persists the identity timestamp as `createdAt`; this tree's canonical field is
 * `createdAtMs`. Accept both on read (sessions roam between trees), keep `createdAtMs` canonical
 * on output.
 */
function normalizeMaterializationIdentityInput(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  const { createdAt: legacyCreatedAt, ...rest } = record;
  if ('createdAtMs' in rest) return rest;
  if (typeof legacyCreatedAt === 'number') {
    return {
      ...rest,
      createdAtMs: legacyCreatedAt,
    };
  }
  return rest;
}

export function createConnectedServiceMaterializationIdentityV1Schema(zod: typeof z) {
  return zod.preprocess(
    normalizeMaterializationIdentityInput,
    zod
      .object({
        v: zod.literal(1),
        id: zod
          .string()
          .trim()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
        createdAtMs: zod.number().int().nonnegative(),
      })
      .passthrough(),
  );
}

export const ConnectedServiceMaterializationIdentityV1Schema =
  lazySchema(() => createConnectedServiceMaterializationIdentityV1Schema(z));
export type ConnectedServiceMaterializationIdentityV1 =
  z.infer<typeof ConnectedServiceMaterializationIdentityV1Schema>;

export function buildConnectedServiceMaterializationIdentityV1(
  params: Readonly<{ id: string; createdAtMs: number }>,
): ConnectedServiceMaterializationIdentityV1 {
  return ConnectedServiceMaterializationIdentityV1Schema.parse({
    v: 1,
    id: params.id,
    createdAtMs: params.createdAtMs,
  });
}

export function readConnectedServiceMaterializationIdentityV1FromMetadata(
  metadata: unknown,
): ConnectedServiceMaterializationIdentityV1 | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const parsed = ConnectedServiceMaterializationIdentityV1Schema.safeParse(
    (metadata as Record<string, unknown>)[CONNECTED_SERVICE_MATERIALIZATION_IDENTITY_METADATA_KEY],
  );
  return parsed.success ? parsed.data : null;
}
