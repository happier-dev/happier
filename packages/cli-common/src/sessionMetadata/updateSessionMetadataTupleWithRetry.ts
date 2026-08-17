import {
  SessionSharedMetadataV1Schema,
  createSessionOwnerMetadataV1,
  projectSessionOwnerCompatibilityViewV1,
  projectSessionSharedMetadataV1,
  type SessionMetadataTuplePatchV1,
  type SessionMetadataOwnerMigrationPatchV1,
  type SessionOwnerMetadataEnvelopeV1,
  type SessionOwnerMetadataV1,
  type SessionSharedMetadataV1,
} from '@happier-dev/protocol';

export type SessionMetadataOwnerTupleMutationValueV1<M, A> = Readonly<{
  metadata: M;
  sharedMetadata: SessionSharedMetadataV1;
  ownerMetadata: SessionOwnerMetadataV1;
  agentState: A | null;
}>;

export type SessionMetadataLegacyOwnerTupleMutationValueV1<M, A> =
  Readonly<{
    metadata: M;
    agentState: A | null;
  }>;

export type SessionMetadataLegacyOwnerTupleMutationSnapshotV1<M, A> =
  Readonly<{
    mode: 'legacy_owner';
    metadataLayoutVersion: 0;
    metadataVersion: number;
    metadataCiphertext: string;
    ownerMetadata: null;
    agentStateVersion: number;
    agentStateCiphertext: string | null;
    value: SessionMetadataLegacyOwnerTupleMutationValueV1<M, A>;
  }>;

export type SessionMetadataSharedEditorTupleMutationValueV1<M> =
  Readonly<{
    metadata: M;
    sharedMetadata: SessionSharedMetadataV1;
    ownerMetadata: null;
    agentState: null;
  }>;

export type SessionMetadataOwnerTupleMutationSnapshotV1<M, A> = Readonly<{
  mode: 'owner';
  metadataLayoutVersion: 1;
  metadataVersion: number;
  sharedMetadataCiphertext: string;
  ownerMetadataEnvelope: SessionOwnerMetadataEnvelopeV1;
  agentStateVersion: number;
  agentStateCiphertext: string | null;
  value: SessionMetadataOwnerTupleMutationValueV1<M, A>;
}>;

export type SessionMetadataSharedEditorTupleMutationSnapshotV1<M> =
  Readonly<{
    mode: 'shared_editor';
    metadataLayoutVersion: 1;
    metadataVersion: number;
    sharedMetadataCiphertext: string;
    value: SessionMetadataSharedEditorTupleMutationValueV1<M>;
  }>;

export type SessionMetadataTupleMutationSnapshotV1<M, A> =
  | SessionMetadataLegacyOwnerTupleMutationSnapshotV1<M, A>
  | SessionMetadataOwnerTupleMutationSnapshotV1<M, A>
  | SessionMetadataSharedEditorTupleMutationSnapshotV1<M>;

export type SessionMetadataTupleMutationV1<M, A> =
  | Readonly<{
      kind: 'metadata';
      update: (metadata: M) => M | Promise<M>;
    }>
  | Readonly<{
      kind: 'agentState';
      update: (agentState: A) => A | Promise<A>;
    }>;

export type SessionMetadataTupleMutationCryptoV1 = Readonly<{
  encryptPayload: (payload: unknown) => Promise<string>;
  encodeOwnerMetadata: (
    ownerMetadata: SessionOwnerMetadataV1,
  ) => SessionOwnerMetadataEnvelopeV1
    | Promise<SessionOwnerMetadataEnvelopeV1>;
}>;

export type SessionMetadataOwnerMigrationCurrentnessV1 =
  | Readonly<{
      expectedAccountEncryptionMode: 'plain';
      expectedAccountContentPublicKeyFingerprint: null;
    }>
  | Readonly<{
      expectedAccountEncryptionMode: 'e2ee';
      expectedAccountContentPublicKeyFingerprint: string;
    }>;

