import { z } from 'zod';

const StoredNonEmptyStringSchema = z.string().min(1);
const LookupNonEmptyStringSchema = z.string().trim().min(1);

export const WorkspaceRefV1Schema = z
  .object({
    id: StoredNonEmptyStringSchema,
    serverId: StoredNonEmptyStringSchema,
    machineId: StoredNonEmptyStringSchema,
    rootPath: StoredNonEmptyStringSchema,
    label: StoredNonEmptyStringSchema.nullable().optional().catch(null),
    createdAtMs: z.number().finite().nonnegative(),
    lastOpenedAtMs: z.number().finite().nonnegative().nullable().optional().catch(null),
  })
  .passthrough();
export type WorkspaceRefV1 = z.infer<typeof WorkspaceRefV1Schema>;

const ProjectKeyByIdV1Schema = z
  .object({
    id: LookupNonEmptyStringSchema,
  })
  .strict();

const ProjectKeyByScopeV1Schema = z
  .object({
    serverId: LookupNonEmptyStringSchema,
    machineId: LookupNonEmptyStringSchema,
    rootPath: LookupNonEmptyStringSchema,
  })
  .strict();

export const ProjectKeyV1Schema = z.union([
  ProjectKeyByIdV1Schema,
  ProjectKeyByScopeV1Schema,
]);
export type ProjectKeyV1 = z.infer<typeof ProjectKeyV1Schema>;
