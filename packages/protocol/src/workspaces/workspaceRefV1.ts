import { lazyZodSchema } from '../lazyZodSchema.js';
import { z } from 'zod';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { ScmHostingRepositoryIdentityV1Schema } from '../scm/hostingRepositoryIdentity.js';

const StoredNonEmptyStringSchema = lazyZodSchema(() => z.string().min(1));
const LookupNonEmptyStringSchema = lazyZodSchema(() => z.string().trim().min(1));

export const WorkspaceProjectFactsV1Schema = lazyZodSchema(() => z.object({
  projectKey: StoredNonEmptyStringSchema.optional(),
  repositoryIdentity: ScmHostingRepositoryIdentityV1Schema.optional(),
  source: z.object({ sourceId: StoredNonEmptyStringSchema, revision: z.number().int().nonnegative() }).strict().optional(),
}).strict());
export type WorkspaceProjectFactsV1 = z.infer<typeof WorkspaceProjectFactsV1Schema>;

export const WorkspaceRefV1WriteSchema = lazyZodSchema(() => z
  .object({
    id: StoredNonEmptyStringSchema,
    serverId: StoredNonEmptyStringSchema,
    machineId: StoredNonEmptyStringSchema,
    rootPath: StoredNonEmptyStringSchema,
    label: StoredNonEmptyStringSchema.nullable().optional().catch(null),
    createdAtMs: z.number().finite().nonnegative(),
    lastOpenedAtMs: z.number().finite().nonnegative().nullable().optional().catch(null),
    ...WorkspaceProjectFactsV1Schema.shape,
  })
  .strict());
export const WorkspaceRefV1Schema = createStoredReadSchema(WorkspaceRefV1WriteSchema);
export type WorkspaceRefV1 = z.infer<typeof WorkspaceRefV1WriteSchema>;

const ProjectKeyByIdV1Schema = lazyZodSchema(() => z
  .object({
    id: LookupNonEmptyStringSchema,
    serverId: LookupNonEmptyStringSchema.optional(),
  })
  .strict());

const ProjectKeyByScopeV1Schema = lazyZodSchema(() => z
  .object({
    serverId: LookupNonEmptyStringSchema,
    machineId: LookupNonEmptyStringSchema,
    rootPath: LookupNonEmptyStringSchema,
  })
  .strict());

export const QualifiedProjectKeyV1Schema = lazyZodSchema(() => z.object({
  serverId: LookupNonEmptyStringSchema,
  projectKey: LookupNonEmptyStringSchema,
}).strict());
export type QualifiedProjectKeyV1 = z.infer<typeof QualifiedProjectKeyV1Schema>;

export const WorkspaceAddressV1Schema = lazyZodSchema(() => z.object({
  serverId: LookupNonEmptyStringSchema,
  workspaceId: LookupNonEmptyStringSchema,
  machineId: LookupNonEmptyStringSchema,
  rootPath: LookupNonEmptyStringSchema,
}).strict());
export type WorkspaceAddressV1 = z.infer<typeof WorkspaceAddressV1Schema>;

export const ProjectKeyV1Schema = lazyZodSchema(() => z.union([
  ProjectKeyByIdV1Schema,
  ProjectKeyByScopeV1Schema,
  QualifiedProjectKeyV1Schema,
]));
export type ProjectKeyV1 = z.infer<typeof ProjectKeyV1Schema>;