export type SessionMetadataLegacyOwnerMutationRequestV1<M, A> =
  | Readonly<{
      kind: 'metadata';
      current:
        SessionMetadataLegacyOwnerTupleMutationSnapshotV1<M, A>;
      updatedMetadata: M;
      mutation: Extract<
        SessionMetadataTupleMutationV1<M, A>,
        Readonly<{ kind: 'metadata' }>
      >;
    }>
  | Readonly<{
      kind: 'agentState';
      current:
        SessionMetadataLegacyOwnerTupleMutationSnapshotV1<M, A>;
      updatedAgentState: A;
      mutation: Extract<
        SessionMetadataTupleMutationV1<M, A>,
        Readonly<{ kind: 'agentState' }>
      >;
    }>;

export type SessionMetadataTupleMutationCommitResultV1<M, A> =
  | Readonly<{
      result: 'success';
      metadataVersion: number;
      agentStateVersion?: number;
    }>
  | Readonly<{
      result: 'conflict';
      currentSnapshot?: SessionMetadataTupleMutationSnapshotV1<M, A>;
    }>;

type TupleMutationError = Error & {
  code:
    | 'metadata_privacy_upgrade_required'
    | 'metadata_tuple_conflict'
    | 'metadata_tuple_ambiguous';
  retryable: false;
  unsupportedFields?: readonly string[];
};

function createTupleMutationError(
  message: string,
  code: TupleMutationError['code'],
  unsupportedFields?: readonly string[],
): TupleMutationError {
  return Object.assign(new Error(message), {
    code,
    retryable: false as const,
    ...(unsupportedFields ? { unsupportedFields } : {}),
  });
}

function resolveMaxAttempts(value: number | undefined): number {
  return typeof value === 'number'
    && Number.isFinite(value)
    && value > 0
      ? Math.min(10, Math.floor(value))
      : 6;
}

/**
 * Browser-safe structural equality for the JSON-shaped tuple domain.
 *
 * Object key insertion order is intentionally irrelevant. This is the single
 * semantic no-op and owner-projection comparison used by every client.
 */
function tupleValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (
    left === null
    || right === null
    || typeof left !== 'object'
    || typeof right !== 'object'
  ) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((value, index) =>
      tupleValuesEqual(value, right[index]));
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  // JSON object serialization omits undefined-valued properties. Treat those
  // properties as absent so a compatibility view containing optional
  // `undefined` keys remains semantically equal to its strict wire projection.
  const leftKeys = Object.keys(leftRecord)
    .filter((key) => leftRecord[key] !== undefined);
  const rightKeys = Object.keys(rightRecord)
    .filter((key) => rightRecord[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(rightRecord, key)
    && tupleValuesEqual(leftRecord[key], rightRecord[key]));
}

function tupleSourceIsExact<M, A>(
  left: SessionMetadataTupleMutationSnapshotV1<M, A>,
  right: SessionMetadataTupleMutationSnapshotV1<M, A>,
): boolean {
  if (left.mode !== right.mode) return false;
  if (left.mode === 'legacy_owner' && right.mode === 'legacy_owner') {
    return left.metadataVersion === right.metadataVersion
      && left.metadataCiphertext === right.metadataCiphertext
      && left.ownerMetadata === null
      && right.ownerMetadata === null
      && left.agentStateVersion === right.agentStateVersion
      && left.agentStateCiphertext === right.agentStateCiphertext;
  }
  if (left.mode === 'owner' && right.mode === 'owner') {
    return left.metadataVersion === right.metadataVersion
      && left.sharedMetadataCiphertext
        === right.sharedMetadataCiphertext
      && tupleValuesEqual(
        left.ownerMetadataEnvelope,
        right.ownerMetadataEnvelope,
      )
      && left.agentStateVersion === right.agentStateVersion
      && left.agentStateCiphertext === right.agentStateCiphertext;
  }
  return left.mode === 'shared_editor'
    && right.mode === 'shared_editor'
    && left.metadataVersion === right.metadataVersion
    && left.sharedMetadataCiphertext
      === right.sharedMetadataCiphertext;
}

