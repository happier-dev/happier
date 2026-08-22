import { randomBytes as nodeRandomBytes } from 'node:crypto';

import {
  prepareSessionMetadataTuplePatchV1,
  updateSessionMetadataTupleWithRetry,
  type SessionMetadataLegacyOwnerMutationRequestV1,
  type SessionMetadataLegacyOwnerTupleMutationSnapshotV1,
  type SessionMetadataOwnerTupleMutationSnapshotV1,
  type SessionMetadataTupleMutationSnapshotV1,
  type SessionMetadataTupleMutationV1,
} from '@happier-dev/cli-common/sessionMetadata';
import {
  createPlainSessionOwnerMetadataEnvelopeV1,
  createAccountScopedCryptoMaterialSnapshotV1,
  convertContentPublicKeyFingerprintToAccountEncryptionMigrateKeyFingerprintV1,
  openSessionOwnerMetadataEnvelopeV1,
  projectSessionMetadataAgentVocabularyWriteCompatibilityV1,
  projectSessionOwnerCompatibilityViewV1,
  sealSessionOwnerMetadataEnvelopeV1,
  SESSION_METADATA_LAYOUT_VERSION_V1,
  SessionOwnerMetadataEnvelopeV1Schema,
  SessionSharedMetadataV1Schema,
  type SessionMetadataInactiveModelIntentExpectationV1,
  type SessionMetadataInactiveModelIntentOwnerPatchV1,
  type AccountScopedCryptoMaterial,
  type SessionOwnerMetadataEnvelopeV1,
  type SessionOwnerMetadataV1,
  type SessionMetadataOwnerPatchV1,
  type SessionMetadataPublisherPreconditionV1,
  type SessionMetadataTuplePatchV1,
  type AccountEncryptionCurrentnessResponse,
} from '@happier-dev/protocol';

import type { AgentState, Metadata } from '@/api/types';
import type { StoredCredentials } from '@/persistence';
import { requireAccountEncryptionCredentials } from '@/api/client/encryptionKey';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
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
import { readSessionMetadataLayoutVersion } from './sessionMetadataLayout';

type MetadataUpdateErrorCode =
  | 'unsupported'
  | 'unknown_error'
  | 'conflict'
  | 'metadata_privacy_upgrade_required'
  | 'session_publisher_authority_lost'
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
  if (!error || typeof error !== 'object') return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ECONNABORTED' || code === 'ECONNRESET' || code === 'ETIMEDOUT';
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

export type SessionMetadataMutationCurrentness = Readonly<{
  signal?: AbortSignal;
  assertCurrent?: () => void;
}>;

