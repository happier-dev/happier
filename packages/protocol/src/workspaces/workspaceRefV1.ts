import { lazyDefinition, lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod/mini';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { ScmHostingRepositoryIdentityV1Schema } from '../scm/hostingRepositoryIdentity.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';

const StoredNonEmptyStringSchema = lazyZodSchema(() => z.string().check(z.minLength(1)));
const LookupNonEmptyStringSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

export const WorkspaceProjectFactsV1Schema = lazyZodSchema(() => z.strictObject({
  projectKey: z.optional(StoredNonEmptyStringSchema),
  repositoryIdentity: z.optional(ScmHostingRepositoryIdentityV1Schema),
  source: z.optional(z.strictObject({ sourceId: StoredNonEmptyStringSchema, revision: z.number().check(z.int(), z.nonnegative()) })),
}));
export type WorkspaceProjectFactsV1 = z.infer<typeof WorkspaceProjectFactsV1Schema>;

export const WorkspaceRefV1WriteSchema = lazyZodSchema(() => z.strictObject({
    id: StoredNonEmptyStringSchema,
    serverId: StoredNonEmptyStringSchema,
    machineId: StoredNonEmptyStringSchema,
    rootPath: StoredNonEmptyStringSchema,
    label: z.catch(z.optional(z.nullable(StoredNonEmptyStringSchema)), null),
    createdAtMs: z.number().check(z.nonnegative()),
    lastOpenedAtMs: z.catch(z.optional(z.nullable(z.number().check(z.nonnegative()))), null),
    ...WorkspaceProjectFactsV1Schema.shape,
  }));
export const WorkspaceRefV1Schema = createStoredReadSchema(WorkspaceRefV1WriteSchema);
export type WorkspaceRefV1 = z.infer<typeof WorkspaceRefV1WriteSchema>;

const ProjectKeyByIdV1Schema = lazyZodSchema(() => z.strictObject({
    id: LookupNonEmptyStringSchema,
    serverId: z.optional(LookupNonEmptyStringSchema),
  }));

const ProjectKeyByScopeV1Schema = lazyZodSchema(() => z.strictObject({
    serverId: LookupNonEmptyStringSchema,
    machineId: LookupNonEmptyStringSchema,
    rootPath: LookupNonEmptyStringSchema,
  }));

export const QualifiedProjectKeyV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: LookupNonEmptyStringSchema,
  projectKey: LookupNonEmptyStringSchema,
}));
export type QualifiedProjectKeyV1 = z.infer<typeof QualifiedProjectKeyV1Schema>;

export const WorkspaceAddressV1Schema = lazyZodSchema(() => z.strictObject({
  serverId: LookupNonEmptyStringSchema,
  workspaceId: LookupNonEmptyStringSchema,
  machineId: LookupNonEmptyStringSchema,
  rootPath: LookupNonEmptyStringSchema,
}));
export type WorkspaceAddressV1 = z.infer<typeof WorkspaceAddressV1Schema>;
/** Private accepted checkout facts, emitted only after Session and Account census admission. */
export const SessionAcceptedWorkspaceV1Schema = lazyZodSchema(() => z.strictObject({
  checkout: WorkspaceAddressV1Schema,
  repository: z.optional(ScmHostingRepositoryIdentityV1Schema),
}));
export type SessionAcceptedWorkspaceV1 = z.infer<typeof SessionAcceptedWorkspaceV1Schema>;
export const SessionAcceptedWorkspaceV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(SessionAcceptedWorkspaceV1Schema));

export const ProjectKeyV1Schema = lazyZodSchema(() => z.union([
  ProjectKeyByIdV1Schema,
  ProjectKeyByScopeV1Schema,
  QualifiedProjectKeyV1Schema,
]));
export type ProjectKeyV1 = z.infer<typeof ProjectKeyV1Schema>;

export const WorkspaceAddressV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(WorkspaceAddressV1Schema));