function tupleIsExactPreparedResult<M, A>(params: Readonly<{
  source: SessionMetadataTupleMutationSnapshotV1<M, A>;
  prepared:
    | PreparedOwnerMutation<M, A>
    | PreparedSharedEditorMutation<M>;
  refreshed: SessionMetadataTupleMutationSnapshotV1<M, A>;
}>): boolean {
  const { source, prepared, refreshed } = params;
  if (
    source.mode === 'legacy_owner'
    && prepared.mode === 'owner'
    && refreshed.mode === 'owner'
  ) {
    return refreshed.metadataVersion === source.metadataVersion + 1
      && refreshed.sharedMetadataCiphertext
        === prepared.sharedMetadataCiphertext
      && tupleValuesEqual(
        refreshed.ownerMetadataEnvelope,
        prepared.ownerMetadataEnvelope,
      )
      && refreshed.agentStateVersion === source.agentStateVersion + 1
      && refreshed.agentStateCiphertext
        === prepared.agentStateCiphertext;
  }
  if (
    source.mode === 'owner'
    && prepared.mode === 'owner'
    && refreshed.mode === 'owner'
  ) {
    return refreshed.metadataVersion === source.metadataVersion + 1
      && refreshed.sharedMetadataCiphertext
        === prepared.sharedMetadataCiphertext
      && tupleValuesEqual(
        refreshed.ownerMetadataEnvelope,
        prepared.ownerMetadataEnvelope,
      )
      && refreshed.agentStateVersion === source.agentStateVersion + 1
      && refreshed.agentStateCiphertext
        === prepared.agentStateCiphertext;
  }
  return source.mode === 'shared_editor'
    && prepared.mode === 'shared_editor'
    && refreshed.mode === 'shared_editor'
    && refreshed.metadataVersion === source.metadataVersion + 1
    && refreshed.sharedMetadataCiphertext
      === prepared.sharedMetadataCiphertext;
}

type PreparedOwnerMutation<M, A> = Readonly<{
  mode: 'owner';
  value: SessionMetadataOwnerTupleMutationValueV1<M, A>;
  sharedMetadataCiphertext: string;
  ownerMetadataEnvelope: SessionOwnerMetadataEnvelopeV1;
  agentStateCiphertext: string | null;
}>;

type PreparedSharedEditorMutation<M> = Readonly<{
  mode: 'shared_editor';
  value: SessionMetadataSharedEditorTupleMutationValueV1<M>;
  sharedMetadataCiphertext: string;
}>;

async function prepareLegacyOwnerMigration<M, A>(params: Readonly<{
  current: SessionMetadataLegacyOwnerTupleMutationSnapshotV1<M, A>;
  mutation: SessionMetadataTupleMutationV1<M, A>;
  crypto: SessionMetadataTupleMutationCryptoV1;
}>): Promise<PreparedOwnerMutation<M, A> | null> {
  const { current, mutation, crypto } = params;
  let updatedMetadata = current.value.metadata;
  let updatedAgentState = current.value.agentState;
  if (mutation.kind === 'metadata') {
    updatedMetadata = await mutation.update(current.value.metadata);
    if (tupleValuesEqual(updatedMetadata, current.value.metadata)) {
      return null;
    }
  } else {
    const baseAgentState = current.value.agentState ?? ({} as A);
    updatedAgentState = await mutation.update(baseAgentState);
    if (tupleValuesEqual(updatedAgentState, baseAgentState)) {
      return null;
    }
  }
  const createdOwnerMetadata = createSessionOwnerMetadataV1({
    metadata: updatedMetadata,
  });
  if (!createdOwnerMetadata.ok) {
    throw createTupleMutationError(
      `Unsupported owner Session metadata: ${
        createdOwnerMetadata.unsupportedFields.join(', ')
      }`,
      'metadata_privacy_upgrade_required',
      createdOwnerMetadata.unsupportedFields,
    );
  }
  const sharedMetadata = projectSessionSharedMetadataV1({
    metadata: updatedMetadata,
    agentState: updatedAgentState,
  });
  return {
    mode: 'owner',
    value: {
      metadata: projectSessionOwnerCompatibilityViewV1({
        sharedMetadata,
        ownerMetadata: createdOwnerMetadata.ownerMetadata,
      }) as unknown as M,
      sharedMetadata,
      ownerMetadata: createdOwnerMetadata.ownerMetadata,
      agentState: updatedAgentState,
    },
    sharedMetadataCiphertext: await crypto.encryptPayload(sharedMetadata),
    ownerMetadataEnvelope:
      await crypto.encodeOwnerMetadata(createdOwnerMetadata.ownerMetadata),
    agentStateCiphertext: updatedAgentState === null
      ? null
      : await crypto.encryptPayload(updatedAgentState),
  };
}

