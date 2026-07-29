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
  projectSessionOwnerCompatibilityViewV1,
  sealSessionOwnerMetadataV1,
  SESSION_METADATA_LAYOUT_VERSION_V1,
  SessionSharedMetadataV1Schema,
  type SessionMetadataInactiveModelIntentExpectationV1,
  type SessionMetadataInactiveModelIntentOwnerPatchV1,
  type SessionMetadataOwnerPatchV1,
  type SessionMetadataTuplePatchV1,
} from '@happier-dev/protocol';

import type { AgentState, Metadata } from '@/api/types';
import type { Credentials } from '@/persistence';
import {
  decryptStoredSessionPayload,
  encryptStoredSessionPayload,
  resolveSessionEncryptionContextFromCredentials,
  resolveSessionStoredContentEncryptionMode,
  tryDecryptSessionOwnerMetadata,
  type SessionEncryptionContext,
  type SessionStoredContentEncryptionMode,
} from '@/session/transport/encryption/sessionEncryptionContext';
import {
  fetchSessionByIdCompat,
  patchSessionMetadata,
  patchSessionMetadataEnvelopeTuple,
} from '@/session/transport/http/sessionsHttp';
import { readSessionMetadataLayoutVersion } from './sessionMetadataLayout';

type MetadataUpdateErrorCode =
  | 'unsupported'
  | 'unknown_error'
  | 'conflict'
  | 'metadata_privacy_upgrade_required'
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
  return code === 'ECONNABORTED' || code === 'ETIMEDOUT';
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

function readLayout0WriterSnapshot(params: Readonly<{
  rawSession: LayoutAwareRawSession;
  mode: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext;
}>): SessionMetadataLegacyOwnerSnapshot {
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
    mode: params.mode,
    ctx: params.ctx,
    value: metadataCiphertext,
  }));
  const agentState = agentStateCiphertext === null
    ? null
    : asRecord(decryptStoredSessionPayload({
        mode: params.mode,
        ctx: params.ctx,
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
  credentials: Credentials;
  rawSession: LayoutAwareRawSession;
  mode: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext;
}>): SessionMetadataEnvelopeTupleSnapshot {
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
    mode: params.mode,
    ctx: params.ctx,
    value: String(params.rawSession.metadata ?? '').trim(),
  });
  const sharedMetadata = SessionSharedMetadataV1Schema.safeParse(sharedPlaintext);
  const ownerMetadata = tryDecryptSessionOwnerMetadata({
    credentials: params.credentials,
    rawSession: params.rawSession,
  });
  const ownerMetadataCiphertext = typeof params.rawSession.ownerMetadata === 'string'
    ? params.rawSession.ownerMetadata
    : '';
  if (
    !sharedMetadata.success
    || !ownerMetadata
    || ownerMetadataCiphertext.trim().length === 0
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
      mode: params.mode,
      ctx: params.ctx,
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
    ownerMetadataCiphertext,
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
  credentials: Credentials;
  rawSession: LayoutAwareRawSession;
}>): SessionMetadataEnvelopeTupleSnapshot {
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  const ctx = resolveSessionEncryptionContextFromCredentials(
    params.credentials,
    params.rawSession,
  );
  return readLayout1TupleSnapshot({
    credentials: params.credentials,
    rawSession: params.rawSession,
    mode,
    ctx,
  });
}

export function readSessionMetadataTupleWriterSnapshot(params: Readonly<{
  credentials: Credentials;
  rawSession: LayoutAwareRawSession;
}>): SessionMetadataTupleWriterSnapshot {
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  const ctx = resolveSessionEncryptionContextFromCredentials(
    params.credentials,
    params.rawSession,
  );
  const layoutVersion = readSessionMetadataLayoutVersion(
    params.rawSession.metadataLayoutVersion,
  );
  if (layoutVersion === 0) {
    return readLayout0WriterSnapshot({
      rawSession: params.rawSession,
      mode,
      ctx,
    });
  }
  if (layoutVersion === SESSION_METADATA_LAYOUT_VERSION_V1) {
    return readLayout1TupleSnapshot({
      credentials: params.credentials,
      rawSession: params.rawSession,
      mode,
      ctx,
    });
  }
  throw createMetadataUpdateError(
    'Unsupported Session metadata layout',
    'metadata_privacy_upgrade_required',
  );
}

