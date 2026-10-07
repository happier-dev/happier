import { z } from 'zod';
import type { RoleActionIdV1 } from './roleActionIdsV1.js';
import { RoleArtifactV1Schema } from './roleArtifactV1.js';
import { RoleInstructionsOverrideV1Schema, RoleOverrideV1Schema } from './rolesV1.js';

const SessionRoleIdentityV1Schema = z.object({
  sessionId: z.string().min(1), roleId: z.string().min(1),
}).strict();
const RoleIdentityV1Schema = z.object({ roleId: z.string().min(1) }).strict();
const RoleArtifactRevisionV1Schema = z.object({
  headerVersion: z.number().int().nonnegative(),
  bodyVersion: z.number().int().nonnegative(),
}).strict();
export const RoleActionEntryV1Schema = z.object({
  roleId: z.string().min(1), role: RoleArtifactV1Schema,
  revision: RoleArtifactRevisionV1Schema.optional(),
  shared: z.boolean(),
  viewOnly: z.boolean(),
  migratedFromV0_2: z.boolean(),
}).strict();
export type RoleActionEntryV1 = z.infer<typeof RoleActionEntryV1Schema>;
const RoleActionUpdatedV1Schema = z.object({ updated: z.literal(true) }).strict();

/** V1 role mutations are executable declarations; all nested object boundaries are closed. */
export const RoleActionInputSchemasV1 = {
  'session.role.set': SessionRoleIdentityV1Schema,
  'session.roles.override.set': RoleOverrideV1Schema.extend({ sessionId: z.string().min(1) }).strict(),
  'session.roles.override.clear': SessionRoleIdentityV1Schema,
  'session.roles.add': SessionRoleIdentityV1Schema.extend({ role: RoleArtifactV1Schema }).strict(),
  'session.roles.remove': SessionRoleIdentityV1Schema,
  'session.notes.set': z.object({ sessionId: z.string().min(1), notes: z.string() }).strict(),
  'session.roles.apply_to_reports': z.object({ sessionId: z.string().min(1) }).strict(),
  'roles.list': z.object({}).strict(),
  'roles.get': RoleIdentityV1Schema,
  'roles.create': z.object({ roleId: z.string().min(1).optional(), role: RoleArtifactV1Schema }).strict(),
  'roles.update': RoleIdentityV1Schema.extend({ expectedRevision: RoleArtifactRevisionV1Schema, role: RoleArtifactV1Schema }).strict(),
  'roles.delete': RoleIdentityV1Schema.extend({ expectedRevision: RoleArtifactRevisionV1Schema }).strict(),
  'roles.override.set': RoleInstructionsOverrideV1Schema,
  'roles.override.reset': RoleIdentityV1Schema,
} as const satisfies Readonly<Record<RoleActionIdV1, z.ZodTypeAny>>;

export const RoleActionOutputSchemasV1 = {
  'session.role.set': RoleActionUpdatedV1Schema,
  'session.roles.override.set': RoleActionUpdatedV1Schema,
  'session.roles.override.clear': RoleActionUpdatedV1Schema,
  'session.roles.add': RoleActionUpdatedV1Schema,
  'session.roles.remove': RoleActionUpdatedV1Schema,
  'session.notes.set': RoleActionUpdatedV1Schema,
  'session.roles.apply_to_reports': z.object({ updatedSessionIds: z.array(z.string().min(1)) }).strict(),
  'roles.list': z.object({ items: z.array(RoleActionEntryV1Schema) }).strict(),
  'roles.get': RoleActionEntryV1Schema,
  'roles.create': z.object({ roleId: z.string().min(1), revision: RoleArtifactRevisionV1Schema }).strict(),
  'roles.update': z.object({ roleId: z.string().min(1), revision: RoleArtifactRevisionV1Schema }).strict(),
  'roles.delete': z.object({ deleted: z.literal(true) }).strict(),
  'roles.override.set': RoleActionUpdatedV1Schema,
  'roles.override.reset': RoleActionUpdatedV1Schema,
} as const satisfies Readonly<Record<RoleActionIdV1, z.ZodTypeAny>>;

export const ACCOUNT_ROLE_MUTATION_IDS_V1 = [
  'roles.create', 'roles.update', 'roles.delete', 'roles.override.set', 'roles.override.reset',
] as const;

export function isAccountRoleMutationV1(actionId: string): boolean {
  return (ACCOUNT_ROLE_MUTATION_IDS_V1 as readonly string[]).includes(actionId);
}
