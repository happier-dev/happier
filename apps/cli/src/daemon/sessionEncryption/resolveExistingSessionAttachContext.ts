import { resolveAgentIdFromSessionMetadata } from '@happier-dev/agents';
import { SESSION_METADATA_LAYOUT_VERSION_V1, SessionOwnerMetadataEnvelopeV1Schema, SessionSharedMetadataV1Schema, projectSessionOwnerCompatibilityViewV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { readAcpConfiguredBackendV1FromMetadata } from '@happier-dev/protocol/sessions/metadata/acpConfiguredBackendV1';
import { readLegacyConfiguredAcpBackendId } from '@happier-dev/protocol/backends/targets/compat/customAcp';
import { resolveLinkedExternalSessionMetadataV1 } from '@happier-dev/protocol/sessions/external/linked-metadata';
import type { BackendTargetRefV1, SessionOwnerMetadataEnvelopeV1, SessionOwnerMetadataV1, AccountEncryptionCurrentnessResponse, SessionReportsToV1, SessionAwarenessOriginV1 } from '@happier-dev/protocol';
import type { SessionAttachFilePayload } from '@/agent/runtime/sessionAttachPayload';
import type { AgentState, Metadata } from '@/api/types';
import type { StoredCredentials } from '@/persistence';
import { encodeBase64 } from '@/api/encryption';
import { resolveCurrentExternalSessionAgentIdentity } from '@/api/session/external/linking/qualifiedLinkIdentityRegistry';
import { resolveVendorResumeIdForExistingSession } from '@/daemon/spawn/resolveVendorResumeIdForExistingSession';
import {
  decryptStoredSessionPayload,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
  tryDecryptSessionMetadata,
  tryDecryptSessionOwnerMetadata,
} from '@/session/transport/encryption/sessionEncryptionContext';
import { readSessionMetadataLayoutVersion } from '@/session/metadata/sessionMetadataLayout';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { tryParseJsonRecord } from '@/utils/tryParseJsonRecord';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { readPendingExecutionRunIds } from '@/api/session/pendingQueueState';
import { isSessionEncryptionModeAllowedByEffectiveClientRequirement } from '@/settings/accountSettings/resolveEffectiveClientEncryptionRequirement';

const EXISTING_SESSION_ATTACH_DETAIL_CONCURRENCY = 4;
let activeExistingSessionAttachDetailReads = 0;
const pendingExistingSessionAttachDetailReadSlots: Array<() => void> = [];

export type ExistingSessionAttachContext = Readonly<{
  ok: true;
  attachPayload: SessionAttachFilePayload;
  metadata: Metadata | null;
  vendorResumeId: string | null;
  linkedVendorResumeId?: string;
  backendTarget: BackendTargetRefV1 | null;
  ownerMetadata?: SessionOwnerMetadataV1;
  existingSessionWorkspacePath?: string;
}>;

export type ExistingSessionAttachContextFailureReason =
  | 'missingSessionId'
  | 'missingToken'
  | 'fetchFailed'
  | 'sessionNotFound'
  | 'missingCredentials'
  | 'invalidEncryptionKey'
  | 'invalidOwnerMetadata'
  | 'linkedResumeIdentityUnavailable'
  | 'clientE2eeRequired';

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
  credentials: StoredCredentials | null;
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
  credentials: StoredCredentials | null;
}>): AgentState | null | undefined {
  const rawAgentState = typeof params.rawSession.agentState === 'string' ? params.rawSession.agentState.trim() : '';
  if (!rawAgentState) return null;

  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  try {
    const value = mode === 'plain'
      ? decryptStoredSessionPayload({
          mode,
          ctx: null,
          value: rawAgentState,
        })
      : (() => {
          if (!params.credentials?.encryption) return undefined;
          const context = resolveSessionEncryptionContextFromCredentials(
            params.credentials,
            params.rawSession,
          );
          return context
            ? decryptStoredSessionPayload({
                mode,
                ctx: context,
                value: rawAgentState,
              })
            : undefined;
        })();
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    return value as AgentState;
  } catch {
    return undefined;
  }
}