export async function prepareSessionMetadataTuplePatchForTransaction(
  params: Readonly<{
    credentials: Credentials;
    rawSession: LayoutAwareRawSession;
    updater: (
      metadata: Record<string, unknown>,
    ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  }>,
): Promise<SessionMetadataOwnerPatchV1> {
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  const ctx = resolveSessionEncryptionContextFromCredentials(
    params.credentials,
    params.rawSession,
  );
  const current = toSharedTupleSnapshot(readSessionMetadataTupleWriterSnapshot({
    credentials: params.credentials,
    rawSession: params.rawSession,
  }));
  if (current.mode === 'legacy_owner') {
    throw createMetadataUpdateError(
      'External Session metadata is not eligible for tuple conversion',
      'metadata_privacy_upgrade_required',
    );
  }
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
          mode,
          ctx,
          payload,
        }),
      sealOwnerMetadata: (ownerMetadata) =>
        sealSessionOwnerMetadataV1({
          material: params.credentials.encryption.type === 'legacy'
            ? {
                type: 'legacy',
                secret: params.credentials.encryption.secret,
              }
            : {
                type: 'dataKey',
                machineKey: params.credentials.encryption.machineKey,
              },
          ownerMetadata,
          randomBytes: (length) => nodeRandomBytes(length),
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
  mode: SessionStoredContentEncryptionMode;
  ctx: SessionEncryptionContext;
  request: SessionMetadataLegacyOwnerMutationRequestV1<
    Metadata,
    AgentState
  >;
  sessionExpectation?:
    SessionMetadataInactiveModelIntentExpectationV1;
  maxAttempts: number;
}>): Promise<SessionMetadataLegacyOwnerSnapshot> {
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
    const ciphertext = encryptStoredSessionPayload({
      mode: params.mode,
      ctx: params.ctx,
      payload: request.updatedMetadata,
    });
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
          mode: params.mode,
          ctx: params.ctx,
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
    await new Promise((resolve) => {
      setTimeout(resolve, Math.min(50 * attempt, 250));
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
        sealOwnerMetadata: () => {
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
    credentials: Credentials;
    sessionId: string;
    mode: SessionStoredContentEncryptionMode;
    ctx: SessionEncryptionContext;
    initialSnapshot: SessionMetadataTupleWriterSnapshot;
    mutation: SessionMetadataEnvelopeTupleMutation;
    sessionExpectation?:
      SessionMetadataInactiveModelIntentExpectationV1;
    mutateLegacy?: (
      request: SessionMetadataLegacyOwnerMutationRequestV1<
        Metadata,
        AgentState
      >,
    ) => Promise<SessionMetadataLegacyOwnerSnapshot>;
    maxAttempts?: number;
  }>,
): Promise<SessionMetadataTupleWriterSnapshot> {
  const updated = await updateSessionMetadataTupleWithRetry<
    Metadata,
    AgentState
  >({
    initialSnapshot: toSharedTupleSnapshot(params.initialSnapshot),
    mutation: params.mutation,
    crypto: {
      encryptPayload: async (payload) =>
        encryptStoredSessionPayload({
          mode: params.mode,
          ctx: params.ctx,
          payload,
        }),
      sealOwnerMetadata: (ownerMetadata) =>
        sealSessionOwnerMetadataV1({
          material: params.credentials.encryption.type === 'legacy'
            ? {
                type: 'legacy',
                secret: params.credentials.encryption.secret,
              }
            : {
                type: 'dataKey',
                machineKey: params.credentials.encryption.machineKey,
              },
          ownerMetadata,
          randomBytes: (length) => nodeRandomBytes(length),
        }),
    },
    commit: async (patch) => {
      let transportPatch:
        | SessionMetadataTuplePatchV1
        | SessionMetadataInactiveModelIntentOwnerPatchV1 = patch;
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
      return { result: 'conflict' as const };
    },
    refreshAfterConflict: async () => {
      if (params.credentials.token !== params.token) {
        throw createMetadataUpdateError(
          'Current Account credentials do not match the Session owner',
          'metadata_privacy_upgrade_required',
        );
      }
      const authoritativeRaw = await fetchSessionByIdCompat({
        token: params.token,
        sessionId: params.sessionId,
        reason: 'waitForMetadataUpdate',
      });
      if (!authoritativeRaw) {
        throw createMetadataUpdateError(
          'Session not found',
          'session_not_found',
        );
      }
      const authoritativeMode =
        resolveSessionStoredContentEncryptionMode(authoritativeRaw);
      const authoritativeCtx =
        resolveSessionEncryptionContextFromCredentials(
          params.credentials,
          authoritativeRaw,
        );
      if (
        authoritativeMode !== params.mode
        || authoritativeCtx.encryptionVariant
          !== params.ctx.encryptionVariant
      ) {
        throw createMetadataUpdateError(
          'Session encryption context changed during tuple mutation',
          'metadata_privacy_upgrade_required',
        );
      }
      return toSharedTupleSnapshot(readSessionMetadataTupleWriterSnapshot({
        credentials: params.credentials,
        rawSession: authoritativeRaw,
      }));
    },
    waitBeforeRetry: async ({ attempt }) => {
      await new Promise((resolve) => {
        setTimeout(resolve, Math.min(50 * attempt, 250));
      });
    },
    isAmbiguousCommitError: isAmbiguousTupleCommitError,
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
  credentials: Credentials;
  sessionId: string;
  rawSession: LayoutAwareRawSession;
  updater: (
    metadata: Record<string, unknown>,
  ) => Record<string, unknown> | Promise<Record<string, unknown>>;
  sessionExpectation?:
    SessionMetadataInactiveModelIntentExpectationV1;
  maxAttempts?: number;
}>): Promise<{ version: number; metadata: Record<string, unknown> }> {
  const mode = resolveSessionStoredContentEncryptionMode(params.rawSession);
  const ctx = resolveSessionEncryptionContextFromCredentials(
    params.credentials,
    params.rawSession,
  );
  const initialSnapshot = readSessionMetadataTupleWriterSnapshot({
    credentials: params.credentials,
    rawSession: params.rawSession,
  });
  const updated = await updateSessionMetadataEnvelopeTupleWithRetry({
    token: params.token,
    credentials: params.credentials,
    sessionId: params.sessionId,
    mode,
    ctx,
    initialSnapshot,
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
        mode,
        ctx,
        request,
        sessionExpectation: params.sessionExpectation,
        maxAttempts: resolveLegacyMaxAttempts(params.maxAttempts),
      }),
    maxAttempts: params.maxAttempts,
  });
  return {
    version: updated.metadataVersion,
    metadata: updated.value.metadata,
  };
}
