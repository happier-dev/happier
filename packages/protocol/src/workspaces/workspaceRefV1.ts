import { lazyDefinition, lazyZodSchema } from '../lazyZodSchema.js';
import { z } from '../zodRuntimePolicy.js';
import { createStoredReadSchema } from '../json/storedReadSchema.js';
import { ScmHostingRepositoryIdentityV1Schema } from '../scm/hostingRepositoryIdentity.js';
import { projectZodProtocolSchema } from '../plugins/actions/internalProtocolZodAdapter.js';
import { ProjectRepositoryObservationV1Schema } from './projectSetup/projectManifestV1.js';

const StoredNonEmptyStringSchema = lazyZodSchema(() => z.string().check(z.minLength(1)));
const LookupNonEmptyStringSchema = lazyZodSchema(() => z.string().check(z.trim(), z.minLength(1)));

export const WorkspaceProjectFactsV1Schema = lazyZodSchema(() => z.strictObject({
  projectKey: z.optional(StoredNonEmptyStringSchema),
  repositoryIdentity: z.optional(ScmHostingRepositoryIdentityV1Schema),
  source: z.optional(z.strictObject({ sourceId: StoredNonEmptyStringSchema, revision: z.number().check(z.int(), z.nonnegative()) })),
}));
export type WorkspaceProjectFactsV1 = z.infer<typeof WorkspaceProjectFactsV1Schema>;
export const WorkspaceRepositoryObservationV1Schema = lazyZodSchema(() => z.extend(ProjectRepositoryObservationV1Schema, {
  source: z.nonoptional(WorkspaceProjectFactsV1Schema.shape.source),
}));

export const WorkspaceRefV1WriteSchema = lazyZodSchema(() => z.strictObject({
    id: StoredNonEmptyStringSchema,
    serverId: StoredNonEmptyStringSchema,
    machineId: StoredNonEmptyStringSchema,
    rootPath: StoredNonEmptyStringSchema,
    label: z.catch(z.optional(z.nullable(StoredNonEmptyStringSchema)), null),
    createdAtMs: z.number().check(z.nonnegative()),
    lastOpenedAtMs: z.catch(z.optional(z.nullable(z.number().check(z.nonnegative()))), null),
    repositoryObservation: z.optional(WorkspaceRepositoryObservationV1Schema),
    ...WorkspaceProjectFactsV1Schema.shape,
  }));
export type MachineWorkspaceRefV1 = z.infer<typeof WorkspaceRefV1WriteSchema>;

/** V2 names a daemon-free guest's own filesystem. It deliberately has no
 * Machine identity, so the V1 stored reader cannot interpret its root on the host. */
export const ManagedWorkspaceRefV2WriteSchema = lazyZodSchema(() => {
  const { machineId: _machineId, ...fields } = WorkspaceRefV1WriteSchema.shape;
  return z.strictObject({ ...fields, v: z.literal(2), kind: z.literal('managed'),
    machineId: z.optional(z.never()),
    managedId: StoredNonEmptyStringSchema,
    controller: z.strictObject({ machineId: StoredNonEmptyStringSchema, installationId: StoredNonEmptyStringSchema }),
  });
});
export type ManagedWorkspaceRefV2 = z.infer<typeof ManagedWorkspaceRefV2WriteSchema>;
/** Current Machine arm keeps native tags visible to stored-read validation. */
export const WorkspaceRefV2MachineWriteSchema = lazyZodSchema(() => z.strictObject({
  ...WorkspaceRefV1WriteSchema.shape, kind: z.optional(z.never()),
}));
export const WorkspaceRefV2WriteSchema = lazyZodSchema(() => z.union([
  // A stored projection must never erase a native discriminator and choose the
  // legacy Machine branch, even when malformed native input also carries machineId.
  WorkspaceRefV2MachineWriteSchema,
  ManagedWorkspaceRefV2WriteSchema,
]));
export const WorkspaceRefV2Schema = createStoredReadSchema(WorkspaceRefV2WriteSchema);
/** Current reader retains V1 Machine references alongside explicitly versioned native references. */
export const WorkspaceRefV1Schema = WorkspaceRefV2Schema;
export type WorkspaceRefV1 = MachineWorkspaceRefV1 | ManagedWorkspaceRefV2;

/** Discriminates already-admitted full refs and their typed routing projections. */
export function isManagedWorkspaceRefV2<T extends object>(ref: T): ref is Extract<T, { kind: 'managed' }> {
  return 'kind' in ref && ref.kind === 'managed';
}

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
/** Native list addresses retain guest identity and controller installation; V1 remains Machine-only. */
export const ManagedWorkspaceAddressV2Schema = lazyZodSchema(() => z.strictObject({
  v: z.literal(2), kind: z.literal('managed'),
  serverId: LookupNonEmptyStringSchema, workspaceId: LookupNonEmptyStringSchema,
  managedId: LookupNonEmptyStringSchema,
  controller: z.strictObject({ machineId: LookupNonEmptyStringSchema, installationId: LookupNonEmptyStringSchema }),
  rootPath: LookupNonEmptyStringSchema,
}));
export const WorkspaceAddressV2Schema = lazyZodSchema(() => z.union([
  z.strictObject({ ...WorkspaceAddressV1Schema.shape, kind: z.optional(z.never()) }),
  ManagedWorkspaceAddressV2Schema,
]));
export type WorkspaceAddressV2 = z.infer<typeof WorkspaceAddressV2Schema>;
/** Exact native namespace lookup when no logical workspace row id is available. */
export const ManagedWorkspaceLocatorV2Schema = lazyZodSchema(() => z.omit(ManagedWorkspaceAddressV2Schema, { workspaceId: true }));
export type ManagedWorkspaceLocatorV2 = z.infer<typeof ManagedWorkspaceLocatorV2Schema>;
/** Feature protocols embed the canonical accepted-checkout address. */
export const WorkspaceAddressV1ProtocolSchema = lazyDefinition(() => projectZodProtocolSchema(WorkspaceAddressV1Schema));

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