function buildOwnerMigrationPatchV1<M, A>(params: Readonly<{
  current: SessionMetadataLegacyOwnerTupleMutationSnapshotV1<M, A>;
  prepared: PreparedOwnerMutation<M, A>;
  currentness: SessionMetadataOwnerMigrationCurrentnessV1;
}>): SessionMetadataOwnerMigrationPatchV1 {
  return {
    mode: 'owner_migration',
    ...params.currentness,
    source: {
      metadataLayoutVersion: 0,
      metadata: {
        version: params.current.metadataVersion,
        ciphertext: params.current.metadataCiphertext,
      },
      ownerMetadata: null,
      agentState: {
        version: params.current.agentStateVersion,
        ciphertext: params.current.agentStateCiphertext,
      },
    },
    target: {
      metadataLayoutVersion: 1,
      sharedMetadata: {
        ciphertext: params.prepared.sharedMetadataCiphertext,
      },
      ownerMetadata: params.prepared.ownerMetadataEnvelope,
      agentState: {
        ciphertext: params.prepared.agentStateCiphertext,
      },
    },
  };
}

function buildCommittedOwnerSnapshot<M, A>(params: Readonly<{
  prepared: PreparedOwnerMutation<M, A>;
  metadataVersion: number;
  agentStateVersion: number;
}>): SessionMetadataOwnerTupleMutationSnapshotV1<M, A> {
  return {
    mode: 'owner',
    metadataLayoutVersion: 1,
    metadataVersion: params.metadataVersion,
    sharedMetadataCiphertext: params.prepared.sharedMetadataCiphertext,
    ownerMetadataEnvelope: params.prepared.ownerMetadataEnvelope,
    agentStateVersion: params.agentStateVersion,
    agentStateCiphertext: params.prepared.agentStateCiphertext,
    value: params.prepared.value,
  };
}

async function prepareTupleMutation<M, A>(params: Readonly<{
  current: SessionMetadataTupleMutationSnapshotV1<M, A>;
  mutation: SessionMetadataTupleMutationV1<M, A>;
  crypto: SessionMetadataTupleMutationCryptoV1;
}>): Promise<
  | PreparedOwnerMutation<M, A>
  | PreparedSharedEditorMutation<M>
  | null
