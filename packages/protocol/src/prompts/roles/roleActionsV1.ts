import { lazyZodSchema } from '../../lazyZodSchema.js';
import { z } from 'zod/mini';
import type { RoleActionIdV1 } from './roleActionIdsV1.js';
import { RoleArtifactV1Schema } from './roleArtifactV1.js';
import { RoleInstructionsOverrideV1Schema, RoleOverrideV1Schema } from './rolesV1.js';
import { SessionTargetV1Schema } from '../../actions/sessionTargetV1.js';

const SessionRoleIdentityV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: z.string().check(z.minLength(1)), roleId: z.string().check(z.minLength(1)),
}));
const SessionRoleSetTargetV1Schema = lazyZodSchema(() => z.strictObject({
  sessionId: SessionTargetV1Schema,
  roleId: z.optional(z.string().check(z.minLength(1))),
  answersWorkerQuestions: z.optional(z.boolean()),
}).check(z.refine((input) => input.roleId !== undefined || input.answersWorkerQuestions !== undefined)));
const SessionRoleSetV1Schema = lazyZodSchema(() => z.safeExtend(SessionRoleSetTargetV1Schema, {
  sessionId: z.string().check(z.minLength(1)),
}));
const RoleIdentityV1Schema = lazyZodSchema(() => z.strictObject({ roleId: z.string().check(z.minLength(1)) }));
const RoleArtifactRevisionV1Schema = lazyZodSchema(() => z.strictObject({
  headerVersion: z.number().check(z.int(), z.nonnegative()),
  bodyVersion: z.number().check(z.int(), z.nonnegative()),
}));
export const RoleActionEntryV1Schema = lazyZodSchema(() => z.strictObject({
  roleId: z.string().check(z.minLength(1)), role: RoleArtifactV1Schema,
  revision: z.optional(RoleArtifactRevisionV1Schema),
  shared: z.boolean(),
  viewOnly: z.boolean(),
  migratedFromV0_2: z.boolean(),
  pluginDisplayName: z.optional(z.string().check(z.minLength(1))),
}));
export type RoleActionEntryV1 = z.infer<typeof RoleActionEntryV1Schema>;
export const RoleSourceDiagnosticV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ source: z.literal('legacy-guidance'),
    reason: z.enum(['unavailable', 'invalid_root', 'invalid_entry', 'duplicate_id']),
    index: z.optional(z.number().check(z.int(), z.nonnegative())), entryId: z.optional(z.string()),
  }),
  z.strictObject({ source: z.literal('artifact'), artifactId: z.string().check(z.minLength(1)),
    reason: z.enum(['unavailable', 'invalid_stored_content']),
  }),
]));
export type RoleSourceDiagnosticV1 = z.infer<typeof RoleSourceDiagnosticV1Schema>;
const RoleActionUpdatedV1Schema = lazyZodSchema(() => z.strictObject({ updated: z.literal(true) }));

/** V1 role mutations are executable declarations; all nested object boundaries are closed. */
export const RoleActionInputSchemasV1 = {
  'session.role.set': SessionRoleSetV1Schema,
  'session.roles.override.set': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(RoleOverrideV1Schema, { sessionId: z.string().check(z.minLength(1)) }))),
  'session.roles.override.clear': SessionRoleIdentityV1Schema,
  'session.roles.add': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(SessionRoleIdentityV1Schema, { role: RoleArtifactV1Schema }))),
  'session.roles.remove': SessionRoleIdentityV1Schema,
  'session.notes.set': z.strictObject({ sessionId: z.string().check(z.minLength(1)), notes: z.string() }),
  'session.roles.apply_to_reports': z.strictObject({ sessionId: z.string().check(z.minLength(1)) }),
  'roles.list': z.strictObject({}),
  'roles.get': RoleIdentityV1Schema,
  'roles.create': z.strictObject({ roleId: z.optional(z.string().check(z.minLength(1))), role: RoleArtifactV1Schema }),
  'roles.update': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(RoleIdentityV1Schema, { expectedRevision: RoleArtifactRevisionV1Schema, role: RoleArtifactV1Schema }))),
  'roles.delete': lazyZodSchema(() => (<T extends z.ZodMiniObject>(schema: T) => z.core.clone(schema, { ...schema._zod.def, catchall: z.never() }) as z.ZodMiniObject<T['shape'], z.core.$strict>)(z.extend(RoleIdentityV1Schema, { expectedRevision: RoleArtifactRevisionV1Schema }))),
  'roles.override.set': RoleInstructionsOverrideV1Schema,
  'roles.override.reset': RoleIdentityV1Schema,
} as const satisfies Readonly<Record<RoleActionIdV1, z.ZodMiniType>>;