function buildAttachSnapshot(params: Readonly<{
  rawSession: Readonly<{
    reportsTo?: SessionReportsToV1;
    origin?: SessionAwarenessOriginV1;
    metadata?: unknown;
    metadataVersion?: unknown;
    agentState?: unknown;
    agentStateVersion?: unknown;
    dataEncryptionKey?: unknown;
    encryptionMode?: unknown;
    metadataLayoutVersion?: unknown;
    pendingExecutionRunIds?: unknown;
  }>;
  credentials: StoredCredentials | null;
  metadataRecord: Record<string, unknown> | null;
  ownerMetadata?: SessionOwnerMetadataV1;
  ownerMetadataEnvelope?: SessionOwnerMetadataEnvelopeV1;
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
  const pendingExecutionRunIds = readPendingExecutionRunIds(params.rawSession);

  return {
    ...(params.rawSession.reportsTo ? { reportsTo: params.rawSession.reportsTo } : {}),
    ...(params.rawSession.origin ? { origin: params.rawSession.origin } : {}),
    metadata: params.metadataRecord as Metadata,
    metadataVersion,
    agentState,
    agentStateVersion,
    ...(pendingExecutionRunIds ? { pendingExecutionRunIds } : {}),
    ...(params.ownerMetadata && params.ownerMetadataEnvelope
      ? {
        metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
        ownerMetadata: params.ownerMetadata,
        ownerMetadataEnvelope: params.ownerMetadataEnvelope,
      }
      : {}),
  };
}

function resolveExistingSessionBackendTarget(metadataRecord: Record<string, unknown> | null): BackendTargetRefV1 | null {
  if (!metadataRecord) return null;

  const configuredBackendId = readAcpConfiguredBackendV1FromMetadata(metadataRecord)?.backendId
    ?? readLegacyConfiguredAcpBackendId(metadataRecord.flavor);
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

async function buildExistingSessionAttachContext(params: Readonly<{
  rawSession: Readonly<{
    metadata?: unknown;
    metadataVersion?: unknown;
    agentState?: unknown;
    agentStateVersion?: unknown;
    dataEncryptionKey?: unknown;
    encryptionMode?: unknown;
    metadataLayoutVersion?: unknown;
    ownerMetadata?: unknown;
    seq?: unknown;
    pendingExecutionRunIds?: unknown;
  }>;
  credentials: StoredCredentials | null;
  accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
}>): Promise<ExistingSessionAttachContext | ExistingSessionAttachContextFailure> {
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  if (!isSessionEncryptionModeAllowedByEffectiveClientRequirement(mode)) {
    return { ok: false, reason: 'clientE2eeRequired' };
  }
  const metadataLayoutVersion = readSessionMetadataLayoutVersion(
    params.rawSession.metadataLayoutVersion,
  );
  const metadataRecord = tryReadExistingSessionMetadataRecord({
    rawSession: params.rawSession,
    credentials: params.credentials,
  });
  const parsedOwnerMetadataEnvelope =
    metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
      ? SessionOwnerMetadataEnvelopeV1Schema.safeParse(
          params.rawSession.ownerMetadata,
        )
      : null;
  const ownerMetadataEnvelope = parsedOwnerMetadataEnvelope?.success
    ? parsedOwnerMetadataEnvelope.data
    : null;
  const ownerMetadata = metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
    && params.credentials
    ? tryDecryptSessionOwnerMetadata({
      credentials: params.credentials,
      rawSession: params.rawSession,
      accountEncryptionMode: params.accountEncryptionCurrentness.mode,
    })
    : null;
  if (
    metadataLayoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1
    && (!ownerMetadataEnvelope || !ownerMetadata || !metadataRecord)
  ) {
    return { ok: false, reason: 'invalidOwnerMetadata' };
  }
  const ownerLocalRuntimeMetadata = ownerMetadata && metadataRecord
    ? projectSessionOwnerCompatibilityViewV1({
      sharedMetadata: SessionSharedMetadataV1Schema.parse(metadataRecord),
      ownerMetadata,
    })
    : null;
  const authorityMetadataRecord = ownerLocalRuntimeMetadata ?? metadataRecord;
  const backendTarget = resolveExistingSessionBackendTarget(authorityMetadataRecord);
  const linkedSessionResolution = resolveLinkedExternalSessionMetadataV1(
    authorityMetadataRecord,
  );
  if (
    !linkedSessionResolution.ok
    && linkedSessionResolution.error !== 'linked_session_not_found'
  ) {
    return { ok: false, reason: 'linkedResumeIdentityUnavailable' };
  }
  const hasLinkedExternalSession = linkedSessionResolution.ok;
  const needsCurrentLinkedAgentIdentity = hasLinkedExternalSession
    && linkedSessionResolution.source !== 'released';
  const linkedExternalSession = linkedSessionResolution.ok
    ? linkedSessionResolution.linkedSession
    : null;
  const linkedSessionCurrentAgent = needsCurrentLinkedAgentIdentity && linkedExternalSession
    ? await resolveCurrentExternalSessionAgentIdentity(linkedExternalSession.agentId).catch(() => null)
    : null;
  const vendorResumeId = resolveVendorResumeIdForExistingSession({
    agent: undefined,
    credentials: params.credentials,
    metadataRecord: authorityMetadataRecord,
    rawSession: params.rawSession,
    linkedSessionCurrentAgent,
  });
  if (hasLinkedExternalSession && !vendorResumeId) {
    return { ok: false, reason: 'linkedResumeIdentityUnavailable' };
  }
  const linkedVendorResumeId = hasLinkedExternalSession
    ? vendorResumeId ?? undefined
    : undefined;
  const existingSessionWorkspacePath = ownerMetadata?.workspace?.path?.trim() || null;
  const lastObservedMessageSeq = resolveLastObservedMessageSeq(params.rawSession);
  const snapshot = buildAttachSnapshot({
    rawSession: params.rawSession,
    credentials: params.credentials,
    metadataRecord,
    ...(ownerMetadata && ownerMetadataEnvelope
      ? { ownerMetadata, ownerMetadataEnvelope }
      : {}),
  });
  if (mode === 'plain') {
    return {
      ok: true,
      metadata: authorityMetadataRecord as Metadata | null,
      attachPayload: {
        v: 2,
        encryptionMode: 'plain',
        ...(lastObservedMessageSeq !== undefined ? { lastObservedMessageSeq } : {}),
        ...(snapshot ? { snapshot } : {}),
      },
      backendTarget,
      vendorResumeId,
      ...(linkedVendorResumeId ? { linkedVendorResumeId } : {}),
      ...(ownerMetadata ? { ownerMetadata } : {}),
      ...(existingSessionWorkspacePath
        ? { existingSessionWorkspacePath }
        : {}),
    };
  }

  if (!params.credentials?.encryption) return { ok: false, reason: 'missingCredentials' };

  const ctx = resolveSessionEncryptionContextFromCredentials(params.credentials, params.rawSession);
  if (!ctx || ctx.encryptionKey.length !== 32) return { ok: false, reason: 'invalidEncryptionKey' };

  return {
    ok: true,
    metadata: authorityMetadataRecord as Metadata | null,
    attachPayload: {
      v: 2,
      encryptionMode: 'e2ee',
      encryptionKeyBase64: encodeBase64(ctx.encryptionKey, 'base64'),
      encryptionVariant: ctx.encryptionVariant,
      ...(lastObservedMessageSeq !== undefined ? { lastObservedMessageSeq } : {}),
      ...(snapshot ? { snapshot } : {}),
    },
    backendTarget,
    vendorResumeId,
    ...(linkedVendorResumeId ? { linkedVendorResumeId } : {}),
    ...(ownerMetadata ? { ownerMetadata } : {}),
    ...(existingSessionWorkspacePath
      ? { existingSessionWorkspacePath }
      : {}),
  };
}

export async function resolveExistingSessionAttachContext(_params: Readonly<{
  token: string;
  sessionId: string;
  credentials: StoredCredentials | null;
}>): Promise<ExistingSessionAttachContext | ExistingSessionAttachContextFailure> {
  const token = normalizeString(_params.token);
  const sessionId = normalizeString(_params.sessionId);
  if (!sessionId) return { ok: false, reason: 'missingSessionId' };
  if (!token) return { ok: false, reason: 'missingToken' };

  try {
    const [raw, accountEncryptionCurrentness] = await Promise.all([
      withExistingSessionAttachDetailReadSlot(
        () => fetchSessionByIdCompat({ token, sessionId, reason: 'manual-recovery' }),
      ),
      fetchAccountEncryptionCurrentness({ token }),
    ]);
    if (!raw) return { ok: false, reason: 'sessionNotFound' };

    return await buildExistingSessionAttachContext({
      rawSession: raw,
      credentials: _params.credentials,
      accountEncryptionCurrentness,
    });
  } catch {
    return { ok: false, reason: 'fetchFailed' };
  }
}
