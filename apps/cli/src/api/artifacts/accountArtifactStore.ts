import axios from 'axios';
import { ARTIFACT_UPLOAD_CONTENT_TYPE_V1, ARTIFACT_UPLOAD_PATH_V1, encodeArtifactUploadFrameV1 } from '@happier-dev/transfers';
import { createHash, randomUUID } from 'node:crypto';

import {
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  decodePlainArtifactStoredContent,
  encodePlainArtifactStoredContent,
  isPlainArtifactDataKeyMarker,
  openEncryptedDataKeyEnvelopeV1,
  sealEncryptedDataKeyEnvelopeV1,
  ArtifactAccessErrorCodeV1Schema,
  ArtifactAccessGrantsListResponseV1Schema,
  ArtifactAccessGrantMutationResponseV1Schema,
  ArtifactAccessRecipientCensusResponseV1Schema,
  ArtifactRecipientKeyEnvelopeCommitResponseV1Schema,
  runArtifactRecipientKeyPreparationV1,
  type ArtifactCallerAccessV1,
  type ArtifactAccessGrantSetInputV1,
  type ArtifactAccessGrantRemoveInputV1,
  ArtifactQuotaExceededV1Schema,
  ArtifactRevisionListResponseV1Schema,
  ArtifactStorageUsageV1Schema,
  prepareArtifactHeaderForRevisionV1,
  withArtifactExcerptV1,
  artifactKindRequiresTextBodyV1,
  createArtifactPublicLinkActionsV1,
  type ArtifactPublicLinkActionIdV1,
  type ArtifactPublicLinkIssuedV1,
  ArtifactBodyV1Schema,
  ArtifactBlobReferenceV1Schema,
  ArtifactBlobReadResponseV1Schema,
  frameSessionDataKeyBundleV0,
  readSessionDataKeyBundleV0,
  sealAesGcmPayloadWebCrypto,
  openAesGcmPayloadWebCrypto,
  type ArtifactBodyV1,
  type ArtifactBlobWriteV1,
  artifactHtmlBundleFromBodyV1,
  ArtifactHtmlPreviewResponseV1Schema,
  buildArtifactHtmlPreviewUrlV1,
  isArtifactHtmlHeaderV1,
  type ArtifactHtmlBundleV1,
  listArtifactHeadersV1,
  type ArtifactListSelectionOptionsV1,
} from '@happier-dev/protocol';

import type { Credentials, StoredCredentials } from '@/persistence';
import type { ConnectedServiceAccountEncryptionMode } from '@/api/client/connectedServiceCredentialApi';
import { createConnectedServiceCredentialApi } from '@/api/client/connectedServiceCredentialApi';
import {
  decodeBase64,
  decryptWithDataKey,
  encodeBase64,
  encryptWithDataKey,
  getRandomBytes,
  libsodiumPublicKeyFromSecretKey,
} from '@/api/encryption';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import { deriveKey } from '@/utils/deriveKey';

export type AccountArtifactRevision = Readonly<{ headerVersion: number; bodyVersion: number }>;
export type AccountArtifactHtmlPreview = Readonly<{ previewUrl?: string; previewError?: 'artifact_html_preview_unavailable' }>;
export type AccountArtifact = Readonly<{
  ownerAccountId: string;
  access: ArtifactCallerAccessV1;
  artifactId: string;
  header: Readonly<Record<string, unknown>>;
  body: ArtifactBodyV1 | null;
  revision: AccountArtifactRevision;
  seq: number;
  createdAt: number;
  updatedAt: number;
}>;
export type AccountArtifactHeader = Readonly<{
  ownerAccountId: string;
  access: ArtifactCallerAccessV1;
  artifactId: string; header: Readonly<Record<string, unknown>>; headerVersion: number;
  seq: number; createdAt: number; updatedAt: number;
  body?: ArtifactBodyV1 | null; bodyVersion?: number;
}>;
export function encodeAccountArtifactListCursor(item: Pick<AccountArtifactHeader, 'artifactId' | 'updatedAt'>): string {
  return Buffer.from(JSON.stringify({ updatedAt: item.updatedAt, id: item.artifactId }), 'utf8').toString('base64url');
}

