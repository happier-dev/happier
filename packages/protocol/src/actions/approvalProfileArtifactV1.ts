import { z } from '../zodRuntimePolicy.js';
import { lazyZodSchema } from '../lazyZodSchema.js';
import { sameStrictJsonValue } from '../json/strictJsonValue.js';
import { ArtifactCallerAccessV1Schema, ArtifactHttpReadV1Schema } from '../artifacts/artifactAccessV1.js';
import type { ArtifactCallerAccessV1 } from '../artifacts/artifactAccessV1.js';
import type { ArtifactListSelectionOptionsV1 } from '../artifacts/artifactListSelectionV1.js';
import type { ArtifactSharingKindAdapterV1, ArtifactSharingResourceV1 } from '../artifacts/artifactSharingV1.js';
import { ArtifactRevisionV1Schema } from '../artifacts/artifactRevisionV1.js';
import { ApprovalProfileIdV1Schema, ApprovalProfileV1Schema,
  type BoundApprovalProfileV1, type ReadableApprovalProfileV1 } from './approvalProfiles.js';

export const APPROVAL_PROFILE_ARTIFACT_KIND_V1 = 'approval-profile.v1' as const;
export const ApprovalProfileContentV1Schema = lazyZodSchema(() => z.omit(ApprovalProfileV1Schema, { id: true }));
export type ApprovalProfileContentV1 = z.infer<typeof ApprovalProfileContentV1Schema>;
export function toApprovalProfileContentV1(profile: ReadableApprovalProfileV1['profile']): ApprovalProfileContentV1 {
  const { id: _id, ...content } = profile;
  return content;
}
export const ApprovalProfileArtifactV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.literal(APPROVAL_PROFILE_ARTIFACT_KIND_V1), profile: ApprovalProfileContentV1Schema,
}));
export type ApprovalProfileArtifactV1 = z.infer<typeof ApprovalProfileArtifactV1Schema>;
export const ReadableApprovalProfileV1Schema = lazyZodSchema(() => z.strictObject({
  id: ApprovalProfileIdV1Schema, profile: ApprovalProfileV1Schema, access: ArtifactCallerAccessV1Schema,
  ownerAccountId: z.optional(z.string()), ownerDisplayName: ArtifactHttpReadV1Schema.shape.ownerDisplayName,
  revision: ArtifactRevisionV1Schema,
}));
export const ApprovalProfileArtifactChangeV1Schema = lazyZodSchema(() => z.union([
  z.strictObject({ kind: z.literal('create'), profile: ApprovalProfileContentV1Schema }),
  z.strictObject({ kind: z.literal('update'), id: ApprovalProfileIdV1Schema,
    expectedRevision: ArtifactRevisionV1Schema, profile: ApprovalProfileContentV1Schema }),
  z.strictObject({ kind: z.literal('delete'), id: ApprovalProfileIdV1Schema, expectedRevision: ArtifactRevisionV1Schema }),
]));
export type ApprovalProfileArtifactChangeV1 = z.infer<typeof ApprovalProfileArtifactChangeV1Schema>;
export const ApprovalProfileArtifactChangeResultV1Schema = lazyZodSchema(() => z.strictObject({
  kind: z.enum(['create', 'update', 'delete']), id: ApprovalProfileIdV1Schema, revision: ArtifactRevisionV1Schema,
}));
export type ApprovalProfileArtifactChangeResultV1 = z.infer<typeof ApprovalProfileArtifactChangeResultV1Schema>;

export function buildApprovalProfileArtifactHeaderV1(content: ApprovalProfileArtifactV1): Readonly<Record<string, unknown>> {
  return { kind: content.kind, name: content.profile.name, title: content.profile.name };
}

export function readApprovalProfileArtifactV1(resource: ArtifactSharingResourceV1): ApprovalProfileArtifactV1 | null {
  if (resource.header.kind !== APPROVAL_PROFILE_ARTIFACT_KIND_V1 || typeof resource.body !== 'string') return null;
  try {
    const parsed = ApprovalProfileArtifactV1Schema.safeParse(JSON.parse(resource.body));
    return parsed.success && parsed.data.profile.name === resource.header.name ? parsed.data : null;
  } catch { return null; }
}

export const approvalProfileArtifactSharingAdapterV1 = {
  kind: APPROVAL_PROFILE_ARTIFACT_KIND_V1,
  canShare: (resource: ArtifactSharingResourceV1) => readApprovalProfileArtifactV1(resource) !== null,
} as const satisfies ArtifactSharingKindAdapterV1;

/** Only resources opened by the Account Artifact transport enter this catalog. */
export function listReadableApprovalProfilesV1(resources: readonly ArtifactSharingResourceV1[]): ReadableApprovalProfileV1[] {
  return resources.flatMap(resource => {
    const content = readApprovalProfileArtifactV1(resource);
    if (!content || !resource.revision || !resource.access) return [];
    return [{ id: resource.artifactId, profile: { ...content.profile, id: resource.artifactId },
      access: resource.access, revision: resource.revision,
      ...(resource.ownerAccountId ? { ownerAccountId: resource.ownerAccountId } : {}),
      ...(resource.ownerDisplayName === undefined ? {} : { ownerDisplayName: resource.ownerDisplayName }) }];
  });
}

