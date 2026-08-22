import axios from 'axios';
import { randomUUID } from 'node:crypto';

import {
  ApprovalRequestV1Schema,
  ARTIFACT_PLAIN_DATA_KEY_MARKER,
  ExecutionRunHostActionApprovalRequestV1Schema,
  TargetActionApprovalRequestV1Schema,
  ActionIdSchema,
  decodePlainArtifactStoredContent,
  encodePlainArtifactStoredContent,
  isPlainArtifactDataKeyMarker,
  openEncryptedDataKeyEnvelopeV1,
  sealEncryptedDataKeyEnvelopeV1,
  type ActionId,
  type ApprovalQueueListItemV1,
  type ApprovalRequestV1,
  type ExecutionRunHostActionApprovalRequestV1,
  type TargetActionApprovalRequestV1,
  type PromptLibraryArtifactStore,
} from '@happier-dev/protocol';

import type { Credentials, StoredCredentials } from '@/persistence';
import {
  createConnectedServiceCredentialApi,
  type ConnectedServiceAccountEncryptionMode,
} from '@/api/client/connectedServiceCredentialApi';
import {
  decodeBase64,
  decryptWithDataKey,
  encodeBase64,
  encryptWithDataKey,
  getRandomBytes,
  libsodiumPublicKeyFromSecretKey,
} from '@/api/encryption';
import { resolveServerHttpBaseUrl } from '@/api/client/serverHttpBaseUrl';
import {
  requireCurrentAccountStoredContentServerCompatibility,
} from '@/api/clientCompatibility/accountStoredContentActivation';
import type { CliServerFeaturesSnapshot } from '@/features/serverFeaturesClient';
import { buildCurrentAccountStoredContentCompatibilityHttpHeaders } from '@/api/clientCompatibility/cliClientCompatibility';
import { deriveKey } from '@/utils/deriveKey';
import { targetActionApprovalRequestsEqual, targetActionApprovalSubjectsEqual } from './targetActionApprovalSubject';
import {
  executionRunHostActionApprovalRequestsEqual,
  executionRunHostActionApprovalSubjectsEqual,
} from './executionRunHostActionApprovalSubject';

type ArtifactFullRecord = Readonly<{
  id: string;
  header: string;
  headerVersion: number;
  body: string;
  bodyVersion: number;
  dataEncryptionKey: string;
  seq: number;
  createdAt: number;
  updatedAt: number;
}>;

type ArtifactListRecord = Omit<ArtifactFullRecord, 'body' | 'bodyVersion'>;

type ArtifactCreateRequest = Readonly<{
  id: string;
  header: string;
  body: string;
  dataEncryptionKey: string;
}>;

type ArtifactUpdateRequest = Readonly<{
  header: string;
  expectedHeaderVersion: number;
  body: string;
  expectedBodyVersion: number;
}>;

async function resolveRecipientSecretKeyOrSeed(credentials: Credentials): Promise<Uint8Array> {
  if (credentials.encryption.type === 'dataKey') return credentials.encryption.machineKey;
  return await deriveKey(credentials.encryption.secret, 'Happy EnCoder', ['content']);
}

async function resolveRecipientPublicKey(credentials: Credentials): Promise<Uint8Array> {
  if (credentials.encryption.type === 'dataKey') return credentials.encryption.publicKey;
  return libsodiumPublicKeyFromSecretKey(await resolveRecipientSecretKeyOrSeed(credentials));
}

async function openArtifactDataEncryptionKey(params: Readonly<{
  credentials: Credentials;
  encryptedDataEncryptionKeyBase64: string;
}>): Promise<Uint8Array | null> {
  const recipientSecretKeyOrSeed = await resolveRecipientSecretKeyOrSeed(params.credentials);
  return openEncryptedDataKeyEnvelopeV1({
    envelope: decodeBase64(params.encryptedDataEncryptionKeyBase64),
    recipientSecretKeyOrSeed,
  });
}

async function sealArtifactDataEncryptionKey(params: Readonly<{
  credentials: Credentials;
  dataEncryptionKey: Uint8Array;
}>): Promise<string> {
  const recipientPublicKey = await resolveRecipientPublicKey(params.credentials);
  const envelope = sealEncryptedDataKeyEnvelopeV1({
    dataKey: params.dataEncryptionKey,
    recipientPublicKey,
    randomBytes: getRandomBytes,
  });
  return encodeBase64(envelope, 'base64');
}

