import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { readAcpConfiguredBackendV1FromMetadata, type BackendTargetRefV1 } from '@happier-dev/protocol';
import type { SessionAttachFilePayload } from '@/agent/runtime/sessionAttachPayload';
import type { AgentState, Metadata } from '@/api/types';
import type { Credentials } from '@/persistence';
import { encodeBase64 } from '@/api/encryption';
import { resolveVendorResumeIdForExistingSession } from '@/daemon/spawn/resolveVendorResumeIdForExistingSession';
import {
  decryptStoredSessionPayload,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
  tryDecryptSessionMetadata,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { tryParseJsonRecord } from '@/utils/tryParseJsonRecord';

const EXISTING_SESSION_ATTACH_DETAIL_CONCURRENCY = 4;
let activeExistingSessionAttachDetailReads = 0;
const pendingExistingSessionAttachDetailReadSlots: Array<() => void> = [];

export type ExistingSessionAttachContext = Readonly<{
  ok: true;
  attachPayload: SessionAttachFilePayload;
  vendorResumeId: string | null;
  backendTarget: BackendTargetRefV1 | null;
}>;

export type ExistingSessionAttachContextFailureReason =
  | 'missingSessionId'
  | 'missingToken'
  | 'fetchFailed'
  | 'sessionNotFound'
  | 'missingCredentials'
  | 'invalidEncryptionKey';

export type ExistingSessionAttachContextFailure = Readonly<{
  ok: false;
  reason: ExistingSessionAttachContextFailureReason;
}>;

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function releaseExistingSessionAttachDetailReadSlot(): void {
  activeExistingSessionAttachDetailReads = Math.max(0, activeExistingSessionAttachDetailReads - 1);
  const next = pendingExistingSessionAttachDetailReadSlots.shift();
  if (!next) return;
  activeExistingSessionAttachDetailReads += 1;
  next();
}

async function withExistingSessionAttachDetailReadSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (activeExistingSessionAttachDetailReads < EXISTING_SESSION_ATTACH_DETAIL_CONCURRENCY) {
    activeExistingSessionAttachDetailReads += 1;
  } else {
    await new Promise<void>((resolve) => {
      pendingExistingSessionAttachDetailReadSlots.push(resolve);
    });
  }

  try {
    return await fn();
  } finally {
    releaseExistingSessionAttachDetailReadSlot();
  }
}

function resolveLastObservedMessageSeq(rawSession: Readonly<{ seq?: unknown }>): number | undefined {
  const seq = rawSession.seq;
  return typeof seq === 'number' && Number.isInteger(seq) && seq >= 0 ? seq : undefined;
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null;
}

function tryReadExistingSessionMetadataRecord(params: Readonly<{
  rawSession: Readonly<{ metadata?: unknown; dataEncryptionKey?: unknown; encryptionMode?: unknown }>;
  credentials: Credentials | null;
}>): Record<string, unknown> | null {
  const rawMetadata = typeof params.rawSession.metadata === 'string' ? params.rawSession.metadata.trim() : '';
  if (!rawMetadata) return null;
  if (params.rawSession.encryptionMode === 'plain') {
    return tryParseJsonRecord(rawMetadata);
  }
  if (!params.credentials) return null;
  return tryDecryptSessionMetadata({
    credentials: params.credentials,
    rawSession: params.rawSession,
  });
}

function tryReadExistingSessionAgentState(params: Readonly<{
  rawSession: Readonly<{ agentState?: unknown; dataEncryptionKey?: unknown; encryptionMode?: unknown }>;
  credentials: Credentials | null;
}>): AgentState | null | undefined {
  const rawAgentState = typeof params.rawSession.agentState === 'string' ? params.rawSession.agentState.trim() : '';
  if (!rawAgentState) return null;

  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  if (mode === 'e2ee' && !params.credentials) return undefined;

  try {
    const value = decryptStoredSessionPayload({
      mode,
      ctx: mode === 'e2ee'
        ? resolveSessionEncryptionContextFromCredentials(params.credentials!, params.rawSession)
        : { encryptionKey: new Uint8Array(32), encryptionVariant: 'dataKey' },
      value: rawAgentState,
    });
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as AgentState;
  } catch {
    return undefined;
  }
}

function buildAttachSnapshot(params: Readonly<{
  rawSession: Readonly<{
    metadata?: unknown;
    metadataVersion?: unknown;
    agentState?: unknown;
    agentStateVersion?: unknown;
    dataEncryptionKey?: unknown;
    encryptionMode?: unknown;
  }>;
  credentials: Credentials | null;
  metadataRecord: Record<string, unknown> | null;
}>): SessionAttachFilePayload['snapshot'] | undefined {
  const metadataVersion = readNonNegativeInteger(params.rawSession.metadataVersion);
  const agentStateVersion = readNonNegativeInteger(params.rawSession.agentStateVersion);
  if (!params.metadataRecord || metadataVersion === null || agentStateVersion === null) {
    return undefined;
  }

  const agentState = tryReadExistingSessionAgentState({
    rawSession: params.rawSession,
    credentials: params.credentials,
  });
  if (agentState === undefined) return undefined;

  return {
    metadata: params.metadataRecord as Metadata,
    metadataVersion,
    agentState,
    agentStateVersion,
  };
}

