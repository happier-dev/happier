import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { readSessionModelSelectionV2FromMetadata } from '@happier-dev/agents/session/state/metadataReaders';
import { SessionModelSelectionIntentV1Schema } from '@happier-dev/protocol/providers/model-selection';

import {
  prepareSessionMetadataTuplePatchV1,
  updateSessionMetadataTupleWithRetry,
  type SessionMetadataLegacyOwnerMutationRequestV1,
  type SessionMetadataLegacyOwnerTupleMutationSnapshotV1,
  type SessionMetadataOwnerTupleMutationSnapshotV1,
  type SessionMetadataSharedEditorTupleMutationSnapshotV1,
  type SessionMetadataTupleMutationSnapshotV1,
  type SessionMetadataTupleMutationV1,
  type SessionMetadataTupleMutationCryptoV1,
} from '@happier-dev/cli-common/sessionMetadata';
import { createPlainSessionOwnerMetadataEnvelopeV1, projectSessionMetadataAgentVocabularyWriteCompatibilityV1, projectSessionOwnerCompatibilityViewV1, SESSION_METADATA_LAYOUT_VERSION_V1, StoredSessionOwnerMetadataEnvelopeV1Schema, StoredSessionSharedMetadataV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { openSessionOwnerMetadataEnvelopeV1, sealSessionOwnerMetadataEnvelopeV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataEnvelopesV1';
import { SessionDisplayProjectionV1Schema, sealSessionSharedDisplayEnvelopeV1Sync, sealSessionOwnerDisplayEnvelopeV1,
  openSessionSharedDisplayEnvelopeV1Sync, openSessionOwnerDisplayEnvelopeV1, type SessionOwnerDisplayV1 } from '@happier-dev/protocol';
import { readSessionAccessProjectionRoleV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import { createAccountScopedCryptoMaterialSnapshotV1 } from '@happier-dev/protocol/crypto/accountScopedCipher';
import { convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1 } from '@happier-dev/protocol/account/encryptionKeyFingerprintV1';
import { projectSessionMetadataForWire, normalizeSessionMetadataForRead } from '@happier-dev/protocol/sessions/metadata/terminalMetadata';
import type { SessionMetadataInactiveModelIntentExpectationV1, SessionMetadataInactiveModelIntentOwnerPatchV1, AccountScopedCryptoMaterial, SessionOwnerMetadataEnvelopeV1, SessionOwnerMetadataV1, SessionMetadataOwnerPatchV1, SessionMetadataPublisherPreconditionV1, SessionMetadataTuplePatchV1, AccountEncryptionCurrentnessResponse } from '@happier-dev/protocol';
import type {
  SessionTeamCredentialBindingIntentListV1,
  SessionTeamCredentialBindingMutationOperationV1,
} from '@happier-dev/protocol/teams';
import type { SessionTeamCredentialBindingMetadataPatchV1 } from '@happier-dev/protocol/teams';

import type { AgentState, Metadata } from '@/api/types';
import { deriveActivitySummaryFromAgentState } from '@/api/session/deriveActivitySummaryFromAgentState';
import { SessionActionConfirmationsV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionActionConfirmationsV1';
import type { StoredCredentials } from '@/persistence';
import { requireAccountEncryptionCredentials } from '@/api/client/encryptionKey';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { classifyServerEndpointError } from '@/api/client/classifyServerEndpointError';
import {
  decryptStoredSessionPayload,
  encryptStoredSessionPayload,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
  tryDecryptSessionOwnerMetadata,
  type SessionStoredContentCryptoContext,
  type SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  fetchSessionByIdCompat,
  patchSessionMetadata,
  patchSessionMetadataEnvelopeTuple,
} from '@/session/transport/http/sessionsHttp';
import { delay, delayUnrefAbortable } from '@/utils/time';
import { logger } from '@/ui/logger';
import { readSessionMetadataLayoutVersion } from './sessionMetadataLayout';

type MetadataUpdateErrorCode =
  | 'unsupported'
  | 'unknown_error'
  | 'conflict'
  | 'metadata_privacy_upgrade_required'
  | 'session_publisher_authority_lost'
  | 'session_team_credential_binding_rejected'
  | 'session_active'
  | 'session_not_found';

function createMetadataUpdateError(
  message: string,
  code: MetadataUpdateErrorCode,
): Error & { code: MetadataUpdateErrorCode; retryable: false } {
  return Object.assign(new Error(message), { code, retryable: false as const });
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return Object.fromEntries(Object.entries(value));
}

function readNonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number'
    && Number.isSafeInteger(value)
    && value >= 0
    ? value
    : null;
}

function resolveLegacyMaxAttempts(value: number | undefined): number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
      ? Math.min(10, Math.floor(value))
      : 6;
}

function isAmbiguousTupleCommitError(error: unknown): boolean {
  const failure = classifyServerEndpointError(error);
  // An HTTP failure can follow a committed tuple, just like a lost response.
  // The tuple owner reconciles exact results and replays only an unchanged
  // source within its existing budget and publisher-currentness checks.
  // Explicit 409 responses are handled by the tuple protocol above; an
  // unexpected conflict envelope must retain its protocol failure.
  return failure.retryable && failure.kind !== 'generation_conflict';
}

export type SessionMetadataEnvelopeTupleSnapshot =
  SessionMetadataOwnerTupleMutationSnapshotV1<Metadata, AgentState>;

export type SessionMetadataLegacyOwnerSnapshot =
  SessionMetadataLegacyOwnerTupleMutationSnapshotV1<
    Metadata,
    AgentState
  >;

export type SessionMetadataTupleWriterSnapshot =
  | SessionMetadataLegacyOwnerSnapshot
  | SessionMetadataEnvelopeTupleSnapshot;

export type SessionMetadataSharedEditorSnapshot =
  SessionMetadataSharedEditorTupleMutationSnapshotV1<Metadata>;

export type SessionMetadataWriterSnapshot =
  | SessionMetadataTupleWriterSnapshot
  | SessionMetadataSharedEditorSnapshot;

/**
 * The explicit authority a Session metadata tuple write is made under.
 *
 * `owner` carries the Account material required to open and reseal the owner
 * envelope. `shared_editor` deliberately carries none: a shared editor writes
 * only the Session-data-key shared projection the server's `shared_editor`
 * tuple mode accepts, and can never reach owner metadata or full Agent state.
 */
export type SessionMetadataTupleWriteAuthority =
  | Readonly<{
    kind: 'owner';
    credentials: StoredCredentials;
    accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
  }>
  | Readonly<{ kind: 'shared_editor' }>;

export type SessionMetadataMutationCurrentness = Readonly<{
  signal?: AbortSignal;
  assertCurrent?: () => void;
  verifyCurrent?: () => Promise<boolean>;
}>;

export function assertSessionMetadataMutationCurrentness(
  currentness: SessionMetadataMutationCurrentness | undefined,
): void {
  currentness?.assertCurrent?.();
  currentness?.signal?.throwIfAborted();
}

export async function verifySessionMetadataMutationCurrentness(
  currentness: SessionMetadataMutationCurrentness | undefined,
): Promise<void> {
  assertSessionMetadataMutationCurrentness(currentness);
  if (currentness?.verifyCurrent && !await currentness.verifyCurrent()) {
    throw createMetadataUpdateError('Session publisher authority is no longer current', 'session_publisher_authority_lost');
  }
  assertSessionMetadataMutationCurrentness(currentness);
}

async function waitForSessionMetadataRetry(params: Readonly<{
  delayMs: number;
  currentness: SessionMetadataMutationCurrentness | undefined;
}>): Promise<void> {
  assertSessionMetadataMutationCurrentness(params.currentness);
  if (params.currentness?.signal) {
    await delayUnrefAbortable(params.delayMs, params.currentness.signal);
  } else {
    await delay(params.delayMs);
  }
  assertSessionMetadataMutationCurrentness(params.currentness);
}

/** Non-content accepted-selection facts acquired with metadata on this exact CAS attempt. */
export type SessionMetadataMutationContext = Readonly<{
  metadataRevision?: number;
  acceptedTeamCredentialBinding?: SessionTeamCredentialBindingIntentListV1[number] | null;
}>;

type MetadataTupleMutation = SessionMetadataTupleMutationV1<Metadata, AgentState>;
export type SessionMetadataEnvelopeTupleMutation =
  | Exclude<MetadataTupleMutation, { kind: 'metadata' }>
  | (Omit<Extract<MetadataTupleMutation, { kind: 'metadata' }>, 'update'> & Readonly<{
      update: (metadata: Metadata, context?: SessionMetadataMutationContext) => Metadata | Promise<Metadata>;
    }>);

function toSharedTupleSnapshot(
  snapshot: SessionMetadataWriterSnapshot,
): SessionMetadataTupleMutationSnapshotV1<Metadata, AgentState> {
  return snapshot;
}

function fromSharedTupleSnapshot(
  snapshot: SessionMetadataOwnerTupleMutationSnapshotV1<Metadata, AgentState>,
): SessionMetadataEnvelopeTupleSnapshot {
  return snapshot;
}

type LayoutAwareRawSession = Readonly<{
  acceptedTeamCredentialBinding?: SessionTeamCredentialBindingIntentListV1[number] | null;
  metadata: string;
  metadataLayoutVersion?: unknown;
  metadataVersion: number;
  ownerMetadata?: unknown;
  agentState?: unknown;
  agentStateVersion?: unknown;
  encryptionMode?: unknown;
  dataEncryptionKey?: unknown;
  displayProjectionV1?: unknown;
}>;

function readDisplayProjectionField(rawSession: LayoutAwareRawSession) {
  const parsed = SessionDisplayProjectionV1Schema.safeParse(rawSession.displayProjectionV1);
  // A malformed or absent display never invalidates the authoritative full tuple.
  return parsed.success ? { displayProjectionV1: parsed.data } : {};
}

function resolveStoredSessionCryptoContext(params: Readonly<{
  credentials: StoredCredentials;
  rawSession: LayoutAwareRawSession;
  mode: SessionStoredContentEncryptionMode;
}>): SessionStoredContentCryptoContext {
  if (params.mode === 'plain') return { mode: 'plain', ctx: null };
  const context = resolveSessionEncryptionContextFromCredentials(
    params.credentials,
    params.rawSession,
  );
  if (!context) {
    throw createMetadataUpdateError(
      'Account encryption material is unavailable',
      'metadata_privacy_upgrade_required',
    );
  }
  return { mode: 'e2ee', ctx: context };
}

function resolveAccountEncryptionMaterial(
  credentials: StoredCredentials,
): AccountScopedCryptoMaterial {
  const encryption = requireAccountEncryptionCredentials(credentials).encryption;
  return encryption.type === 'legacy'
    ? { type: 'legacy', secret: encryption.secret }
    : { type: 'dataKey', machineKey: encryption.machineKey };
}

function resolveOwnerMigrationCurrentness(params: Readonly<{
  credentials: StoredCredentials;
  accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
}>) {
  if (params.accountEncryptionCurrentness.mode === 'plain') {
    return {
      expectedAccountEncryptionMode: 'plain' as const,
      expectedAccountContentPublicKeyFingerprint: null,
    };
  }
  const encryption =
    requireAccountEncryptionCredentials(params.credentials).encryption;
  const snapshot = createAccountScopedCryptoMaterialSnapshotV1({
    accountEncryptionMode: 'e2ee',
    material: resolveAccountEncryptionMaterial(params.credentials),
    ...(encryption.type === 'dataKey'
      ? { dataKeyPublicKey: encryption.publicKey }
      : {}),
  });
  if (
    params.accountEncryptionCurrentness.contentKeyFingerprint === null
    || convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1(
      snapshot.contentPublicKeyFingerprint,
    )
      !== params.accountEncryptionCurrentness.contentKeyFingerprint
  ) {
    throw createMetadataUpdateError(
      'Account encryption material does not match current Account state',
      'metadata_privacy_upgrade_required',
    );
  }
  return {
    expectedAccountEncryptionMode: 'e2ee' as const,
    expectedAccountContentPublicKeyFingerprint:
      snapshot.contentPublicKeyFingerprint,
  };
}

function encodeSessionOwnerMetadataEnvelope(params: Readonly<{
  credentials: StoredCredentials;
  accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
  ownerMetadata: SessionOwnerMetadataV1;
}>): SessionOwnerMetadataEnvelopeV1 {
  if (params.accountEncryptionMode === 'plain') {
    return createPlainSessionOwnerMetadataEnvelopeV1(
      params.ownerMetadata,
    );
  }
  return sealSessionOwnerMetadataEnvelopeV1({
    material: resolveAccountEncryptionMaterial(params.credentials),
    ownerMetadata: params.ownerMetadata,
    randomBytes: (length) => nodeRandomBytes(length),
  });
}

/** Only crypto and captured authority live here; semantic projection belongs to cli-common. */
function createSessionMetadataTupleCrypto(params: Readonly<{
  cryptoContext: SessionStoredContentCryptoContext;
  readOwnerAuthority?: () => Readonly<{
    credentials: StoredCredentials;
    accountEncryptionMode: AccountEncryptionCurrentnessResponse['mode'];
  }> | null;
}>): SessionMetadataTupleMutationCryptoV1 {
  const requireOwnerAuthority = () => {
    const owner = params.readOwnerAuthority?.();
    if (!owner) throw createMetadataUpdateError('Owner Session metadata material is unavailable', 'metadata_privacy_upgrade_required');
    return owner;
  };
  return {
    encryptPayload: async payload => encryptStoredSessionPayload({ ...params.cryptoContext, payload }),
    encodeOwnerMetadata: ownerMetadata => encodeSessionOwnerMetadataEnvelope({ ...requireOwnerAuthority(), ownerMetadata }),
    encodeSharedDisplay: display => {
      const sealed = sealSessionSharedDisplayEnvelopeV1Sync({
        sessionMode: params.cryptoContext.mode, display,
        encryptPayload: payload => encryptStoredSessionPayload({ ...params.cryptoContext, payload }) });
      if (!sealed.ok) throw createMetadataUpdateError(`Session display encryption unavailable: ${sealed.reason}`, 'metadata_privacy_upgrade_required');
      return sealed.envelope;
    },
    ...(params.readOwnerAuthority ? { encodeOwnerDisplay: (display: SessionOwnerDisplayV1) => {
      const owner = requireOwnerAuthority();
      const sealed = sealSessionOwnerDisplayEnvelopeV1({
        accountMode: owner.accountEncryptionMode, display,
        ...(owner.accountEncryptionMode === 'e2ee' ? { material: resolveAccountEncryptionMaterial(owner.credentials) } : {}),
        randomBytes: length => nodeRandomBytes(length) });
      if (!sealed.ok) throw createMetadataUpdateError(`Owner display encryption unavailable: ${sealed.reason}`, 'metadata_privacy_upgrade_required');
      return sealed.envelope;
    } } : {}),
  };
}

function readLayout0WriterSnapshot(params: Readonly<{
  rawSession: LayoutAwareRawSession;
}> & SessionStoredContentCryptoContext): SessionMetadataLegacyOwnerSnapshot {
  const cryptoContext: SessionStoredContentCryptoContext = params;
  if (
    params.rawSession.metadataLayoutVersion !== undefined
    && params.rawSession.metadataLayoutVersion !== 0
  ) {
    throw createMetadataUpdateError(
      'Session metadata layout changed during legacy mutation',
      'metadata_privacy_upgrade_required',
    );
  }
  const metadataVersion =
    readNonNegativeInteger(params.rawSession.metadataVersion);
  const agentStateVersion =
    readNonNegativeInteger(params.rawSession.agentStateVersion);
  const metadataCiphertext =
    typeof params.rawSession.metadata === 'string'
      ? params.rawSession.metadata
      : '';
  const agentStateCiphertext =
    params.rawSession.agentState === null
      ? null
      : typeof params.rawSession.agentState === 'string'
        ? params.rawSession.agentState
        : undefined;
  if (
    metadataVersion === null
    || agentStateVersion === null
    || metadataVersion >= Number.MAX_SAFE_INTEGER
    || agentStateVersion >= Number.MAX_SAFE_INTEGER
    || metadataCiphertext.length === 0
    || agentStateCiphertext === undefined
    || (
      params.rawSession.ownerMetadata !== null
      && params.rawSession.ownerMetadata !== undefined
    )
  ) {
    throw createMetadataUpdateError(
      'Layout-0 Session metadata source tuple is invalid',
      'metadata_privacy_upgrade_required',
    );
  }
  const metadata = asRecord(decryptStoredSessionPayload({
    ...cryptoContext,
    value: metadataCiphertext,
  }));
  const agentState = agentStateCiphertext === null
    ? null
    : asRecord(decryptStoredSessionPayload({
        ...cryptoContext,
        value: agentStateCiphertext,
      }));
  if (!metadata || (agentStateCiphertext !== null && !agentState)) {
    throw createMetadataUpdateError(
      'Layout-0 Session metadata source payload is invalid',
      'metadata_privacy_upgrade_required',
    );
  }
  const metadataValue = normalizeSessionMetadataForRead(metadata) as Metadata;
  return {
    mode: 'legacy_owner',
    metadataLayoutVersion: 0,
    metadataVersion,
    metadataCiphertext,
    ownerMetadata: null,
    agentStateVersion,
    agentStateCiphertext,
    value: {
      metadata: metadataValue,
      agentState: agentState as AgentState | null,
    },
  };
}

function readLayout1TupleSnapshot(params: Readonly<{
  credentials: StoredCredentials;
  accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
  rawSession: LayoutAwareRawSession;
}> & SessionStoredContentCryptoContext): SessionMetadataEnvelopeTupleSnapshot {
  const cryptoContext: SessionStoredContentCryptoContext = params;
  if (
    readSessionMetadataLayoutVersion(params.rawSession.metadataLayoutVersion)
    !== SESSION_METADATA_LAYOUT_VERSION_V1
  ) {
    throw createMetadataUpdateError(
      'Session metadata layout changed during tuple mutation',
      'metadata_privacy_upgrade_required',
    );
  }
  const metadataVersion = readNonNegativeInteger(params.rawSession.metadataVersion);
  const agentStateVersion = readNonNegativeInteger(params.rawSession.agentStateVersion);
  if (metadataVersion === null || agentStateVersion === null) {
    throw createMetadataUpdateError(
      'Session metadata tuple versions are invalid',
      'metadata_privacy_upgrade_required',
    );
  }

  const sharedPlaintext = decryptStoredSessionPayload({
    ...cryptoContext,
    value: String(params.rawSession.metadata ?? '').trim(),
  });
  const sharedMetadata = StoredSessionSharedMetadataV1Schema.safeParse(sharedPlaintext);
  const ownerMetadata = tryDecryptSessionOwnerMetadata({
    credentials: params.credentials,
    accountEncryptionMode: params.accountEncryptionCurrentness.mode,
    rawSession: params.rawSession,
  });
  const ownerMetadataEnvelope = StoredSessionOwnerMetadataEnvelopeV1Schema.safeParse(
    params.rawSession.ownerMetadata,
  );
  if (
    !sharedMetadata.success
    || !ownerMetadata
    || !ownerMetadataEnvelope.success
  ) {
    throw createMetadataUpdateError(
      'Owner session metadata is unavailable',
      'metadata_privacy_upgrade_required',
    );
  }

  let agentState: AgentState | null = null;
  const rawAgentState = typeof params.rawSession.agentState === 'string'
    ? params.rawSession.agentState.trim()
    : '';
  if (rawAgentState) {
    const decryptedAgentState = asRecord(decryptStoredSessionPayload({
      ...cryptoContext,
      value: rawAgentState,
    }));
    if (!decryptedAgentState) {
      throw createMetadataUpdateError(
        'Session AgentState payload is invalid',
        'metadata_privacy_upgrade_required',
      );
    }
    agentState = decryptedAgentState as AgentState;
  } else if (
    params.rawSession.agentState !== null
    && params.rawSession.agentState !== undefined
  ) {
    throw createMetadataUpdateError(
      'Session AgentState payload is invalid',
      'metadata_privacy_upgrade_required',
    );
  }

  return {
    mode: 'owner',
    metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
    metadataVersion,
    sharedMetadataCiphertext:
      String(params.rawSession.metadata ?? '').trim(),
    ...readDisplayProjectionField(params.rawSession),
    ownerMetadataEnvelope: ownerMetadataEnvelope.data,
    agentStateVersion,
    agentStateCiphertext: rawAgentState || null,
    value: {
      metadata: projectSessionOwnerCompatibilityViewV1({
        sharedMetadata: sharedMetadata.data,
        ownerMetadata,
      }) as Metadata,
      sharedMetadata: sharedMetadata.data,
      ownerMetadata,
      agentState,
    },
  };
}

export function readSessionMetadataEnvelopeTupleSnapshot(params: Readonly<{
  credentials: StoredCredentials;
  accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
  rawSession: LayoutAwareRawSession;
}>): SessionMetadataEnvelopeTupleSnapshot {
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  const cryptoContext = resolveStoredSessionCryptoContext({
    credentials: params.credentials,
    rawSession: params.rawSession,
    mode,
  });
  return readLayout1TupleSnapshot({
    credentials: params.credentials,
    accountEncryptionCurrentness: params.accountEncryptionCurrentness,
    rawSession: params.rawSession,
    ...cryptoContext,
  });
}

/**
 * Reads the layout-1 shared projection a non-owner editor may see and rewrite.
 *
 * It opens only the Session-data-key shared metadata. The owner envelope and
 * full Agent state are not read, because a shared editor holds no Account
 * content key and the server never serves it either value.
 */
export function readSessionMetadataSharedEditorTupleSnapshot(
  params: Readonly<{
    rawSession: LayoutAwareRawSession;
  }> & SessionStoredContentCryptoContext,
): SessionMetadataSharedEditorSnapshot {
  const cryptoContext: SessionStoredContentCryptoContext = params;
  if (
    readSessionMetadataLayoutVersion(params.rawSession.metadataLayoutVersion)
    !== SESSION_METADATA_LAYOUT_VERSION_V1
  ) {
    throw createMetadataUpdateError(
      'Shared-editor Session metadata requires the layout-1 tuple',
      'metadata_privacy_upgrade_required',
    );
  }
  const metadataVersion = readNonNegativeInteger(
    params.rawSession.metadataVersion,
  );
  if (metadataVersion === null) {
    throw createMetadataUpdateError(
      'Session metadata tuple versions are invalid',
      'metadata_privacy_upgrade_required',
    );
  }
  const sharedMetadataCiphertext =
    String(params.rawSession.metadata ?? '').trim();
  const sharedMetadata = StoredSessionSharedMetadataV1Schema.safeParse(
    decryptStoredSessionPayload({
      ...cryptoContext,
      value: sharedMetadataCiphertext,
    }),
  );
  if (!sharedMetadata.success) {
    throw createMetadataUpdateError(
      'Shared Session metadata is unavailable',
      'metadata_privacy_upgrade_required',
    );
  }
  return {
    mode: 'shared_editor',
    metadataLayoutVersion: SESSION_METADATA_LAYOUT_VERSION_V1,
    metadataVersion,
    sharedMetadataCiphertext,
    ...readDisplayProjectionField(params.rawSession),
    value: {
      metadata: sharedMetadata.data as unknown as Metadata,
      sharedMetadata: sharedMetadata.data,
      ownerMetadata: null,
      agentState: null,
    },
  };
}

export function readSessionMetadataTupleWriterSnapshot(params: Readonly<{
  credentials: StoredCredentials;
  accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
  rawSession: LayoutAwareRawSession;
}>): SessionMetadataTupleWriterSnapshot {
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  const layoutVersion = readSessionMetadataLayoutVersion(
    params.rawSession.metadataLayoutVersion,
  );
  if (layoutVersion === 0) {
    const cryptoContext = resolveStoredSessionCryptoContext({
      credentials: params.credentials,
      rawSession: params.rawSession,
      mode,
    });
    return readLayout0WriterSnapshot({
      rawSession: params.rawSession,
      ...cryptoContext,
    });
  }
  if (layoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1) {
    const cryptoContext = resolveStoredSessionCryptoContext({
      credentials: params.credentials,
      rawSession: params.rawSession,
      mode,
    });
    return readLayout1TupleSnapshot({
      credentials: params.credentials,
      accountEncryptionCurrentness: params.accountEncryptionCurrentness,
      rawSession: params.rawSession,
      ...cryptoContext,
    });
  }
  throw createMetadataUpdateError(
    'Unsupported Session metadata layout',
    'metadata_privacy_upgrade_required',
  );
}

/** Read-local availability only; the caller must separately prove current owner material. */
function attachDisplayProjectionAvailability(params: Readonly<{
  snapshot: SessionMetadataTupleWriterSnapshot;
  credentials: StoredCredentials;
  accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
  cryptoContext: SessionStoredContentCryptoContext;
}>): SessionMetadataTupleWriterSnapshot {
  const snapshot = params.snapshot;
  if (snapshot.mode === 'legacy_owner') return snapshot;
  const projection = snapshot.displayProjectionV1;
  const linked = projection?.metadataLayoutVersion === snapshot.metadataLayoutVersion
    && projection.sourceMetadataVersion === snapshot.metadataVersion;
  const shared = linked && openSessionSharedDisplayEnvelopeV1Sync({
    sessionMode: params.cryptoContext.mode, envelope: projection.shared,
    decryptPayload: value => decryptStoredSessionPayload({ ...params.cryptoContext, value }),
  }).ok;
  const owner = linked && openSessionOwnerDisplayEnvelopeV1({
    accountMode: params.accountEncryptionCurrentness.mode, envelope: projection.owner,
    ...(params.accountEncryptionCurrentness.mode === 'e2ee'
      ? { material: resolveAccountEncryptionMaterial(params.credentials) } : {}),
  }).ok;
  return { ...snapshot, displayProjectionV1Availability: { shared, owner } };
}

/**
 * Best-effort maintenance after a direct Account-owner full read. It consumes
 * that exact snapshot, never refetches it before CAS, and records no completion
 * state on refusal: the full read remains usable and a later read can retry.
 */
export async function ensureSessionDisplayProjectionAfterOwnerRead(params: Readonly<{
  credentials: StoredCredentials;
  sessionId: string;
  accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
  rawSession: LayoutAwareRawSession & Readonly<{ effectiveAccess?: unknown; share?: unknown }>;
  signal?: AbortSignal;
}>): Promise<void> {
  if (readSessionAccessProjectionRoleV1(params.rawSession) !== 'owner') return;
  try {
    params.signal?.throwIfAborted();
    // Opening an old envelope is not proof that these credentials match the
    // Account's captured current content key, even when the full fallback opens.
    resolveOwnerMigrationCurrentness(params);
    const cryptoContext = resolveStoredSessionCryptoContext({ ...params,
      mode: resolveSessionStoredContentEncryptionMode(params.rawSession) });
    const initialSnapshot = attachDisplayProjectionAvailability({ ...params, cryptoContext,
      snapshot: readSessionMetadataTupleWriterSnapshot(params) });
    await updateSessionMetadataEnvelopeTupleWithRetry({
      token: params.credentials.token, sessionId: params.sessionId,
      authority: { kind: 'owner', credentials: params.credentials,
        accountEncryptionCurrentness: params.accountEncryptionCurrentness },
      initialSnapshot, mutation: { kind: 'ensureDisplayProjection' }, ...cryptoContext,
      ...(params.signal ? { currentness: { signal: params.signal } } : {}),
    });
  } catch (error) {
    params.signal?.throwIfAborted();
    logger.infoFile('[API] session_display_projection_ensure_unavailable', {
      sessionId: params.sessionId,
      classification: classifyServerEndpointError(error),
    });
  }
}

export async function prepareSessionMetadataTuplePatchForTransaction(
  params: Readonly<{
    credentials: StoredCredentials;
    accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
    rawSession: LayoutAwareRawSession;
    updater: (
      metadata: Record<string, unknown>,
    ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  }>,
): Promise<SessionMetadataOwnerPatchV1> {
  const current = readSessionMetadataTupleWriterSnapshot({
    credentials: params.credentials,
    accountEncryptionCurrentness: params.accountEncryptionCurrentness,
    rawSession: params.rawSession,
  });
  if (current.mode === 'legacy_owner') {
    throw createMetadataUpdateError(
      'External Session metadata is not eligible for tuple conversion',
      'metadata_privacy_upgrade_required',
    );
  }
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  const cryptoContext = resolveStoredSessionCryptoContext({
    credentials: params.credentials,
    rawSession: params.rawSession,
    mode,
  });
  const patch = await prepareSessionMetadataTuplePatchV1<Metadata, AgentState>({
    current,
    mutation: {
      kind: 'metadata',
      update: async (metadata) =>
        await params.updater(metadata as Record<string, unknown>) as Metadata,
    },
    crypto: createSessionMetadataTupleCrypto({ cryptoContext,
      readOwnerAuthority: () => ({ credentials: params.credentials, accountEncryptionMode: params.accountEncryptionCurrentness.mode }) }),
  });
  if (!patch) {
    throw createMetadataUpdateError(
      'External Session link retirement produced no metadata change',
      'metadata_privacy_upgrade_required',
    );
  }
  if (patch.mode !== 'owner') {
    throw createMetadataUpdateError(
      'External Session link retirement requires owner metadata authority',
      'metadata_privacy_upgrade_required',
    );
  }
  return patch;
}

async function updateLegacyMetadataWithHttpRetry(params: Readonly<{
  token: string;
  resolveAuthorizationHeaders?: (request: Readonly<{
    method: 'GET' | 'POST' | 'PATCH'; path: string; body?: unknown;
  }>) => Readonly<Record<string, string>> | null;
  sessionId: string;
  request: SessionMetadataLegacyOwnerMutationRequestV1<
    Metadata,
    AgentState
  >;
  sessionExpectation?:
    SessionMetadataInactiveModelIntentExpectationV1;
  currentness?: SessionMetadataMutationCurrentness;
  maxAttempts: number;
}> & SessionStoredContentCryptoContext): Promise<SessionMetadataLegacyOwnerSnapshot> {
  const cryptoContext: SessionStoredContentCryptoContext = params;
  if (params.request.kind !== 'metadata') {
    throw createMetadataUpdateError(
      'Legacy Session Agent-state mutation requires its socket owner',
      'metadata_privacy_upgrade_required',
    );
  }

  const apply = async (
    request: Extract<
      SessionMetadataLegacyOwnerMutationRequestV1<Metadata, AgentState>,
      Readonly<{ kind: 'metadata' }>
    >,
    attempt: number,
  ): Promise<SessionMetadataLegacyOwnerSnapshot> => {
    assertSessionMetadataMutationCurrentness(params.currentness);
    const wireMetadata =
      projectSessionMetadataForWire(projectSessionMetadataAgentVocabularyWriteCompatibilityV1(
        request.updatedMetadata,
      ));
    const ciphertext = encryptStoredSessionPayload({
      ...cryptoContext,
      payload: wireMetadata,
    });
    assertSessionMetadataMutationCurrentness(params.currentness);
    await verifySessionMetadataMutationCurrentness(params.currentness);
    const result = await patchSessionMetadata({
      token: params.token,
      ...(params.currentness?.signal ? { signal: params.currentness.signal } : {}),
      ...(params.resolveAuthorizationHeaders
        ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
        : {}),
      sessionId: params.sessionId,
      ciphertext,
      expectedVersion: request.current.metadataVersion,
      sessionExpectation: params.sessionExpectation,
    });
    if (result.success) {
      return {
        ...request.current,
        metadataVersion: result.version,
        metadataCiphertext: ciphertext,
        value: {
          ...request.current.value,
          metadata: request.updatedMetadata,
        },
      };
    }
    assertSessionMetadataMutationCurrentness(params.currentness);
    if (result.error === 'session_active') {
      throw createMetadataUpdateError(
        'Session became active before its model intent could be recorded',
        'session_active',
      );
    }
    if (attempt >= params.maxAttempts) {
      throw createMetadataUpdateError(
        'Metadata update conflict',
        'conflict',
      );
    }
    const currentCiphertext = result.current.value;
    const currentMetadata = currentCiphertext === null
      ? null
      : asRecord(decryptStoredSessionPayload({
          ...cryptoContext,
          value: currentCiphertext,
        }));
    if (currentCiphertext === null || !currentMetadata) {
      throw createMetadataUpdateError(
        'Legacy Session metadata conflict snapshot is unavailable',
        'metadata_privacy_upgrade_required',
      );
    }
    const current: SessionMetadataLegacyOwnerSnapshot = {
      ...request.current,
      metadataVersion: result.current.version,
      metadataCiphertext: currentCiphertext,
      value: {
        ...request.current.value,
        metadata: normalizeSessionMetadataForRead(currentMetadata) as Metadata,
      },
    };
    await waitForSessionMetadataRetry({
      delayMs: Math.min(50 * attempt, 250),
      currentness: params.currentness,
    });
    const reapplied = await updateSessionMetadataTupleWithRetry<
      Metadata,
      AgentState
    >({
      initialSnapshot: current,
      mutation: request.mutation,
      crypto: {
        encryptPayload: async () => {
          throw new Error('legacy metadata retry must not build a tuple');
        },
        encodeOwnerMetadata: () => {
          throw new Error('legacy metadata retry must not seal owner metadata');
        },
      },
      commit: async () => {
        throw new Error('legacy metadata retry must not commit a tuple');
      },
      mutateLegacy: async (nextRequest) => {
        if (nextRequest.kind !== 'metadata') {
          throw createMetadataUpdateError(
            'Legacy Session mutation kind changed during retry',
            'metadata_privacy_upgrade_required',
          );
        }
        return await apply(nextRequest, attempt + 1);
      },
    });
    if (reapplied.mode !== 'legacy_owner') {
      throw createMetadataUpdateError(
        'Legacy Session metadata mutation changed layout',
        'metadata_privacy_upgrade_required',
      );
    }
    return reapplied;
  };

  return await apply(params.request, 1);
}

export async function updateSessionMetadataEnvelopeTupleWithRetry(
  params: Readonly<{
    token: string;
    resolveAuthorizationHeaders?: (request: Readonly<{
      method: 'GET' | 'POST' | 'PATCH'; path: string; body?: unknown;
    }>) => Readonly<Record<string, string>> | null;
    authority: SessionMetadataTupleWriteAuthority;
    sessionId: string;
    initialSnapshot: SessionMetadataWriterSnapshot;
    mutation: SessionMetadataEnvelopeTupleMutation;
    projectKey?: string;
    publisherPrecondition?: SessionMetadataPublisherPreconditionV1;
    sessionExpectation?:
      SessionMetadataInactiveModelIntentExpectationV1;
    teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
    acceptedTeamCredentialBinding?: SessionTeamCredentialBindingIntentListV1[number] | null;
    /** Carries validated refreshes and committed binding facts to a retaining writer. */
    onOwnerSnapshotContextChanged?: (admission: Readonly<{
      accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
      acceptedTeamCredentialBinding: NonNullable<Awaited<ReturnType<typeof fetchSessionByIdCompat>>>['acceptedTeamCredentialBinding'];
    }>) => void;
    teamCredentialBindingOperation?: SessionTeamCredentialBindingMutationOperationV1;
    teamVisibilityGrantConsent?: Readonly<{ teamId: string }>;
    mutateLegacy?: (
      request: SessionMetadataLegacyOwnerMutationRequestV1<
        Metadata,
        AgentState
      >,
    ) => Promise<SessionMetadataLegacyOwnerSnapshot>;
    currentness?: SessionMetadataMutationCurrentness;
    maxAttempts?: number;
  }> & SessionStoredContentCryptoContext,
): Promise<SessionMetadataWriterSnapshot> {
  try {
    const cryptoContext: SessionStoredContentCryptoContext = params;
    const owner = params.authority.kind === 'owner' ? params.authority : null;
    if (!owner && params.initialSnapshot.mode !== 'shared_editor') {
      throw createMetadataUpdateError(
        'Owner Session metadata authority is unavailable to a shared editor',
        'metadata_privacy_upgrade_required',
      );
    }
    let accountEncryptionCurrentness = owner?.accountEncryptionCurrentness;
    let activitySummaryV1: SessionMetadataOwnerPatchV1['activitySummaryV1'];
    let sharedActionConfirmationSummaryV1: SessionMetadataOwnerPatchV1['sharedActionConfirmationSummaryV1'];
    let teamCredentialBindings = params.teamCredentialBindings;
    let acceptedTeamCredentialBinding = params.acceptedTeamCredentialBinding;
    const mutation = params.mutation;
    const mutationWithSummary: MetadataTupleMutation = mutation.kind === 'agentState'
      ? {
          ...mutation,
          update: async (previous: AgentState) => {
            const next = await mutation.update(previous);
            const summary = deriveActivitySummaryFromAgentState(next, previous);
            activitySummaryV1 = {
              pendingPermissionRequestCount: summary.pendingPermissionRequestCount,
              pendingUserActionRequestCount: summary.pendingUserActionRequestCount,
              pendingRequestNewestCreatedAt: summary.pendingRequestNewestCreatedAt,
              ...(summary.newUserActionRequiredOccurrences.length ? {
                newUserActionRequiredOccurrences: [...summary.newUserActionRequiredOccurrences],
              } : {}),
            };
            return next;
          },
        }
      : mutation.kind === 'metadata' ? {
          ...mutation,
          update: async (previous: Metadata, metadataRevision?: number) => {
            const next = await mutation.update(previous, { acceptedTeamCredentialBinding, metadataRevision });
            // Recompute on each tuple CAS attempt, from the transition that
            // actually won. Active and inactive model owners share this writer.
            teamCredentialBindings = params.teamCredentialBindings;
            if (!teamCredentialBindings && next.modelSelectionIntentV2 === undefined
              && (previous.modelSelectionIntentV2 !== undefined || acceptedTeamCredentialBinding?.resourceId != null)) {
              const previousIntent = SessionModelSelectionIntentV1Schema.safeParse(previous.modelSelectionIntentV1);
              const nextIntent = SessionModelSelectionIntentV1Schema.safeParse(next.modelSelectionIntentV1);
              const ordinaryIntentChanged = nextIntent.success && (!previousIntent.success
                || JSON.stringify(previousIntent.data) !== JSON.stringify(nextIntent.data));
              const removedTeamIntent = readSessionModelSelectionV2FromMetadata(previous)?.ref.source === 'team_resource';
              if (nextIntent.success && (removedTeamIntent
                || (acceptedTeamCredentialBinding?.resourceId != null && ordinaryIntentChanged))) {
                teamCredentialBindings = [{ v: 1, slot: { kind: 'provider_model' }, resourceId: null }];
              }
            }
            if (previous.actionConfirmationsV1 !== undefined || next.actionConfirmationsV1 !== undefined) {
              const confirmations = next.actionConfirmationsV1 === undefined
                ? null : SessionActionConfirmationsV1Schema.parse(next.actionConfirmationsV1);
              const summary = deriveActivitySummaryFromAgentState(confirmations);
              sharedActionConfirmationSummaryV1 = {
                pendingPermissionRequestCount: summary.pendingPermissionRequestCount,
              };
            }
            return next;
          },
        } : mutation;
    const updated = await updateSessionMetadataTupleWithRetry<
      Metadata,
      AgentState
    >({
      initialSnapshot: toSharedTupleSnapshot(params.initialSnapshot),
      mutation: mutationWithSummary,
      ...(params.projectKey !== undefined ? { projectKey: params.projectKey } : {}),
      crypto: createSessionMetadataTupleCrypto({ cryptoContext,
        ...(owner ? { readOwnerAuthority: () => accountEncryptionCurrentness
          ? { credentials: owner.credentials, accountEncryptionMode: accountEncryptionCurrentness.mode } : null } : {}) }),
      commit: async (patch) => {
        assertSessionMetadataMutationCurrentness(params.currentness);
        let transportPatch:
          | SessionMetadataTuplePatchV1
          | SessionMetadataInactiveModelIntentOwnerPatchV1
          | SessionTeamCredentialBindingMetadataPatchV1 = patch;
        if (params.publisherPrecondition) {
          if (patch.mode !== 'owner' || params.sessionExpectation) {
            throw createMetadataUpdateError(
              'Current-publisher metadata authority applies only to active owner tuple writes',
              'metadata_privacy_upgrade_required',
            );
          }
          transportPatch = {
            ...patch,
            publisherPrecondition: params.publisherPrecondition,
          } satisfies SessionMetadataOwnerPatchV1;
        }
        if (params.sessionExpectation) {
          if (patch.mode !== 'owner') {
            throw createMetadataUpdateError(
              'Inactive Session model intent requires owner metadata authority',
              'metadata_privacy_upgrade_required',
            );
          }
          transportPatch = {
            ...patch,
            mode: 'owner_inactive_model_intent',
            sessionExpectation: params.sessionExpectation,
          } satisfies SessionMetadataInactiveModelIntentOwnerPatchV1;
        }
        if (teamCredentialBindings) {
          if (patch.mode !== 'owner') {
            throw createMetadataUpdateError(
              'Team credential binding requires owner metadata authority',
              'metadata_privacy_upgrade_required',
            );
          }
          transportPatch = {
            ...patch,
            mode: 'owner_team_credential_binding',
            operation: params.teamCredentialBindingOperation ?? 'session.model.set',
            teamCredentialBindings,
            ...(params.teamVisibilityGrantConsent ? { teamVisibilityGrantConsent: params.teamVisibilityGrantConsent } : {}),
            ...(params.sessionExpectation ? { sessionExpectation: params.sessionExpectation } : {}),
          };
        }
        if (activitySummaryV1 && (transportPatch.mode === 'owner' || transportPatch.mode === 'owner_migration')) {
          transportPatch = { ...transportPatch, activitySummaryV1 };
        }
        if (sharedActionConfirmationSummaryV1 && (transportPatch.mode === 'owner'
          || transportPatch.mode === 'owner_migration' || transportPatch.mode === 'shared_editor')) {
          transportPatch = { ...transportPatch, sharedActionConfirmationSummaryV1 };
        }
        await verifySessionMetadataMutationCurrentness(params.currentness);
        const result = await patchSessionMetadataEnvelopeTuple({
          token: params.token,
          ...(params.currentness?.signal ? { signal: params.currentness.signal } : {}),
          ...(params.resolveAuthorizationHeaders
            ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
            : {}),
          sessionId: params.sessionId,
          patch: transportPatch,
        });
        if (result.success) {
          if (teamCredentialBindings && accountEncryptionCurrentness) {
            acceptedTeamCredentialBinding = teamCredentialBindings.find(binding => binding.slot.kind === 'provider_model')
              ?? acceptedTeamCredentialBinding;
            params.onOwnerSnapshotContextChanged?.({ accountEncryptionCurrentness, acceptedTeamCredentialBinding });
          }
          // A shared-editor commit never carries an Agent-state version because
          // the server's shared-editor tuple mode does not write that value.
          if (transportPatch.mode === 'shared_editor') {
            return {
              result: 'success' as const,
              metadataVersion: result.sharedMetadata.version,
            };
          }
          if (!result.agentState) {
            throw createMetadataUpdateError(
              'Session AgentState tuple version is unavailable',
              'metadata_privacy_upgrade_required',
            );
          }
          return {
              result: 'success' as const,
              metadataVersion: result.sharedMetadata.version,
              agentStateVersion: result.agentState.version,
            };
        }
        if (result.error === 'session_active') {
          throw createMetadataUpdateError(
            'Session became active before its model intent could be recorded',
            'session_active',
          );
        }
        if (result.error === 'session_publisher_authority_lost') {
          throw createMetadataUpdateError(
            'Session publisher authority was superseded before metadata commit',
            'session_publisher_authority_lost',
          );
        }
        if (result.error === 'session_team_credential_binding_rejected') {
          throw Object.assign(
            createMetadataUpdateError(
              'Team credential binding was rejected by current Session policy',
              'session_team_credential_binding_rejected',
            ),
            { reason: result.reason },
          );
        }
        return { result: 'conflict' as const };
      },
      refreshAfterConflict: async () => {
        await verifySessionMetadataMutationCurrentness(params.currentness);
        if (!owner) {
          const sharedRaw = await fetchSessionByIdCompat({
            token: params.token,
            ...(params.currentness?.signal ? { signal: params.currentness.signal } : {}),
            ...(params.resolveAuthorizationHeaders
              ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
              : {}),
            sessionId: params.sessionId,
            reason: 'waitForMetadataUpdate',
          });
          assertSessionMetadataMutationCurrentness(params.currentness);
          if (!sharedRaw) {
            throw createMetadataUpdateError(
              'Session not found',
              'session_not_found',
            );
          }
          if (
            resolveSessionStoredContentEncryptionMode(sharedRaw) !== params.mode
          ) {
            throw createMetadataUpdateError(
              'Session encryption context changed during tuple mutation',
              'metadata_privacy_upgrade_required',
            );
          }
          return readSessionMetadataSharedEditorTupleSnapshot({
            rawSession: sharedRaw,
            ...cryptoContext,
          });
        }
        if (owner.credentials.token !== params.token) {
          throw createMetadataUpdateError(
            'Current Account credentials do not match the Session owner',
            'metadata_privacy_upgrade_required',
          );
        }
        const [authoritativeRaw, refreshedAccountCurrentness] =
          await Promise.all([
            fetchSessionByIdCompat({
              token: params.token,
              ...(params.currentness?.signal ? { signal: params.currentness.signal } : {}),
              ...(params.resolveAuthorizationHeaders
                ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
                : {}),
              sessionId: params.sessionId,
              reason: 'waitForMetadataUpdate',
            }),
            fetchAccountEncryptionCurrentness({
              token: params.token,
              ...(params.currentness?.signal ? { signal: params.currentness.signal } : {}),
              ...(params.resolveAuthorizationHeaders
                ? {
                    authorizationHeaders: params.resolveAuthorizationHeaders({
                      method: 'GET', path: '/v1/account/encryption/currentness',
                    }) ?? undefined,
                  }
                : {}),
            }),
          ]);
        assertSessionMetadataMutationCurrentness(params.currentness);
        if (!authoritativeRaw) {
          throw createMetadataUpdateError(
            'Session not found',
            'session_not_found',
          );
        }
        accountEncryptionCurrentness = refreshedAccountCurrentness;
        acceptedTeamCredentialBinding = authoritativeRaw.acceptedTeamCredentialBinding;
        const authoritativeMode =
          resolveSessionStoredContentEncryptionMode(authoritativeRaw);
        const authoritativeContext = resolveStoredSessionCryptoContext({
          credentials: owner.credentials,
          rawSession: authoritativeRaw,
          mode: authoritativeMode,
        });
        const contextChanged = authoritativeMode !== params.mode
          || (
            authoritativeMode === 'e2ee'
            && params.mode === 'e2ee'
            && authoritativeContext.mode === 'e2ee'
            && authoritativeContext.ctx.encryptionVariant
              !== params.ctx.encryptionVariant
          );
        const ensureKeyChanged = params.mutation.kind === 'ensureDisplayProjection'
          && authoritativeContext.mode === 'e2ee' && params.mode === 'e2ee'
          && !Buffer.from(authoritativeContext.ctx.encryptionKey).equals(Buffer.from(params.ctx.encryptionKey));
        if (contextChanged || ensureKeyChanged) {
          throw createMetadataUpdateError(
            'Session encryption context changed during tuple mutation',
            'metadata_privacy_upgrade_required',
          );
        }
        if (params.mutation.kind === 'ensureDisplayProjection') {
          if (readSessionAccessProjectionRoleV1(authoritativeRaw) !== 'owner') {
            throw createMetadataUpdateError('Session owner authority changed during display maintenance', 'metadata_privacy_upgrade_required');
          }
          resolveOwnerMigrationCurrentness({ credentials: owner.credentials,
            accountEncryptionCurrentness: refreshedAccountCurrentness });
        }
        const authoritativeSnapshot = readSessionMetadataTupleWriterSnapshot({
            credentials: owner.credentials,
            accountEncryptionCurrentness: refreshedAccountCurrentness,
            rawSession: authoritativeRaw,
          });
        params.onOwnerSnapshotContextChanged?.({ accountEncryptionCurrentness: refreshedAccountCurrentness,
          acceptedTeamCredentialBinding: authoritativeRaw.acceptedTeamCredentialBinding });
        return toSharedTupleSnapshot(params.mutation.kind === 'ensureDisplayProjection'
          ? attachDisplayProjectionAvailability({ snapshot: authoritativeSnapshot,
            credentials: owner.credentials, accountEncryptionCurrentness: refreshedAccountCurrentness,
            cryptoContext: authoritativeContext }) : authoritativeSnapshot);
      },
      waitBeforeRetry: async ({ attempt }) => {
        await waitForSessionMetadataRetry({
          delayMs: Math.min(50 * attempt, 250),
          currentness: params.currentness,
        });
      },
      isAmbiguousCommitError: isAmbiguousTupleCommitError,
      ...(owner
        ? {
          resolveOwnerMigrationCurrentness: () =>
            resolveOwnerMigrationCurrentness({
              credentials: owner.credentials,
              accountEncryptionCurrentness:
                accountEncryptionCurrentness ?? owner.accountEncryptionCurrentness,
            }),
          mutateLegacy: params.mutateLegacy,
        }
        : {}),
      assertCurrent: () =>
        assertSessionMetadataMutationCurrentness(params.currentness),
      maxAttempts: params.maxAttempts,
    });
    if (updated.mode === 'shared_editor') {
      if (owner) {
        throw createMetadataUpdateError(
          'Owner session metadata mutation changed to shared-editor authority',
          'metadata_privacy_upgrade_required',
        );
      }
      return updated;
    }
    if (!owner) {
      throw createMetadataUpdateError(
        'Shared-editor session metadata mutation changed to owner authority',
        'metadata_privacy_upgrade_required',
      );
    }
    if (updated.mode === 'owner') {
      return fromSharedTupleSnapshot(updated);
    }
    if (updated.mode !== 'legacy_owner') {
      throw createMetadataUpdateError(
        'Unsupported Session metadata mutation authority',
        'metadata_privacy_upgrade_required',
      );
    }
    return updated;
  } catch (error) {
    const superseded = typeof error === 'object'
      && error !== null
      && 'code' in error
      && error.code === 'session_publisher_authority_lost';
    if (params.mutation.kind === 'metadata' && !params.currentness?.signal?.aborted && !superseded) {
      logger.infoFile('[API] session_metadata_update_failed', {
        phase: 'terminal_failure',
        operation: 'update-metadata',
        sessionId: params.sessionId,
      });
    }
    throw error;
  }
}

export async function updateSessionMetadataWithRetry(params: Readonly<{
  token: string;
  resolveAuthorizationHeaders?: (request: Readonly<{
    method: 'GET' | 'POST' | 'PATCH'; path: string; body?: unknown;
  }>) => Readonly<Record<string, string>> | null;
  credentials: StoredCredentials;
  accountEncryptionCurrentness?: AccountEncryptionCurrentnessResponse;
  sessionId: string;
  rawSession: LayoutAwareRawSession;
  /** Accepted non-content Project relationship, written only by the owner tuple. */
  projectKey?: string;
  updater: (
    metadata: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  expectedMetadataRevision?: number;
  sessionExpectation?:
    SessionMetadataInactiveModelIntentExpectationV1;
  teamCredentialBindings?: SessionTeamCredentialBindingIntentListV1;
  teamCredentialBindingOperation?: SessionTeamCredentialBindingMutationOperationV1;
  teamVisibilityGrantConsent?: Readonly<{ teamId: string }>;
  currentness?: SessionMetadataMutationCurrentness;
  maxAttempts?: number;
}>): Promise<{ version: number; metadata: Record<string, unknown> }> {
  await verifySessionMetadataMutationCurrentness(params.currentness);
  const accountEncryptionCurrentness = params.accountEncryptionCurrentness
    ?? await fetchAccountEncryptionCurrentness({
      token: params.token,
      ...(params.currentness?.signal ? { signal: params.currentness.signal } : {}),
      ...(params.resolveAuthorizationHeaders
        ? {
            authorizationHeaders: params.resolveAuthorizationHeaders({
              method: 'GET', path: '/v1/account/encryption/currentness',
            }) ?? undefined,
          }
        : {}),
    });
  assertSessionMetadataMutationCurrentness(params.currentness);
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  const cryptoContext = resolveStoredSessionCryptoContext({
    credentials: params.credentials,
    rawSession: params.rawSession,
    mode,
  });
  let initialSnapshot = readSessionMetadataTupleWriterSnapshot({
    credentials: params.credentials,
    accountEncryptionCurrentness,
    rawSession: params.rawSession,
  });
  if (params.teamCredentialBindings && initialSnapshot.mode === 'legacy_owner') {
    throw createMetadataUpdateError(
      'Team credential binding requires Session metadata layout v1',
      'metadata_privacy_upgrade_required',
    );
  }
  // Migration has its own strict wire shape. Publish the accepted relationship
  // only after the canonical migration has produced a layout-one owner tuple.
  if (params.projectKey !== undefined && initialSnapshot.mode === 'legacy_owner') {
    const migrated = await updateSessionMetadataEnvelopeTupleWithRetry({
      token: params.token,
      ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
      authority: { kind: 'owner', credentials: params.credentials, accountEncryptionCurrentness },
      sessionId: params.sessionId, ...cryptoContext, initialSnapshot,
      mutation: { kind: 'ownerMigration' }, currentness: params.currentness, maxAttempts: params.maxAttempts,
    });
    if (migrated.mode !== 'owner') {
      throw createMetadataUpdateError('Project publication requires owner metadata authority', 'metadata_privacy_upgrade_required');
    }
    initialSnapshot = migrated;
  }
  assertSessionMetadataMutationCurrentness(params.currentness);
  const updated = await updateSessionMetadataEnvelopeTupleWithRetry({
    token: params.token,
    ...(params.resolveAuthorizationHeaders
      ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
      : {}),
    authority: {
      kind: 'owner',
      credentials: params.credentials,
      accountEncryptionCurrentness,
    },
    sessionId: params.sessionId,
    ...cryptoContext,
    initialSnapshot,
    ...(params.projectKey !== undefined ? { projectKey: params.projectKey } : {}),
    currentness: params.currentness,
    sessionExpectation: params.sessionExpectation,
    teamCredentialBindings: params.teamCredentialBindings,
    teamCredentialBindingOperation: params.teamCredentialBindingOperation,
    teamVisibilityGrantConsent: params.teamVisibilityGrantConsent,
    mutation: {
      kind: 'metadata',
      ...(params.expectedMetadataRevision !== undefined ? { expectedMetadataRevision: params.expectedMetadataRevision } : {}),
      update: async (metadata) =>
        await params.updater(metadata) as Metadata,
    },
    mutateLegacy: async (request) =>
      await updateLegacyMetadataWithHttpRetry({
        token: params.token,
        ...(params.resolveAuthorizationHeaders
          ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders }
          : {}),
        sessionId: params.sessionId,
        ...cryptoContext,
        request,
        sessionExpectation: params.sessionExpectation,
        currentness: params.currentness,
        maxAttempts: resolveLegacyMaxAttempts(params.maxAttempts),
      }),
    maxAttempts: params.maxAttempts,
  });
  return {
    version: updated.metadataVersion,
    metadata: updated.value.metadata,
  };
}
