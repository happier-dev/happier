import { ArtifactActionInputSchemasV1, ArtifactActionOutputSchemasV1 } from '../../artifacts/artifactActionsV1.js';
import { getArtifactUseTargetV1, type ArtifactSharingResourceV1 } from '../../artifacts/artifactSharingV1.js';
import { sealPublicShareDataKeyV1 } from '../../crypto/publicShareEncryptedDataKeyEnvelopeV0.js';
import { buildStoredContentPublicShareUrlV1, generateStoredContentPublicShareMaterialV1,
  StoredContentPublicShareCreateRequestV1Schema, StoredContentPublicShareCreateResponseV1Schema,
  StoredContentPublicSharesListResponseV1Schema } from '../../sharing/storedContentPublicShareV1.js';

export type ArtifactPublicLinkActionIdV1 = 'artifact.public_link.create' | 'artifact.public_link.list' | 'artifact.public_link.revoke' | 'artifact.public_link.audit';
/** Complete link issued by the keyholding host after approved creation; never an HTTP payload. */
export type ArtifactPublicLinkIssuedV1 = Readonly<{ lookupId: string; secret: string; shareId: string; url: string }>;
export type ArtifactPublicLinkKeyholdingResourceV1 = ArtifactSharingResourceV1 & Readonly<{
  encryptionMode: 'plain' | 'e2ee'; dataKey: Uint8Array | null;
}>;
export type ArtifactPublicLinkRequestV1 = Readonly<{ method: 'GET' | 'POST' | 'DELETE'; path: string; body?: unknown; signal?: AbortSignal }>;

/** The authenticated publication-list transport shared by management and audience admission. */
export async function readArtifactPublicLinksV1(params: Readonly<{
  artifactId: string;
  request: (request: ArtifactPublicLinkRequestV1) => Promise<unknown>;
  signal?: AbortSignal;
}>) {
  params.signal?.throwIfAborted();
  const path = `/v1/public-shares?${new URLSearchParams({ subjectKind: 'artifact', subjectId: params.artifactId })}`;
  const result = StoredContentPublicSharesListResponseV1Schema.parse(await params.request({ method: 'GET', path, signal: params.signal }));
  params.signal?.throwIfAborted();
  if (result.publicShares.some(row => row.subject.kind !== 'artifact' || row.subject.id !== params.artifactId)) {
    throw Object.assign(new Error('public_share_subject_mismatch'), { code: 'public_share_subject_mismatch' });
  }
  return result;
}

/** One logical owner; host adapters supply authenticated HTTP and already-opened Artifact keys. */
export function createArtifactPublicLinkActionsV1(params: Readonly<{
  read: (artifactId: string, signal?: AbortSignal) => Promise<ArtifactPublicLinkKeyholdingResourceV1 | null>;
  request: (request: ArtifactPublicLinkRequestV1) => Promise<unknown>;
  randomBytes: (length: number) => Uint8Array;
  onPublicLinkIssued?: (link: ArtifactPublicLinkIssuedV1) => void | Promise<void>;
}>) {
  return async (args: Readonly<{ actionId: ArtifactPublicLinkActionIdV1; input: unknown; signal?: AbortSignal }>): Promise<unknown> => {
    args.signal?.throwIfAborted();
    const input = ArtifactActionInputSchemasV1[args.actionId].parse(args.input);
    const resource = await params.read(input.artifactId, args.signal);
    args.signal?.throwIfAborted();
    if (!resource || resource.artifactId !== input.artifactId) throw Object.assign(new Error('artifact_not_found'), { code: 'artifact_not_found' });
    if (resource.access !== 'owner') throw Object.assign(new Error('artifact_access_forbidden'), { code: 'artifact_access_forbidden' });
    // Existing publications must remain revocable even if the current kind no longer admits new links.
    if (args.actionId === 'artifact.public_link.create' && !getArtifactUseTargetV1(resource).publicLinkAllowed) {
      throw Object.assign(new Error('artifact_kind_not_shareable'), { code: 'artifact_kind_not_shareable' });
    }
    if (args.actionId === 'artifact.public_link.list') {
      return readArtifactPublicLinksV1({ ...params, artifactId: input.artifactId, signal: args.signal });
    }
    if (args.actionId === 'artifact.public_link.revoke' || args.actionId === 'artifact.public_link.audit') {
      const revoke = ArtifactActionInputSchemasV1[args.actionId].parse(input);
      const owned = await readArtifactPublicLinksV1({ ...params, artifactId: input.artifactId, signal: args.signal });
      if (!owned.publicShares.some(row => row.id === revoke.shareId && row.subject.kind === 'artifact' && row.subject.id === input.artifactId)) throw Object.assign(new Error('public_share_not_found'), { code: 'public_share_not_found' });
      if (args.actionId === 'artifact.public_link.audit') {
        const result = await params.request({ method: 'GET', path: `/v1/public-shares/${encodeURIComponent(revoke.shareId)}/access-log`, signal: args.signal });
        args.signal?.throwIfAborted();
        return ArtifactActionOutputSchemasV1[args.actionId].parse(result);
      }
      await params.request({ method: 'DELETE', path: `/v1/public-shares/${encodeURIComponent(revoke.shareId)}`, signal: args.signal });
      return { artifactId: input.artifactId, shareId: revoke.shareId, revoked: true };
    }
    const create = ArtifactActionInputSchemasV1['artifact.public_link.create'].parse(input);
    if ((resource.encryptionMode === 'e2ee') !== (resource.dataKey !== null)) throw Object.assign(new Error('artifact_encryption_material_unavailable'), { code: 'artifact_encryption_material_unavailable' });
    const material = generateStoredContentPublicShareMaterialV1(params.randomBytes);
    const body = StoredContentPublicShareCreateRequestV1Schema.parse({ subject: { kind: 'artifact', id: create.artifactId },
      lookupId: material.lookupId, keyDerivation: 'fragment_v1',
      ...(resource.dataKey === null ? {} : { encryptedDataKey: sealPublicShareDataKeyV1({ dataKey: resource.dataKey, secret: material.secret, randomBytes: params.randomBytes }) }),
      ...(create.expiresAt === undefined ? {} : { expiresAt: create.expiresAt }),
      ...(create.maxUses === undefined ? {} : { maxUses: create.maxUses }),
      ...(create.isConsentRequired === undefined ? {} : { isConsentRequired: create.isConsentRequired }) });
    const result = StoredContentPublicShareCreateResponseV1Schema.parse(await params.request({ method: 'POST', path: '/v1/public-shares', body, signal: args.signal }));
    if (result.publicShare.subject.kind !== 'artifact' || result.publicShare.subject.id !== create.artifactId || result.publicShare.keyDerivation !== 'fragment_v1') throw Object.assign(new Error('public_share_subject_mismatch'), { code: 'public_share_subject_mismatch' });
    const url = buildStoredContentPublicShareUrlV1({ ...material, origin: result.isolatedOrigin });
    try {
      await params.onPublicLinkIssued?.({ ...material, shareId: result.publicShare.id, url });
    } catch {
      // The Home committed; a host custody exception cannot disclose the secret or prove rollback.
      throw Object.assign(new Error('outcome_unknown'), { code: 'outcome_unknown' });
    }
    args.signal?.throwIfAborted();
    return ArtifactActionOutputSchemasV1[args.actionId].parse({ publicShare: result.publicShare, url });
  };
}