type StoredArtifact = Readonly<{
  ownerAccountId: string;
  access: ArtifactCallerAccessV1;
  encryptionMode: 'plain' | 'e2ee';
  id: string; header: string; headerVersion: number; body: string; bodyVersion: number;
  dataEncryptionKey: string; seq: number; createdAt: number; updatedAt: number;
}>;

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
export class ArtifactEncryptionMaterialUnavailableError extends Error {
  readonly code = ARTIFACT_ENCRYPTION_MATERIAL_UNAVAILABLE;
  constructor() { super('Artifact encryption material is unavailable'); this.name = 'ArtifactEncryptionMaterialUnavailableError'; }
}

function requireCredentials(credentials: StoredCredentials): Credentials {
  if (!credentials.encryption) throw new ArtifactEncryptionMaterialUnavailableError();
  return credentials;
}

async function recipientSecret(credentials: Credentials): Promise<Uint8Array> {
  return credentials.encryption.type === 'dataKey'
    ? credentials.encryption.machineKey
    : deriveKey(credentials.encryption.secret, 'Happy EnCoder', ['content']);
}

async function createCodec(params: Readonly<{
  credentials: StoredCredentials; mode: ConnectedServiceAccountEncryptionMode;
}>): Promise<Codec> {
  if (params.mode === 'plain') {
    return { mode: 'plain', dataKey: null, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      encode: encodePlainArtifactStoredContent, decode: decodePlainArtifactStoredContent };
  }
  if (params.mode === 'unknown') throw Object.assign(new Error('account_encryption_mode_unavailable'), { code: 'account_encryption_mode_unavailable' });
  const credentials = requireCredentials(params.credentials);
  const key = getRandomBytes(32);
  const publicKey = credentials.encryption.type === 'dataKey'
    ? credentials.encryption.publicKey
    : libsodiumPublicKeyFromSecretKey(await recipientSecret(credentials));
  return {
    mode: 'e2ee',
    dataKey: key,
    dataEncryptionKey: encodeBase64(sealEncryptedDataKeyEnvelopeV1({ dataKey: key, recipientPublicKey: publicKey, randomBytes: getRandomBytes }), 'base64'),
    encode: (value) => encodeBase64(encryptWithDataKey(value, key), 'base64'),
    decode: (value) => decryptWithDataKey(decodeBase64(value), key),
  };
}

async function openCodec(credentialsInput: StoredCredentials, dataEncryptionKey: string, mode: ConnectedServiceAccountEncryptionMode): Promise<Codec> {
  if (mode === 'unknown') throw Object.assign(new Error('account_encryption_mode_unavailable'), { code: 'account_encryption_mode_unavailable' });
  if ((mode === 'plain') !== isPlainArtifactDataKeyMarker(dataEncryptionKey)) {
    throw Object.assign(new Error('artifact_account_mode_mismatch'), { code: 'artifact_account_mode_mismatch' });
  }
  if (isPlainArtifactDataKeyMarker(dataEncryptionKey)) return {
    mode: 'plain', dataKey: null, dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
    encode: encodePlainArtifactStoredContent, decode: decodePlainArtifactStoredContent,
  };
  const credentials = requireCredentials(credentialsInput);
  const key = openEncryptedDataKeyEnvelopeV1({
    envelope: decodeBase64(dataEncryptionKey), recipientSecretKeyOrSeed: await recipientSecret(credentials),
  });
  if (!key) throw new ArtifactEncryptionMaterialUnavailableError();
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
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new ArtifactEncryptionMaterialUnavailableError();
  const parsed = ArtifactBodyV1Schema.nullable().safeParse(Reflect.get(decoded, 'body'));
  if (!parsed.success) throw new ArtifactEncryptionMaterialUnavailableError();
  return parsed.data;
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
  const content = codec.mode === 'plain' ? { t: 'plain' as const, v: encodeBase64(bytes) }
    : { t: 'encrypted' as const, c: encodeBase64(frameSessionDataKeyBundleV0(await sealAesGcmPayloadWebCrypto(bytes, codec.dataKey!))) };
  return { body, blob: { blobId: body.blobId, content } };
}