function readConfiguredAcpBackendIdFromFlavor(metadata: Record<string, unknown>): string | null {
  const flavor = typeof metadata.flavor === 'string' ? metadata.flavor.trim() : '';
  if (!flavor.startsWith('acp:')) return null;
  const backendId = flavor.slice(4).trim();
  return backendId || null;
}

function resolveExistingSessionBackendTarget(metadataRecord: Record<string, unknown> | null): BackendTargetRefV1 | null {
  if (!metadataRecord) return null;

  const configuredBackendId = readAcpConfiguredBackendV1FromMetadata(metadataRecord)?.backendId
    ?? readConfiguredAcpBackendIdFromFlavor(metadataRecord);
  if (configuredBackendId) {
    return {
      kind: 'configuredAcpBackend',
      backendId: configuredBackendId,
    };
  }

  const agentId = resolveAgentIdFromSessionMetadata(metadataRecord);
  if (!agentId) {
    return null;
  }

  return {
    kind: 'builtInAgent',
    agentId,
  };
}

function buildExistingSessionAttachContext(params: Readonly<{
  rawSession: Readonly<{
    metadata?: unknown;
    metadataVersion?: unknown;
    agentState?: unknown;
    agentStateVersion?: unknown;
    dataEncryptionKey?: unknown;
    encryptionMode?: unknown;
    seq?: unknown;
  }>;
  credentials: Credentials | null;
}>): ExistingSessionAttachContext | ExistingSessionAttachContextFailure {
  const metadataRecord = tryReadExistingSessionMetadataRecord({
    rawSession: params.rawSession,
    credentials: params.credentials,
  });
  const backendTarget = resolveExistingSessionBackendTarget(metadataRecord);
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  const lastObservedMessageSeq = resolveLastObservedMessageSeq(params.rawSession);
  const snapshot = buildAttachSnapshot({
    rawSession: params.rawSession,
    credentials: params.credentials,
    metadataRecord,
  });
  if (mode === 'plain') {
    return {
      ok: true,
      attachPayload: {
        v: 2,
        encryptionMode: 'plain',
        ...(lastObservedMessageSeq !== undefined ? { lastObservedMessageSeq } : {}),
        ...(snapshot ? { snapshot } : {}),
      },
      backendTarget,
      vendorResumeId: resolveVendorResumeIdForExistingSession({
        agent: undefined,
        credentials: params.credentials,
        metadataRecord,
        rawSession: params.rawSession,
      }),
    };
  }

  if (!params.credentials) return { ok: false, reason: 'missingCredentials' };

  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, params.rawSession);
  if (ctx.encryptionKey.length !== 32) return { ok: false, reason: 'invalidEncryptionKey' };

  return {
    ok: true,
    attachPayload: {
      v: 2,
      encryptionMode: 'e2ee',
      encryptionKeyBase64: encodeBase64(ctx.encryptionKey, 'base64'),
      encryptionVariant: ctx.encryptionVariant,
      ...(lastObservedMessageSeq !== undefined ? { lastObservedMessageSeq } : {}),
      ...(snapshot ? { snapshot } : {}),
    },
    backendTarget,
    vendorResumeId: resolveVendorResumeIdForExistingSession({
      agent: undefined,
      credentials: params.credentials,
      metadataRecord,
      rawSession: params.rawSession,
    }),
  };
}

export async function resolveExistingSessionAttachContext(_params: Readonly<{
  token: string;
  sessionId: string;
  credentials: Credentials | null;
}>): Promise<ExistingSessionAttachContext | ExistingSessionAttachContextFailure> {
  const token = normalizeString(_params.token);
  const sessionId = normalizeString(_params.sessionId);
  if (!sessionId) return { ok: false, reason: 'missingSessionId' };
  if (!token) return { ok: false, reason: 'missingToken' };

  try {
    const raw = await withExistingSessionAttachDetailReadSlot(
      () => fetchSessionByIdCompat({ token, sessionId, reason: 'manual-recovery' }),
    );
    if (!raw) return { ok: false, reason: 'sessionNotFound' };

    return buildExistingSessionAttachContext({
      rawSession: raw,
      credentials: _params.credentials,
    });
  } catch {
    return { ok: false, reason: 'fetchFailed' };
  }
}