> {
  const { current, mutation, crypto } = params;

  if (current.mode === 'legacy_owner') {
    throw createTupleMutationError(
      'Legacy Session metadata mutation delegate is unavailable',
      'metadata_privacy_upgrade_required',
    );
  }

  if (current.mode === 'shared_editor') {
    if (mutation.kind !== 'metadata') {
      throw createTupleMutationError(
        'Shared editors cannot mutate owner Agent state',
        'metadata_privacy_upgrade_required',
      );
    }
    const updatedMetadata = await mutation.update(current.value.metadata);
    if (tupleValuesEqual(updatedMetadata, current.value.metadata)) {
      return null;
    }
    const strictShared = SessionSharedMetadataV1Schema.safeParse(
      updatedMetadata,
    );
    if (!strictShared.success) {
      throw createTupleMutationError(
        'Shared Session metadata contains owner-only or unsupported fields',
        'metadata_privacy_upgrade_required',
      );
    }
    return {
      mode: 'shared_editor',
      value: {
        metadata: strictShared.data as unknown as M,
        sharedMetadata: strictShared.data,
        ownerMetadata: null,
        agentState: null,
      },
      sharedMetadataCiphertext:
        await crypto.encryptPayload(strictShared.data),
    };
  }

  let updatedMetadata = current.value.metadata;
  let updatedAgentState = current.value.agentState;
  if (mutation.kind === 'metadata') {
    updatedMetadata = await mutation.update(current.value.metadata);
    if (tupleValuesEqual(updatedMetadata, current.value.metadata)) {
      return null;
    }
  } else {
    const baseAgentState = current.value.agentState ?? ({} as A);
    updatedAgentState = await mutation.update(baseAgentState);
    if (tupleValuesEqual(updatedAgentState, baseAgentState)) {
      return null;
    }
  }

  const createdOwnerMetadata = createSessionOwnerMetadataV1({
    metadata: updatedMetadata,
  });
  if (!createdOwnerMetadata.ok) {
    throw createTupleMutationError(
      `Unsupported owner Session metadata: ${
        createdOwnerMetadata.unsupportedFields.join(', ')
      }`,
      'metadata_privacy_upgrade_required',
      createdOwnerMetadata.unsupportedFields,
    );
  }
  const previousProjectedOwnerMetadata = createSessionOwnerMetadataV1({
    metadata: current.value.metadata,
  });
  if (!previousProjectedOwnerMetadata.ok) {
    throw createTupleMutationError(
      'Current owner Session metadata cannot be projected safely',
      'metadata_privacy_upgrade_required',
      previousProjectedOwnerMetadata.unsupportedFields,
    );
  }
  const sharedMetadata = projectSessionSharedMetadataV1({
    metadata: updatedMetadata,
    agentState: updatedAgentState,
  });
  const ownerMetadataChanged = !tupleValuesEqual(
    createdOwnerMetadata.ownerMetadata,
    previousProjectedOwnerMetadata.ownerMetadata,
  );
  const ownerMetadata = ownerMetadataChanged
    ? createdOwnerMetadata.ownerMetadata
    : current.value.ownerMetadata;
  const ownerMetadataEnvelope = ownerMetadataChanged
    ? await crypto.encodeOwnerMetadata(ownerMetadata)
    : current.ownerMetadataEnvelope;
  const canonicalMetadata = projectSessionOwnerCompatibilityViewV1({
    sharedMetadata,
    ownerMetadata,
  }) as unknown as M;
  return {
    mode: 'owner',
    value: {
      metadata: canonicalMetadata,
      sharedMetadata,
      ownerMetadata,
      agentState: updatedAgentState,
    },
    sharedMetadataCiphertext: await crypto.encryptPayload(sharedMetadata),
    ownerMetadataEnvelope,
    agentStateCiphertext: updatedAgentState === null
      ? null
      : await crypto.encryptPayload(updatedAgentState),
  };
}

/**
 * Prepares one strict layout-1 Session metadata tuple patch without committing it.
 *
 * Callers that must compose metadata replacement into a larger canonical
 * transaction use this owner instead of rebuilding tuple projection/CAS rules.
 */
function buildPreparedSessionMetadataTuplePatchV1<M, A>(
  current: Exclude<
    SessionMetadataTupleMutationSnapshotV1<M, A>,
    SessionMetadataLegacyOwnerTupleMutationSnapshotV1<M, A>
  >,
  prepared:
    | PreparedOwnerMutation<M, A>
    | PreparedSharedEditorMutation<M>,
): SessionMetadataTuplePatchV1 {
  if (current.mode === 'owner' && prepared.mode === 'owner') {
    return {
      mode: 'owner',
      metadataLayoutVersion: 1,
      expectedOwnerMetadata: current.ownerMetadataEnvelope,
      sharedMetadata: {
        ciphertext: prepared.sharedMetadataCiphertext,
        expectedVersion: current.metadataVersion,
      },
      ownerMetadata: prepared.ownerMetadataEnvelope,
      agentState: {
        ciphertext: prepared.agentStateCiphertext,
        expectedVersion: current.agentStateVersion,
      },
    };
  }
  if (
    current.mode === 'shared_editor'
    && prepared.mode === 'shared_editor'
  ) {
    return {
      mode: 'shared_editor',
      metadataLayoutVersion: 1,
      sharedMetadata: {
        ciphertext: prepared.sharedMetadataCiphertext,
        expectedVersion: current.metadataVersion,
      },
    };
  }
  throw createTupleMutationError(
    'Metadata tuple mutation mode changed during preparation',
    'metadata_privacy_upgrade_required',
  );
}

