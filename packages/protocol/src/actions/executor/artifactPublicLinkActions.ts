import { decodeBase64, encodeBase64 } from '../../crypto/base64.js';
import { computeContentPublicKeyFingerprint } from '../../machines/identity/contentPublicKeyFingerprint.js';
import { prepareResourceRecipientKeyEnvelopesV1 } from '../../teams/resourceRecipientKeyPreparationV1.js';
import { z } from 'zod/mini';
import { lazyZodSchema } from '../../lazyZodSchema.js';
import { ArtifactActionInputSchemasV1, ArtifactActionOutputSchemasV1, ArtifactDocumentV1Schema, ArtifactSignedInLinkCreateRequestV1Schema, ArtifactSignedInLinkEnsureResponseV1Schema, ArtifactSignedInLinkJoinReadV1Schema, ArtifactSignedInLinkJoinCommitInputV1Schema, ArtifactSignedInLinkJoinCommitResultV1Schema, type ArtifactSignedInLinkJoinReadV1 } from '../../artifacts/artifactActionsV1.js';
import { getArtifactUseTargetV1, type ArtifactSharingResourceV1 } from '../../artifacts/artifactSharingV1.js';
import { sealPublicShareDataKeyV1, openPublicShareDataKeyV1 } from '../../crypto/publicShareEncryptedDataKeyEnvelopeV0.js';
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

const signedInLinkOpenedArtifactSchema = lazyZodSchema(() => z.pick(ArtifactDocumentV1Schema, {
  artifactId: true, ownerAccountId: true, header: true, body: true, revision: true,
}));
export type ArtifactSignedInLinkOpenedArtifactV1 = z.infer<typeof signedInLinkOpenedArtifactSchema>;
export type ArtifactSignedInLinkOpenedV1 = Readonly<{
  artifact: ArtifactSignedInLinkOpenedArtifactV1;
  source: Readonly<{ authorAccountId: string; artifactId: string }>;
  follow: boolean;
  followUnavailableReason?: 'plain_account';
}>;

/** Opening material belongs to the answering host, never to an Action operand or stored source. */
export function createArtifactSignedInLinkJoinActionV1(params: Readonly<{
  request: (request: ArtifactPublicLinkRequestV1) => Promise<unknown>;
  consumeSecret: (lookupId: string) => Promise<string | null>;
  resolveRecipient: (signal?: AbortSignal) => Promise<Readonly<{ accountId: string; mode: 'plain' | 'e2ee'; contentPublicKey: Uint8Array | null }>>;
  randomBytes: (length: number) => Uint8Array;
  openContent: (input: Readonly<{ read: ArtifactSignedInLinkJoinReadV1; dataKey: Uint8Array | null }>) => Promise<ArtifactSignedInLinkOpenedArtifactV1>;
  onOpened: (opened: ArtifactSignedInLinkOpenedV1) => void | Promise<void>;
}>) {
  return async (args: Readonly<{ input: unknown; signal?: AbortSignal }>) => {
    args.signal?.throwIfAborted();
    const input = ArtifactActionInputSchemasV1['artifact.public_link.join'].parse(args.input);
    const secret = await params.consumeSecret(input.lookupId);
    if (!secret) throw Object.assign(new Error('artifact_encryption_material_unavailable'), { code: 'artifact_encryption_material_unavailable' });
    const path = `/v1/artifact-signed-in-links/${encodeURIComponent(input.lookupId)}/join`;
    const read = ArtifactSignedInLinkJoinReadV1Schema.parse(await params.request({ method: 'GET', path, signal: args.signal }));
    const recipient = await params.resolveRecipient(args.signal);
    if (read.recipientAccountId !== recipient.accountId) throw Object.assign(new Error('recipient_key_unavailable'), { code: 'recipient_key_unavailable' });
    args.signal?.throwIfAborted();
    const dataKey = read.encryptionMode === 'e2ee' ? openPublicShareDataKeyV1({ encryptedDataKey: read.encryptedDataKey!, secret }) : null;
    if (read.encryptionMode === 'e2ee' && !dataKey) throw Object.assign(new Error('artifact_encryption_material_unavailable'), { code: 'artifact_encryption_material_unavailable' });
    const artifact = signedInLinkOpenedArtifactSchema.parse(await params.openContent({ read, dataKey }));
    const source = { authorAccountId: read.authorAccountId, artifactId: read.artifactId };
    if (artifact.artifactId !== source.artifactId || artifact.ownerAccountId !== source.authorAccountId) {
      throw Object.assign(new Error('artifact_content_unavailable'), { code: 'artifact_content_unavailable' });
    }
    if (!getArtifactUseTargetV1(artifact, 'signed_in').publicLinkAllowed) {
      throw Object.assign(new Error('artifact_content_unavailable'), { code: 'artifact_content_unavailable' });
    }
    args.signal?.throwIfAborted();
    let keyEnvelope;
    if (dataKey) {
      if (recipient.mode === 'plain') {
        const result = { ...source, follow: false, followUnavailableReason: 'plain_account' as const };
        await params.onOpened({ artifact, source, follow: false, followUnavailableReason: 'plain_account' });
        return ArtifactActionOutputSchemasV1['artifact.public_link.join'].parse(result);
      }
      if (read.recipientContentKey.status === 'unavailable') throw Object.assign(new Error('recipient_key_unavailable'), { code: 'recipient_key_unavailable', reason: read.recipientContentKey.reason });
      if (!recipient.contentPublicKey || encodeBase64(recipient.contentPublicKey) !== read.recipientContentKey.contentPublicKey)
        throw Object.assign(new Error('recipient_key_unavailable'), { code: 'recipient_key_unavailable' });
      keyEnvelope = prepareResourceRecipientKeyEnvelopesV1({ dataKey, randomBytes: params.randomBytes, recipients: [{
        recipientAccountId: read.recipientAccountId, contentKey: read.recipientContentKey,
        contentPublicKeyFingerprint: computeContentPublicKeyFingerprint(decodeBase64(read.recipientContentKey.contentPublicKey)),
        encryptedDataKey: null, recipientContentPublicKeyFingerprint: null,
      }] })[0];
      if (!keyEnvelope) throw Object.assign(new Error('recipient_key_unavailable'), { code: 'recipient_key_unavailable' });
    }
    args.signal?.throwIfAborted();
    const body = ArtifactSignedInLinkJoinCommitInputV1Schema.parse({ ...(keyEnvelope ? { keyEnvelope } : {}) });
    const committed = ArtifactSignedInLinkJoinCommitResultV1Schema.parse(await params.request({ method: 'POST', path, body, signal: args.signal }));
    if (committed.artifactId !== read.artifactId || committed.ownerAccountId !== read.authorAccountId) {
      throw Object.assign(new Error('artifact_content_unavailable'), { code: 'artifact_content_unavailable' });
    }
    await params.onOpened({ artifact, source, follow: true });
    return ArtifactActionOutputSchemasV1['artifact.public_link.join'].parse({ ...source, follow: true });
  };
}