type ArtifactStoredContentCodec = Readonly<{
  mode: 'plain' | 'e2ee';
  dataEncryptionKey: string;
  encode(value: unknown): string;
  decode(value: string): unknown | null;
}>;

export const ARTIFACT_ENCRYPTION_MATERIAL_UNAVAILABLE =
  'artifact_encryption_material_unavailable' as const;

export class ArtifactEncryptionMaterialUnavailableError extends Error {
  readonly code = ARTIFACT_ENCRYPTION_MATERIAL_UNAVAILABLE;

  constructor() {
    super('Artifact encryption material is unavailable');
    this.name = 'ArtifactEncryptionMaterialUnavailableError';
  }
}

function requireArtifactE2eeCredentials(credentials: StoredCredentials): Credentials {
  if (!credentials.encryption) {
    throw new ArtifactEncryptionMaterialUnavailableError();
  }
  return credentials;
}

async function createArtifactStoredContentCodec(params: Readonly<{
  credentials: StoredCredentials;
  accountMode: ConnectedServiceAccountEncryptionMode;
  requirePlainWriteCompatibility: () => Promise<void>;
}>): Promise<ArtifactStoredContentCodec> {
  if (params.accountMode === 'plain') {
    await params.requirePlainWriteCompatibility();
    return {
      mode: 'plain',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      encode: encodePlainArtifactStoredContent,
      decode: decodePlainArtifactStoredContent,
    };
  }
  if (params.accountMode === 'unknown') {
    throw Object.assign(new Error('account_encryption_mode_unavailable'), {
      code: 'account_encryption_mode_unavailable',
    });
  }

  const credentials = requireArtifactE2eeCredentials(params.credentials);
  const dataEncryptionKey = getRandomBytes(32);
  return {
    mode: 'e2ee',
    dataEncryptionKey: await sealArtifactDataEncryptionKey({ credentials, dataEncryptionKey }),
    encode: (value) => encodeBase64(encryptWithDataKey(value, dataEncryptionKey), 'base64'),
    decode: (value) => decryptWithDataKey(decodeBase64(value), dataEncryptionKey),
  };
}

async function openArtifactStoredContentCodec(params: Readonly<{
  credentials: StoredCredentials;
  storedDataEncryptionKey: string;
}>): Promise<ArtifactStoredContentCodec> {
  if (isPlainArtifactDataKeyMarker(params.storedDataEncryptionKey)) {
    return {
      mode: 'plain',
      dataEncryptionKey: ARTIFACT_PLAIN_DATA_KEY_MARKER,
      encode: encodePlainArtifactStoredContent,
      decode: decodePlainArtifactStoredContent,
    };
  }

  const credentials = requireArtifactE2eeCredentials(params.credentials);
  const dataEncryptionKey = await openArtifactDataEncryptionKey({
    credentials,
    encryptedDataEncryptionKeyBase64: params.storedDataEncryptionKey,
  });
  if (!dataEncryptionKey) {
    throw new ArtifactEncryptionMaterialUnavailableError();
  }
  return {
    mode: 'e2ee',
    dataEncryptionKey: params.storedDataEncryptionKey,
    encode: (value) => encodeBase64(encryptWithDataKey(value, dataEncryptionKey), 'base64'),
    decode: (value) => decryptWithDataKey(decodeBase64(value), dataEncryptionKey),
  };
}

function decodeArtifactStoredContent(
  codec: ArtifactStoredContentCodec,
  value: string,
): unknown | null {
  try {
    const decoded = codec.decode(value);
    if (decoded === null) {
      throw new ArtifactEncryptionMaterialUnavailableError();
    }
    return decoded;
  } catch (error) {
    if (error instanceof ArtifactEncryptionMaterialUnavailableError) throw error;
    throw new ArtifactEncryptionMaterialUnavailableError();
  }
}

function buildApprovalArtifactHeader(request: ApprovalRequestV1): Record<string, unknown> {
  const sessionId = typeof request.createdBy.sessionId === 'string' ? request.createdBy.sessionId.trim() : '';
  return {
    v: 1,
    kind: 'approval_request.v1',
    title: request.summary,
    approvalStatus: request.status,
    actionId: request.actionId,
    ...(sessionId ? { sessions: [sessionId], sessionId } : {}),
  };
}

