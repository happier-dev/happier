import * as z from 'zod/mini';

import { isAccountScopedBlobCiphertextForKind } from '../../crypto/accountScopedCipherEnvelope.js';
import { createStoredReadSchema } from '../../json/storedReadSchema.js';
import { lazyDefinition } from '../../lazyZodSchema.js';

export const PROJECT_TRUST_ACCOUNT_SCOPED_BLOB_KIND_V1 = 'project_setup_trust' as const;
export const PROJECT_TRUST_ROUTE_V1 = '/v1/account/project-trust' as const;

const OpaqueIdSchema = lazyDefinition(() => z.string().check(z.minLength(1), z.refine(value => value === value.trim())));
const RevisionSchema = lazyDefinition(() => z.number().check(z.int(), z.gte(0), z.lte(Number.MAX_SAFE_INTEGER)));
export const QualifiedProjectTrustProjectV1Schema = lazyDefinition(() => z.strictObject({
  serverId: OpaqueIdSchema,
  projectId: OpaqueIdSchema,
}));
export type QualifiedProjectTrustProjectV1 = z.infer<typeof QualifiedProjectTrustProjectV1Schema>;

/** One approving Account's current reviewed effect; neither Machine nor digest is a row key. */
export const ProjectTrustValueV1Schema = lazyDefinition(() => z.strictObject({
  project: QualifiedProjectTrustProjectV1Schema,
  reviewedEffectDigest: z.string().check(z.minLength(1)),
  approvedAtMs: RevisionSchema,
}));
export type ProjectTrustValueV1 = z.infer<typeof ProjectTrustValueV1Schema>;
export const StoredProjectTrustValueV1Schema = createStoredReadSchema(ProjectTrustValueV1Schema);

/** Opened Account ciphertext must belong to the exact qualified row requested. */
export function assertProjectTrustValueForProjectV1(value: unknown, project: QualifiedProjectTrustProjectV1): ProjectTrustValueV1 {
  const parsed = StoredProjectTrustValueV1Schema.parse(value);
  if (parsed.project.serverId !== project.serverId || parsed.project.projectId !== project.projectId) throw new Error('Project Trust value does not match the qualified Project');
  return parsed;
}

export const ProjectTrustContentV1Schema = lazyDefinition(() => z.discriminatedUnion('t', [
  z.strictObject({ t: z.literal('plain'), v: ProjectTrustValueV1Schema }),
  z.strictObject({ t: z.literal('encrypted'), c: z.string().check(z.minLength(1)) }),
]));
export type ProjectTrustContentV1 = z.infer<typeof ProjectTrustContentV1Schema>;
export const StoredProjectTrustContentV1Schema = createStoredReadSchema(ProjectTrustContentV1Schema);

export function assertProjectTrustContentForModeV1(input: unknown, mode: 'plain' | 'e2ee'): ProjectTrustContentV1 {
  const content = StoredProjectTrustContentV1Schema.parse(input);
  if ((mode === 'plain' && content.t !== 'plain') || (mode === 'e2ee' && (
    content.t !== 'encrypted' || !isAccountScopedBlobCiphertextForKind({ kind: PROJECT_TRUST_ACCOUNT_SCOPED_BLOB_KIND_V1, ciphertext: content.c })
  ))) throw new Error('Project Trust content does not match the Account encryption mode');
  return content;
}

export const ProjectTrustRowV1Schema = lazyDefinition(() => z.strictObject({
  project: QualifiedProjectTrustProjectV1Schema,
  revision: RevisionSchema,
  content: z.nullable(ProjectTrustContentV1Schema),
}));
export type ProjectTrustRowV1 = z.infer<typeof ProjectTrustRowV1Schema>;
export const StoredProjectTrustRowV1Schema = createStoredReadSchema(ProjectTrustRowV1Schema);
export const ProjectTrustReadRequestV1Schema = lazyDefinition(() => z.strictObject({ project: QualifiedProjectTrustProjectV1Schema }));
export const ProjectTrustListRequestV1Schema = lazyDefinition(() => z.strictObject({ project: z.optional(QualifiedProjectTrustProjectV1Schema) }));
export const ProjectTrustReadResponseV1Schema = lazyDefinition(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('present'), revision: RevisionSchema, content: ProjectTrustContentV1Schema }),
  z.strictObject({ status: z.literal('absent') }),
  z.strictObject({ status: z.literal('deleted'), revision: RevisionSchema }),
]));
export type ProjectTrustReadResponseV1 = z.infer<typeof ProjectTrustReadResponseV1Schema>;
export const ProjectTrustListResponseV1Schema = lazyDefinition(() => z.strictObject({ rows: z.array(ProjectTrustRowV1Schema) }));
export type ProjectTrustListResponseV1 = z.infer<typeof ProjectTrustListResponseV1Schema>;
export const ProjectTrustMutationRequestV1Schema = lazyDefinition(() => z.strictObject({
  project: QualifiedProjectTrustProjectV1Schema,
  expectedRevision: z.union([RevisionSchema, z.literal('absent')]),
  content: z.nullable(ProjectTrustContentV1Schema),
}));
export type ProjectTrustMutationRequestV1 = z.infer<typeof ProjectTrustMutationRequestV1Schema>;
export const ProjectTrustMutationResponseV1Schema = lazyDefinition(() => z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('updated'), revision: RevisionSchema, cursor: RevisionSchema }),
  z.strictObject({ status: z.literal('conflict'), revision: z.number().check(z.int(), z.gte(-1), z.lte(Number.MAX_SAFE_INTEGER)) }),
]));
export type ProjectTrustMutationResponseV1 = z.infer<typeof ProjectTrustMutationResponseV1Schema>;
export const ProjectTrustStorageUnavailableV1Schema = lazyDefinition(() => z.strictObject({
  error: z.literal('project_trust_storage_unavailable'),
  reason: z.enum(['account-not-found', 'account-inconsistent', 'account-mode-mismatch', 'invalid-stored-content']),
}));
export type ProjectTrustStorageUnavailableV1 = z.infer<typeof ProjectTrustStorageUnavailableV1Schema>;
export const ProjectTrustChangeHintV1Schema = lazyDefinition(() => z.strictObject({
  projectTrust: z.literal(true), project: QualifiedProjectTrustProjectV1Schema, revision: RevisionSchema,
}));