export function bindApprovalProfileV1(rows: readonly ReadableApprovalProfileV1[], requestedId: string): BoundApprovalProfileV1 {
  const profile = rows.find(row => row.id === requestedId)?.profile ?? null;
  return { profile, resolution: { status: profile ? 'available' : 'missing', requestedId } };
}

export async function loadReadableApprovalProfilesV1(list: (options: ArtifactListSelectionOptionsV1) => Promise<Readonly<{
  items: readonly (ArtifactSharingResourceV1 & { headerVersion?: number; bodyVersion?: number })[]; nextCursor?: string;
}>>, signal?: AbortSignal): Promise<ReadableApprovalProfileV1[]> {
  const rows: ReadableApprovalProfileV1[] = [];
  let cursor: string | undefined;
  do {
    signal?.throwIfAborted();
    const page = await list({ kinds: [APPROVAL_PROFILE_ARTIFACT_KIND_V1], includeBody: true, cursor, signal });
    rows.push(...listReadableApprovalProfilesV1(page.items.map(item => ({ ...item,
      ...(item.revision || item.headerVersion === undefined || item.bodyVersion === undefined ? {}
        : { revision: { headerVersion: item.headerVersion, bodyVersion: item.bodyVersion } }),
    }))));
    cursor = page.nextCursor;
  } while (cursor);
  return rows;
}

type Revision = ReadableApprovalProfileV1['revision'];
type Failure = Readonly<{ ok: false; errorCode: string; error: string }>;
export type ApprovalProfileArtifactStoreV1 = Readonly<{
  read: (id: string, options?: Readonly<{ signal?: AbortSignal }>) => Promise<(ArtifactSharingResourceV1 & { revision: Revision; access: ArtifactCallerAccessV1 }) | null>;
  create: (input: Readonly<{ header: Readonly<Record<string, unknown>>; body: string; signal?: AbortSignal }>) => Promise<Readonly<{ artifactId: string; revision: Revision }>>;
  update: (input: Readonly<{ artifactId: string; expectedRevision: Revision; header: Readonly<Record<string, unknown>>; body: string; signal?: AbortSignal }>) => Promise<Readonly<{ ok: true; revision: Revision }> | Failure>;
  delete: (id: string, options: Readonly<{ expectedRevision: Revision; signal?: AbortSignal }>) => Promise<Readonly<{ ok: true }> | Failure>;
}>;

/** Both hosts use one content/CAS/no-op owner; the Artifact transport retains ACL and crypto. */
export async function executeApprovalProfileArtifactChangeV1(store: ApprovalProfileArtifactStoreV1,
  change: ApprovalProfileArtifactChangeV1, signal?: AbortSignal): Promise<Failure | Readonly<{
    ok: true; result: { profileChange: ApprovalProfileArtifactChangeResultV1 }; profile?: ReadableApprovalProfileV1;
  }>> {
  signal?.throwIfAborted();
  const fail = (errorCode: string): Failure => ({ ok: false, errorCode, error: errorCode });
  if (change.kind === 'create') {
    const content: ApprovalProfileArtifactV1 = { kind: APPROVAL_PROFILE_ARTIFACT_KIND_V1, profile: change.profile };
    const created = await store.create({ header: buildApprovalProfileArtifactHeaderV1(content), body: JSON.stringify(content), signal });
    return { ok: true, result: { profileChange: { kind: change.kind, id: created.artifactId, revision: created.revision } },
      profile: { id: created.artifactId, profile: { ...change.profile, id: created.artifactId }, access: 'owner', revision: created.revision } };
  }
  const current = await store.read(change.id, { signal });
  if (!current || current.header.kind !== APPROVAL_PROFILE_ARTIFACT_KIND_V1) return fail('not_found');
  if (current.access === 'view' || change.kind === 'delete' && current.access !== 'owner') return fail('forbidden');
  if (!sameStrictJsonValue(current.revision, change.expectedRevision)) return fail('currentness_conflict');
  if (change.kind === 'delete') {
    const deleted = await store.delete(change.id, { expectedRevision: change.expectedRevision, signal });
    return deleted.ok ? { ok: true, result: { profileChange: { kind: change.kind, id: change.id, revision: change.expectedRevision } } }
      : deleted.errorCode === 'version_mismatch' ? fail('currentness_conflict') : deleted;
  }
  const content: ApprovalProfileArtifactV1 = { kind: APPROVAL_PROFILE_ARTIFACT_KIND_V1, profile: change.profile };
  const unchanged = sameStrictJsonValue(readApprovalProfileArtifactV1(current), content);
  const updated = unchanged ? { ok: true as const, revision: current.revision } : await store.update({
    artifactId: change.id, expectedRevision: change.expectedRevision,
    header: { ...current.header, ...buildApprovalProfileArtifactHeaderV1(content) }, body: JSON.stringify(content), signal,
  });
  if (!updated.ok) return updated.errorCode === 'version_mismatch' ? fail('currentness_conflict') : updated;
  const profile = listReadableApprovalProfilesV1([{ ...current, body: JSON.stringify(content),
    header: buildApprovalProfileArtifactHeaderV1(content), revision: updated.revision }])[0];
  return { ok: true, result: { profileChange: { kind: change.kind, id: change.id, revision: updated.revision } }, profile };
}