function parseApprovalStatus(value: unknown): ApprovalRequestV1['status'] | null {
  if (
    value === 'open'
    || value === 'approved'
    || value === 'rejected'
    || value === 'executed'
    || value === 'failed'
    || value === 'canceled'
  ) {
    return value;
  }
  return null;
}

function parseApprovalActionId(value: unknown): ActionId | null {
  return typeof value === 'string' && ActionIdSchema.safeParse(value).success ? value as ActionId : null;
}

function normalizeArtifactServerId(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function decryptApprovalArtifactHeader(
  storedHeader: string,
  codec: ArtifactStoredContentCodec,
): Record<string, unknown> | null {
  const header = decodeArtifactStoredContent(codec, storedHeader) as Record<string, unknown> | null;
  return header && (
    header.kind === 'approval_request.v1'
    || header.kind === 'target_action_approval.v1'
    || header.kind === 'execution_run_host_action_approval.v1'
  ) ? header : null;
}

function buildTargetActionApprovalArtifactHeader(request: TargetActionApprovalRequestV1): Record<string, unknown> {
  return {
    v: 1, kind: 'target_action_approval.v1', title: request.summary,
    approvalStatus: request.status, qualifiedActionId: request.qualifiedActionId,
    subjectFingerprint: request.subjectFingerprint,
  };
}

function readTargetActionApprovalBody(body: string, codec: ArtifactStoredContentCodec): TargetActionApprovalRequestV1 | null {
  const decrypted = decodeArtifactStoredContent(codec, body) as { body?: unknown } | null;
  if (typeof decrypted?.body !== 'string') return null;
  try {
    const parsed = TargetActionApprovalRequestV1Schema.safeParse(JSON.parse(decrypted.body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function buildExecutionRunHostActionApprovalArtifactHeader(
  request: ExecutionRunHostActionApprovalRequestV1,
): Record<string, unknown> {
  return {
    v: 1,
    kind: 'execution_run_host_action_approval.v1',
    title: request.summary,
    approvalStatus: request.status,
    actionId: request.actionId,
    sessionId: request.sessionId,
    sessions: [request.sessionId],
    runId: request.runId,
    subjectFingerprint: request.subjectFingerprint,
    serverId: request.serverId,
  };
}

function readExecutionRunHostActionApprovalBody(
  body: string,
  codec: ArtifactStoredContentCodec,
): ExecutionRunHostActionApprovalRequestV1 | null {
  const decrypted = decodeArtifactStoredContent(codec, body) as { body?: unknown } | null;
  if (typeof decrypted?.body !== 'string') return null;
  try {
    const parsed = ExecutionRunHostActionApprovalRequestV1Schema.safeParse(JSON.parse(decrypted.body));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function approvalArtifactMatchesServerScope(
  header: Record<string, unknown>,
  serverId: string | null,
): boolean {
  if (!serverId) return true;
  return normalizeArtifactServerId(header.serverId) === serverId;
}

async function fetchArtifactFullRecord(params: Readonly<{
  credentials: StoredCredentials;
  artifactId: string;
  signal?: AbortSignal;
}>): Promise<ArtifactFullRecord | null> {
  const response = await axios.get(`${resolveServerHttpBaseUrl()}/v1/artifacts/${encodeURIComponent(params.artifactId)}`, {
    headers: {
      ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      Authorization: `Bearer ${params.credentials.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15_000,
    ...(params.signal ? { signal: params.signal } : {}),
    validateStatus: () => true,
  });

  if (response.status === 404) return null;
  if (response.status === 500 && response.data?.error === 'Failed to get artifact') {
    throw new ArtifactEncryptionMaterialUnavailableError();
  }
  if (response.status < 200 || response.status >= 300) return null;

  const record = response.data as Record<string, unknown>;
  if (typeof record.id !== 'string') return null;
  if (typeof record.header !== 'string') return null;
  if (typeof record.body !== 'string') return null;
  if (typeof record.dataEncryptionKey !== 'string') return null;

  return {
    id: record.id,
    header: record.header,
    headerVersion: Number((record as any).headerVersion),
    body: record.body,
    bodyVersion: Number((record as any).bodyVersion),
    dataEncryptionKey: record.dataEncryptionKey,
    seq: Number((record as any).seq),
    createdAt: Number((record as any).createdAt),
    updatedAt: Number((record as any).updatedAt),
  };
}

async function fetchArtifactListRecords(params: Readonly<{
  credentials: StoredCredentials;
  limit: number;
}>): Promise<readonly ArtifactListRecord[]> {
  const url = new URL('/v1/artifacts', resolveServerHttpBaseUrl());
  url.searchParams.set('limit', String(params.limit));
  const response = await axios.get(url.toString(), {
    headers: {
      ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      Authorization: `Bearer ${params.credentials.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15_000,
    validateStatus: () => true,
  });

  if (response.status === 500 && response.data?.error === 'Failed to get artifacts') {
    throw new ArtifactEncryptionMaterialUnavailableError();
  }
  if (response.status < 200 || response.status >= 300 || !Array.isArray(response.data)) return [];

  return response.data.flatMap((raw: unknown) => {
    if (!raw || typeof raw !== 'object') return [];
    const record = raw as Record<string, unknown>;
    if (typeof record.id !== 'string') return [];
    if (typeof record.header !== 'string') return [];
    if (typeof record.dataEncryptionKey !== 'string') return [];
    return [{
      id: record.id,
      header: record.header,
      headerVersion: Number(record.headerVersion),
      dataEncryptionKey: record.dataEncryptionKey,
      seq: Number(record.seq),
      createdAt: Number(record.createdAt),
      updatedAt: Number(record.updatedAt),
    }];
  });
}

async function createArtifact(params: Readonly<{
  credentials: StoredCredentials;
  request: ArtifactCreateRequest;
  signal?: AbortSignal;
}>): Promise<{ ok: true; artifactId: string } | { ok: false }> {
  const response = await axios.post(`${resolveServerHttpBaseUrl()}/v1/artifacts`, params.request, {
    headers: {
      ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      Authorization: `Bearer ${params.credentials.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15_000,
    ...(params.signal ? { signal: params.signal } : {}),
    validateStatus: () => true,
  });

  if (response.status < 200 || response.status >= 300) return { ok: false };
  const record = response.data as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : params.request.id;
  return { ok: true, artifactId: id };
}

async function updateArtifact(params: Readonly<{
  credentials: StoredCredentials;
  artifactId: string;
  request: ArtifactUpdateRequest;
  storageMode: ArtifactStoredContentCodec['mode'];
  requirePlainWriteCompatibility: () => Promise<void>;
  signal?: AbortSignal;
}>): Promise<
  | { ok: true }
  | { ok: false; errorCode: 'not_found' | 'version_mismatch' | 'update_failed'; error: string }
> {
  if (params.storageMode === 'plain') {
    await params.requirePlainWriteCompatibility();
  }
  const response = await axios.post(`${resolveServerHttpBaseUrl()}/v1/artifacts/${encodeURIComponent(params.artifactId)}`, params.request, {
    headers: {
      ...buildCurrentAccountStoredContentCompatibilityHttpHeaders(),
      Authorization: `Bearer ${params.credentials.token}`,
      'Content-Type': 'application/json',
    },
    timeout: 15_000,
    ...(params.signal ? { signal: params.signal } : {}),
    validateStatus: () => true,
  });

  if (response.status === 404) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
  if (response.status < 200 || response.status >= 300) return { ok: false, errorCode: 'update_failed', error: 'artifact_update_failed' };

  const parsed = response.data as any;
  if (parsed && parsed.success === true) return { ok: true };
  if (parsed && parsed.success === false && parsed.error === 'version-mismatch') {
    return { ok: false, errorCode: 'version_mismatch', error: 'artifact_version_mismatch' };
  }
  return { ok: false, errorCode: 'update_failed', error: 'artifact_update_failed' };
}

export function createCliApprovalsArtifactStore(params: Readonly<{
  credentials: StoredCredentials;
  getAccountEncryptionMode?: () => Promise<ConnectedServiceAccountEncryptionMode>;
  getServerFeaturesSnapshot?: () => Promise<CliServerFeaturesSnapshot | undefined>;
}>): Readonly<{
  approvalsList: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsList']>;
  approvalsCreate: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsCreate']>;
  approvalsGet: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsGet']>;
  approvalsUpdate: NonNullable<import('@happier-dev/protocol').ActionExecutorDeps['approvalsUpdate']>;
  targetActionApprovalsCreate(args: Readonly<{ request: TargetActionApprovalRequestV1 }>): Promise<Readonly<{ artifactId: string }>>;
  targetActionApprovalsGet(args: Readonly<{ artifactId: string }>): Promise<TargetActionApprovalRequestV1 | null>;
  targetActionApprovalsUpdate(args: Readonly<{ artifactId: string; request: TargetActionApprovalRequestV1 }>): Promise<Readonly<{ ok: true } | { ok: false; errorCode: string; error: string }>>;
  executionRunHostActionApprovalsCreate(args: Readonly<{ request: ExecutionRunHostActionApprovalRequestV1 }>): Promise<Readonly<{ artifactId: string }>>;
  executionRunHostActionApprovalsGet(args: Readonly<{ artifactId: string }>): Promise<ExecutionRunHostActionApprovalRequestV1 | null>;
  executionRunHostActionApprovalsUpdate(args: Readonly<{ artifactId: string; request: ExecutionRunHostActionApprovalRequestV1 }>): Promise<Readonly<{ ok: true } | { ok: false; errorCode: string; error: string }>>;
  promptLibraryStore: PromptLibraryArtifactStore;
}> {
  const accountModeApi = params.getAccountEncryptionMode
    ? null
    : createConnectedServiceCredentialApi(params.credentials);
  const getAccountEncryptionMode = params.getAccountEncryptionMode
    ?? (() => accountModeApi!.getAccountEncryptionMode());
  const requirePlainWriteCompatibility = async (): Promise<void> => {
    await requireCurrentAccountStoredContentServerCompatibility({
      ...(params.getServerFeaturesSnapshot
        ? { resolveSnapshot: params.getServerFeaturesSnapshot }
        : {}),
    });
  };

  return {
    promptLibraryStore: {
      read: async (artifactId, options) => {
        options?.signal?.throwIfAborted();
        const artifact = await fetchArtifactFullRecord({
          credentials: params.credentials,
          artifactId,
          ...(options?.signal ? { signal: options.signal } : {}),
        });
        options?.signal?.throwIfAborted();
        if (!artifact) return null;
        const codec = await openArtifactStoredContentCodec({
          credentials: params.credentials,
          storedDataEncryptionKey: artifact.dataEncryptionKey,
        });
        options?.signal?.throwIfAborted();
        const header = decodeArtifactStoredContent(codec, artifact.header);
        const bodyEnvelope = decodeArtifactStoredContent(codec, artifact.body) as { body?: unknown } | null;
        if (!header || typeof header !== 'object' || Array.isArray(header)) return null;
        return {
          id: artifact.id,
          header: header as Readonly<Record<string, unknown>>,
          body: typeof bodyEnvelope?.body === 'string' ? bodyEnvelope.body : null,
        };
      },
      create: async ({ header, body, signal }) => {
        signal?.throwIfAborted();
        const artifactId = randomUUID();
        const codec = await createArtifactStoredContentCodec({
          credentials: params.credentials,
          accountMode: await getAccountEncryptionMode(),
          requirePlainWriteCompatibility,
        });
        signal?.throwIfAborted();
        const created = await createArtifact({
          credentials: params.credentials,
          request: {
            id: artifactId,
            header: codec.encode(header),
            body: codec.encode({ body }),
            dataEncryptionKey: codec.dataEncryptionKey,
          },
          ...(signal ? { signal } : {}),
        });
        signal?.throwIfAborted();
        if (!created.ok) throw new Error('artifact_create_failed');
        return created.artifactId;
      },
      update: async ({ artifactId, header, body, signal }) => {
        signal?.throwIfAborted();
        const artifact = await fetchArtifactFullRecord({
          credentials: params.credentials,
          artifactId,
          ...(signal ? { signal } : {}),
        });
        signal?.throwIfAborted();
        if (!artifact) throw new Error('artifact_not_found');
        const codec = await openArtifactStoredContentCodec({
          credentials: params.credentials,
          storedDataEncryptionKey: artifact.dataEncryptionKey,
        });
        signal?.throwIfAborted();
        const updated = await updateArtifact({
          credentials: params.credentials,
          artifactId,
          request: {
            header: codec.encode(header),
            expectedHeaderVersion: artifact.headerVersion,
            body: codec.encode({ body }),
            expectedBodyVersion: artifact.bodyVersion,
          },
          storageMode: codec.mode,
          requirePlainWriteCompatibility,
          ...(signal ? { signal } : {}),
        });
        signal?.throwIfAborted();
        if (!updated.ok) throw Object.assign(new Error(updated.error), { code: updated.errorCode });
      },
    },
    executionRunHostActionApprovalsCreate: async ({ request }) => {
      const artifactId = randomUUID();
      const codec = await createArtifactStoredContentCodec({
        credentials: params.credentials,
        accountMode: await getAccountEncryptionMode(),
        requirePlainWriteCompatibility,
      });
      const res = await createArtifact({ credentials: params.credentials, request: {
        id: artifactId,
        header: codec.encode(buildExecutionRunHostActionApprovalArtifactHeader(request)),
        body: codec.encode({ body: JSON.stringify(request) }),
        dataEncryptionKey: codec.dataEncryptionKey,
      } });
      if (!res.ok) throw new Error('execution_run_host_action_approval_create_failed');
      return { artifactId: res.artifactId };
    },
    executionRunHostActionApprovalsGet: async ({ artifactId }) => {
      const artifact = await fetchArtifactFullRecord({ credentials: params.credentials, artifactId });
      if (!artifact) return null;
      const codec = await openArtifactStoredContentCodec({
        credentials: params.credentials,
        storedDataEncryptionKey: artifact.dataEncryptionKey,
      });
      const header = decryptApprovalArtifactHeader(artifact.header, codec);
      if (header?.kind !== 'execution_run_host_action_approval.v1') return null;
      const parsed = readExecutionRunHostActionApprovalBody(artifact.body, codec);
      if (!parsed
        || parsed.subjectFingerprint !== header.subjectFingerprint
        || parsed.actionId !== header.actionId
        || parsed.sessionId !== header.sessionId
        || parsed.runId !== header.runId
        || parsed.serverId !== header.serverId) return null;
      return parsed;
    },
    executionRunHostActionApprovalsUpdate: async ({ artifactId, request }) => {
      const artifact = await fetchArtifactFullRecord({ credentials: params.credentials, artifactId });
      if (!artifact) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
      const codec = await openArtifactStoredContentCodec({
        credentials: params.credentials,
        storedDataEncryptionKey: artifact.dataEncryptionKey,
      });
      const existingHeader = decryptApprovalArtifactHeader(artifact.header, codec);
      if (existingHeader?.kind !== 'execution_run_host_action_approval.v1'
        || existingHeader.subjectFingerprint !== request.subjectFingerprint) {
        return { ok: false, errorCode: 'subject_mismatch', error: 'execution_run_host_action_approval_subject_mismatch' };
      }
      const existing = readExecutionRunHostActionApprovalBody(artifact.body, codec);
      if (!existing || !executionRunHostActionApprovalSubjectsEqual(existing, request)) {
        return { ok: false, errorCode: 'subject_mismatch', error: 'execution_run_host_action_approval_subject_mismatch' };
      }
      if (executionRunHostActionApprovalRequestsEqual(existing, request)) return { ok: true };
      if (existing.status !== 'open'
        || (request.status !== 'approved' && request.status !== 'rejected' && request.status !== 'canceled')
        || request.updatedAtMs < existing.updatedAtMs) {
        return { ok: false, errorCode: 'invalid_transition', error: 'execution_run_host_action_approval_invalid_transition' };
      }
      const updated = await updateArtifact({ credentials: params.credentials, artifactId, request: {
        header: codec.encode(buildExecutionRunHostActionApprovalArtifactHeader(request)),
        expectedHeaderVersion: artifact.headerVersion,
        body: codec.encode({ body: JSON.stringify(request) }),
        expectedBodyVersion: artifact.bodyVersion,
      }, storageMode: codec.mode, requirePlainWriteCompatibility });
      return updated.ok ? { ok: true } : updated;
    },
    targetActionApprovalsCreate: async ({ request }) => {
      const artifactId = randomUUID();
      const codec = await createArtifactStoredContentCodec({
        credentials: params.credentials,
        accountMode: await getAccountEncryptionMode(),
        requirePlainWriteCompatibility,
      });
      const res = await createArtifact({ credentials: params.credentials, request: {
        id: artifactId,
        header: codec.encode(buildTargetActionApprovalArtifactHeader(request)),
        body: codec.encode({ body: JSON.stringify(request) }),
        dataEncryptionKey: codec.dataEncryptionKey,
      } });
      if (!res.ok) throw new Error('target_action_approval_create_failed');
      return { artifactId: res.artifactId };
    },
    targetActionApprovalsGet: async ({ artifactId }) => {
      const artifact = await fetchArtifactFullRecord({ credentials: params.credentials, artifactId });
      if (!artifact) return null;
      const codec = await openArtifactStoredContentCodec({
        credentials: params.credentials,
        storedDataEncryptionKey: artifact.dataEncryptionKey,
      });
      const header = decryptApprovalArtifactHeader(artifact.header, codec);
      if (header?.kind !== 'target_action_approval.v1') return null;
      const parsed = readTargetActionApprovalBody(artifact.body, codec);
      if (!parsed || parsed.subjectFingerprint !== header.subjectFingerprint || parsed.qualifiedActionId !== header.qualifiedActionId) return null;
      return parsed;
    },
    targetActionApprovalsUpdate: async ({ artifactId, request }) => {
      const artifact = await fetchArtifactFullRecord({ credentials: params.credentials, artifactId });
      if (!artifact) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
      const codec = await openArtifactStoredContentCodec({
        credentials: params.credentials,
        storedDataEncryptionKey: artifact.dataEncryptionKey,
      });
      const existing = decryptApprovalArtifactHeader(artifact.header, codec);
      if (existing?.kind !== 'target_action_approval.v1' || existing.subjectFingerprint !== request.subjectFingerprint) return { ok: false, errorCode: 'subject_mismatch', error: 'target_action_approval_subject_mismatch' };
      const existingRequest = readTargetActionApprovalBody(artifact.body, codec);
      if (!existingRequest || !targetActionApprovalSubjectsEqual(existingRequest, request)) {
        return { ok: false, errorCode: 'subject_mismatch', error: 'target_action_approval_subject_mismatch' };
      }
      if (targetActionApprovalRequestsEqual(existingRequest, request)) return { ok: true };
      if (existingRequest.status !== 'open'
        || (request.status !== 'approved' && request.status !== 'rejected' && request.status !== 'canceled')
        || request.updatedAtMs < existingRequest.updatedAtMs) {
        return { ok: false, errorCode: 'invalid_transition', error: 'target_action_approval_invalid_transition' };
      }
      const updated = await updateArtifact({ credentials: params.credentials, artifactId, request: {
        header: codec.encode(buildTargetActionApprovalArtifactHeader(request)), expectedHeaderVersion: artifact.headerVersion,
        body: codec.encode({ body: JSON.stringify(request) }), expectedBodyVersion: artifact.bodyVersion,
      }, storageMode: codec.mode, requirePlainWriteCompatibility });
      return updated.ok ? { ok: true } : updated;
    },
    approvalsList: async ({ status, limit, serverId }) => {
      const items: ApprovalQueueListItemV1[] = [];
      const normalizedServerId = typeof serverId === 'string' && serverId.trim().length > 0 ? serverId.trim() : null;
      const maxItems = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(1, Math.min(100, Math.trunc(limit))) : 32;
      const serverLimit = Math.max(maxItems, Math.min(500, maxItems * 5));
      const records = await fetchArtifactListRecords({ credentials: params.credentials, limit: serverLimit });

      for (const artifact of records) {
        if (items.length >= maxItems) break;
        const codec = await openArtifactStoredContentCodec({
          credentials: params.credentials,
          storedDataEncryptionKey: artifact.dataEncryptionKey,
        });
        const header = decryptApprovalArtifactHeader(artifact.header, codec);
        if (!header) continue;
        if (header.kind !== 'approval_request.v1') continue;
        if (typeof status === 'string' && header.approvalStatus !== status) continue;
        const headerServerId = normalizeArtifactServerId(header.serverId);
        if (!approvalArtifactMatchesServerScope(header, normalizedServerId)) continue;

        const actionId = parseApprovalActionId(header.actionId);
        const summary = typeof header.title === 'string' ? header.title : '';
        const approvalStatus = parseApprovalStatus(header.approvalStatus);
        if (!actionId || !summary || !approvalStatus) continue;

        items.push({
          artifactId: artifact.id,
          status: approvalStatus,
          actionId,
          summary,
          ...(typeof header.sessionId === 'string' && header.sessionId.trim().length > 0 ? { sessionId: header.sessionId.trim() } : {}),
          ...(headerServerId ? { serverId: headerServerId } : {}),
          updatedAtMs: Number.isFinite(artifact.updatedAt) ? artifact.updatedAt : 0,
        });
      }

      return {
        items,
        queryPlan: {
          kind: 'bounded_approval_artifact_header_scan',
          backingStore: 'ArtifactStore',
          boundedBy: `GET /v1/artifacts?limit=${serverLimit}`,
          serverLimit,
          hydratedTranscripts: false,
        },
      };
    },

    approvalsCreate: async ({ request, serverId }) => {
      const artifactId = randomUUID();
      const codec = await createArtifactStoredContentCodec({
        credentials: params.credentials,
        accountMode: await getAccountEncryptionMode(),
        requirePlainWriteCompatibility,
      });

      const header = {
        ...buildApprovalArtifactHeader(request),
        ...(typeof serverId === 'string' && serverId.trim().length > 0 ? { serverId: serverId.trim() } : {}),
      };

      const res = await createArtifact({
        credentials: params.credentials,
        request: {
          id: artifactId,
          header: codec.encode(header),
          body: codec.encode({ body: JSON.stringify(request) }),
          dataEncryptionKey: codec.dataEncryptionKey,
        },
      });
      if (!res.ok) {
        throw new Error('approval_request_create_failed');
      }
      return { artifactId: res.artifactId };
    },

    approvalsGet: async ({ artifactId, serverId }) => {
      const artifact = await fetchArtifactFullRecord({ credentials: params.credentials, artifactId });
      if (!artifact) return null;

      const codec = await openArtifactStoredContentCodec({
        credentials: params.credentials,
        storedDataEncryptionKey: artifact.dataEncryptionKey,
      });

      const header = decryptApprovalArtifactHeader(artifact.header, codec);
      if (!header || !approvalArtifactMatchesServerScope(header, normalizeArtifactServerId(serverId))) return null;

      const decrypted = decodeArtifactStoredContent(codec, artifact.body) as { body?: unknown } | null;
      const body = typeof decrypted?.body === 'string' ? decrypted.body : null;
      if (!body) return null;

      try {
        const parsed = ApprovalRequestV1Schema.safeParse(JSON.parse(body));
        return parsed.success ? parsed.data : null;
      } catch {
        return null;
      }
    },

    approvalsUpdate: async ({ artifactId, request, serverId }) => {
      const artifact = await fetchArtifactFullRecord({ credentials: params.credentials, artifactId });
      if (!artifact) return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };

      const codec = await openArtifactStoredContentCodec({
        credentials: params.credentials,
        storedDataEncryptionKey: artifact.dataEncryptionKey,
      });

      const existingHeader = decryptApprovalArtifactHeader(artifact.header, codec);
      if (!existingHeader || !approvalArtifactMatchesServerScope(existingHeader, normalizeArtifactServerId(serverId))) {
        return { ok: false, errorCode: 'not_found', error: 'artifact_not_found' };
      }

      const header = {
        ...buildApprovalArtifactHeader(request),
        ...(typeof serverId === 'string' && serverId.trim().length > 0 ? { serverId: serverId.trim() } : {}),
      };
      const updated = await updateArtifact({
        credentials: params.credentials,
        artifactId,
        request: {
          header: codec.encode(header),
          expectedHeaderVersion: artifact.headerVersion,
          body: codec.encode({ body: JSON.stringify(request) }),
          expectedBodyVersion: artifact.bodyVersion,
        },
        storageMode: codec.mode,
        requirePlainWriteCompatibility,
      });

      if (updated.ok) return { ok: true };
      return { ok: false, errorCode: updated.errorCode, error: updated.error };
    },
  };
}