function unavailableBinary(): Error {
  return Object.assign(new Error('artifact_content_unavailable'), { code: 'artifact_content_unavailable' });
}

function requireBodyForArtifactKind(header: Readonly<Record<string, unknown>>, body: ArtifactBodyV1 | null): void {
  if (artifactKindRequiresTextBodyV1(header.kind) && typeof body !== 'string') throw unavailableBinary();
}

function parseStoredArtifact(raw: unknown): StoredArtifact | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  if (typeof value.id !== 'string' || typeof value.header !== 'string' || typeof value.body !== 'string' || typeof value.dataEncryptionKey !== 'string') return null;
  const headerVersion = readNonnegativeSafeInteger(value.headerVersion);
  const bodyVersion = readNonnegativeSafeInteger(value.bodyVersion);
  const seq = readNonnegativeSafeInteger(value.seq);
  const createdAt = readNonnegativeSafeInteger(value.createdAt);
  const updatedAt = readNonnegativeSafeInteger(value.updatedAt);
  if (headerVersion === null || bodyVersion === null || seq === null || createdAt === null || updatedAt === null) return null;
  return { id: value.id, header: value.header, headerVersion, body: value.body,
    bodyVersion, dataEncryptionKey: value.dataEncryptionKey, seq, createdAt, updatedAt, ...readStoredAccess(value) };
}

const artifactAuthorityProjectionSchema = ArtifactAccessRecipientCensusResponseV1Schema.pick({ ownerAccountId: true, access: true, encryptionMode: true });

function readStoredAccess(value: Record<string, unknown>): Pick<StoredArtifact, 'ownerAccountId' | 'access' | 'encryptionMode'> {
  const projection = artifactAuthorityProjectionSchema
    .safeParse({ ownerAccountId: value.ownerAccountId, access: value.access, encryptionMode: value.encryptionMode });
  if (!projection.success) throw new ArtifactEncryptionMaterialUnavailableError();
  return projection.data;
}