export function assertSessionMetadataMutationCurrentness(
  currentness: SessionMetadataMutationCurrentness | undefined,
): void {
  currentness?.assertCurrent?.();
  currentness?.signal?.throwIfAborted();
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

export type SessionMetadataEnvelopeTupleMutation =
  SessionMetadataTupleMutationV1<Metadata, AgentState>;

function toSharedTupleSnapshot(
  snapshot: SessionMetadataTupleWriterSnapshot,
): SessionMetadataTupleMutationSnapshotV1<Metadata, AgentState> {
  return snapshot;
}

function fromSharedTupleSnapshot(
  snapshot: SessionMetadataOwnerTupleMutationSnapshotV1<Metadata, AgentState>,
): SessionMetadataEnvelopeTupleSnapshot {
  return snapshot;
}

type LayoutAwareRawSession = Readonly<{
  metadata: string;
  metadataLayoutVersion?: unknown;
  metadataVersion: number;
  ownerMetadata?: unknown;
  agentState?: unknown;
  agentStateVersion?: unknown;
  encryptionMode?: unknown;
  dataEncryptionKey?: unknown;
}>;

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
  const metadataValue = metadata as Metadata;
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
  const sharedMetadata = SessionSharedMetadataV1Schema.safeParse(sharedPlaintext);
  const ownerMetadata = tryDecryptSessionOwnerMetadata({
    credentials: params.credentials,
    accountEncryptionMode: params.accountEncryptionCurrentness.mode,
    rawSession: params.rawSession,
  });
  const ownerMetadataEnvelope = SessionOwnerMetadataEnvelopeV1Schema.safeParse(
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
    crypto: {
      encryptPayload: async (payload) =>
        encryptStoredSessionPayload({
          ...cryptoContext,
          payload,
        }),
      encodeOwnerMetadata: (ownerMetadata) =>
        encodeSessionOwnerMetadataEnvelope({
          credentials: params.credentials,
          accountEncryptionMode: params.accountEncryptionCurrentness.mode,
          ownerMetadata,
        }),
    },
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
      projectSessionMetadataAgentVocabularyWriteCompatibilityV1(
        request.updatedMetadata,
      );
    const ciphertext = encryptStoredSessionPayload({
      ...cryptoContext,
      payload: wireMetadata,
    });
    assertSessionMetadataMutationCurrentness(params.currentness);
    const result = await patchSessionMetadata({
      token: params.token,
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
        metadata: currentMetadata as Metadata,
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
    credentials: StoredCredentials;
    accountEncryptionCurrentness: AccountEncryptionCurrentnessResponse;
    sessionId: string;
    initialSnapshot: SessionMetadataTupleWriterSnapshot;
    mutation: SessionMetadataEnvelopeTupleMutation;
    publisherPrecondition?: SessionMetadataPublisherPreconditionV1;
    sessionExpectation?:
      SessionMetadataInactiveModelIntentExpectationV1;
    mutateLegacy?: (
      request: SessionMetadataLegacyOwnerMutationRequestV1<
        Metadata,
        AgentState
      >,
    ) => Promise<SessionMetadataLegacyOwnerSnapshot>;
    currentness?: SessionMetadataMutationCurrentness;
    maxAttempts?: number;
  }> & SessionStoredContentCryptoContext,
): Promise<SessionMetadataTupleWriterSnapshot> {
  const cryptoContext: SessionStoredContentCryptoContext = params;
  let accountEncryptionCurrentness = params.accountEncryptionCurrentness;
  const updated = await updateSessionMetadataTupleWithRetry<
    Metadata,
    AgentState
  >({
    initialSnapshot: toSharedTupleSnapshot(params.initialSnapshot),
    mutation: params.mutation,
    crypto: {
      encryptPayload: async (payload) =>
        encryptStoredSessionPayload({
          ...cryptoContext,
          payload,
        }),
      encodeOwnerMetadata: (ownerMetadata) =>
        encodeSessionOwnerMetadataEnvelope({
          credentials: params.credentials,
          accountEncryptionMode: accountEncryptionCurrentness.mode,
          ownerMetadata,
        }),
    },
    commit: async (patch) => {
      assertSessionMetadataMutationCurrentness(params.currentness);
      let transportPatch:
        | SessionMetadataTuplePatchV1
        | SessionMetadataInactiveModelIntentOwnerPatchV1 = patch;
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
      const result = await patchSessionMetadataEnvelopeTuple({
        token: params.token,
        sessionId: params.sessionId,
        patch: transportPatch,
      });
      if (result.success) {
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
      return { result: 'conflict' as const };
    },
    refreshAfterConflict: async () => {
      assertSessionMetadataMutationCurrentness(params.currentness);
      if (params.credentials.token !== params.token) {
        throw createMetadataUpdateError(
          'Current Account credentials do not match the Session owner',
          'metadata_privacy_upgrade_required',
        );
      }
      const [authoritativeRaw, refreshedAccountCurrentness] =
        await Promise.all([
          fetchSessionByIdCompat({
            token: params.token,
            sessionId: params.sessionId,
            reason: 'waitForMetadataUpdate',
          }),
          fetchAccountEncryptionCurrentness({ token: params.token }),
        ]);
      assertSessionMetadataMutationCurrentness(params.currentness);
      if (!authoritativeRaw) {
        throw createMetadataUpdateError(
          'Session not found',
          'session_not_found',
        );
      }
      accountEncryptionCurrentness = refreshedAccountCurrentness;
      const authoritativeMode =
        resolveSessionStoredContentEncryptionMode(authoritativeRaw);
      const authoritativeContext = resolveStoredSessionCryptoContext({
        credentials: params.credentials,
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
      if (contextChanged) {
        throw createMetadataUpdateError(
          'Session encryption context changed during tuple mutation',
          'metadata_privacy_upgrade_required',
        );
      }
      const authoritativeSnapshot = toSharedTupleSnapshot(
        readSessionMetadataTupleWriterSnapshot({
          credentials: params.credentials,
          accountEncryptionCurrentness,
          rawSession: authoritativeRaw,
        }),
      );
      return authoritativeSnapshot;
    },
    waitBeforeRetry: async ({ attempt }) => {
      await waitForSessionMetadataRetry({
        delayMs: Math.min(50 * attempt, 250),
        currentness: params.currentness,
      });
    },
    isAmbiguousCommitError: isAmbiguousTupleCommitError,
    resolveOwnerMigrationCurrentness: () =>
      resolveOwnerMigrationCurrentness({
        credentials: params.credentials,
        accountEncryptionCurrentness,
      }),
    assertCurrent: () =>
      assertSessionMetadataMutationCurrentness(params.currentness),
    mutateLegacy: params.mutateLegacy,
    maxAttempts: params.maxAttempts,
  });
  if (updated.mode === 'owner') {
    return fromSharedTupleSnapshot(updated);
  }
  if (updated.mode === 'shared_editor') {
    throw createMetadataUpdateError(
      'Owner session metadata mutation changed to shared-editor authority',
      'metadata_privacy_upgrade_required',
    );
  }
  if (updated.mode !== 'legacy_owner') {
    throw createMetadataUpdateError(
      'Unsupported Session metadata mutation authority',
      'metadata_privacy_upgrade_required',
    );
  }
  return updated;
}

export async function updateSessionMetadataWithRetry(params: Readonly<{
  token: string;
  credentials: StoredCredentials;
  accountEncryptionCurrentness?: AccountEncryptionCurrentnessResponse;
  sessionId: string;
  rawSession: LayoutAwareRawSession;
  updater: (
    metadata: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  sessionExpectation?:
    SessionMetadataInactiveModelIntentExpectationV1;
  currentness?: SessionMetadataMutationCurrentness;
  maxAttempts?: number;
}>): Promise<{ version: number; metadata: Record<string, unknown> }> {
  assertSessionMetadataMutationCurrentness(params.currentness);
  const accountEncryptionCurrentness = params.accountEncryptionCurrentness
    ?? await fetchAccountEncryptionCurrentness({ token: params.token });
  assertSessionMetadataMutationCurrentness(params.currentness);
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  const cryptoContext = resolveStoredSessionCryptoContext({
    credentials: params.credentials,
    rawSession: params.rawSession,
    mode,
  });
  const initialSnapshot = readSessionMetadataTupleWriterSnapshot({
    credentials: params.credentials,
    accountEncryptionCurrentness,
    rawSession: params.rawSession,
  });
  assertSessionMetadataMutationCurrentness(params.currentness);
  const updated = await updateSessionMetadataEnvelopeTupleWithRetry({
    token: params.token,
    credentials: params.credentials,
    accountEncryptionCurrentness,
    sessionId: params.sessionId,
    ...cryptoContext,
    initialSnapshot,
    currentness: params.currentness,
    sessionExpectation: params.sessionExpectation,
    mutation: {
      kind: 'metadata',
      update: async (metadata) =>
        await params.updater(metadata) as Metadata,
    },
    mutateLegacy: async (request) =>
      await updateLegacyMetadataWithHttpRetry({
        token: params.token,
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
