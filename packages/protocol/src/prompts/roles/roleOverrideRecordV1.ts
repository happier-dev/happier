import { z } from 'zod';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { RoleInstructionsOverrideV1Schema } from './rolesV1.js';

/** Documents remain Artifacts; this catalog owns only the reader's overrides. */
export const RoleOverrideCatalogV1Schema = lazyZodSchema(() => z.object({
  overrides: z.record(z.string().min(1), RoleInstructionsOverrideV1Schema),
}).strict().superRefine((value, context) => {
  for (const [roleId, override] of Object.entries(value.overrides)) {
    if (roleId !== override.roleId) context.addIssue({
      code: 'custom', path: ['overrides', roleId, 'roleId'], message: 'Role override id must match its record key',
    });
  }
}));
export type RoleOverrideCatalogV1 = z.infer<typeof RoleOverrideCatalogV1Schema>;
export const StoredRoleOverrideCatalogV1Schema = createStoredReadSchema(RoleOverrideCatalogV1Schema);

export const RoleOverrideRecordV1Schema = lazyZodSchema(() => RoleOverrideCatalogV1Schema.safeExtend({ v: z.literal(1) }));
export type RoleOverrideRecordV1 = z.infer<typeof RoleOverrideRecordV1Schema>;
export const StoredRoleOverrideRecordV1Schema = createStoredReadSchema(RoleOverrideRecordV1Schema);

/** A required empty catalog is ready; unreadable authority is never an empty catalog. */
export type AccountRoleOverridesReadV1 =
  | Readonly<{ status: 'ready'; overrides: RoleOverrideCatalogV1['overrides'] }>
  | Readonly<{ status: 'unavailable'; reason: string }>;

export const RoleOverrideMutationV1Schema = lazyZodSchema(() => z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('set'), override: RoleInstructionsOverrideV1Schema }).strict(),
  z.object({ kind: z.literal('reset'), roleId: z.string().min(1) }).strict(),
]));
export type RoleOverrideMutationV1 = z.infer<typeof RoleOverrideMutationV1Schema>;

/** One semantic mutation for both retained Settings admission and the destination row. */
export function applyRoleOverrideMutationV1(catalog: RoleOverrideCatalogV1, input: RoleOverrideMutationV1): RoleOverrideCatalogV1 {
  const mutation = RoleOverrideMutationV1Schema.parse(input);
  const current = RoleOverrideCatalogV1Schema.parse(catalog);
  const overrides = { ...current.overrides };
  if (mutation.kind === 'reset') delete overrides[mutation.roleId];
  else overrides[mutation.override.roleId] = mutation.override;
  return { overrides };
}
