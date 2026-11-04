import { createCliArtifactSignedInLinkJoinAction } from './artifactSignedInLinkJoin';
import type { ArtifactTemplateAcceptedVersionInputV1 } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { reportArtifactTemplateAcceptedVersion } from './artifactAccessHttp';
import { isDeepStrictEqual } from 'node:util';
import { resolveInboxItemAttentionV1 } from '@happier-dev/protocol/sessions/follow/sessionFollowPolicyV1';
import { type ServiceHealthNoticeNotificationV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { ServiceHealthNoticeNotificationV1Schema } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import { healthAlertIdentityTupleV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';
import axios from '@/api/client/credentialAxios';


import { ArtifactJsonUpdateHttpInputV1Schema } from '@happier-dev/protocol';

import { timeWebLatencyPhase } from '@/daemon/externalActions/webLatencyTrace';
import { z } from 'zod/mini';
import { ARTIFACT_UPLOAD_CONTENT_TYPE_V1, ARTIFACT_UPLOAD_PATH_V1, encodeArtifactUploadFrameV1 } from '@happier-dev/transfers';
import { createHash, createHmac, randomUUID } from 'node:crypto';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { deriveAccountMachineKeyFromRecoverySecret } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { type UsageNoticeArtifactHeaderV1,
  ACCOUNT_NOTICE_ARTIFACT_KIND_V1, AccountNoticeArtifactBodyV1Schema, AccountNoticeArtifactHeaderV1Schema,
  readAccountNoticeArtifactV1, readAccountNoticeArtifactHeaderV1, readUsageNoticeArtifactV1, readUsageNoticeArtifactHeaderV1,
  type AccountNoticeArtifactHeaderV1 } from '@happier-dev/protocol/activity/usageNoticeArtifactV1';

import { ARTIFACT_PLAIN_DATA_KEY_MARKER, decodePlainArtifactStoredContent, encodePlainArtifactStoredContent, isPlainArtifactDataKeyMarker } from '@happier-dev/protocol/storage/artifactStoredContent';
import { createResourceDataKey, openResourceDataKey, ResourceDataKeyUnavailableError } from '@/api/encryption/resourceDataKey';
import { ArtifactAccessErrorCodeV1Schema, ArtifactAccessGrantsListResponseV1Schema, ArtifactAccessGrantMutationResponseV1Schema, ArtifactAccessRecipientCensusResponseV1Schema, ArtifactRecipientKeyEnvelopeCommitResponseV1Schema, ArtifactReadBatchInputV1Schema, ArtifactReadBatchResponseV1Schema, ArtifactReadHeadersBatchInputV1Schema, ArtifactReadHeadersBatchResponseV1Schema, ArtifactHttpReadV1Schema } from '@happier-dev/protocol/artifacts/artifactAccessV1';
import { completeArtifactAccessMutationPreparationV1, runArtifactRecipientKeyPreparationV1, prepareArtifactRecipientKeyEnvelopesV1 } from '@happier-dev/protocol/artifacts/artifactRecipientKeyPreparationV1';
import type { ArtifactCallerAccessV1, ArtifactAccessGrantSetInputV1, ArtifactAccessGrantRemoveInputV1, ArtifactPublicLinkActionIdV1, ArtifactPublicLinkIssuedV1, ArtifactSavedByV1, ArtifactWorkspaceSourceV1, ArtifactRevisionProvenanceV1, ArtifactBodyV1, ArtifactBlobWriteV1, ArtifactListSelectionOptionsV1 } from '@happier-dev/protocol';
import { ArtifactHeaderMetadataV1Schema, ArtifactPublicAudienceV1ReadSchema, type ArtifactPublicAudienceV1, ArtifactQuotaExceededV1Schema, ArtifactRevisionListResponseV1Schema, ArtifactStorageUsageV1Schema } from '@happier-dev/protocol/artifacts/artifactActionsV1';
import { canShareArtifactWriteContentV1, prepareArtifactHeaderForRevisionV1, prepareArtifactHeaderForBodyV1 } from '@happier-dev/protocol/artifacts/artifactHeaderRestorationV1';
import { withArtifactExcerptV1 } from '@happier-dev/protocol/artifacts/artifactExcerptV1';
import { artifactKindRequiresSharedAudienceV1, artifactKindRequiresTextBodyV1, readArtifactSharedAudienceV1 } from '@happier-dev/protocol/artifacts/artifactSharingV1';
import { createArtifactPublicLinkActionsV1, readArtifactPublicLinksV1, type ArtifactPublicLinkRequestV1 } from '@happier-dev/protocol/actions/executor/artifactPublicLinkActions';
import { ArtifactBodyV1Schema, ArtifactBodyEnvelopeV1StoredSchema, ArtifactPrivateRevisionMetadataV1Schema, ArtifactPrivateRevisionMetadataV1StoredSchema, ArtifactBlobReferenceV1Schema, ArtifactBlobReadResponseV1Schema } from '@happier-dev/protocol/artifacts/artifactBinaryV1';
import { openResourceBinaryContent, sealResourceBinaryContent } from '@/api/encryption/resourceBinaryContent';
import { artifactHtmlBundleFromBodyV1, isArtifactHtmlHeaderV1 } from '@happier-dev/protocol/artifacts/artifactHtmlV1';
import { listArtifactHeadersV1, type ArtifactListPageOptionsV1 } from '@happier-dev/protocol/artifacts/artifactListSelectionV1';
import { tryDeriveArtifactStoredKindV1, ArtifactKindCoverageV1Schema, ArtifactKindWriteBatchResponseV1Schema,
  frameArtifactKindWriteBatchesV1, type ArtifactKindCoverageV1, type ArtifactKindWriteBatchInputV1 } from '@happier-dev/protocol/artifacts/artifactKindV1';
import { readServerEnabledBit } from '@happier-dev/protocol/features/serverEnabledBit';
import { fetchServerFeaturesSnapshot, type CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { approvalArtifactBodyMatchesHeaderV1 } from '@happier-dev/protocol/approvals/approvalArtifactHeaderV1';
import { projectTargetActionApprovalInvocationV1, TargetActionApprovalRequestV1Schema } from '@happier-dev/protocol/approvals/targetActionApprovalRequestV1';
import { ApprovalRequestV2Schema } from '@happier-dev/protocol/approvals/approvalRequestV1';
import { computeActionInputApprovalDigestV1 } from '@happier-dev/protocol/actions/decisionAuthority';
import { SessionAccessGrantsListResponseV1Schema } from '@happier-dev/protocol/sessions/access/sessionAccessOperationsV1';

import type { Credentials, StoredCredentials } from '@/persistence';
import type { AccountEncryptionModeReadOptions, ConnectedServiceAccountEncryptionMode } from '@/api/client/connectedServiceCredentialApi';
import { createConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import {
  libsodiumPublicKeyFromSecretKey,
  decodeBase64,
  decryptWithDataKey,
  encodeBase64,
  encryptWithDataKey,
  getRandomBytes,
} from '@/api/encryption';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { logger } from '@/ui/logger';
import { readAccountIdFromToken } from '@/cloud/decodeJwtPayload';
import type { HomeHubArtifactTransportV1 } from '@happier-dev/protocol/home';
import type { CoordinationMessageRefV1 } from '@happier-dev/protocol/discussions/messageRefs';
import { MemoryDecisionSourceErrorCodeV1Schema } from '@happier-dev/protocol/prompts/library/memoryActionsV1';
import { requesterAccountEncryptionMode, type RequesterAccountAuthorizationHeaders } from '@/daemon/sessionEncryption/requesterAccountActionContext';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import { createHttpStatusError, HttpStatusError, readHttpStatus } from '@/api/client/httpStatusError';
import { createBackoff } from '@/utils/time';
import { DOC_EDIT_PROPOSAL_HTTP_PATHS_V1, DocEditAcceptHostInputV1Schema, DocEditAcceptTransportInputV1Schema,
  DocEditDeclineTransportInputV1Schema, DocEditDecisionResultV1Schema,
  type DocEditAcceptHostInputV1, type DocEditDeclineInputV1 } from '@happier-dev/protocol/artifacts/artifactCollaborationActionsV1';

export type AccountArtifactRevision = Readonly<{ headerVersion: number; bodyVersion: number }>;

function readArtifactStorageFailureCode(value: unknown) {
  return value === 'database_transaction_conflict_exhausted' || value === 'database_connection_unavailable' ? value : null;
}

// Retry only the revision-fenced HTTP write, never its Action/native effect.
// The existing transport backoff owns the retry budget. Identical bytes and
// expected versions keep a lost acknowledgement from applying a second write;
// the caller still reconciles a resulting revision conflict with its receipt.
const retryArtifactRevisionUpdate = createBackoff({
  shouldRetry: error => {
    const { kind } = classifyServerEndpointError(error);
    return kind === 'server_error' || kind === 'network' || kind === 'timeout';
  },
  onError: (error, failuresCount) => {
    const { kind, statusCode } = classifyServerEndpointError(error);
    logger.infoFile('[Artifacts] Retrying revision update', { failuresCount, kind, statusCode });
  },
});

export type ArtifactRequestAuthorizationHeaders = (request: Readonly<{ method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string; body?: unknown }>) => Promise<RequesterAccountAuthorizationHeaders>;
export type AccountArtifact = Readonly<{
  ownerAccountId: string;
  ownerDisplayName?: string | null;
  access: ArtifactCallerAccessV1;
  shared?: boolean;
  publicAudience?: ArtifactPublicAudienceV1;
  artifactId: string;
  header: Readonly<Record<string, unknown>>;
  body: ArtifactBodyV1 | null;
  provenance?: ArtifactRevisionProvenanceV1;
  revision: AccountArtifactRevision;
  seq: number;
  createdAt: number;
  updatedAt: number;
}>;
export type AccountArtifactHeader = Readonly<{
  ownerAccountId: string;
  ownerDisplayName?: string | null;
  access: ArtifactCallerAccessV1;
  publicAudience?: ArtifactPublicAudienceV1;
  artifactId: string; header: Readonly<Record<string, unknown>>; headerVersion: number;
  seq: number; createdAt: number; updatedAt: number;
  body?: ArtifactBodyV1 | null; bodyVersion?: number;
  provenance?: ArtifactRevisionProvenanceV1;
}>;
export function encodeAccountArtifactListCursor(item: Pick<AccountArtifactHeader, 'artifactId' | 'updatedAt'>): string {
  return Buffer.from(JSON.stringify({ updatedAt: item.updatedAt, id: item.artifactId }), 'utf8').toString('base64url');
}

type StoredArtifactHeader = Readonly<{
  ownerAccountId: string;
  ownerDisplayName?: string | null;
  access: ArtifactCallerAccessV1;
  publicAudience: ArtifactPublicAudienceV1;
  encryptionMode: 'plain' | 'e2ee';
  id: string; header: string; headerVersion: number; bodyVersion?: number;
  dataEncryptionKey: string; seq: number; createdAt: number; updatedAt: number;
  provenance?: string | null; provenanceDataEncryptionKey?: string | null;
}>;
type StoredArtifact = StoredArtifactHeader & Readonly<{ body: string; bodyVersion: number }>;

type Codec = Readonly<{
  mode: 'plain' | 'e2ee'; dataEncryptionKey: string;
  dataKey: Uint8Array | null;
  encode(value: unknown): string; decode(value: string): unknown | null;
}>;

function readNonnegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}

function readAcknowledgedRevision(value: unknown): AccountArtifactRevision {
  const headerVersion = readNonnegativeSafeInteger(value && typeof value === 'object' ? Reflect.get(value, 'headerVersion') : undefined);
  const bodyVersion = readNonnegativeSafeInteger(value && typeof value === 'object' ? Reflect.get(value, 'bodyVersion') : undefined);
  if (headerVersion === null || bodyVersion === null) {
    throw Object.assign(new Error('artifact_content_unavailable'), { code: 'artifact_content_unavailable' });
  }
  return { headerVersion, bodyVersion };
}

function readQuotaFailure(response: Readonly<{ status: number; data: unknown }>) {
  if (response.status !== 413) return null;
  const parsed = ArtifactQuotaExceededV1Schema.safeParse(response.data);
  if (!parsed.success) return null;
  const { budget, limitBytes, usedBytes } = parsed.data;
  return { ok: false, errorCode: 'quota_exceeded', error: 'quota_exceeded',
    details: { budget, limitBytes, usedBytes } } as const;
}

export const ARTIFACT_ENCRYPTION_MATERIAL_UNAVAILABLE = 'artifact_encryption_material_unavailable' as const;
export type ArtifactQueryHintBackfillResult = ArtifactKindCoverageV1
  | Readonly<{ status: 'unsupported' | 'retired' }>
  | Readonly<{ status: 'unavailable'; reason: 'read_unavailable' | 'write_unavailable' | 'write_refused' }>;
export type ArtifactQueryHintFeatures = () => CliServerFeaturesSnapshot | undefined | Promise<CliServerFeaturesSnapshot | undefined>;
export class ArtifactEncryptionMaterialUnavailableError extends Error {
  readonly code = ARTIFACT_ENCRYPTION_MATERIAL_UNAVAILABLE;
  constructor() { super('Artifact encryption material is unavailable'); this.name = 'ArtifactEncryptionMaterialUnavailableError'; }
}

function requireCredentials(credentials: ContentEncryption): Pick<Credentials, 'encryption'> {
  if (!credentials.encryption) throw new ArtifactEncryptionMaterialUnavailableError();
  return { encryption: credentials.encryption };
}

function usageNoticeOccurrence(params: Readonly<{ accountId: string; notice: UsageNoticeArtifactHeaderV1['notice'] }>): string {
  return JSON.stringify(params.notice.topic === 'resource_limit'
    ? ['happier:machine-vitals-notice-occurrence:v1', params.accountId, params.notice.machineId,
      params.notice.kind, 'volumeId' in params.notice ? params.notice.volumeId : null, params.notice.phase, params.notice.at]
    : ['happier:usage-notice-occurrence:v1', params.accountId,
      params.notice.serviceId, params.notice.profileId, params.notice.kind, params.notice.issueFingerprint]);
}

function accountNoticeOccurrence(accountId: string, notice: Pick<AccountNoticeArtifactHeaderV1, 'source' | 'notice'>): string {
  if (notice.source.kind === 'host' && notice.source.topic === 'service_health') {
    return JSON.stringify(['happier:service-health-notice:v1', accountId, healthAlertIdentityTupleV1(notice.source.subject)]);
  }
  if (notice.source.kind === 'host' && notice.notice) {
    return usageNoticeOccurrence({ accountId, notice: notice.notice });
  }
  return JSON.stringify(['happier:plugin-notice:v1', accountId, notice.source]);
}

function privateNoticeArtifactId(params: Readonly<{ occurrence: string; mode: 'plain' | 'e2ee'; credentials: ContentEncryption }>): string {
  let bytes: Buffer;
  if (params.mode === 'plain') {
    bytes = createHash('sha1').update(params.occurrence).digest().subarray(0, 16);
  } else {
    const material = requireCredentials(params.credentials).encryption;
    // This is the Account content private key, not the per-machine data key.
    const accountKey = material.type === 'dataKey' ? material.machineKey : deriveAccountMachineKeyFromRecoverySecret(material.secret);
    bytes = createHmac('sha256', accountKey).update(params.occurrence).digest().subarray(0, 16);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function createCodec(params: Readonly<{
  credentials: ContentEncryption; mode: ConnectedServiceAccountEncryptionMode;
}>): Promise<Codec> {
  if (params.mode === 'plain') {
    return { mode: 'plain', dataKey: null, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      encode: encodePlainArtifactStoredContent, decode: decodePlainArtifactStoredContent };
  }
  if (params.mode === 'unknown') throw Object.assign(new Error('account_encryption_mode_unavailable'), { code: 'account_encryption_mode_unavailable' });
  requireCredentials(params.credentials);
  const resource = await createResourceDataKey({ credentials: params.credentials, mode: 'e2ee' });
  if (resource.mode !== 'e2ee') throw new ArtifactEncryptionMaterialUnavailableError();
  const key = resource.dataKey;
  return {
    mode: 'e2ee',
    dataKey: key,
    dataEncryptionKey: resource.dataEncryptionKey,
    encode: (value) => encodeBase64(encryptWithDataKey(value, key), 'base64'),
    decode: (value) => decryptWithDataKey(decodeBase64(value), key),
  };
}

async function openCodec(credentialsInput: ContentEncryption, dataEncryptionKey: string, mode: ConnectedServiceAccountEncryptionMode): Promise<Codec> {
  if (mode === 'unknown') throw Object.assign(new Error('account_encryption_mode_unavailable'), { code: 'account_encryption_mode_unavailable' });
  if ((mode === 'plain') !== isPlainArtifactDataKeyMarker(dataEncryptionKey)) {
    throw Object.assign(new Error('artifact_account_mode_mismatch'), { code: 'artifact_account_mode_mismatch' });
  }
  if (isPlainArtifactDataKeyMarker(dataEncryptionKey)) return {
    mode: 'plain', dataKey: null, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    encode: encodePlainArtifactStoredContent, decode: decodePlainArtifactStoredContent,
  };
  requireCredentials(credentialsInput);
  let key: Uint8Array;
  try {
    const resource = await openResourceDataKey({ credentials: credentialsInput, mode: 'e2ee', dataEncryptionKey });
    if (resource.mode !== 'e2ee') throw new ArtifactEncryptionMaterialUnavailableError();
    key = resource.dataKey;
  } catch (error) {
    if (error instanceof ResourceDataKeyUnavailableError) throw new ArtifactEncryptionMaterialUnavailableError();
    throw error;
  }
  return { mode: 'e2ee', dataKey: key, dataEncryptionKey,
    encode: (value) => encodeBase64(encryptWithDataKey(value, key), 'base64'),
    decode: (value) => decryptWithDataKey(decodeBase64(value), key) };
}

function decode(codec: Codec, value: string): unknown {
  try {
    const decoded = codec.decode(value);
    if (decoded === null) throw new ArtifactEncryptionMaterialUnavailableError();
    return decoded;
  } catch (error) {
    if (error instanceof ArtifactEncryptionMaterialUnavailableError) throw error;
    throw new ArtifactEncryptionMaterialUnavailableError();
  }
}

function decodeBody(codec: Codec, value: string): ArtifactBodyV1 | null {
  const decoded = decode(codec, value);
  const parsed = ArtifactBodyEnvelopeV1StoredSchema.safeParse(decoded);
  if (!parsed.success) throw new ArtifactEncryptionMaterialUnavailableError();
  return parsed.data.body;
}

type ArtifactWriteContent = Readonly<{ body: ArtifactBodyV1; binary?: never } | {
  binary: Readonly<{ bytes: Uint8Array; mime: string }>; body?: never;
}>;

async function prepareWriteContent(codec: Codec, input: ArtifactWriteContent): Promise<Readonly<{
  body: ArtifactBodyV1; blob?: ArtifactBlobWriteV1;
}>> {
  if (!input.binary) {
    const body = ArtifactBodyV1Schema.parse(input.body);
    return { body, ...(typeof body === 'string' ? {} : { blob: { blobId: body.blobId } }) };
  }
  const { bytes, mime } = input.binary;
  const body = ArtifactBlobReferenceV1Schema.parse({ blobId: randomUUID(), mime, sizeBytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex') });
  const content = await sealResourceBinaryContent(codec, bytes);
  return { body, blob: { blobId: body.blobId, content } };
}

function unavailableBinary(): Error {
  return Object.assign(new Error('artifact_content_unavailable'), { code: 'artifact_content_unavailable' });
}

function requireBodyForArtifactKind(header: Readonly<Record<string, unknown>>, body: ArtifactBodyV1 | null): void {
  if (artifactKindRequiresTextBodyV1(header.kind) && typeof body !== 'string') throw unavailableBinary();
}

function parseStoredArtifactHeader(raw: unknown): StoredArtifactHeader | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || typeof value.header !== 'string' || typeof value.dataEncryptionKey !== 'string') return null;
  const headerVersion = readNonnegativeSafeInteger(value.headerVersion);
  const bodyVersion = readNonnegativeSafeInteger(value.bodyVersion);
  const seq = readNonnegativeSafeInteger(value.seq);
  const createdAt = readNonnegativeSafeInteger(value.createdAt);
  const updatedAt = readNonnegativeSafeInteger(value.updatedAt);
  if (headerVersion === null || (value.bodyVersion !== undefined && bodyVersion === null)
    || seq === null || createdAt === null || updatedAt === null) return null;
  if ((value.provenance != null && typeof value.provenance !== 'string')
    || (value.provenanceDataEncryptionKey != null && typeof value.provenanceDataEncryptionKey !== 'string')) {
    throw new ArtifactEncryptionMaterialUnavailableError();
  }
  return { id: value.id, header: value.header, headerVersion,
    ...(value.ownerDisplayName === undefined ? {} : { ownerDisplayName: ArtifactHttpReadV1Schema.shape.ownerDisplayName.parse(value.ownerDisplayName) }),
    publicAudience: ArtifactPublicAudienceV1ReadSchema.parse(value.publicAudience),
    ...(bodyVersion === null ? {} : { bodyVersion }), dataEncryptionKey: value.dataEncryptionKey, seq, createdAt, updatedAt,
    ...(typeof value.provenance === 'string' ? { provenance: value.provenance } : {}),
    ...(typeof value.provenanceDataEncryptionKey === 'string' ? { provenanceDataEncryptionKey: value.provenanceDataEncryptionKey } : {}),
    ...readStoredAccess(value) };
}

function parseStoredArtifact(raw: unknown): StoredArtifact | null {
  if (!raw || typeof raw !== 'object') return null;
  const body: unknown = Reflect.get(raw, 'body');
  if (typeof body !== 'string' || readNonnegativeSafeInteger(Reflect.get(raw, 'bodyVersion')) === null) return null;
  const header = parseStoredArtifactHeader(raw);
  return header && header.bodyVersion !== undefined
    ? { ...header, body, bodyVersion: header.bodyVersion } : null;
}

const artifactAuthorityProjectionSchema = z.pick(ArtifactAccessRecipientCensusResponseV1Schema, { ownerAccountId: true, access: true, encryptionMode: true });

function readStoredAccess(value: Record<string, unknown>): Pick<StoredArtifact, 'ownerAccountId' | 'access' | 'encryptionMode'> {
  const projection = artifactAuthorityProjectionSchema
    .safeParse({ ownerAccountId: value.ownerAccountId, access: value.access, encryptionMode: value.encryptionMode });
  if (!projection.success) throw new ArtifactEncryptionMaterialUnavailableError();
  return projection.data;
}

export function createAccountArtifactStore(params: Readonly<{
  getAccountEncryptionMode: (options?: AccountEncryptionModeReadOptions) => Promise<ConnectedServiceAccountEncryptionMode>;
  savedBy?: ArtifactSavedByV1;
  resolveServerFeaturesSnapshot?: ArtifactQueryHintFeatures;
}> & (Readonly<{ credentials: StoredCredentials; accountContent?: never }>
  | Readonly<{ credentials?: never; accountContent: Readonly<{ accountId: string; encryption: StoredCredentials['encryption'] }> }>)) {
  const contentAccountId = params.accountContent?.accountId ?? readAccountIdFromToken(params.credentials!.token);
  const contentCredentials: ContentEncryption = params.accountContent ?? params.credentials;
  const supportsQueryHints = async () => {
    try {
      const snapshot = await params.resolveServerFeaturesSnapshot?.();
      return snapshot?.status === 'ready' && readServerEnabledBit(snapshot.features, 'artifacts.queryHints') === true;
    } catch { return false; }
  };
  const writeKind = async (header: Readonly<Record<string, unknown>>) => await supportsQueryHints()
    ? tryDeriveArtifactStoredKindV1(header) : undefined;
  // Account-mode conversion retains Artifact ids. A miss at the mode-private
  // digest therefore consults the incumbent private list, not a second index.
  async function findRetainedNotice(accountId: string, occurrence: string, signal?: AbortSignal): Promise<AccountArtifact | null> {
    const indexed = await supportsQueryHints();
    let cursor: string | undefined;
    let sawUnreadable = false;
    do {
      const page = indexed ? await list({ limit: 500, kinds: ['account_notice.v1', 'usage_notice.v1'], ownerAccountId: accountId, cursor, signal })
        : await store.list({ limit: 500, cursor, signal });
      sawUnreadable ||= page.coverage !== 'complete';
      for (const item of page.items) {
        if (item.ownerAccountId !== accountId || item.access !== 'owner' || item.publicAudience === 'retained') continue;
        const notice = readAccountNoticeArtifactHeaderV1(item.header);
        const legacy = notice ? null : readUsageNoticeArtifactHeaderV1(item.header);
        const identity = notice ? accountNoticeOccurrence(accountId, notice)
          : legacy ? usageNoticeOccurrence({ accountId, notice: legacy.notice }) : null;
        if (identity !== occurrence) continue;
        const current = await store.read(item.artifactId, { signal });
        if (!current || current.ownerAccountId !== accountId || current.access !== 'owner' || current.shared
          || current.publicAudience !== 'none'
          || !(readAccountNoticeArtifactV1(current) || readUsageNoticeArtifactV1(current))) {
          throw Object.assign(new Error('notice_owner_mismatch'), { code: 'notice_owner_mismatch' });
        }
        return current;
      }
      cursor = page.nextCursor;
    } while (cursor);
    // An unresolved private header on any page cannot prove this occurrence absent.
    if (sawUnreadable) throw unavailableBinary();
    return null;
  }
  // Axios chooses the media type from actual request data. Bodyless GET/DELETE
  // requests must not advertise JSON; binary uploads set their own media type.
  const headers = () => {
    if (!params.credentials) throw Object.assign(new Error('artifact_authorization_required'), { code: 'artifact_authorization_required' });
    return { Authorization: `Bearer ${params.credentials.token}` };
  };
  const fetchStoredResponse = async (artifactId: string, signal?: AbortSignal, authorizationHeaders?: ArtifactRequestAuthorizationHeaders,
    projection?: 'headers'): Promise<Readonly<{ data: unknown }> | null> => {
    signal?.throwIfAborted();
    const path = projection ? '/v1/artifacts/read' : `/v1/artifacts/${encodeURIComponent(artifactId)}`;
    const body = projection ? ArtifactReadHeadersBatchInputV1Schema.parse({ artifactIds: [artifactId], projection }) : undefined;
    const config = { headers: authorizationHeaders ? await authorizationHeaders({ method: body ? 'POST' : 'GET', path,
      ...(body ? { body } : {}) }) : headers(), ...(signal ? { signal } : {}), validateStatus: () => true };
    const response = body ? await axios.post<unknown>(`${resolveServerHttpBaseUrl()}${path}`, body, config)
      : await axios.get<unknown>(`${resolveServerHttpBaseUrl()}${path}`, config);
    signal?.throwIfAborted();
    // A missing batch endpoint is not evidence that the selected Artifact is absent.
    if (!projection && response.status === 404) return null;
    if (response.data && typeof response.data === 'object' && Reflect.get(response.data, 'error') === 'artifact_content_unavailable') {
      throw new ArtifactEncryptionMaterialUnavailableError();
    }
    if (response.status < 200 || response.status >= 300) throw Object.assign(new HttpStatusError(response.status, 'artifact_read_unavailable'), {
      code: 'artifact_read_unavailable', status: response.status,
    });
    if (projection) {
      const parsed = ArtifactReadHeadersBatchResponseV1Schema.safeParse(response.data);
      if (!parsed.success || parsed.data.items.length !== 1 || parsed.data.items[0]?.artifactId !== artifactId) {
        throw Object.assign(new Error('artifact_read_invalid'), { code: 'artifact_read_invalid' });
      }
      const item = parsed.data.items[0]!;
      if (!item.ok) {
        if (item.error === 'artifact_not_found') return null;
        if (item.error === 'artifact_content_unavailable' && !item.retryable) throw new ArtifactEncryptionMaterialUnavailableError();
        throw Object.assign(new HttpStatusError(item.status, 'artifact_read_unavailable'), {
          code: 'artifact_read_unavailable', status: item.status,
        });
      }
      return { data: item.artifact };
    }
    if (!response.data || typeof response.data !== 'object' || Reflect.get(response.data, 'id') !== artifactId) {
      throw Object.assign(new Error('artifact_read_invalid'), { code: 'artifact_read_invalid' });
    }
    return { data: response.data };
  };
  const fetchStored = async (artifactId: string, signal?: AbortSignal, authorizationHeaders?: ArtifactRequestAuthorizationHeaders): Promise<StoredArtifact | null> => {
    const response = await fetchStoredResponse(artifactId, signal, authorizationHeaders);
    if (!response) return null;
    const stored = parseStoredArtifact(response.data);
    if (!stored) throw Object.assign(new Error('artifact_read_invalid'), { code: 'artifact_read_invalid' });
    return stored;
  };
  const accessUrl = (artifactId: string, leaf: string) => `${resolveServerHttpBaseUrl()}/v1/artifacts/${encodeURIComponent(artifactId)}/access/${leaf}`;
  const accessConfig = (signal?: AbortSignal) => ({ headers: headers(),
    ...(signal ? { signal } : {}), validateStatus: () => true });
  const authorizedAccessConfig = async (artifactId: string, leaf: string,
    method: 'GET' | 'POST' | 'PUT' | 'DELETE', signal?: AbortSignal,
    authorizationHeaders?: ArtifactRequestAuthorizationHeaders, body?: unknown) => ({
    headers: authorizationHeaders ? await authorizationHeaders({ method,
      path: new URL(accessUrl(artifactId, leaf)).pathname, ...(body === undefined ? {} : { body }) }) : headers(),
    ...(signal ? { signal } : {}), validateStatus: () => true,
  });
  const requireAccessResponse = (response: Readonly<{ status: number; data: unknown }>) => {
    if (response.status >= 200 && response.status < 300) return response.data;
    const value = response.data && typeof response.data === 'object' ? response.data as Record<string, unknown> : {};
    const known = ArtifactAccessErrorCodeV1Schema.safeParse(value.error);
    const code = known.success ? known.data
      : response.status === 404 || response.status === 405 ? 'artifact_access_unavailable' : 'artifact_access_failed';
    throw Object.assign(new HttpStatusError(response.status, code), { code, status: response.status });
  };
  const readAccessGrants = async (artifactId: string, signal?: AbortSignal, authorizationHeaders?: ArtifactRequestAuthorizationHeaders) =>
    ArtifactAccessGrantsListResponseV1Schema.parse(requireAccessResponse(await axios.get(accessUrl(artifactId, 'grants'),
      await authorizedAccessConfig(artifactId, 'grants', 'GET', signal, authorizationHeaders))));
  const requestPublicLink = async (request: ArtifactPublicLinkRequestV1, authorizationHeaders?: ArtifactRequestAuthorizationHeaders) => {
    request.signal?.throwIfAborted();
    const config = { ...accessConfig(request.signal), ...(authorizationHeaders ? { headers: await authorizationHeaders(request) } : {}) };
    const url = `${resolveServerHttpBaseUrl()}${request.path}`;
    const response = request.method === 'GET' ? await axios.get(url, config)
      : request.method === 'DELETE' ? await axios.delete(url, config) : await axios.post(url, request.body, config);
    if (response.status < 200 || response.status >= 300) {
      const payload: unknown = response.data;
      const code = payload !== null && typeof payload === 'object'
        && Reflect.get(payload, 'error') === 'public_share_isolation_unavailable'
        ? 'public_share_isolation_unavailable' : 'public_share_request_failed';
      throw Object.assign(new Error(code), { code });
    }
    request.signal?.throwIfAborted();
    return response.data;
  };
  const prepare = async (stored: Pick<StoredArtifactHeader, 'id' | 'encryptionMode' | 'dataEncryptionKey' | 'provenanceDataEncryptionKey'>, codec: Codec, signal?: AbortSignal,
    authorizationHeaders?: ArtifactRequestAuthorizationHeaders) => {
    if (codec.mode === 'plain') return;
    const provenanceCodec = stored.provenanceDataEncryptionKey
      ? await openCodec(contentCredentials, stored.provenanceDataEncryptionKey, stored.encryptionMode) : null;
    await runArtifactRecipientKeyPreparationV1({ artifactId: stored.id, dataKey: codec.dataKey,
      provenanceDataKey: provenanceCodec?.dataKey, openedProvenanceDataEncryptionKey: stored.provenanceDataEncryptionKey,
      openedDataEncryptionKey: stored.dataEncryptionKey, randomBytes: getRandomBytes, ...(signal ? { signal } : {}),
      readCensus: async () => ArtifactAccessRecipientCensusResponseV1Schema.parse(requireAccessResponse(
        await axios.get(accessUrl(stored.id, 'recipients'), await authorizedAccessConfig(stored.id, 'recipients', 'GET', signal, authorizationHeaders)))),
      commit: async (input) => ArtifactRecipientKeyEnvelopeCommitResponseV1Schema.parse(requireAccessResponse(
        await axios.post(accessUrl(stored.id, 'key-envelopes'), input, await authorizedAccessConfig(stored.id, 'key-envelopes', 'POST', signal, authorizationHeaders, input)))),
    });
  };
  const readAccountMode = async (options?: Readonly<{ authorizationHeaders?: ArtifactRequestAuthorizationHeaders;
    signal?: AbortSignal }>): Promise<ConnectedServiceAccountEncryptionMode> => {
    if (!params.accountContent && options?.authorizationHeaders) {
      const authorization = await options.authorizationHeaders({ method: 'GET', path: '/v1/account/encryption/currentness' });
      const requesterMode = authorization[requesterAccountEncryptionMode];
      if (requesterMode !== undefined) return requesterMode;
      // Only this store's own bearer may borrow its Account observation.
      // A transported signed proof without the host-local admission fails closed.
      const bearer = Object.entries(authorization).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
      if (bearer !== `Bearer ${params.credentials!.token}`) return 'unknown';
    }
    return params.getAccountEncryptionMode({ ...options, usage: 'identity' });
  };
  const assertOwnerAccountMode = async (stored: Pick<StoredArtifact, 'access' | 'encryptionMode'>,
    timing?: { accountModeMs: number; codecMs: number },
    options?: Readonly<{ authorizationHeaders?: ArtifactRequestAuthorizationHeaders; signal?: AbortSignal }>,
    admittedMode?: Promise<ConnectedServiceAccountEncryptionMode>) => {
    // Personal Artifact reads/writes follow the persisted Account mode. Shared
    // recipients instead open the owner's content mode, which may differ from theirs.
    if (stored.access === 'owner') {
      const startedAt = performance.now();
      const accountMode = await (options?.authorizationHeaders ? readAccountMode(options) : admittedMode ?? readAccountMode(options));
      if (timing) timing.accountModeMs += performance.now() - startedAt;
      if (accountMode === 'unknown') throw Object.assign(new Error('account_encryption_mode_unavailable'), { code: 'account_encryption_mode_unavailable' });
      if (accountMode !== stored.encryptionMode) throw Object.assign(new Error('artifact_account_mode_mismatch'), { code: 'artifact_account_mode_mismatch' });
    }
  };
  const openStored = async (stored: Pick<StoredArtifact, 'access' | 'encryptionMode' | 'dataEncryptionKey'>,
    timing?: { accountModeMs: number; codecMs: number },
    options?: Readonly<{ authorizationHeaders?: ArtifactRequestAuthorizationHeaders; signal?: AbortSignal }>,
    admittedMode?: Promise<ConnectedServiceAccountEncryptionMode>) => {
    await assertOwnerAccountMode(stored, timing, options, admittedMode);
    const startedAt = performance.now();
    try { return await openCodec(contentCredentials, stored.dataEncryptionKey, stored.encryptionMode); }
    finally { if (timing) timing.codecMs += performance.now() - startedAt; }
  };
  const openProvenanceCodec = async (stored: Pick<StoredArtifact, 'encryptionMode' | 'provenanceDataEncryptionKey'>): Promise<Codec | null> => {
    if (stored.encryptionMode === 'plain') return openCodec(contentCredentials, ARTIFACT_PLAIN_DATA_KEY_MARKER, 'plain');
    return stored.provenanceDataEncryptionKey
      ? openCodec(contentCredentials, stored.provenanceDataEncryptionKey, 'e2ee') : null;
  };
  const readProvenance = (codec: Codec | null, value: string | null | undefined, artifactId: string, bodyVersion: number) => {
    if (value == null) return undefined;
    if (!codec) throw new ArtifactEncryptionMaterialUnavailableError();
    const parsed = ArtifactPrivateRevisionMetadataV1StoredSchema.safeParse(decode(codec, value));
    if (!parsed.success || parsed.data.artifactId !== artifactId || parsed.data.bodyVersion !== bodyVersion) {
      throw new ArtifactEncryptionMaterialUnavailableError();
    }
    return parsed.data.provenance;
  };
  const writeProvenance = async (input: Readonly<{ artifactId: string; bodyVersion: number; savedBy?: ArtifactSavedByV1 | null; source?: ArtifactWorkspaceSourceV1; restoredFromBodyVersion?: number; signal?: AbortSignal; mutationAuthorizationHeaders?: ArtifactRequestAuthorizationHeaders; authorizationHeaders?: ArtifactRequestAuthorizationHeaders }>, stored: StoredArtifact | undefined, contentCodec: Codec): Promise<Readonly<{
    wire: Readonly<{ provenance?: string; provenanceDataEncryptionKey?: string }>;
    prepareRecipients?: () => Promise<void>;
  }>> => {
    const savedBy = input.savedBy === undefined ? params.savedBy : input.savedBy;
    if (!savedBy) return { wire: {} };
    const existing = stored ? await openProvenanceCodec(stored) : null;
    const codec = existing ?? await createCodec({ credentials: contentCredentials,
      mode: contentCodec.mode });
    const metadata = ArtifactPrivateRevisionMetadataV1Schema.parse({ v: 1, artifactId: input.artifactId, bodyVersion: input.bodyVersion,
      provenance: { savedBy, ...(input.source ? { source: input.source } : {}), ...(input.restoredFromBodyVersion === undefined ? {} : { restoredFromBodyVersion: input.restoredFromBodyVersion }) } });
    let ownerEnvelope = codec.dataEncryptionKey;
    let prepareRecipients: (() => Promise<void>) | undefined;
    if (!existing && codec.mode === 'e2ee' && stored) {
      const contentDataKey = contentCodec?.dataKey;
      if (!contentDataKey) throw new ArtifactEncryptionMaterialUnavailableError();
      const readCensus = async () => ArtifactAccessRecipientCensusResponseV1Schema.parse(requireAccessResponse(
        await axios.get(accessUrl(stored.id, 'recipients'), await authorizedAccessConfig(stored.id, 'recipients', 'GET', input.signal, input.authorizationHeaders))));
      const census = await readCensus();
      if (census.artifactId !== stored.id || census.callerDataEncryptionKey !== stored.dataEncryptionKey || census.provenanceDataEncryptionKey) {
        throw new ArtifactEncryptionMaterialUnavailableError();
      }
      if (stored.access !== 'owner') {
        const owner = prepareArtifactRecipientKeyEnvelopesV1({ dataKey: contentDataKey, provenanceDataKey: codec.dataKey,
          recipients: census.recipients.filter(recipient => recipient.recipientAccountId === stored.ownerAccountId), randomBytes: getRandomBytes,
          replaceExisting: true })[0];
        if (!owner?.encryptedProvenanceDataKey) throw new ArtifactEncryptionMaterialUnavailableError();
        ownerEnvelope = owner.encryptedProvenanceDataKey;
      }
      const expectedOwnerEnvelope = ownerEnvelope;
      prepareRecipients = async () => {
        input.signal?.throwIfAborted();
        const current = await readCensus();
        if (current.artifactId !== stored.id || current.callerDataEncryptionKey !== stored.dataEncryptionKey
          || current.provenanceDataEncryptionKey !== expectedOwnerEnvelope || !current.dataEncryptionKey) {
          throw new ArtifactEncryptionMaterialUnavailableError();
        }
        const recipientKeyEnvelopes = prepareArtifactRecipientKeyEnvelopesV1({ dataKey: contentDataKey, provenanceDataKey: codec.dataKey,
          recipients: current.recipients.filter(recipient => recipient.recipientAccountId !== current.ownerAccountId), randomBytes: getRandomBytes });
        if (!recipientKeyEnvelopes.length) return;
        ArtifactRecipientKeyEnvelopeCommitResponseV1Schema.parse(requireAccessResponse(await axios.post(accessUrl(stored.id, 'key-envelopes'), {
          artifactId: stored.id, expectedDataEncryptionKey: current.dataEncryptionKey,
          expectedProvenanceDataEncryptionKey: expectedOwnerEnvelope, recipientKeyEnvelopes,
        }, await authorizedAccessConfig(stored.id, 'key-envelopes', 'POST', input.signal, input.mutationAuthorizationHeaders ?? input.authorizationHeaders, {
          artifactId: stored.id, expectedDataEncryptionKey: current.dataEncryptionKey,
          expectedProvenanceDataEncryptionKey: expectedOwnerEnvelope, recipientKeyEnvelopes,
        }))));
      };
    }
    return { wire: { provenance: codec.encode(metadata),
      ...(!existing && codec.mode === 'e2ee' ? { provenanceDataEncryptionKey: ownerEnvelope } : {}) },
      ...(prepareRecipients ? { prepareRecipients } : {}) };
  };
  const prepareCurrent = async (artifactId: string, signal?: AbortSignal, authorizationHeaders?: ArtifactRequestAuthorizationHeaders) => {
    const stored = await fetchStored(artifactId, signal, authorizationHeaders);
    if (!stored) throw Object.assign(new Error('artifact_not_found'), { code: 'artifact_not_found' });
    await prepare(stored, await openStored(stored, undefined, { signal, authorizationHeaders }), signal, authorizationHeaders);
  };
  const sharedWriteContext = async (stored: StoredArtifact, currentHeader: Readonly<Record<string, unknown>>,
    candidateHeader: Readonly<Record<string, unknown>>, signal?: AbortSignal, candidateBody?: ArtifactBodyV1 | null,
    authorizationHeaders?: ArtifactRequestAuthorizationHeaders) => {
    if (!artifactKindRequiresSharedAudienceV1(currentHeader.kind) && !artifactKindRequiresSharedAudienceV1(candidateHeader.kind)) return undefined;
    const current = { artifactId: stored.id, header: currentHeader, ownerAccountId: stored.ownerAccountId, access: stored.access,
      publicAudience: stored.publicAudience };
    if (candidateBody !== undefined && canShareArtifactWriteContentV1(current, candidateHeader, candidateBody)) return undefined;
    const shared = await readArtifactSharedAudienceV1({ current, signal,
      readGrants: () => store.accessGrants.list({ artifactId: stored.id }, signal,
        authorizationHeaders ? { authorizationHeaders } : undefined) });
    signal?.throwIfAborted();
    return { current, shared };
  };
  const projectStoredArtifact = async (stored: StoredArtifact, options?: Readonly<{
    signal?: AbortSignal;
    authorizationHeaders?: ArtifactRequestAuthorizationHeaders;
    /** Decision preparation observes content without repairing recipient key delivery. */
    prepareRecipients?: boolean;
    /** Ordinary Artifact reads do not publish native widget audience admission. */
    includeSharedAudience?: boolean;
  }>, openedCodec?: Codec): Promise<AccountArtifact> => {
    options?.signal?.throwIfAborted();
    const codec = openedCodec ?? await timeWebLatencyPhase('artifact.read.open', () => openStored(stored, undefined, options));
    const { header, body, provenance } = await timeWebLatencyPhase('artifact.read.decode', async () => ({
      header: decode(codec, stored.header), body: decodeBody(codec, stored.body),
      provenance: readProvenance(await openProvenanceCodec(stored), stored.provenance, stored.id, stored.bodyVersion),
    }));
    if (!header || typeof header !== 'object' || Array.isArray(header)) throw new ArtifactEncryptionMaterialUnavailableError();
    requireBodyForArtifactKind(header as Readonly<Record<string, unknown>>, body);
    if (options?.prepareRecipients !== false) await timeWebLatencyPhase('artifact.read.recipients', () =>
      prepare(stored, codec, options?.signal, options?.authorizationHeaders));
    options?.signal?.throwIfAborted();
    const sharing = options?.includeSharedAudience === false ? undefined
      : await sharedWriteContext(stored, header as Readonly<Record<string, unknown>>, header as Readonly<Record<string, unknown>>, options?.signal);
    return { artifactId: stored.id, header: header as Readonly<Record<string, unknown>>,
      ownerAccountId: stored.ownerAccountId, access: stored.access,
      ...(stored.ownerDisplayName === undefined ? {} : { ownerDisplayName: stored.ownerDisplayName }),
      publicAudience: stored.publicAudience,
      ...(sharing ? { shared: sharing.shared } : {}),
      body,
      ...(provenance ? { provenance } : {}),
      revision: { headerVersion: stored.headerVersion, bodyVersion: stored.bodyVersion },
      seq: stored.seq, createdAt: stored.createdAt, updatedAt: stored.updatedAt };
  };
  const readStoredArtifact = async (artifactId: string, options?: Parameters<typeof projectStoredArtifact>[1]) => {
    options?.signal?.throwIfAborted();
    return timeWebLatencyPhase('artifact.read.http', () => fetchStored(artifactId, options?.signal, options?.authorizationHeaders));
  };
  const read = async (artifactId: string, options?: Parameters<typeof projectStoredArtifact>[1]): Promise<AccountArtifact | null> => {
    const stored = await readStoredArtifact(artifactId, options);
    return stored ? projectStoredArtifact(stored, options) : null;
  };
  const validateHtmlContent = async (header: Readonly<Record<string, unknown>>, content: ArtifactWriteContent,
    artifactId: string, signal?: AbortSignal): Promise<void> => {
    if (!isArtifactHtmlHeaderV1(header)) return;
    try {
      if (content.binary) { artifactHtmlBundleFromBodyV1(content.binary.bytes, content.binary.mime); return; }
      if (typeof content.body === 'string') { artifactHtmlBundleFromBodyV1(content.body); return; }
      const body = ArtifactBlobReferenceV1Schema.parse(content.body);
      artifactHtmlBundleFromBodyV1(await store.readBinary({ artifactId, body, signal }), body.mime);
    } catch {
      signal?.throwIfAborted();
      throw Object.assign(new Error('artifact_html_content_invalid'), { code: 'artifact_html_content_invalid' });
    }
  };
  const fetchHeaderPage = async (options?: ArtifactListPageOptionsV1) => {
    options?.signal?.throwIfAborted();
    const url = new URL('/v1/artifacts', resolveServerHttpBaseUrl());
    if (options?.limit !== undefined) url.searchParams.set('limit', String(options.limit));
    if (options?.cursor) url.searchParams.set('cursor', options.cursor);
    if (options?.audience) url.searchParams.set('audience', options.audience);
    if (options?.includeBody) url.searchParams.set('includeBody', 'true');
    const coarseKind = options?.coarseKind;
    const indexedKinds = options?.indexedKinds ?? options?.kinds;
    const filtered = coarseKind !== undefined || indexedKinds !== undefined || Boolean(options?.unclassified) || options?.audience !== undefined;
    if (filtered && coarseKind !== undefined) url.searchParams.set('kind', coarseKind);
    if (indexedKinds !== undefined) url.searchParams.set('kinds', JSON.stringify(indexedKinds));
    if (options?.unclassified) url.searchParams.set('unclassified', String(options.unclassified));
    if (options?.ownerAccountId) url.searchParams.set('ownerAccountId', options.ownerAccountId);
    const response = await axios.get(url.toString(), { headers: headers(),
      ...(options?.signal ? { signal: options.signal } : {}), validateStatus: () => true });
    options?.signal?.throwIfAborted();
    if (response.status < 200 || response.status >= 300) {
      throw Object.assign(new HttpStatusError(response.status, response.status === 400 ? 'artifact_list_cursor_invalid' : 'artifact_list_failed'), {
        code: response.status === 400 ? 'invalid_cursor' : 'list_failed', status: response.status,
      });
    }
    const data: unknown = response.data;
    const rows: unknown = filtered && data && typeof data === 'object' ? Reflect.get(data, 'items') : data;
    const hasUnclassified: unknown = filtered && data && typeof data === 'object' ? Reflect.get(data, 'hasUnclassified') : undefined;
    const wireCoverage: unknown = filtered && data && typeof data === 'object' ? Reflect.get(data, 'coverage') : undefined;
    const kindCoverage = wireCoverage === undefined ? undefined : ArtifactKindCoverageV1Schema.parse(wireCoverage);
    if (!Array.isArray(rows) || (filtered && typeof hasUnclassified !== 'boolean')) {
      throw Object.assign(new Error('artifact_list_failed'), { code: 'list_failed', status: response.status });
    }
    const last = rows.at(-1);
    const nextCursor = options?.limit !== undefined && rows.length === options.limit
      && last && typeof last === 'object' && typeof Reflect.get(last, 'id') === 'string' && typeof Reflect.get(last, 'updatedAt') === 'number'
      ? encodeAccountArtifactListCursor({ artifactId: Reflect.get(last, 'id'), updatedAt: Reflect.get(last, 'updatedAt') }) : undefined;
    return { rows: rows as readonly unknown[], nextCursor,
      ...(kindCoverage ? { kindCoverage } : {}),
      ...(typeof hasUnclassified === 'boolean' ? { hasUnclassified } : {}) };
  };
  /** Selected headers use the admitted narrow transport, never a body read or inventory walk. */
  const createHeaderReader = (options?: Readonly<{ signal?: AbortSignal; prepareRecipients?: boolean }>) => {
    return async (artifactId: string): Promise<AccountArtifactHeader | null> => {
      const response = await fetchStoredResponse(artifactId, options?.signal, undefined, 'headers');
      if (!response) return null;
      const stored = parseStoredArtifactHeader(response.data);
      if (!stored) throw Object.assign(new Error('artifact_read_invalid'), { code: 'artifact_read_invalid' });
      const codec = await openStored(stored, undefined, options);
      const header = decode(codec, stored.header);
      if (!header || typeof header !== 'object' || Array.isArray(header) || Object.keys(header).length === 0) {
        throw new ArtifactEncryptionMaterialUnavailableError();
      }
      if (options?.prepareRecipients !== false) await prepare(stored, codec, options?.signal);
      await assertOwnerAccountMode(stored, undefined, { signal: options?.signal });
      options?.signal?.throwIfAborted();
      return { artifactId: stored.id, header: header as Readonly<Record<string, unknown>>,
        ...(stored.ownerDisplayName === undefined ? {} : { ownerDisplayName: stored.ownerDisplayName }),
        ownerAccountId: stored.ownerAccountId, access: stored.access, publicAudience: stored.publicAudience,
        headerVersion: stored.headerVersion, ...(stored.bodyVersion === undefined ? {} : { bodyVersion: stored.bodyVersion }),
        seq: stored.seq, createdAt: stored.createdAt, updatedAt: stored.updatedAt };
    };
  };
  // Header discovery and selected details share the same mode/envelope projection.
  const projectHeaderRows = async (rows: readonly unknown[], options: Readonly<{ includeBody?: boolean; signal?: AbortSignal }>,
    timing: { accountModeMs: number; codecMs: number },
    readAccountMode?: () => Promise<ConnectedServiceAccountEncryptionMode>): Promise<AccountArtifactHeader[]> => {
    const items: AccountArtifactHeader[] = [];
    for (const raw of rows) {
      // MITIGATION: Inbox notice discovery still opens coarse-other headers.
      // N1-L3/Artifact query ownership must narrow that source before removing
      // fairness for publisher filesystem reads, lease HTTP and cancellation.
      await yieldToEventLoop();
      options.signal?.throwIfAborted();
      if (!raw || typeof raw !== 'object') continue;
      const value = raw as Record<string, unknown>;
      if (typeof value.id !== 'string' || typeof value.header !== 'string' || typeof value.dataEncryptionKey !== 'string') continue;
      const headerVersion = readNonnegativeSafeInteger(value.headerVersion);
      const seq = readNonnegativeSafeInteger(value.seq);
      const createdAt = readNonnegativeSafeInteger(value.createdAt);
      const updatedAt = readNonnegativeSafeInteger(value.updatedAt);
      if (headerVersion === null || seq === null || createdAt === null || updatedAt === null) continue;
      const access = readStoredAccess(value);
      let codec: Codec;
      let header: unknown;
      try {
        codec = await openStored({ ...access, dataEncryptionKey: value.dataEncryptionKey }, timing, { signal: options.signal },
          access.access === 'owner' ? readAccountMode?.() : undefined);
      } catch (error) {
        // openStored checks the persisted Account mode first. Missing Account
        // material stays request-wide; a failed per-record envelope does not.
        if (error instanceof ArtifactEncryptionMaterialUnavailableError && contentCredentials.encryption) continue;
        throw error;
      }
      try {
        header = decode(codec, value.header);
      } catch (error) {
        // An unopened header cannot be classified as a Workflow or another kind.
        if (error instanceof ArtifactEncryptionMaterialUnavailableError) continue;
        throw error;
      }
      if (!header || typeof header !== 'object' || Array.isArray(header)) continue;
      const knownBodyVersion = readNonnegativeSafeInteger(value.bodyVersion);
      let content: Pick<AccountArtifactHeader, 'body' | 'bodyVersion' | 'provenance'> = knownBodyVersion === null ? {} : { bodyVersion: knownBodyVersion };
      if (options?.includeBody) {
        const bodyVersion = readNonnegativeSafeInteger(value.bodyVersion);
        if (typeof value.body === 'string' && bodyVersion !== null) {
          try {
            const body = decodeBody(codec, value.body);
            requireBodyForArtifactKind(header as Readonly<Record<string, unknown>>, body);
            if ((value.provenance != null && typeof value.provenance !== 'string')
              || (value.provenanceDataEncryptionKey != null && typeof value.provenanceDataEncryptionKey !== 'string')) {
              throw new ArtifactEncryptionMaterialUnavailableError();
            }
            const provenance = readProvenance(await openProvenanceCodec({ encryptionMode: access.encryptionMode,
              provenanceDataEncryptionKey: typeof value.provenanceDataEncryptionKey === 'string' ? value.provenanceDataEncryptionKey : null }),
              typeof value.provenance === 'string' ? value.provenance : null, value.id, bodyVersion);
            content = { body, bodyVersion, ...(provenance ? { provenance } : {}) };
          } catch (error) {
            if (!(error instanceof ArtifactEncryptionMaterialUnavailableError)
              && (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'artifact_content_unavailable')) throw error;
            content = { bodyVersion };
          }
        }
      }
      items.push({ artifactId: value.id, header: header as Readonly<Record<string, unknown>>,
        ...content,
        ...(value.ownerDisplayName === undefined ? {} : { ownerDisplayName: ArtifactHttpReadV1Schema.shape.ownerDisplayName.parse(value.ownerDisplayName) }),
        ownerAccountId: access.ownerAccountId, access: access.access,
        publicAudience: ArtifactPublicAudienceV1ReadSchema.parse(value.publicAudience),
        headerVersion, seq, createdAt, updatedAt });
    }
    return items;
  };
  const prepareUpdateContent = async (input: UpdateInput, storedBasis?: StoredArtifact) => {
    input.signal?.throwIfAborted();
    if (input.memoryDecisionSource && typeof input.body !== 'string')
      return { ok: false, errorCode: 'memory_decision_source_unsupported', error: 'memory_decision_source_unsupported' } as const;
    // Mutation-only authority never selects an encrypted read envelope. A host
    // admitting the same Account may explicitly authorize both reads and writes.
    const stored = storedBasis ?? await fetchStored(input.artifactId, input.signal, input.authorizationHeaders);
    if (!stored) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' } as const;
    const codec = await openStored(stored, undefined, { signal: input.signal, authorizationHeaders: input.authorizationHeaders });
    await validateHtmlContent(input.header, input, input.artifactId, input.signal);
    const content = await prepareWriteContent(codec, input);
    requireBodyForArtifactKind(input.header, content.body);
    const blob: ArtifactBlobWriteV1 | null | undefined = content.blob
      ?? (ArtifactBlobReferenceV1Schema.safeParse(decodeBody(codec, stored.body)).success ? null : undefined);
    input.signal?.throwIfAborted();
    const currentHeader = ArtifactHeaderMetadataV1Schema.safeParse(decode(codec, stored.header));
    if (!currentHeader.success) throw new ArtifactEncryptionMaterialUnavailableError();
    const context = await sharedWriteContext(stored, currentHeader.data, input.header, input.signal, content.body, input.authorizationHeaders);
    const nextHeader = withArtifactExcerptV1(prepareArtifactHeaderForBodyV1(input.header, content.body, context), content.body);
    const header = codec.encode(nextHeader);
    const kind = await writeKind(nextHeader);
    const body = codec.encode({ body: content.body });
    const source = readProvenance(await openProvenanceCodec(stored), stored.provenance, stored.id, stored.bodyVersion)?.source;
    const provenance = await writeProvenance({ artifactId: input.artifactId, bodyVersion: input.expectedRevision.bodyVersion + 1,
      savedBy: input.savedBy, source, signal: input.signal,
      mutationAuthorizationHeaders: input.mutationAuthorizationHeaders, authorizationHeaders: input.authorizationHeaders }, stored, codec);

    const wire = { header, expectedHeaderVersion: input.expectedRevision.headerVersion,

      body, expectedBodyVersion: input.expectedRevision.bodyVersion,
      ...provenance.wire, ...(kind === undefined ? {} : { kind,  }) };
    return { ok: true, stored, blob, header, body, kind, provenance, wire, afterCommit: async () => {
      await provenance.prepareRecipients?.();
      if (input.prepareRecipients) await prepare({ ...stored,
        provenanceDataEncryptionKey: provenance.wire.provenanceDataEncryptionKey ?? stored.provenanceDataEncryptionKey },
        codec, input.signal, input.authorizationHeaders);
    } } as const;
  };
  type UpdateInput = Readonly<{ artifactId: string; expectedRevision: AccountArtifactRevision; header: Readonly<Record<string, unknown>>; savedBy?: ArtifactSavedByV1 | null; memoryDecisionSource?: CoordinationMessageRefV1; signal?: AbortSignal; beforeWrite?: () => void | Promise<void>; mutationAuthorizationHeaders?: ArtifactRequestAuthorizationHeaders; authorizationHeaders?: ArtifactRequestAuthorizationHeaders; prepareRecipients?: boolean }> & ArtifactWriteContent;
  const update = async (input: UpdateInput, storedBasis?: StoredArtifact) => {
    const prepared = await prepareUpdateContent(input, storedBasis);
    if (!prepared.ok) return prepared;
    const { stored, blob, header, body, kind, provenance, wire } = prepared;
    let response;
    let writeAttempts = 0;
    try {
      response = await retryArtifactRevisionUpdate(async () => {
        input.signal?.throwIfAborted();
        if (input.beforeWrite) await input.beforeWrite();
        await assertOwnerAccountMode(stored, undefined, { signal: input.signal, authorizationHeaders: input.authorizationHeaders });
        input.signal?.throwIfAborted();
        writeAttempts += 1;
        let result;
        if (blob?.content) {
          const uploadBody = Buffer.from(encodeArtifactUploadFrameV1({
            kind: 'update', artifactId: input.artifactId, blobId: blob.blobId, header, body, ...provenance.wire,
            ...(kind === undefined ? {} : { artifactKind: kind }),
            expectedHeaderVersion: input.expectedRevision.headerVersion, expectedBodyVersion: input.expectedRevision.bodyVersion,
          }, blob.content));
          const authorize = input.mutationAuthorizationHeaders ?? input.authorizationHeaders;
          const requestHeaders = authorize
            ? await authorize({ method: 'POST', path: ARTIFACT_UPLOAD_PATH_V1, body: uploadBody })
            : headers();
          result = await axios.post(`${resolveServerHttpBaseUrl()}${ARTIFACT_UPLOAD_PATH_V1}`, uploadBody, {
            headers: { ...requestHeaders, 'Content-Type': ARTIFACT_UPLOAD_CONTENT_TYPE_V1 },
            ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
          });
        } else {
          const path = `/v1/artifacts/${encodeURIComponent(input.artifactId)}${input.memoryDecisionSource ? '/memory-decision' : blob !== undefined ? '/content/binary' : ''}`;
          const requestBody = {
            ...wire,
            ...(input.memoryDecisionSource ? { memoryDecisionSource: input.memoryDecisionSource } : {}),
            ...(blob !== undefined ? { blob } : {}),
          };
          const authorize = input.mutationAuthorizationHeaders ?? input.authorizationHeaders;
          const requestHeaders = authorize
            ? await authorize({ method: 'POST', path, body: requestBody })
            : headers();
          result = await axios.post(`${resolveServerHttpBaseUrl()}${path}`, requestBody, {
            headers: requestHeaders, ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true,
          });
        }
        if (result.status >= 500) {
          const storageError = result.status === 503 ? readArtifactStorageFailureCode(result.data?.error) : null;
          throw createHttpStatusError(result.status, storageError ?? 'artifact_update_unavailable', storageError ?? undefined);
        }
        return result;
      });
    } catch (error) {
      if (error instanceof HttpStatusError && (readHttpStatus(error) ?? 0) >= 500) {
        const storageError = readArtifactStorageFailureCode('code' in error ? error.code : undefined);
        if (storageError) return { ok: false, errorCode: storageError, error: storageError } as const;
        return { ok: false, errorCode: 'update_failed', error: 'artifact_update_failed' } as const;
      }
      throw error;
    }
    const quota = readQuotaFailure(response);
    if (quota) return quota;
    const sourceError = MemoryDecisionSourceErrorCodeV1Schema.safeParse(response.data?.error);
    if ((response.status < 200 || response.status >= 300) && sourceError.success)
      return { ok: false, errorCode: sourceError.data, error: sourceError.data } as const;
    if (response.status === 404 && input.memoryDecisionSource && response.data?.error !== 'Artifact not found')
      return { ok: false, errorCode: 'memory_decision_source_unsupported', error: 'memory_decision_source_unsupported' } as const;
    if (response.status === 404) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' } as const;
    if (response.status < 200 || response.status >= 300) return { ok: false, errorCode: 'update_failed', error: 'artifact_update_failed' } as const;
    if (response.data?.success === false && response.data?.error === 'version-mismatch') {
      // A later conflict cannot disprove an earlier attempt's lost commit acknowledgement.
      return { ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch',
        ...(writeAttempts === 1 ? { writeCommitted: false as const } : {}) } as const;
    }
    if (response.data?.success === true) await prepared.afterCommit();
    return response.data?.success === true
      ? { ok: true, revision: readAcknowledgedRevision(response.data) } as const
      : { ok: false, errorCode: 'update_failed', error: 'artifact_update_failed' } as const;
  };
  const store = {
    prepareJsonUpdate: async (input: UpdateInput) => {
      const prepared = await prepareUpdateContent(input);
      if (!prepared.ok) return prepared;
      if (prepared.blob !== undefined || input.memoryDecisionSource) {
        return { ok: false, errorCode: 'unsupported_artifact_update', error: 'unsupported_artifact_update' } as const;
      }
      return { ok: true, artifactId: input.artifactId,
        mutation: ArtifactJsonUpdateHttpInputV1Schema.parse(prepared.wire),
        assertCurrent: async () => {
          input.signal?.throwIfAborted();
          if (input.beforeWrite) await input.beforeWrite();
          await assertOwnerAccountMode(prepared.stored, undefined, { signal: input.signal, authorizationHeaders: input.authorizationHeaders });
          input.signal?.throwIfAborted();
        },
        afterCommit: prepared.afterCommit,
      } as const;
    },
    read,
    /** One operation's read/validate/CAS, without a second row/key fetch. */
    readForUpdate: async (artifactId: string, options?: Parameters<typeof projectStoredArtifact>[1]) => {
      const stored = await readStoredArtifact(artifactId, options);
      if (!stored) return null;
      const codec = await timeWebLatencyPhase('artifact.read.open', () => openStored(stored, undefined, options));
      const artifact = await projectStoredArtifact(stored, options, codec);
      const assertAssociatedResource = (input: Readonly<{ artifactId: string; expectedRevision: AccountArtifactRevision }>) => {
        options?.signal?.throwIfAborted();
        if (input.artifactId !== stored.id || input.expectedRevision.headerVersion !== stored.headerVersion
          || input.expectedRevision.bodyVersion !== stored.bodyVersion) throw new ArtifactEncryptionMaterialUnavailableError();
      };
      return { artifact,
        /** The admitted resource supplies its mode/key, never the recipient Account's codec. */
        openAssociatedContent: (input: Readonly<{ artifactId: string; expectedRevision: AccountArtifactRevision;
          content: ArtifactAssociatedStoredContent }>): unknown => {
          assertAssociatedResource(input);
          if (input.content.t === 'plain') {
            if (codec.mode !== 'plain') throw new ArtifactEncryptionMaterialUnavailableError();
            return input.content.v;
          }
          if (codec.mode !== 'e2ee') throw new ArtifactEncryptionMaterialUnavailableError();
          const opened = codec.decode(input.content.c);
          if (opened === null) throw new ArtifactEncryptionMaterialUnavailableError();
          return opened;
        },
        sealAssociatedContent: (input: Readonly<{ artifactId: string; expectedRevision: AccountArtifactRevision;
          value: unknown }>): ArtifactAssociatedStoredContent => {
          assertAssociatedResource(input);
          return codec.mode === 'plain' ? { t: 'plain', v: input.value } : { t: 'encrypted', c: codec.encode(input.value) };
        },
        update: (content: Pick<AccountArtifact, 'header'> & Readonly<{ body: ArtifactBodyV1 }>) => update({ ...content,
        artifactId: stored.id, expectedRevision: { headerVersion: stored.headerVersion, bodyVersion: stored.bodyVersion },
        ...(options?.signal ? { signal: options.signal } : {}) }, stored) };
    },
    /** Qualified host APIs admit their own identity; reuse the Account codec, not ordinary Artifact visibility. */
    openStoredEnvelope: async (envelope: Readonly<{ header: string; body: string; dataEncryptionKey: string }>,
      options?: Readonly<{ signal?: AbortSignal }>): Promise<Readonly<{ header: Readonly<Record<string, unknown>>; body: ArtifactBodyV1 | null }>> => {
      options?.signal?.throwIfAborted();
      const mode = await readAccountMode(options);
      options?.signal?.throwIfAborted();
      const codec = await openCodec(contentCredentials, envelope.dataEncryptionKey, mode);
      const header = decode(codec, envelope.header);
      const body = decodeBody(codec, envelope.body);
      if (!header || typeof header !== 'object' || Array.isArray(header)) throw new ArtifactEncryptionMaterialUnavailableError();
      requireBodyForArtifactKind(header as Readonly<Record<string, unknown>>, body);
      await assertOwnerAccountMode({ access: 'owner', encryptionMode: codec.mode }, undefined, { ...options });
      options?.signal?.throwIfAborted();
      return { header: header as Readonly<Record<string, unknown>>, body };
    },
    /** Host-only exact-request recipient. A View grant never supplies decision authority. */
    prepareApprovalRequesterRecipient: async (input: Readonly<{
      artifactId: string; requesterAccountId: string; sessionId: string; signal?: AbortSignal;
    }>): Promise<void> => {
      input.signal?.throwIfAborted();
      const invalid = () => Object.assign(new Error('artifact_approval_requester_invalid'), { code: 'artifact_approval_requester_invalid' });
      const stored = await fetchStored(input.artifactId, input.signal);
      if (!stored || stored.access !== 'owner' || stored.ownerAccountId !== contentAccountId) throw invalid();
      const codec = await openStored(stored);
      const header = decode(codec, stored.header);
      const body = decodeBody(codec, stored.body);
      if (!header || typeof header !== 'object' || Array.isArray(header) || typeof body !== 'string') throw invalid();
      const parsed = approvalArtifactBodyMatchesHeaderV1(header as Readonly<Record<string, unknown>>, body);
      // Stored readers may drop obsolete fields for display. Recipient mutation
      // instead admits the original closed subject, before that normalization.
      const builtIn = parsed?.family === 'built_in' && parsed.request.v === 2
        ? ApprovalRequestV2Schema.safeParse(JSON.parse(body)) : null;
      const target = parsed?.family === 'target_action'
        ? TargetActionApprovalRequestV1Schema.safeParse(JSON.parse(body)) : null;
      const request = builtIn?.success ? builtIn.data : target?.success ? target.data : null;
      const subject = request?.requesterConfirmation;
      const invocation = target?.success ? projectTargetActionApprovalInvocationV1(target.data)
        : builtIn?.success ? builtIn.data : null;
      if (!request || !subject || !invocation || subject.requesterAccountId !== input.requesterAccountId
        || subject.personaSessionRef.sessionId !== input.sessionId || subject.executionAccountId !== stored.ownerAccountId
        || subject.inputDigest !== computeActionInputApprovalDigestV1(invocation.actionId, invocation.actionArgs)) throw invalid();
      // Historical attribution is not current disclosure or invoke authority.
      // The existing Session owner rechecks this exact recipient without
      // borrowing the Bot owner's authenticated entitlement as the requester's.
      const accessResponse = await axios.post(`${resolveServerHttpBaseUrl()}/v2/sessions/access-grants/list`, {
        sessionId: input.sessionId, recipientAccountId: subject.requesterAccountId,
      }, accessConfig(input.signal));
      const access = SessionAccessGrantsListResponseV1Schema.safeParse(accessResponse.data);
      if (accessResponse.status !== 200 || !access.success || access.data.visibility !== 'complete'
        || access.data.recipientAccess?.accountId !== subject.requesterAccountId
        || access.data.recipientAccess.effectiveAccess?.capabilities.readTranscript !== true
        || access.data.recipientAccess.effectiveAccess.capabilities.submitAgentInput !== true) throw invalid();
      input.signal?.throwIfAborted();
      await store.accessGrants.set({ artifactId: input.artifactId,
        principal: { kind: 'account', accountId: subject.requesterAccountId }, accessLevel: 'view' }, input.signal);
    },
    createHeaderReader,
    /** Header reads share the exact transport and header-only projection. */
    readHeader: (artifactId: string, options?: Readonly<{ signal?: AbortSignal; prepareRecipients?: boolean }>) => createHeaderReader(options)(artifactId),
    /** Exposure admission reads existing grants/publications without opening content or repairing keys. */
    readExposure: async (artifactId: string, options?: Readonly<{ signal?: AbortSignal; authorizationHeaders?: ArtifactRequestAuthorizationHeaders }>) => {
      options?.signal?.throwIfAborted();
      const grants = await readAccessGrants(artifactId, options?.signal, options?.authorizationHeaders);
      options?.signal?.throwIfAborted();
      const publicShares = grants.access === 'owner' ? await readArtifactPublicLinksV1({ artifactId, signal: options?.signal,
        request: request => requestPublicLink(request, options?.authorizationHeaders) }) : null;
      options?.signal?.throwIfAborted();
      return { grants, publicShares };
    },
    joinSignedInLink: (args: Readonly<{ input: unknown; signal?: AbortSignal }>,
      callbacks: Pick<Parameters<typeof createCliArtifactSignedInLinkJoinAction>[0], 'consumeSecret' | 'onOpened'>) => createCliArtifactSignedInLinkJoinAction({
        ...callbacks, request: request => requestPublicLink(request),
        resolveRecipient: async signal => {
          const mode = await params.getAccountEncryptionMode({ signal, usage: 'identity' });
          if (!contentAccountId || mode !== 'plain' && mode !== 'e2ee') throw new ArtifactEncryptionMaterialUnavailableError();
          if (mode === 'plain') return { accountId: contentAccountId, mode, contentPublicKey: null };
          const encryption = requireCredentials(contentCredentials).encryption;
          const contentPublicKey = encryption.type === 'dataKey' ? encryption.publicKey
            : libsodiumPublicKeyFromSecretKey(deriveAccountMachineKeyFromRecoverySecret(encryption.secret));
          return { accountId: contentAccountId, mode, contentPublicKey };
        },
      })(args),
    publicLinks: async (args: Readonly<{ actionId: ArtifactPublicLinkActionIdV1; input: unknown; signal?: AbortSignal }>,
      onPublicLinkIssued?: (link: ArtifactPublicLinkIssuedV1) => void | Promise<void>) => createArtifactPublicLinkActionsV1({
        randomBytes: getRandomBytes, onPublicLinkIssued,
        read: async (artifactId, signal) => {
          const stored = await fetchStored(artifactId, signal);
          if (!stored) return null;
          const codec = await openStored(stored);
          const header = decode(codec, stored.header);
          if (!header || typeof header !== 'object' || Array.isArray(header)) throw new ArtifactEncryptionMaterialUnavailableError();
          return { artifactId: stored.id, access: stored.access, header: header as Readonly<Record<string, unknown>>,
            body: decodeBody(codec, stored.body), encryptionMode: codec.mode, dataKey: codec.dataKey,
            revision: { headerVersion: stored.headerVersion, bodyVersion: stored.bodyVersion } };
        },
        request: request => requestPublicLink(request),
      })(args),
    readBinary: async (input: Readonly<{ artifactId: string; body: ArtifactBodyV1; signal?: AbortSignal }>): Promise<Uint8Array> => {
      input.signal?.throwIfAborted();
      const reference = ArtifactBlobReferenceV1Schema.safeParse(input.body);
      if (!reference.success) throw unavailableBinary();
      const stored = await fetchStored(input.artifactId, input.signal);
      if (!stored) throw unavailableBinary();
      const codec = await openStored(stored);
      const response = await axios.get(`${resolveServerHttpBaseUrl()}/v1/artifacts/${encodeURIComponent(input.artifactId)}/blobs/${encodeURIComponent(reference.data.blobId)}`, accessConfig(input.signal));
      const parsed = ArtifactBlobReadResponseV1Schema.safeParse(response.data);
      if (response.status < 200 || response.status >= 300 || !parsed.success || parsed.data.blobId !== reference.data.blobId) throw unavailableBinary();
      let bytes: Uint8Array;
      try {
        bytes = await openResourceBinaryContent(codec, reference.data, parsed.data.content);
      } catch { throw unavailableBinary(); }
      input.signal?.throwIfAborted();
      return bytes;
    },
    reportTemplateAcceptedVersion: async (input: ArtifactTemplateAcceptedVersionInputV1, signal?: AbortSignal,
      options?: Readonly<{ authorizationHeaders?: ArtifactRequestAuthorizationHeaders }>): Promise<void> => {
      await reportArtifactTemplateAcceptedVersion(input, {
        ...await authorizedAccessConfig(input.artifactId, 'accepted-version', 'PUT', signal, options?.authorizationHeaders, input), signal,
      });
    },
    accessGrants: {
      list: async (input: Readonly<{ artifactId: string }>, signal?: AbortSignal, options?: Readonly<{ authorizationHeaders?: ArtifactRequestAuthorizationHeaders }>) => {
        const result = await readAccessGrants(input.artifactId, signal, options?.authorizationHeaders);
        await prepareCurrent(input.artifactId, signal, options?.authorizationHeaders);
        return result;
      },
      set: async (input: ArtifactAccessGrantSetInputV1, signal?: AbortSignal, options?: Readonly<{ authorizationHeaders?: ArtifactRequestAuthorizationHeaders }>) => {
        const result = ArtifactAccessGrantMutationResponseV1Schema.parse(requireAccessResponse(await axios.put(accessUrl(input.artifactId, 'grants'), input,
          await authorizedAccessConfig(input.artifactId, 'grants', 'PUT', signal, options?.authorizationHeaders, input))));
        return completeArtifactAccessMutationPreparationV1({ result,
          prepare: () => prepareCurrent(input.artifactId, signal, options?.authorizationHeaders) });
      },
      remove: async (input: ArtifactAccessGrantRemoveInputV1, signal?: AbortSignal, options?: Readonly<{ authorizationHeaders?: ArtifactRequestAuthorizationHeaders }>) => {
        const result = ArtifactAccessGrantMutationResponseV1Schema.parse(requireAccessResponse(await axios.delete(accessUrl(input.artifactId, 'grants'), {
          ...await authorizedAccessConfig(input.artifactId, 'grants', 'DELETE', signal, options?.authorizationHeaders, input), data: input })));
        return completeArtifactAccessMutationPreparationV1({ result,
          prepare: () => prepareCurrent(input.artifactId, signal, options?.authorizationHeaders) });
      },
    },
    revisions: {
      list: async (input: Readonly<{ artifactId: string }>, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        const stored = await fetchStored(input.artifactId, signal);
        if (!stored) throw Object.assign(new Error('artifact_not_found'), { code: 'artifact_not_found' });
        const codec = await openStored(stored);
        const response = await axios.get(`${resolveServerHttpBaseUrl()}/v1/artifacts/${encodeURIComponent(input.artifactId)}/revisions`, accessConfig(signal));
        if (response.status < 200 || response.status >= 300) {
          throw Object.assign(new Error('artifact_revisions_unavailable'), { code: 'artifact_revisions_unavailable' });
        }
        const parsed = ArtifactRevisionListResponseV1Schema.safeParse(response.data);
        if (!parsed.success) throw new ArtifactEncryptionMaterialUnavailableError();
        const provenanceCodec = await openProvenanceCodec(stored);
        const revisions = parsed.data.revisions.map((value) => {
          const provenance = readProvenance(provenanceCodec, value.provenance, input.artifactId, value.bodyVersion);
          const { provenance: _sealedProvenance, ...revision } = value;
          return { ...revision, body: decodeBody(codec, value.body), ...(provenance ? { provenance } : {}) };
        });
        await prepare(stored, codec, signal);
        signal?.throwIfAborted();
        return { artifactId: input.artifactId, revisions, retentionCount: parsed.data.retentionCount };
      },
      restore: async (input: Readonly<{ artifactId: string; bodyVersion: number; expectedRevision: AccountArtifactRevision; savedBy?: ArtifactSavedByV1 }>, signal?: AbortSignal) => {
        signal?.throwIfAborted();
        const stored = await fetchStored(input.artifactId, signal);
        if (!stored) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' } as const;
        const codec = await openStored(stored);
        if (stored.headerVersion !== input.expectedRevision.headerVersion || stored.bodyVersion !== input.expectedRevision.bodyVersion) {
          return { ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' } as const;
        }
        const header = decode(codec, stored.header);
        if (!header || typeof header !== 'object' || Array.isArray(header)) throw new ArtifactEncryptionMaterialUnavailableError();
        const history = await store.revisions.list({ artifactId: input.artifactId }, signal);
        const retained = history.revisions.find((revision) => revision.bodyVersion === input.bodyVersion);
        if (!retained) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' } as const;
        const nextHeader = prepareArtifactHeaderForRevisionV1({ artifactId: input.artifactId,
          header: header as Readonly<Record<string, unknown>>, body: retained.body, expectedRevision: input.expectedRevision,
          nextRevision: { headerVersion: stored.headerVersion + 1, bodyVersion: stored.bodyVersion + 1 },
          shared: (await sharedWriteContext(stored, header as Readonly<Record<string, unknown>>, header as Readonly<Record<string, unknown>>, signal, retained.body))?.shared });
        signal?.throwIfAborted();
        const provenance = await writeProvenance({ artifactId: input.artifactId, bodyVersion: stored.bodyVersion + 1,
          savedBy: input.savedBy, source: retained.provenance?.source, restoredFromBodyVersion: input.bodyVersion, signal }, stored, codec);
        const kind = await writeKind(nextHeader);
        await assertOwnerAccountMode(stored, undefined, { signal });
        signal?.throwIfAborted();
        const response = await axios.post(`${resolveServerHttpBaseUrl()}/v1/artifacts/${encodeURIComponent(input.artifactId)}/revisions/${input.bodyVersion}/restore`,
          { expectedHeaderVersion: input.expectedRevision.headerVersion, expectedBodyVersion: input.expectedRevision.bodyVersion,
            header: codec.encode(withArtifactExcerptV1(nextHeader, retained.body)),
            ...(kind === undefined ? {} : { kind }),
            ...provenance.wire }, accessConfig(signal));
        const quota = readQuotaFailure(response);
        if (quota) return quota;
        if (response.status === 409 || response.data?.error === 'version-mismatch') {
          return { ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' } as const;
        }
        if (response.status === 404) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' } as const;
        if (response.status >= 200 && response.status < 300 && response.data?.success === true) await provenance.prepareRecipients?.();
        return response.status >= 200 && response.status < 300 && response.data?.success === true
          ? { ok: true, revision: readAcknowledgedRevision(response.data) } as const
          : { ok: false, errorCode: 'restore_failed', error: 'artifact_restore_failed' } as const;
      },
    },
    storageUsage: async (signal?: AbortSignal) => {
      signal?.throwIfAborted();
      const response = await axios.get(`${resolveServerHttpBaseUrl()}/v1/artifacts/storage/usage`, accessConfig(signal));
      const parsed = ArtifactStorageUsageV1Schema.safeParse(response.data);
      if (response.status < 200 || response.status >= 300 || !parsed.success) {
        throw Object.assign(new Error('artifact_storage_usage_unavailable'), { code: 'artifact_storage_usage_unavailable' });
      }
      return parsed.data;
    },
    list: async (options?: ArtifactListPageOptionsV1,
      readAccountMode?: () => Promise<ConnectedServiceAccountEncryptionMode>): Promise<Readonly<{ items: readonly AccountArtifactHeader[]; nextCursor?: string; hasUnclassified?: boolean; kindCoverage?: ArtifactKindCoverageV1; coverage: 'complete' | 'partial' }>> => {
      const startedAt = performance.now();
      const { rows, nextCursor, hasUnclassified, kindCoverage } = await fetchHeaderPage(options);
      const httpMs = performance.now() - startedAt;
      const timing = { accountModeMs: 0, codecMs: 0 };
      const items = await projectHeaderRows(rows, options ?? {}, timing, readAccountMode);
      logger.infoFile('[Artifacts] List page timing', { rows: rows.length, items: items.length,
        includeBody: options?.includeBody === true, httpMs: Math.round(httpMs),
        accountModeMs: Math.round(timing.accountModeMs), codecMs: Math.round(timing.codecMs),
        decodeAndProjectionMs: Math.round(performance.now() - startedAt - httpMs - timing.accountModeMs - timing.codecMs),
        durationMs: Math.round(performance.now() - startedAt) });
      return { items, coverage: items.length === rows.length ? 'complete' : 'partial', ...(nextCursor ? { nextCursor } : {}),
        ...(kindCoverage ? { kindCoverage } : {}),
        ...(hasUnclassified === undefined ? {} : { hasUnclassified }) };
    },
    create: async (input: Readonly<{ artifactId?: string; noticeAccountId?: string; header: Readonly<Record<string, unknown>>; savedBy?: ArtifactSavedByV1 | null; source?: ArtifactWorkspaceSourceV1; memoryDecisionSource?: CoordinationMessageRefV1; signal?: AbortSignal; beforeWrite?: () => void | Promise<void>; authorizationHeaders?: ArtifactRequestAuthorizationHeaders; prepareRecipients?: boolean }> & ArtifactWriteContent) => {
      input.signal?.throwIfAborted();
      if (input.memoryDecisionSource && typeof input.body !== 'string')
        throw Object.assign(new Error('memory_decision_source_unsupported'), { code: 'memory_decision_source_unsupported' });
      const codec = await createCodec({ credentials: contentCredentials, mode: await readAccountMode({ signal: input.signal, authorizationHeaders: input.authorizationHeaders }) });
      await input.beforeWrite?.();
      let artifactId: string;
      if (input.header.kind === ACCOUNT_NOTICE_ARTIFACT_KIND_V1 || input.noticeAccountId !== undefined) {
        const notice = readAccountNoticeArtifactV1({ header: input.header, body: input.body });
        const accountId = contentAccountId;
        if (!notice || notice.status !== 'open' || !input.noticeAccountId || input.artifactId !== undefined) {
          throw Object.assign(new Error('notice_identity_unavailable'), { code: 'notice_identity_unavailable' });
        }
        if (!accountId || accountId !== input.noticeAccountId) {
          throw Object.assign(new Error('notice_account_scope_mismatch'), { code: 'notice_account_scope_mismatch' });
        }
        artifactId = privateNoticeArtifactId({ occurrence: accountNoticeOccurrence(accountId, notice),
          mode: codec.mode, credentials: contentCredentials });
        if (await fetchStored(artifactId, input.signal)
          || await findRetainedNotice(accountId, accountNoticeOccurrence(accountId, notice), input.signal)) {
          throw Object.assign(new Error('conflict'), { code: 'conflict' });
        }
      } else artifactId = input.artifactId ?? randomUUID();
      await validateHtmlContent(input.header, input, artifactId, input.signal);
      const content = await prepareWriteContent(codec, input);
      requireBodyForArtifactKind(input.header, content.body);
      input.signal?.throwIfAborted();
      const nextHeader = withArtifactExcerptV1(prepareArtifactHeaderForBodyV1(input.header, content.body), content.body);
      const header = codec.encode(nextHeader);
      const kind = await writeKind(nextHeader);
      const body = codec.encode({ body: content.body });
      const provenance = (await writeProvenance({ artifactId, bodyVersion: 1, savedBy: input.savedBy, source: input.source, signal: input.signal }, undefined, codec)).wire;
      // Host-owned admission is rechecked after preparation's last await and
      // immediately before the first HTTP write. It is never a persisted field.
      if (input.beforeWrite) await input.beforeWrite();
      await assertOwnerAccountMode({ access: 'owner', encryptionMode: codec.mode }, undefined,
        { signal: input.signal, authorizationHeaders: input.authorizationHeaders });
      input.signal?.throwIfAborted();
      const path = content.blob?.content ? ARTIFACT_UPLOAD_PATH_V1
        : `/v1/artifacts${input.memoryDecisionSource ? '/memory-decision/create' : content.blob ? '/content/binary' : ''}`;
      const requestBody = content.blob?.content ? Buffer.from(encodeArtifactUploadFrameV1({
          kind: 'create', artifactId, blobId: content.blob.blobId, header, body, dataEncryptionKey: codec.dataEncryptionKey, ...provenance,
          ...(kind === undefined ? {} : { artifactKind: kind }),
        }, content.blob.content)) : {
        id: artifactId, header, body, dataEncryptionKey: codec.dataEncryptionKey, ...provenance,
        ...(kind === undefined ? {} : { kind }),
        ...(input.memoryDecisionSource ? { memoryDecisionSource: input.memoryDecisionSource } : {}),
        ...(content.blob ? { blob: content.blob } : {}),
      };
      const requestHeaders = input.authorizationHeaders
        ? await input.authorizationHeaders({ method: 'POST', path, body: requestBody }) : headers();
      const response = await axios.post(`${resolveServerHttpBaseUrl()}${path}`, requestBody, {
        headers: { ...requestHeaders, ...(content.blob?.content ? { 'Content-Type': ARTIFACT_UPLOAD_CONTENT_TYPE_V1 } : {}) },
        ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true });
      const quota = readQuotaFailure(response);
      if (quota) throw Object.assign(new Error(quota.error), { code: quota.errorCode, details: quota.details });
      const sourceError = MemoryDecisionSourceErrorCodeV1Schema.safeParse(response.data?.error);
      if ((response.status < 200 || response.status >= 300) && sourceError.success)
        throw Object.assign(new Error(sourceError.data), { code: sourceError.data });
      if (response.status === 404 && input.memoryDecisionSource)
        throw Object.assign(new Error('memory_decision_source_unsupported'), { code: 'memory_decision_source_unsupported' });
      if (response.status < 200 || response.status >= 300) {
        // Only published storage codes may cross this boundary. Retain status
        // without carrying Axios request headers or arbitrary server content.
        const storageError = response.status === 503 ? readArtifactStorageFailureCode(response.data?.error) : null;
        throw createHttpStatusError(response.status, storageError ?? (response.status === 409 ? 'artifact_create_conflict' : 'artifact_create_failed'),
          storageError ?? (response.status === 409 ? 'conflict' : 'create_failed'));
      }
      if (response.data?.id !== artifactId) {
        throw Object.assign(new Error('artifact_content_unavailable'), { code: 'artifact_content_unavailable' });
      }
      const revision = readAcknowledgedRevision(response.data);
      // Some admitted publications are created with an existing resource audience.
      // Reuse the new content key; only its canonical recipient census is read.
      if (input.prepareRecipients) await prepare({ id: artifactId, encryptionMode: codec.mode,
        dataEncryptionKey: codec.dataEncryptionKey, provenanceDataEncryptionKey: provenance.provenanceDataEncryptionKey },
        codec, input.signal, input.authorizationHeaders);
      return { artifactId, revision };
    },
    update: (input: Parameters<typeof update>[0]) => update(input),
    delete: async (artifactId: string, options?: Readonly<{ signal?: AbortSignal; expectedRevision?: AccountArtifactRevision }>) => {
      options?.signal?.throwIfAborted();
      // The revision route keeps deletion atomic at the Artifact owner.
      const revisionPath = options?.expectedRevision
        ? `/revision/${options.expectedRevision.headerVersion}/${options.expectedRevision.bodyVersion}` : '';
      const response = await axios.delete(`${resolveServerHttpBaseUrl()}/v1/artifacts/${encodeURIComponent(artifactId)}${revisionPath}`, {
        headers: headers(), ...(options?.signal ? { signal: options.signal } : {}), validateStatus: () => true,
      });
      if (response.status === 404) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' } as const;
      if (response.status === 409 && response.data?.error === 'version-mismatch') return { ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' } as const;
      return response.status >= 200 && response.status < 300
        ? { ok: true } as const
        : { ok: false, errorCode: 'delete_failed', error: 'artifact_delete_failed' } as const;
    },
  };
  const readListBodies = async (items: readonly AccountArtifactHeader[], signal?: AbortSignal,
    readAccountMode?: () => Promise<ConnectedServiceAccountEncryptionMode>): Promise<readonly AccountArtifactHeader[]> => {
    signal?.throwIfAborted();
    if (items.length === 0) return items;
    const startedAt = performance.now();
    const input = ArtifactReadBatchInputV1Schema.parse({ artifactIds: items.map(item => item.artifactId) });
    const response = await axios.post(`${resolveServerHttpBaseUrl()}/v1/artifacts/read`, input, accessConfig(signal));
    signal?.throwIfAborted();
    const httpMs = performance.now() - startedAt;
    if (response.status < 200 || response.status >= 300) {
      throw Object.assign(new HttpStatusError(response.status, 'artifact_read_unavailable'), { code: 'artifact_read_unavailable', status: response.status });
    }
    const parsed = ArtifactReadBatchResponseV1Schema.safeParse(response.data);
    if (!parsed.success || parsed.data.items.length !== items.length
      || parsed.data.items.some((item, index) => item.artifactId !== items[index].artifactId)) {
      throw Object.assign(new Error('artifact_read_invalid'), { code: 'artifact_read_invalid' });
    }
    const timing = { accountModeMs: 0, codecMs: 0 };
    const opened = await projectHeaderRows(parsed.data.items.flatMap(item => item.ok ? [item.artifact] : []), { includeBody: true, signal }, timing, readAccountMode);
    signal?.throwIfAborted();
    const byId = new Map(opened.map(item => [item.artifactId, item]));
    logger.infoFile('[Artifacts] Selected body batch timing', { rows: items.length, items: opened.length,
      httpMs: Math.round(httpMs), accountModeMs: Math.round(timing.accountModeMs), codecMs: Math.round(timing.codecMs),
      durationMs: Math.round(performance.now() - startedAt) });
    // Keep refused/unopenable identities visible without content so consumers can report incomplete coverage.
    return items.map(item => byId.get(item.artifactId) ?? item);
  };
  async function list(options?: ArtifactListSelectionOptionsV1) {
    let accountMode: Promise<ConnectedServiceAccountEncryptionMode> | undefined;
    const readAccountMode = () => accountMode ??= params.getAccountEncryptionMode({ usage: 'identity', signal: options?.signal });
    const result = await listArtifactHeadersV1({ options,
      readPage: page => store.list(page, readAccountMode), encodeCursor: encodeAccountArtifactListCursor,
      ...((options?.kind || options?.kinds || options?.headerFilter) && options.includeBody
        ? { readBodies: (items: readonly AccountArtifactHeader[]) => readListBodies(items, options.signal, readAccountMode) } : {}) });
    options?.signal?.throwIfAborted();
    if (accountMode && result.items.some(item => item.access === 'owner' && Object.hasOwn(item, 'body'))) {
      const mode = await accountMode;
      if (mode === 'unknown') throw Object.assign(new Error('account_encryption_mode_unavailable'), { code: 'account_encryption_mode_unavailable' });
      await assertOwnerAccountMode({ access: 'owner', encryptionMode: mode }, undefined, { signal: options?.signal });
    }
    options?.signal?.throwIfAborted();
    return result;
  }
  const backfillQueryHints = async (options: Readonly<{ signal?: AbortSignal; isCurrent(): Promise<boolean> }>): Promise<ArtifactQueryHintBackfillResult> => {
    const current = async () => !options.signal?.aborted && await options.isCurrent() && !options.signal?.aborted;
    let phase: 'read_unavailable' | 'write_unavailable' = 'read_unavailable';
    try {
      if (!await current()) return { status: 'retired' };
      if (!await supportsQueryHints()) return { status: 'unsupported' };
      const ownerAccountId = contentAccountId;
      if (!ownerAccountId) return { status: 'unavailable', reason: phase };
      const labels: ArtifactKindWriteBatchInputV1['items'] = [];
      let cursor: string | undefined;
      let mode: Promise<ConnectedServiceAccountEncryptionMode> | undefined;
      const readAccountMode = () => mode ??= params.getAccountEncryptionMode({ usage: 'identity', signal: options.signal });
      do {
        if (!await current()) return { status: 'retired' };
        const page = await fetchHeaderPage({ limit: 500, unclassified: true, ownerAccountId, cursor, signal: options.signal });
        if (!page.kindCoverage) return { status: 'unavailable', reason: phase };
        const items = await projectHeaderRows(page.rows, { signal: options.signal }, { accountModeMs: 0, codecMs: 0 }, readAccountMode);
        if (!await current()) return { status: 'retired' };
        for (const item of items) {
          if (item.access !== 'owner' || item.ownerAccountId !== ownerAccountId) continue;
          const kind = tryDeriveArtifactStoredKindV1(item.header);
          if (kind !== undefined) labels.push({ artifactId: item.artifactId, kind, expectedHeaderVersion: item.headerVersion });
        }
        cursor = page.nextCursor;
      } while (cursor);
      for (const input of frameArtifactKindWriteBatchesV1(labels)) {
        if (!await current()) return { status: 'retired' };
        if (!await supportsQueryHints()) return { status: 'unsupported' };
        if (!await current()) return { status: 'retired' };
        phase = 'write_unavailable';
        const response = await axios.post(`${resolveServerHttpBaseUrl()}/v1/artifacts/query-hints/batch`, input, accessConfig(options.signal));
        if (!await current()) return { status: 'retired' };
        const result = ArtifactKindWriteBatchResponseV1Schema.safeParse(response.data);
        if (response.status < 200 || response.status >= 300 || !result.success || result.data.items.length !== input.items.length
          || result.data.items.some((item, index) => item.artifactId !== input.items[index]?.artifactId)) return { status: 'unavailable', reason: phase };
        if (result.data.items.some(item => !item.success)) return { status: 'unavailable', reason: 'write_refused' };
      }
      phase = 'read_unavailable';
      if (!await current()) return { status: 'retired' };
      const probe = await fetchHeaderPage({ limit: 1, kinds: [], ownerAccountId, signal: options.signal });
      if (!await current()) return { status: 'retired' };
      return probe.kindCoverage ?? { status: 'unavailable', reason: phase };
    } catch {
      return !await current().catch(() => false) ? { status: 'retired' } : { status: 'unavailable', reason: phase };
    }
  };
  return {
    ...store,
    readBodies: readListBodies,
    backfillQueryHints,
    /** The public Action stays reference-only; only the admitted keyholding host supplies preparation. */
    decideDocEditProposal: async (args: (Readonly<{ actionId: 'doc.edit.accept'; input: DocEditAcceptHostInputV1 }>
      | Readonly<{ actionId: 'doc.edit.decline'; input: DocEditDeclineInputV1 }>) & Readonly<{
        signal?: AbortSignal;
        authorizationHeaders?: ArtifactRequestAuthorizationHeaders;
      }>) => {
      args.signal?.throwIfAborted();
      let body: unknown;
      if (args.actionId === 'doc.edit.accept') {
        const input = DocEditAcceptHostInputV1Schema.parse(args.input);
        if (input.preparation) {
          const stored = await fetchStored(input.preparation.doc.ref.artifactId, args.signal, args.authorizationHeaders);
          if (!stored) throw Object.assign(new Error('not_found'), { code: 'not_found' });
          const codec = await openStored(stored, undefined, { authorizationHeaders: args.authorizationHeaders, signal: args.signal });
          body = DocEditAcceptTransportInputV1Schema.parse({ ...input,
            preparation: { ...input.preparation, body: codec.encode({ body: input.preparation.body }) } });
        } else body = DocEditAcceptTransportInputV1Schema.parse(input);
      } else body = DocEditDeclineTransportInputV1Schema.parse(args.input);
      const path = args.actionId === 'doc.edit.accept' ? DOC_EDIT_PROPOSAL_HTTP_PATHS_V1.accept : DOC_EDIT_PROPOSAL_HTTP_PATHS_V1.decline;
      const authorization = args.authorizationHeaders ? await args.authorizationHeaders({ method: 'POST', path, body }) : headers();
      args.signal?.throwIfAborted();
      const response = await axios.post(`${resolveServerHttpBaseUrl()}${path}`, body, {
        headers: authorization, ...(args.signal ? { signal: args.signal } : {}), validateStatus: () => true,
      });
      if (response.status < 200 || response.status >= 300) {
        const code = response.data && typeof response.data === 'object' && typeof response.data.error === 'string'
          ? response.data.error : 'doc_edit_proposal_decision_failed';
        throw Object.assign(new Error(code), { code });
      }
      const result = DocEditDecisionResultV1Schema.parse(response.data);
      if (result.proposalRef.messageId !== args.input.proposalRef.messageId
        || result.proposalRef.discussion.discussionId !== args.input.proposalRef.discussion.discussionId
        || result.proposalRef.discussion.serverId !== args.input.proposalRef.discussion.serverId) {
        throw Object.assign(new Error('doc_edit_proposal_invalid'), { code: 'doc_edit_proposal_invalid' });
      }
      return result;
    },
    /** Plugin identity is supplied only by the admitted host, never SDK input. */
    writeNotice: async (input: Readonly<{
      accountId: string; source: Extract<AccountNoticeArtifactHeaderV1['source'], { kind: 'plugin' } | { topic: 'service_health' }>;
      title: string; type: AccountNoticeArtifactHeaderV1['type']; body?: string;
      page?: AccountNoticeArtifactHeaderV1['page']; resolved: boolean;
      healthPhase?: AccountNoticeArtifactHeaderV1['healthPhase'];
      environmentHealth?: AccountNoticeArtifactHeaderV1['environmentHealth'];
      investigation?: AccountNoticeArtifactHeaderV1['investigation'];
      recoveryChoices?: Readonly<NonNullable<AccountNoticeArtifactHeaderV1['recoveryChoices']>>
        | ((reference: Readonly<{ artifactId: string }>) => Readonly<NonNullable<AccountNoticeArtifactHeaderV1['recoveryChoices']>>);
      signal?: AbortSignal; beforeWrite?: () => void | Promise<void>;
    }>): Promise<AccountNoticeWriteReceipt> => {
      const accountId = contentAccountId;
      if (!accountId || accountId !== input.accountId) {
        throw Object.assign(new Error('notice_account_scope_mismatch'), { code: 'notice_account_scope_mismatch' });
      }
      const mode = await params.getAccountEncryptionMode();
      if (mode === 'unknown') throw Object.assign(new Error('account_encryption_mode_unavailable'), { code: 'account_encryption_mode_unavailable' });
      const baseContent = AccountNoticeArtifactBodyV1Schema.parse({ v: 1, source: input.source, type: input.type,
        resolved: input.resolved, ...(input.healthPhase === undefined ? {} : { healthPhase: input.healthPhase }),
        ...(input.environmentHealth === undefined ? {} : { environmentHealth: input.environmentHealth }),
        ...(input.investigation === undefined ? {} : { investigation: input.investigation }),
        ...(input.body === undefined ? {} : { body: input.body }), ...(input.page === undefined ? {} : { page: input.page }) });
      const occurrence = accountNoticeOccurrence(accountId, baseContent);
      let artifactId = privateNoticeArtifactId({ occurrence,
        mode, credentials: contentCredentials });
      for (;;) {
        input.signal?.throwIfAborted();
        await input.beforeWrite?.();
        const current: AccountArtifact | null = await store.read(artifactId, { signal: input.signal, includeSharedAudience: false })
          ?? await findRetainedNotice(accountId, occurrence, input.signal);
        if (current) artifactId = current.artifactId;
        const notice = current ? readAccountNoticeArtifactV1(current) : null;
        if (current && (current.ownerAccountId !== accountId || current.access !== 'owner' || current.shared === true
          || current.publicAudience !== 'none' || !notice || accountNoticeOccurrence(accountId, notice) !== occurrence)) {
          throw Object.assign(new Error('notice_owner_mismatch'), { code: 'notice_owner_mismatch' });
        }
        const recoveryChoices = typeof input.recoveryChoices === 'function' ? input.recoveryChoices({ artifactId }) : input.recoveryChoices;
        const content = AccountNoticeArtifactBodyV1Schema.parse({ ...baseContent,
          ...(recoveryChoices === undefined ? {} : { recoveryChoices }) });
        if (content.recoveryChoices?.some(choice => choice.actionId === 'inbox.notice.dismiss' && choice.input.artifactId !== artifactId)) {
          throw Object.assign(new Error('notice_recovery_target_mismatch'), { code: 'notice_recovery_target_mismatch' });
        }
        const health = content.healthPhase !== undefined;
        const reopen = health && notice?.healthPhase !== content.healthPhase;
        if (notice) {
          const previous = AccountNoticeArtifactBodyV1Schema.parse({ v: notice.v, source: notice.source, type: notice.type,
            resolved: health && content.healthPhase === 'recovered' ? content.resolved : notice.resolved,
            ...(notice.body === undefined ? {} : { body: notice.body }), ...(notice.page === undefined ? {} : { page: notice.page }),
            ...(notice.investigation === undefined ? {} : { investigation: notice.investigation }),
            ...(notice.recoveryChoices === undefined ? {} : { recoveryChoices: notice.recoveryChoices }),
            ...(notice.healthPhase === undefined ? {} : { healthPhase: notice.healthPhase }),
            ...(notice.environmentHealth === undefined ? {} : { environmentHealth: notice.environmentHealth }) });
          if (notice.title === input.title && isDeepStrictEqual(previous, content)) {
            return { artifactId, revision: current!.revision, changed: false, opened: false, pushWorthy: false };
          }
        }
        // Evidence can change after recovery was acknowledged. That update does
        // not undo the person's acknowledgement; only a new failure reopens it.
        const nextContent = health && notice?.healthPhase === 'recovered' && content.healthPhase === 'recovered'
          ? { ...content, resolved: notice.resolved } : content;
        const body = JSON.stringify(nextContent);
        const header = AccountNoticeArtifactHeaderV1Schema.parse({ ...nextContent, kind: ACCOUNT_NOTICE_ARTIFACT_KIND_V1,
          title: input.title, status: reopen ? 'open' : notice?.status ?? 'open',
          ...(!reopen && notice?.readAt !== undefined ? { readAt: notice.readAt } : {}) });
        const committed = (result: Readonly<{ artifactId: string; revision: AccountArtifactRevision }>): AccountNoticeWriteReceipt => {
          // Default native attention covers a new actionable opening, not
          // evidence refreshes, non-production updates or recovery phases.
          const opening = header.source.kind === 'host' && header.source.topic === 'service_health'
            && header.type === 'blocked' && header.healthPhase === 'open'
            && (!notice || notice.healthPhase !== 'open' || notice.type !== 'blocked');
          const opened = header.status === 'open' && !header.resolved
            && (health ? header.healthPhase === 'open' && (!notice || notice.healthPhase === 'recovered' || notice.resolved)
              : !notice || notice.resolved);
          const pushWorthy = opened || !health && header.status === 'open' && !header.resolved && notice !== null
            && !resolveInboxItemAttentionV1(notice.type).person.push && resolveInboxItemAttentionV1(header.type).person.push;
          const healthOpening = opening ? projectServiceHealthNoticeNotification({ header, accountId, artifactId: result.artifactId }) : null;
          return { ...result, changed: true, opened, pushWorthy, ...(healthOpening ? { healthOpening } : {}) };
        };
        if (!current) {
          if (input.resolved || content.healthPhase === 'recovered') return { artifactId, changed: false, opened: false, pushWorthy: false };
          try {
            return committed(await store.create({ noticeAccountId: accountId, header, body, signal: input.signal, beforeWrite: input.beforeWrite }));
          } catch (error) {
            if (error !== null && typeof error === 'object' && 'code' in error && error.code === 'conflict') continue;
            throw error;
          }
        }
        const updated = await store.update({ artifactId, expectedRevision: current.revision, header, body,
          signal: input.signal, beforeWrite: input.beforeWrite });
        if (updated.ok) return committed({ artifactId, revision: updated.revision });
        if (updated.errorCode === 'version_mismatch') continue;
        throw Object.assign(new Error(updated.error), { code: updated.errorCode });
      }
    },
    list,
  };
}

export function createCredentialedAccountArtifactStore(credentials: StoredCredentials,
  options: Readonly<{ resolveServerFeaturesSnapshot?: ArtifactQueryHintFeatures }> = {}) {
  const accountModeApi = createConnectedServiceCredentialApi(credentials);
  const accountId = readAccountIdFromToken(credentials.token);
  return createAccountArtifactStore({
    credentials,
    resolveServerFeaturesSnapshot: options.resolveServerFeaturesSnapshot
      ?? (() => fetchServerFeaturesSnapshot({ serverUrl: resolveServerHttpBaseUrl() })),
    getAccountEncryptionMode: options => accountModeApi.getAccountEncryptionMode(options),
    ...(accountId ? { savedBy: { kind: 'person', accountId } as const } : {}),
  });
}

/** Layout owners require readable acknowledged content, not the generic create receipt. */
export function createAcknowledgedAccountArtifactTransport(
  transport: Pick<ReturnType<typeof createAccountArtifactStore>, 'read' | 'create' | 'update'> & Partial<Pick<ReturnType<typeof createAccountArtifactStore>, 'list' | 'delete'>>,
): HomeHubArtifactTransportV1 & Partial<Pick<ReturnType<typeof createAccountArtifactStore>, 'list' | 'delete'>> {
  return {
    read: transport.read,
    update: transport.update,
    ...(transport.list ? { list: transport.list } : {}),
    ...(transport.delete ? { delete: transport.delete } : {}),
    create: async input => {
      const created = await transport.create(input);
      const acknowledged = await transport.read(created.artifactId, { signal: input.signal });
      if (!acknowledged) throw Object.assign(new Error('artifact_content_unavailable'), { code: 'artifact_content_unavailable' });
      return acknowledged;
    },
  };
}

type ContentEncryption = Pick<StoredCredentials, 'encryption'>;

export type ArtifactAssociatedStoredContent = Readonly<{ t: 'plain'; v: unknown } | { t: 'encrypted'; c: string }>;

export type AccountNoticeWriteReceipt = Readonly<{
  artifactId: string; revision?: AccountArtifactRevision; changed: false; opened?: false; pushWorthy?: false;
}> | Readonly<{
  artifactId: string; revision: AccountArtifactRevision; changed: true;
  /** Acknowledged new/recovered opening, never an evidence-only revision. */
  opened?: boolean;
  /** New opening or quiet-to-actionable transition, decided from committed notice facts. */
  pushWorthy?: boolean;
  healthOpening?: ServiceHealthNoticeNotificationV1;
}>;

export function projectServiceHealthNoticeNotification(input: Readonly<{
  accountId: string; artifactId: string; header: AccountNoticeArtifactHeaderV1;
}>): ServiceHealthNoticeNotificationV1 | null {
  const { header, accountId, artifactId } = input;
  const page = header.page;
  if (header.source.kind !== 'host' || header.source.topic !== 'service_health'
    || (header.type !== 'blocked' && header.type !== 'update') || !page || !('kind' in page)) return null;
  return ServiceHealthNoticeNotificationV1Schema.parse({ topic: 'service_health', type: header.type,
    title: header.title, ...(header.body === undefined ? {} : { body: header.body }),
    data: { v: 1, topic: 'account_notice', accountId, artifactId, source: header.source, page,
      serverId: page.page === 'machine_service' ? page.machine.serverId : page.environment.serverId } });
}