/** Action ingress accepts selectors; the front door resolves them before exact leaf/RPC validation. */
export const RoleActionTargetInputSchemasV1 = {
  ...RoleActionInputSchemasV1,
  'session.role.set': SessionRoleSetTargetV1Schema,
  'session.roles.override.set': lazyZodSchema(() => z.extend(RoleActionInputSchemasV1['session.roles.override.set'], { sessionId: SessionTargetV1Schema })),
  'session.roles.override.clear': lazyZodSchema(() => z.extend(RoleActionInputSchemasV1['session.roles.override.clear'], { sessionId: SessionTargetV1Schema })),
  'session.roles.add': lazyZodSchema(() => z.extend(RoleActionInputSchemasV1['session.roles.add'], { sessionId: SessionTargetV1Schema })),
  'session.roles.remove': lazyZodSchema(() => z.extend(RoleActionInputSchemasV1['session.roles.remove'], { sessionId: SessionTargetV1Schema })),
  'session.notes.set': lazyZodSchema(() => z.extend(RoleActionInputSchemasV1['session.notes.set'], { sessionId: SessionTargetV1Schema })),
  'session.roles.apply_to_reports': lazyZodSchema(() => z.extend(RoleActionInputSchemasV1['session.roles.apply_to_reports'], { sessionId: SessionTargetV1Schema })),
} as const satisfies Readonly<Record<RoleActionIdV1, z.ZodMiniType>>;

export const RoleActionOutputSchemasV1 = {
  'session.role.set': RoleActionUpdatedV1Schema,
  'session.roles.override.set': RoleActionUpdatedV1Schema,
  'session.roles.override.clear': RoleActionUpdatedV1Schema,
  'session.roles.add': RoleActionUpdatedV1Schema,
  'session.roles.remove': RoleActionUpdatedV1Schema,
  'session.notes.set': RoleActionUpdatedV1Schema,
  'session.roles.apply_to_reports': z.strictObject({ updatedSessionIds: z.array(z.string().check(z.minLength(1))) }),
  'roles.list': z.strictObject({ items: z.array(RoleActionEntryV1Schema), diagnostics: z.array(RoleSourceDiagnosticV1Schema) }),
  'roles.get': RoleActionEntryV1Schema,
  'roles.create': z.strictObject({ roleId: z.string().check(z.minLength(1)), revision: RoleArtifactRevisionV1Schema }),
  'roles.update': z.strictObject({ roleId: z.string().check(z.minLength(1)), revision: RoleArtifactRevisionV1Schema }),
  'roles.delete': z.strictObject({ deleted: z.literal(true) }),
  'roles.override.set': RoleActionUpdatedV1Schema,
  'roles.override.reset': RoleActionUpdatedV1Schema,
} as const satisfies Readonly<Record<RoleActionIdV1, z.ZodMiniType>>;

export const ACCOUNT_ROLE_MUTATION_IDS_V1 = [
  'roles.create', 'roles.update', 'roles.delete', 'roles.override.set', 'roles.override.reset',
] as const;

export function isAccountRoleMutationV1(actionId: string): boolean {
  return (ACCOUNT_ROLE_MUTATION_IDS_V1 as readonly string[]).includes(actionId);
}