/** The authenticated publication-list transport shared by management and audience admission. */
export async function readArtifactPublicLinksV1(params: Readonly<{
  artifactId: string;
  audience?: 'anonymous' | 'signed_in';
  request: (request: ArtifactPublicLinkRequestV1) => Promise<unknown>;
  signal?: AbortSignal;
}>) {
  params.signal?.throwIfAborted();
  const path = params.audience === 'signed_in' ? `/v1/artifact-signed-in-links?${new URLSearchParams({ artifactId: params.artifactId })}`
    : `/v1/public-shares?${new URLSearchParams({ subjectKind: 'artifact', subjectId: params.artifactId })}`;
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
  shareableServerUrl?: string | null;
}>) {
  return async (args: Readonly<{ actionId: ArtifactPublicLinkActionIdV1; input: unknown; signal?: AbortSignal }>): Promise<unknown> => {
    args.signal?.throwIfAborted();
    const input = ArtifactActionInputSchemasV1[args.actionId].parse(args.input);
    const audience = 'audience' in input ? input.audience ?? 'anonymous' : 'anonymous';
    if (args.actionId === 'artifact.public_link.create' && audience === 'signed_in' && !params.onPublicLinkIssued) {
      throw Object.assign(new Error('unsupported_action'), { code: 'unsupported_action' });
    }
    const resource = await params.read(input.artifactId, args.signal);
    args.signal?.throwIfAborted();
    if (!resource || resource.artifactId !== input.artifactId) throw Object.assign(new Error('artifact_not_found'), { code: 'artifact_not_found' });
    if (resource.access !== 'owner') throw Object.assign(new Error('artifact_access_forbidden'), { code: 'artifact_access_forbidden' });
    // Existing publications must remain revocable even if the current kind no longer admits new links.
    if (args.actionId === 'artifact.public_link.create' && !getArtifactUseTargetV1(resource, audience).publicLinkAllowed) {
      throw Object.assign(new Error('artifact_kind_not_shareable'), { code: 'artifact_kind_not_shareable' });
    }
    if (args.actionId === 'artifact.public_link.list') {
      return readArtifactPublicLinksV1({ ...params, artifactId: input.artifactId, audience, signal: args.signal });
    }
    if (args.actionId === 'artifact.public_link.revoke' || args.actionId === 'artifact.public_link.audit') {
      const revoke = ArtifactActionInputSchemasV1[args.actionId].parse(input);
      const owned = await readArtifactPublicLinksV1({ ...params, artifactId: input.artifactId, audience, signal: args.signal });
      if (!owned.publicShares.some(row => row.id === revoke.shareId && row.subject.kind === 'artifact' && row.subject.id === input.artifactId)) throw Object.assign(new Error('public_share_not_found'), { code: 'public_share_not_found' });
      if (args.actionId === 'artifact.public_link.audit') {
        const result = await params.request({ method: 'GET', path: `/v1/public-shares/${encodeURIComponent(revoke.shareId)}/access-log`, signal: args.signal });
        args.signal?.throwIfAborted();
        return ArtifactActionOutputSchemasV1[args.actionId].parse(result);
      }
      await params.request({ method: 'DELETE', path: audience === 'signed_in' ? `/v1/artifact-signed-in-links/${encodeURIComponent(input.artifactId)}`
        : `/v1/public-shares/${encodeURIComponent(revoke.shareId)}`, signal: args.signal });
      return { artifactId: input.artifactId, shareId: revoke.shareId, revoked: true };
    }
    const create = ArtifactActionInputSchemasV1['artifact.public_link.create'].parse(input);
    if ((resource.encryptionMode === 'e2ee') !== (resource.dataKey !== null)) throw Object.assign(new Error('artifact_encryption_material_unavailable'), { code: 'artifact_encryption_material_unavailable' });
    const material = generateStoredContentPublicShareMaterialV1(params.randomBytes);
    const encryptedDataKey = resource.dataKey === null ? undefined : sealPublicShareDataKeyV1({ dataKey: resource.dataKey, secret: material.secret, randomBytes: params.randomBytes });
    const body = audience === 'signed_in' ? ArtifactSignedInLinkCreateRequestV1Schema.parse({ artifactId: create.artifactId,
      lookupId: material.lookupId, ...(encryptedDataKey === undefined ? {} : { encryptedDataKey }),
      ...(create.preserveExisting ? { preserveExisting: true } : {}) })
      : StoredContentPublicShareCreateRequestV1Schema.parse({ subject: { kind: 'artifact', id: create.artifactId },
      lookupId: material.lookupId, keyDerivation: 'fragment_v1',
      ...(encryptedDataKey === undefined ? {} : { encryptedDataKey }),
      ...(create.expiresAt === undefined ? {} : { expiresAt: create.expiresAt }),
      ...(create.maxUses === undefined ? {} : { maxUses: create.maxUses }),
      ...(create.isConsentRequired === undefined ? {} : { isConsentRequired: create.isConsentRequired }) });
    const response = await params.request({ method: 'POST',
      path: audience === 'signed_in' ? '/v1/artifact-signed-in-links' : '/v1/public-shares', body, signal: args.signal });
    const result = (create.preserveExisting ? ArtifactSignedInLinkEnsureResponseV1Schema : StoredContentPublicShareCreateResponseV1Schema).parse(response);
    if (result.publicShare.subject.kind !== 'artifact' || result.publicShare.subject.id !== create.artifactId || result.publicShare.keyDerivation !== 'fragment_v1') throw Object.assign(new Error('public_share_subject_mismatch'), { code: 'public_share_subject_mismatch' });
    if (audience === 'signed_in' && result.publicShare.audience !== 'signed_in') throw Object.assign(new Error('outcome_unknown'), { code: 'outcome_unknown' });
    // The server retained the current bearer; generated material was never published.
    if ('created' in result && !result.created) return ArtifactActionOutputSchemasV1[args.actionId].parse({ publicShare: result.publicShare });
    const url = buildStoredContentPublicShareUrlV1({ ...material, origin: result.viewerOrigin,
      ...(audience === 'signed_in' ? { audience, shareableServerUrl: params.shareableServerUrl } : {}) });
    try {
      await params.onPublicLinkIssued?.({ ...material, shareId: result.publicShare.id, url });
    } catch {
      // The Home committed; a host custody exception cannot disclose the secret or prove rollback.
      throw Object.assign(new Error('outcome_unknown'), { code: 'outcome_unknown' });
    }
    args.signal?.throwIfAborted();
    const resultUrl = audience === 'signed_in' ? url.slice(0, url.indexOf('#')) : url;
    return ArtifactActionOutputSchemasV1[args.actionId].parse({ publicShare: result.publicShare, url: resultUrl });
  };
}