export async function prepareSessionMetadataTuplePatchV1<M, A>(
  params: Readonly<{
    current: Exclude<
      SessionMetadataTupleMutationSnapshotV1<M, A>,
      SessionMetadataLegacyOwnerTupleMutationSnapshotV1<M, A>
    >;
    mutation: SessionMetadataTupleMutationV1<M, A>;
    crypto: SessionMetadataTupleMutationCryptoV1;
  }>,
): Promise<SessionMetadataTuplePatchV1 | null> {
  const prepared = await prepareTupleMutation(params);
  return prepared === null
    ? null
    : buildPreparedSessionMetadataTuplePatchV1(params.current, prepared);
}

/**
 * The transport-agnostic Session metadata tuple mutation/currentness owner.
 *
 * This owner applies the requested semantic mutation, splits owner/shared
 * projections, preserves an unchanged exact owner envelope, encrypts the
 * rebuilt tuple through typed client callbacks, serializes the CAS PATCH, and
 * reapplies the same semantic mutation after an explicit conflict refresh.
 * Transport adapters only open/seal/encrypt, commit, refetch, and update state.
 *
 * Ordinary layout 0 delegates to the compatible legacy owner. Ordinary owner
 * and shared-editor conflicts retain their bounded retry behavior.
 */
export async function updateSessionMetadataTupleWithRetry<M, A>(
  params: Readonly<{
    initialSnapshot: SessionMetadataTupleMutationSnapshotV1<M, A>;
    mutation: SessionMetadataTupleMutationV1<M, A>;
    crypto: SessionMetadataTupleMutationCryptoV1;
    commit: (
      patch: SessionMetadataTuplePatchV1,
    ) => Promise<SessionMetadataTupleMutationCommitResultV1<M, A>>;
    refreshAfterConflict?: (
      current: SessionMetadataTupleMutationSnapshotV1<M, A>,
    ) => Promise<SessionMetadataTupleMutationSnapshotV1<M, A>>;
    waitBeforeRetry?: (context: Readonly<{
      attempt: number;
      nextAttempt: number;
      maxAttempts: number;
    }>) => Promise<void>;
    isAmbiguousCommitError?: (error: unknown) => boolean;
    mutateLegacy?: (
      request: SessionMetadataLegacyOwnerMutationRequestV1<M, A>,
    ) => Promise<SessionMetadataLegacyOwnerTupleMutationSnapshotV1<M, A>>;
    ownerMigrationCurrentness?:
      SessionMetadataOwnerMigrationCurrentnessV1;
    resolveOwnerMigrationCurrentness?: () =>
      | SessionMetadataOwnerMigrationCurrentnessV1
      | Promise<SessionMetadataOwnerMigrationCurrentnessV1>;
    /**
     * Checks whether the mutation remains owned before the retry coordinator
     * performs another local preparation, refresh, or commit.
     */
    assertCurrent?: () => void;
    maxAttempts?: number;
  }>,
): Promise<SessionMetadataTupleMutationSnapshotV1<M, A>> {
  const maxAttempts = resolveMaxAttempts(params.maxAttempts);
  let current = params.initialSnapshot;

  params.assertCurrent?.();

  if (
    current.mode === 'legacy_owner'
    && (
      params.ownerMigrationCurrentness
      || params.resolveOwnerMigrationCurrentness
    )
  ) {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      params.assertCurrent?.();
      const source:
        SessionMetadataLegacyOwnerTupleMutationSnapshotV1<M, A> =
          current;
      const prepared = await prepareLegacyOwnerMigration({
        current: source,
        mutation: params.mutation,
        crypto: params.crypto,
      });
      if (prepared === null) return source;
      params.assertCurrent?.();
      const ownerMigrationCurrentness =
        await params.resolveOwnerMigrationCurrentness?.()
        ?? params.ownerMigrationCurrentness;
      if (!ownerMigrationCurrentness) {
        throw createTupleMutationError(
          'Session metadata owner migration currentness is unavailable',
          'metadata_privacy_upgrade_required',
        );
      }
      params.assertCurrent?.();
      const patch = buildOwnerMigrationPatchV1({
        current: source,
        prepared,
        currentness: ownerMigrationCurrentness,
      });
      let result: SessionMetadataTupleMutationCommitResultV1<M, A>;
      try {
        result = await params.commit(patch);
      } catch (error) {
        if (!params.isAmbiguousCommitError?.(error)) throw error;
        let refreshed:
          | SessionMetadataTupleMutationSnapshotV1<M, A>
          | undefined;
        try {
          params.assertCurrent?.();
          refreshed = await params.refreshAfterConflict?.(source);
          params.assertCurrent?.();
        } catch {
          params.assertCurrent?.();
          refreshed = undefined;
        }
        if (
          refreshed
          && tupleIsExactPreparedResult({
            source,
            prepared,
            refreshed,
          })
        ) {
          return refreshed;
        }
        if (
          refreshed?.mode === 'legacy_owner'
          && tupleSourceIsExact(source, refreshed)
          && attempt < maxAttempts
        ) {
          current = refreshed;
          params.assertCurrent?.();
          await params.waitBeforeRetry?.({
            attempt,
            nextAttempt: attempt + 1,
            maxAttempts,
          });
          params.assertCurrent?.();
          continue;
        }
        throw createTupleMutationError(
          'Session metadata owner migration result is ambiguous',
          'metadata_tuple_ambiguous',
        );
      }
      if (result.result === 'success') {
        if (typeof result.agentStateVersion !== 'number') {
          throw createTupleMutationError(
            'Session AgentState tuple version is unavailable',
            'metadata_privacy_upgrade_required',
          );
        }
        return buildCommittedOwnerSnapshot({
          prepared,
          metadataVersion: result.metadataVersion,
          agentStateVersion: result.agentStateVersion,
        });
      }
      params.assertCurrent?.();
      const refreshed = result.currentSnapshot
        ?? await (async () => {
          params.assertCurrent?.();
          const next = await params.refreshAfterConflict?.(source);
          params.assertCurrent?.();
          return next;
        })();
      if (
        refreshed
        && tupleIsExactPreparedResult({
          source,
          prepared,
          refreshed,
        })
      ) {
        return refreshed;
      }
      if (!refreshed) {
        throw createTupleMutationError(
          'Metadata tuple conflict snapshot is unavailable',
          'metadata_privacy_upgrade_required',
        );
      }
      if (refreshed.mode !== 'legacy_owner') {
        current = refreshed;
        break;
      }
      if (attempt >= maxAttempts) {
        throw createTupleMutationError(
          'Metadata tuple update conflict',
          'metadata_tuple_conflict',
        );
      }
      current = refreshed;
      params.assertCurrent?.();
      await params.waitBeforeRetry?.({
        attempt,
        nextAttempt: attempt + 1,
        maxAttempts,
      });
      params.assertCurrent?.();
    }
  }

  if (current.mode === 'legacy_owner') {
    if (!params.mutateLegacy) {
      throw createTupleMutationError(
        'Legacy Session metadata mutation delegate is unavailable',
        'metadata_privacy_upgrade_required',
      );
    }
    params.assertCurrent?.();
    if (params.mutation.kind === 'metadata') {
      const updatedMetadata = await params.mutation.update(
        current.value.metadata,
      );
      if (tupleValuesEqual(updatedMetadata, current.value.metadata)) {
        return current;
      }
      params.assertCurrent?.();
      return await params.mutateLegacy({
        kind: 'metadata',
        current,
        updatedMetadata,
        mutation: params.mutation,
      });
    }
    const baseAgentState = current.value.agentState ?? ({} as A);
    const updatedAgentState = await params.mutation.update(baseAgentState);
    if (tupleValuesEqual(updatedAgentState, baseAgentState)) {
      return current;
    }
    params.assertCurrent?.();
    return await params.mutateLegacy({
      kind: 'agentState',
      current,
      updatedAgentState,
      mutation: params.mutation,
    });
  }

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    params.assertCurrent?.();
    const prepared:
      | PreparedOwnerMutation<M, A>
      | PreparedSharedEditorMutation<M>
      | null = await prepareTupleMutation({
      current,
      mutation: params.mutation,
      crypto: params.crypto,
    });
    if (prepared === null) {
      return current;
    }
    if (prepared.mode !== current.mode) {
      throw createTupleMutationError(
        'Metadata tuple mutation mode changed during preparation',
        'metadata_privacy_upgrade_required',
      );
    }

    params.assertCurrent?.();
    const patch = buildPreparedSessionMetadataTuplePatchV1(current, prepared);

    let result: SessionMetadataTupleMutationCommitResultV1<M, A>;
    try {
      result = await params.commit(patch);
    } catch (error) {
      if (!params.isAmbiguousCommitError?.(error)) {
        throw error;
      }
      let refreshed:
        | SessionMetadataTupleMutationSnapshotV1<M, A>
        | undefined;
      try {
        params.assertCurrent?.();
        refreshed = await params.refreshAfterConflict?.(current);
        params.assertCurrent?.();
      } catch {
        params.assertCurrent?.();
        refreshed = undefined;
      }
      if (
        refreshed
        && tupleIsExactPreparedResult({
          source: current,
          prepared,
          refreshed,
        })
      ) {
        return refreshed;
      }
      if (
        refreshed
        && tupleSourceIsExact(current, refreshed)
        && attempt < maxAttempts
      ) {
        current = refreshed;
        params.assertCurrent?.();
        await params.waitBeforeRetry?.({
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
        });
        params.assertCurrent?.();
        continue;
      }
      throw createTupleMutationError(
        'Session metadata tuple result is ambiguous',
        'metadata_tuple_ambiguous',
      );
    }
    if (result.result === 'success') {
      if (prepared.mode === 'owner') {
        if (typeof result.agentStateVersion !== 'number') {
          throw createTupleMutationError(
            'Session AgentState tuple version is unavailable',
            'metadata_privacy_upgrade_required',
          );
        }
        return {
          mode: 'owner',
          metadataLayoutVersion: 1,
          metadataVersion: result.metadataVersion,
          sharedMetadataCiphertext:
            prepared.sharedMetadataCiphertext,
          ownerMetadataEnvelope:
            prepared.ownerMetadataEnvelope,
          agentStateVersion: result.agentStateVersion,
          agentStateCiphertext:
            prepared.agentStateCiphertext,
          value: prepared.value,
        };
      }
      if (prepared.mode !== 'shared_editor') {
        throw createTupleMutationError(
          'Metadata tuple mutation mode changed before commit completed',
          'metadata_privacy_upgrade_required',
        );
      }
      return {
        mode: 'shared_editor',
        metadataLayoutVersion: 1,
        metadataVersion: result.metadataVersion,
        sharedMetadataCiphertext:
          prepared.sharedMetadataCiphertext,
        value: prepared.value,
      };
    }

    params.assertCurrent?.();
    if (attempt >= maxAttempts) break;
    const next: SessionMetadataTupleMutationSnapshotV1<M, A> | undefined =
      result.currentSnapshot
      ?? await (async (): Promise<
        SessionMetadataTupleMutationSnapshotV1<M, A> | undefined
      > => {
        params.assertCurrent?.();
        const refreshed: SessionMetadataTupleMutationSnapshotV1<M, A>
          | undefined = await params.refreshAfterConflict?.(current);
        params.assertCurrent?.();
        return refreshed;
      })();
    const validConflictTransition = next
      && next.mode === current.mode;
    if (!validConflictTransition) {
      throw createTupleMutationError(
        'Metadata tuple conflict snapshot is unavailable',
        'metadata_privacy_upgrade_required',
      );
    }
    current = next;
    params.assertCurrent?.();
    await params.waitBeforeRetry?.({
      attempt,
      nextAttempt: attempt + 1,
      maxAttempts,
    });
    params.assertCurrent?.();
  }

  throw createTupleMutationError(
    'Metadata tuple update conflict',
    'metadata_tuple_conflict',
  );
}