export function createAccountArtifactStore(params: Readonly<{
  credentials: StoredCredentials;
  getAccountEncryptionMode: () => Promise<ConnectedServiceAccountEncryptionMode>;
}>) {
  // Axios chooses the media type from actual request data. Bodyless GET/DELETE
  // requests must not advertise JSON; binary uploads set their own media type.
  const headers = () => ({ Authorization: `Bearer ${params.credentials.token}` });
  const fetchStored = async (artifactId: string, signal?: AbortSignal): Promise<StoredArtifact | null> => {
    const response = await axios.get(`${resolveServerHttpBaseUrl()}/v1/artifacts/${encodeURIComponent(artifactId)}`, {
      headers: headers(), timeout: 15_000, ...(signal ? { signal } : {}), validateStatus: () => true,
    });
    if (response.status === 404) return null;
    if (response.data?.error === 'artifact_content_unavailable') throw new ArtifactEncryptionMaterialUnavailableError();
    if (response.status === 500 && response.data?.error === 'Failed to get artifact') throw new ArtifactEncryptionMaterialUnavailableError();
    return response.status >= 200 && response.status < 300 ? parseStoredArtifact(response.data) : null;
  };
  const accessUrl = (artifactId: string, leaf: string) => `${resolveServerHttpBaseUrl()}/v1/artifacts/${encodeURIComponent(artifactId)}/access/${leaf}`;
  const accessConfig = (signal?: AbortSignal) => ({ headers: headers(), timeout: 15_000,
    ...(signal ? { signal } : {}), validateStatus: () => true });
  const requireAccessResponse = (response: Readonly<{ status: number; data: unknown }>) => {
    if (response.status >= 200 && response.status < 300) return response.data;
    const value = response.data && typeof response.data === 'object' ? response.data as Record<string, unknown> : {};
    const known = ArtifactAccessErrorCodeV1Schema.safeParse(value.error);
    const code = known.success ? known.data
      : response.status === 404 || response.status === 405 ? 'artifact_access_unavailable' : 'artifact_access_failed';
    throw Object.assign(new Error(code), { code });
  };
  const prepare = async (stored: StoredArtifact, codec: Codec, signal?: AbortSignal) => {
    if (codec.mode === 'plain') return;
    await runArtifactRecipientKeyPreparationV1({ artifactId: stored.id, dataKey: codec.dataKey,
      openedDataEncryptionKey: stored.dataEncryptionKey, randomBytes: getRandomBytes, ...(signal ? { signal } : {}),
      readCensus: async () => ArtifactAccessRecipientCensusResponseV1Schema.parse(requireAccessResponse(
        await axios.get(accessUrl(stored.id, 'recipients'), accessConfig(signal)))),
      commit: async (input) => ArtifactRecipientKeyEnvelopeCommitResponseV1Schema.parse(requireAccessResponse(
        await axios.post(accessUrl(stored.id, 'key-envelopes'), input, accessConfig(signal)))),
    });
  };
  const openStored = async (stored: Pick<StoredArtifact, 'access' | 'encryptionMode' | 'dataEncryptionKey'>) => {
    // Personal Artifact reads/writes follow the persisted Account mode. Shared
    // recipients instead open the owner's content mode, which may differ from theirs.
    if (stored.access === 'owner') {
      const accountMode = await params.getAccountEncryptionMode();
      if (accountMode === 'unknown') throw Object.assign(new Error('account_encryption_mode_unavailable'), { code: 'account_encryption_mode_unavailable' });
      if (accountMode !== stored.encryptionMode) throw Object.assign(new Error('artifact_account_mode_mismatch'), { code: 'artifact_account_mode_mismatch' });
    }
    return openCodec(params.credentials, stored.dataEncryptionKey, stored.encryptionMode);
  };
  const prepareCurrent = async (artifactId: string, signal?: AbortSignal) => {
    const stored = await fetchStored(artifactId, signal);
    if (!stored) throw Object.assign(new Error('artifact_not_found'), { code: 'artifact_not_found' });
    await prepare(stored, await openStored(stored), signal);
  };
  const read = async (artifactId: string, options?: Readonly<{ signal?: AbortSignal }>): Promise<AccountArtifact | null> => {
    options?.signal?.throwIfAborted();
    const stored = await fetchStored(artifactId, options?.signal);
    if (!stored) return null;
    const codec = await openStored(stored);
    const header = decode(codec, stored.header);
    const body = decodeBody(codec, stored.body);
    if (!header || typeof header !== 'object' || Array.isArray(header)) return null;
    requireBodyForArtifactKind(header as Readonly<Record<string, unknown>>, body);
    await prepare(stored, codec, options?.signal);
    options?.signal?.throwIfAborted();
    return { artifactId: stored.id, header: header as Readonly<Record<string, unknown>>,
      ownerAccountId: stored.ownerAccountId, access: stored.access,
      body,
      revision: { headerVersion: stored.headerVersion, bodyVersion: stored.bodyVersion },
      seq: stored.seq, createdAt: stored.createdAt, updatedAt: stored.updatedAt };
  };
  const htmlBundle = async (header: Readonly<Record<string, unknown>>, content: ArtifactWriteContent,
    artifactId: string, signal?: AbortSignal): Promise<ArtifactHtmlBundleV1 | null> => {
    if (!isArtifactHtmlHeaderV1(header)) return null;
    try {
      if (content.binary) return artifactHtmlBundleFromBodyV1(content.binary.bytes, content.binary.mime);
      if (typeof content.body === 'string') return artifactHtmlBundleFromBodyV1(content.body);
      const body = ArtifactBlobReferenceV1Schema.parse(content.body);
      return artifactHtmlBundleFromBodyV1(await store.readBinary({ artifactId, body, signal }), body.mime);
    } catch {
      signal?.throwIfAborted();
      throw Object.assign(new Error('artifact_html_content_invalid'), { code: 'artifact_html_content_invalid' });
    }
  };
  const previewFromBundle = async (artifactId: string, bundle: ArtifactHtmlBundleV1 | null,
    signal?: AbortSignal): Promise<AccountArtifactHtmlPreview> => {
    if (!bundle) return {};
    try {
      const apiBaseUrl = resolveServerHttpBaseUrl();
      const response = await axios.get(`${apiBaseUrl}/v1/artifacts/${encodeURIComponent(artifactId)}/html-preview`, accessConfig(signal));
      const { url } = ArtifactHtmlPreviewResponseV1Schema.parse(response.data);
      if (response.status < 200 || response.status >= 300
        || new URL(url).pathname !== `/a/${encodeURIComponent(artifactId)}`) throw new Error('artifact_html_preview_unavailable');
      return { previewUrl: buildArtifactHtmlPreviewUrlV1({ url, bundle, forbiddenOrigins: [new URL(apiBaseUrl).origin] }) };
    } catch {
      // A preview is a projection, not another write: preserve an already committed acknowledgement.
      return { previewError: 'artifact_html_preview_unavailable' };
    }
  };
  const store = {
    read,
    htmlPreview: async (artifact: Pick<AccountArtifact, 'artifactId' | 'header' | 'body'>,
      signal?: AbortSignal): Promise<AccountArtifactHtmlPreview> => {
      if (!isArtifactHtmlHeaderV1(artifact.header)) return {};
      try {
        if (artifact.body === null) throw new Error('artifact_html_content_invalid');
        return await previewFromBundle(artifact.artifactId,
          await htmlBundle(artifact.header, { body: artifact.body }, artifact.artifactId, signal), signal);
      } catch { return { previewError: 'artifact_html_preview_unavailable' }; }
    },
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
        request: async (request) => {
          const url = `${resolveServerHttpBaseUrl()}${request.path}`;
          const config = accessConfig(request.signal);
          const response = request.method === 'GET' ? await axios.get(url, config)
            : request.method === 'DELETE' ? await axios.delete(url, config) : await axios.post(url, request.body, config);
          if (response.status < 200 || response.status >= 300) throw Object.assign(new Error('public_share_request_failed'), { code: 'public_share_request_failed' });
          return response.data;
        },
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
      const content = parsed.data.content;
      if ((codec.mode === 'plain') !== (content.t === 'plain')) throw unavailableBinary();
      let bytes: Uint8Array;
      try {
        if (content.t === 'plain') bytes = decodeBase64(content.v);
        else {
          const bundle = readSessionDataKeyBundleV0(decodeBase64(content.c));
          if (bundle.status !== 'ready') throw unavailableBinary();
          bytes = await openAesGcmPayloadWebCrypto(bundle.payload, codec.dataKey!);
        }
      } catch { throw unavailableBinary(); }
      if (bytes.byteLength !== reference.data.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== reference.data.sha256) throw unavailableBinary();
      input.signal?.throwIfAborted();
      return bytes;
    },
    accessGrants: {
      list: async (input: Readonly<{ artifactId: string }>, signal?: AbortSignal) => {
        const result = ArtifactAccessGrantsListResponseV1Schema.parse(requireAccessResponse(await axios.get(accessUrl(input.artifactId, 'grants'), accessConfig(signal))));
        await prepareCurrent(input.artifactId, signal);
        return result;
      },
      set: async (input: ArtifactAccessGrantSetInputV1, signal?: AbortSignal) => {
        const result = ArtifactAccessGrantMutationResponseV1Schema.parse(requireAccessResponse(await axios.put(accessUrl(input.artifactId, 'grants'), input, accessConfig(signal))));
        if (result.access !== null) await prepareCurrent(input.artifactId, signal);
        return result;
      },
      remove: async (input: ArtifactAccessGrantRemoveInputV1, signal?: AbortSignal) => {
        const result = ArtifactAccessGrantMutationResponseV1Schema.parse(requireAccessResponse(await axios.delete(accessUrl(input.artifactId, 'grants'), { ...accessConfig(signal), data: input })));
        if (result.access !== null) await prepareCurrent(input.artifactId, signal);
        return result;
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
        const revisions = parsed.data.revisions.map((value) => {
          return { ...value, body: decodeBody(codec, value.body) };
        });
        await prepare(stored, codec, signal);
        signal?.throwIfAborted();
        return { artifactId: input.artifactId, revisions, retentionCount: parsed.data.retentionCount };
      },
      restore: async (input: Readonly<{ artifactId: string; bodyVersion: number; expectedRevision: AccountArtifactRevision }>, signal?: AbortSignal) => {
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
          nextRevision: { headerVersion: stored.headerVersion + 1, bodyVersion: stored.bodyVersion + 1 } });
        signal?.throwIfAborted();
        const response = await axios.post(`${resolveServerHttpBaseUrl()}/v1/artifacts/${encodeURIComponent(input.artifactId)}/revisions/${input.bodyVersion}/restore`,
          { expectedHeaderVersion: input.expectedRevision.headerVersion, expectedBodyVersion: input.expectedRevision.bodyVersion,
            header: codec.encode(withArtifactExcerptV1(nextHeader, retained.body)) }, accessConfig(signal));
        const quota = readQuotaFailure(response);
        if (quota) return quota;
        if (response.status === 409 || response.data?.error === 'version-mismatch') {
          return { ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' } as const;
        }
        if (response.status === 404) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' } as const;
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
    list: async (options?: Readonly<{ limit?: number; cursor?: string; includeBody?: boolean; signal?: AbortSignal }>): Promise<Readonly<{ items: readonly AccountArtifactHeader[]; nextCursor?: string; coverage: 'complete' | 'partial' }>> => {
      options?.signal?.throwIfAborted();
      const url = new URL('/v1/artifacts', resolveServerHttpBaseUrl());
      if (options?.limit !== undefined) url.searchParams.set('limit', String(options.limit));
      if (options?.cursor) url.searchParams.set('cursor', options.cursor);
      if (options?.includeBody) url.searchParams.set('includeBody', 'true');
      const response = await axios.get(url.toString(), { headers: headers(), timeout: 15_000,
        ...(options?.signal ? { signal: options.signal } : {}), validateStatus: () => true });
      if (response.status === 500 && response.data?.error === 'Failed to get artifacts') throw new ArtifactEncryptionMaterialUnavailableError();
      if (response.status < 200 || response.status >= 300 || !Array.isArray(response.data)) {
        throw Object.assign(new Error(response.status === 400 ? 'artifact_list_cursor_invalid' : 'artifact_list_failed'), {
          code: response.status === 400 ? 'invalid_cursor' : 'list_failed',
        });
      }
      const items: AccountArtifactHeader[] = [];
      for (const raw of response.data) {
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
          codec = await openStored({ ...access, dataEncryptionKey: value.dataEncryptionKey });
        } catch (error) {
          // openStored checks the persisted Account mode first. Missing Account
          // material stays request-wide; a failed per-record envelope does not.
          if (error instanceof ArtifactEncryptionMaterialUnavailableError && params.credentials.encryption) continue;
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
        let content: Pick<AccountArtifactHeader, 'body' | 'bodyVersion'> = {};
        if (options?.includeBody) {
          const bodyVersion = readNonnegativeSafeInteger(value.bodyVersion);
          if (typeof value.body === 'string' && bodyVersion !== null) {
            try {
              const body = decodeBody(codec, value.body);
              requireBodyForArtifactKind(header as Readonly<Record<string, unknown>>, body);
              content = { body, bodyVersion };
            } catch (error) {
              if (!(error instanceof ArtifactEncryptionMaterialUnavailableError)
                && (!error || typeof error !== 'object' || Reflect.get(error, 'code') !== 'artifact_content_unavailable')) throw error;
              content = { bodyVersion };
            }
          }
        }
        items.push({ artifactId: value.id, header: header as Readonly<Record<string, unknown>>,
          ...content,
          ownerAccountId: access.ownerAccountId, access: access.access,
          headerVersion, seq, createdAt, updatedAt });
      }
      const last = response.data.at(-1) as Record<string, unknown> | undefined;
      const requestedLimit = options?.limit;
      const nextCursor = requestedLimit !== undefined && response.data.length === requestedLimit
        && typeof last?.id === 'string' && typeof last?.updatedAt === 'number'
        ? encodeAccountArtifactListCursor({ updatedAt: last.updatedAt, artifactId: last.id })
        : undefined;
      return { items, coverage: items.length === response.data.length ? 'complete' : 'partial', ...(nextCursor ? { nextCursor } : {}) };
    },
    create: async (input: Readonly<{ artifactId?: string; header: Readonly<Record<string, unknown>>; signal?: AbortSignal }> & ArtifactWriteContent) => {
      input.signal?.throwIfAborted();
      const codec = await createCodec({ credentials: params.credentials, mode: await params.getAccountEncryptionMode() });
      const artifactId = input.artifactId ?? randomUUID();
      const bundle = await htmlBundle(input.header, input, artifactId, input.signal);
      const content = await prepareWriteContent(codec, input);
      requireBodyForArtifactKind(input.header, content.body);
      input.signal?.throwIfAborted();
      const header = codec.encode(withArtifactExcerptV1(input.header, content.body));
      const body = codec.encode({ body: content.body });
      const response = content.blob?.content
        ? await axios.post(`${resolveServerHttpBaseUrl()}${ARTIFACT_UPLOAD_PATH_V1}`, Buffer.from(encodeArtifactUploadFrameV1({
          kind: 'create', artifactId, blobId: content.blob.blobId, header, body, dataEncryptionKey: codec.dataEncryptionKey,
        }, content.blob.content)), { headers: { ...headers(), 'Content-Type': ARTIFACT_UPLOAD_CONTENT_TYPE_V1 },
          ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true })
        : await axios.post(`${resolveServerHttpBaseUrl()}/v1/artifacts${content.blob ? '/content/binary' : ''}`, {
        id: artifactId, header, body, dataEncryptionKey: codec.dataEncryptionKey,
        ...(content.blob ? { blob: content.blob } : {}),
      }, { headers: headers(), timeout: 15_000, ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true });
      const quota = readQuotaFailure(response);
      if (quota) throw Object.assign(new Error(quota.error), { code: quota.errorCode, details: quota.details });
      if (response.status < 200 || response.status >= 300) throw Object.assign(new Error(response.status === 409 ? 'artifact_create_conflict' : 'artifact_create_failed'), { code: response.status === 409 ? 'conflict' : 'create_failed' });
      if (response.data?.id !== artifactId) {
        throw Object.assign(new Error('artifact_content_unavailable'), { code: 'artifact_content_unavailable' });
      }
      const revision = readAcknowledgedRevision(response.data);
      return { artifactId, revision, ...await previewFromBundle(artifactId, bundle, input.signal) };
    },
    update: async (input: Readonly<{ artifactId: string; expectedRevision: AccountArtifactRevision; header: Readonly<Record<string, unknown>>; signal?: AbortSignal }> & ArtifactWriteContent) => {
      const stored = await fetchStored(input.artifactId, input.signal);
      if (!stored) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' } as const;
      const codec = await openStored(stored);
      const bundle = await htmlBundle(input.header, input, input.artifactId, input.signal);
      const content = await prepareWriteContent(codec, input);
      requireBodyForArtifactKind(input.header, content.body);
      const blob: ArtifactBlobWriteV1 | null | undefined = content.blob
        ?? (ArtifactBlobReferenceV1Schema.safeParse(decodeBody(codec, stored.body)).success ? null : undefined);
      input.signal?.throwIfAborted();
      const header = codec.encode(withArtifactExcerptV1(input.header, content.body));
      const body = codec.encode({ body: content.body });
      const response = blob?.content
        ? await axios.post(`${resolveServerHttpBaseUrl()}${ARTIFACT_UPLOAD_PATH_V1}`, Buffer.from(encodeArtifactUploadFrameV1({
          kind: 'update', artifactId: input.artifactId, blobId: blob.blobId, header, body,
          expectedHeaderVersion: input.expectedRevision.headerVersion, expectedBodyVersion: input.expectedRevision.bodyVersion,
        }, blob.content)), { headers: { ...headers(), 'Content-Type': ARTIFACT_UPLOAD_CONTENT_TYPE_V1 },
          ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true })
        : await axios.post(`${resolveServerHttpBaseUrl()}/v1/artifacts/${encodeURIComponent(input.artifactId)}${blob !== undefined ? '/content/binary' : ''}`, {
        header, expectedHeaderVersion: input.expectedRevision.headerVersion,
        body, expectedBodyVersion: input.expectedRevision.bodyVersion,
        ...(blob !== undefined ? { blob } : {}),
      }, { headers: headers(), timeout: 15_000, ...(input.signal ? { signal: input.signal } : {}), validateStatus: () => true });
      const quota = readQuotaFailure(response);
      if (quota) return quota;
      if (response.status === 404) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' } as const;
      if (response.status < 200 || response.status >= 300) return { ok: false, errorCode: 'update_failed', error: 'artifact_update_failed' } as const;
      if (response.data?.success === false && response.data?.error === 'version-mismatch') return { ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' } as const;
      return response.data?.success === true
        ? { ok: true, revision: readAcknowledgedRevision(response.data),
          ...await previewFromBundle(input.artifactId, bundle, input.signal) } as const
        : { ok: false, errorCode: 'update_failed', error: 'artifact_update_failed' } as const;
    },
    delete: async (artifactId: string, options?: Readonly<{ signal?: AbortSignal; expectedRevision?: AccountArtifactRevision }>) => {
      options?.signal?.throwIfAborted();
      // The revision route keeps deletion atomic at the Artifact owner.
      const revisionPath = options?.expectedRevision
        ? `/revision/${options.expectedRevision.headerVersion}/${options.expectedRevision.bodyVersion}` : '';
      const response = await axios.delete(`${resolveServerHttpBaseUrl()}/v1/artifacts/${encodeURIComponent(artifactId)}${revisionPath}`, {
        headers: headers(), timeout: 15_000, ...(options?.signal ? { signal: options.signal } : {}), validateStatus: () => true,
      });
      if (response.status === 404) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' } as const;
      if (response.status === 409 && response.data?.error === 'version-mismatch') return { ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' } as const;
      return response.status >= 200 && response.status < 300
        ? { ok: true } as const
        : { ok: false, errorCode: 'delete_failed', error: 'artifact_delete_failed' } as const;
    },
  };
  return {
    ...store,
    list: (options?: ArtifactListSelectionOptionsV1) => listArtifactHeadersV1({ options,
      readPage: store.list, encodeCursor: encodeAccountArtifactListCursor }),
  };
}

export function createCredentialedAccountArtifactStore(credentials: StoredCredentials) {
  const accountModeApi = createConnectedServiceCredentialApi(credentials);
  return createAccountArtifactStore({
    credentials,
    getAccountEncryptionMode: () => accountModeApi.getAccountEncryptionMode(),
  });
}
