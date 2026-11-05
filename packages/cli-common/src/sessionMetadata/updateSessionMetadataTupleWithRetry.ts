import { SessionSharedMetadataV1Schema, createSessionOwnerMetadataV1, projectSessionOwnerCompatibilityViewV1, projectSessionSharedMetadataV1 } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import { projectSessionDisplayV1 } from '@happier-dev/protocol/sessions/metadata/sessionDisplayProjectionV1';
import { SessionDisplayProjectionV1Schema, SessionSharedDisplayEnvelopeV1Schema, SessionOwnerDisplayEnvelopeV1Schema } from '@happier-dev/protocol/sessions/metadata/sessionDisplaySchemasV1';
import type { SessionMetadataTuplePatchV1, SessionMetadataOwnerMigrationPatchV1, SessionOwnerMetadataEnvelopeV1, SessionOwnerMetadataV1, SessionSharedMetadataV1, SessionDisplayProjectionV1, SessionSharedDisplayV1, SessionOwnerDisplayV1, SessionSharedDisplayEnvelopeV1, SessionOwnerDisplayEnvelopeV1 } from '@happier-dev/protocol';

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
  displayProjectionV1?: SessionDisplayProjectionV1 | null;
  /** Actual leaf-open results from this captured full read; never wire authority. */
  displayProjectionV1Availability?: Readonly<{ shared: boolean; owner: boolean }>;
  value: SessionMetadataOwnerTupleMutationValueV1<M, A>;
}>;

export type SessionMetadataSharedEditorTupleMutationSnapshotV1<M> =
  Readonly<{
    mode: 'shared_editor';
    metadataLayoutVersion: 1;
    metadataVersion: number;
    sharedMetadataCiphertext: string;
    displayProjectionV1?: SessionDisplayProjectionV1 | null;
    value: SessionMetadataSharedEditorTupleMutationValueV1<M>;
  }>;

export type SessionMetadataTupleMutationSnapshotV1<M, A> =
  | SessionMetadataLegacyOwnerTupleMutationSnapshotV1<M, A>
  | SessionMetadataOwnerTupleMutationSnapshotV1<M, A>
  | SessionMetadataSharedEditorTupleMutationSnapshotV1<M>;

export type SessionMetadataTupleMutationV1<M, A> =
  | Readonly<{
      kind: 'metadata';
      expectedMetadataRevision?: number;
      update: (metadata: M) => M | Promise<M>;
    }>
  | Readonly<{
      kind: 'agentState';
      update: (agentState: A) => A | Promise<A>;
    }>
  /**
   * The owner's explicit request to split a layout-0 tuple into the canonical
   * layout-1 owner/shared tuple without changing any value (PA-L2). It commits
   * through the same `owner_migration` CAS as a value-changing owner mutation.
   * A tuple that is already layout 1 is complete and commits nothing; a
   * layout-0 tuple without owner currentness is refused typed, never written
   * through the legacy writer.
   */
  | Readonly<{
      kind: 'ownerMigration';
    }>
  /** Repair retained display through the same owner tuple CAS, without a value edit. */
  | Readonly<{
      kind: 'ensureDisplayProjection';
    }>;

export type SessionMetadataTupleMutationCryptoV1 = Readonly<{
  encryptPayload: (payload: unknown) => Promise<string>;
  encodeOwnerMetadata: (
    ownerMetadata: SessionOwnerMetadataV1,
  ) => SessionOwnerMetadataEnvelopeV1
    | Promise<SessionOwnerMetadataEnvelopeV1>;
  /** Seal only the canonical projected value with the captured Session key/mode. */
  encodeSharedDisplay?: (display: SessionSharedDisplayV1) => SessionSharedDisplayEnvelopeV1 | Promise<SessionSharedDisplayEnvelopeV1>;
  /** Owner authority only. Shared editors never call this Account-domain encoder. */
  encodeOwnerDisplay?: (display: SessionOwnerDisplayV1) => SessionOwnerDisplayEnvelopeV1 | Promise<SessionOwnerDisplayEnvelopeV1>;
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
    | 'session_attested_context_read_only'
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

/** Produce display from this exact tuple transition, never from an adapter-owned summary. */
async function prepareDisplayProjection<M, A>(params: Readonly<{
  current?: SessionMetadataOwnerTupleMutationSnapshotV1<M, A> | SessionMetadataSharedEditorTupleMutationSnapshotV1<M>;
  sharedMetadata: SessionSharedMetadataV1;
  ownerMetadata?: SessionOwnerMetadataV1;
  sourceMetadataVersion: number;
  crypto: SessionMetadataTupleMutationCryptoV1;
  requireAvailableProof?: true;
}>): Promise<SessionDisplayProjectionV1 | null> {
  try {
    const next = projectSessionDisplayV1(params);
    const parsed = SessionDisplayProjectionV1Schema.safeParse(params.current?.displayProjectionV1);
    const current = parsed.success && params.current
      && parsed.data.sourceMetadataVersion === params.current.metadataVersion
      && parsed.data.metadataLayoutVersion === params.current.metadataLayoutVersion ? parsed.data : null;
    // Derive both semantic values before any crypto callback. The tuple's existing
    // CAS proves the unchanged full source; the sidecar has no independent writer.
    const previous = current && params.current ? projectSessionDisplayV1({
      sharedMetadata: params.current.value.sharedMetadata,
      ...(params.current.mode === 'owner' ? { ownerMetadata: params.current.value.ownerMetadata } : {}),
    }) : null;
    const availability = params.current?.mode === 'owner' ? params.current.displayProjectionV1Availability : undefined;
    const shared = current && previous && (!params.requireAvailableProof || availability?.shared === true)
      && tupleValuesEqual(previous.shared, next.shared)
      ? current.shared
      : params.crypto.encodeSharedDisplay
        ? SessionSharedDisplayEnvelopeV1Schema.parse(await params.crypto.encodeSharedDisplay(next.shared)) : null;
    if (!shared) return null;
    const owner = next.owner
      ? current?.owner && previous?.owner && (!params.requireAvailableProof || availability?.owner === true)
        && tupleValuesEqual(previous.owner, next.owner)
        ? current.owner
        : params.crypto.encodeOwnerDisplay
          ? SessionOwnerDisplayEnvelopeV1Schema.parse(await params.crypto.encodeOwnerDisplay(next.owner)) : undefined
      : undefined;
    return SessionDisplayProjectionV1Schema.parse({ v: 1, metadataLayoutVersion: 1,
      sourceMetadataVersion: params.sourceMetadataVersion, shared, ...(owner ? { owner } : {}) });
  } catch (error) {
    if (params.requireAvailableProof) throw error;
    // Display is a derived leaf; a failed projection or seal withdraws it from
    // this CAS without preventing the authoritative full tuple mutation.
    console.warn('[SessionDisplay] Projection unavailable; withdrawing display from metadata tuple write');
    return null;
  }
}

function applyMetadataUpdate<M>(metadata: M, update: (metadata: M) => M | Promise<M>): M | Promise<M> {
  const readContext = (value: unknown): unknown => value !== null && typeof value === 'object'
    ? Reflect.get(value, 'attestedContext') : undefined;
  const initial = readContext(metadata);
  // Capture primitive birth facts before invoking even an in-place updater.
  const before = initial !== null && typeof initial === 'object' ? { ...initial } : initial;
  // A refused in-place update must not change the live snapshot either.
  const updateInput = metadata !== null && typeof metadata === 'object' && !Array.isArray(metadata)
    ? { ...metadata, ...(initial === undefined ? {} : { attestedContext:
      initial !== null && typeof initial === 'object' ? { ...initial } : initial }) } as M
    : metadata;
  const verify = (updated: M): M => {
    if (!tupleValuesEqual(before, readContext(updated))) {
      throw createTupleMutationError('Session attestation is immutable after birth', 'session_attested_context_read_only');
    }
    return updated;
  };
  const updated = update(updateInput);
  // The legacy socket writer requires synchronous callbacks to stay synchronous.
  return updated && typeof (updated as Promise<M>).then === 'function'
    ? Promise.resolve(updated).then(verify) : verify(updated as M);
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
      && left.agentStateCiphertext === right.agentStateCiphertext
      && tupleValuesEqual(left.displayProjectionV1 ?? null, right.displayProjectionV1 ?? null);
  }
  return left.mode === 'shared_editor'
    && right.mode === 'shared_editor'
    && left.metadataVersion === right.metadataVersion
    && left.sharedMetadataCiphertext
      === right.sharedMetadataCiphertext
    && tupleValuesEqual(left.displayProjectionV1 ?? null, right.displayProjectionV1 ?? null);
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
        === prepared.agentStateCiphertext
      && tupleValuesEqual(refreshed.displayProjectionV1 ?? null, prepared.displayProjectionV1);
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
      && refreshed.agentStateVersion === source.agentStateVersion
        + (prepared.agentStateCiphertext === source.agentStateCiphertext ? 0 : 1)
      && refreshed.agentStateCiphertext
        === prepared.agentStateCiphertext
      && tupleValuesEqual(refreshed.displayProjectionV1 ?? null, prepared.displayProjectionV1);
  }
  return source.mode === 'shared_editor'
    && prepared.mode === 'shared_editor'
    && refreshed.mode === 'shared_editor'
    && refreshed.metadataVersion === source.metadataVersion + 1
    && refreshed.sharedMetadataCiphertext
      === prepared.sharedMetadataCiphertext
    && tupleValuesEqual(refreshed.displayProjectionV1 ?? null, prepared.displayProjectionV1);
}

type PreparedOwnerMutation<M, A> = Readonly<{
  mode: 'owner';
  value: SessionMetadataOwnerTupleMutationValueV1<M, A>;
  sharedMetadataCiphertext: string;
  ownerMetadataEnvelope: SessionOwnerMetadataEnvelopeV1;
  agentStateCiphertext: string | null;
  displayProjectionV1: SessionDisplayProjectionV1 | null;
  displayProjectionV1Availability?: Readonly<{ shared: boolean; owner: boolean }>;
}>;

type PreparedSharedEditorMutation<M> = Readonly<{
  mode: 'shared_editor';
  value: SessionMetadataSharedEditorTupleMutationValueV1<M>;
  sharedMetadataCiphertext: string;
  displayProjectionV1: SessionDisplayProjectionV1 | null;
}>;

function assertReviewedMetadataRevision<M, A>(current: SessionMetadataTupleMutationSnapshotV1<M, A>, mutation: SessionMetadataTupleMutationV1<M, A>): void {
  if (mutation.kind !== 'metadata' || mutation.expectedMetadataRevision === undefined) return;
  if (!Number.isSafeInteger(mutation.expectedMetadataRevision) || mutation.expectedMetadataRevision < 0
    || current.metadataVersion !== mutation.expectedMetadataRevision) {
    throw createTupleMutationError('Reviewed Session metadata revision changed', 'metadata_tuple_conflict');
  }
}

async function prepareLegacyOwnerMigration<M, A>(params: Readonly<{
  current: SessionMetadataLegacyOwnerTupleMutationSnapshotV1<M, A>;
  mutation: SessionMetadataTupleMutationV1<M, A>;
  crypto: SessionMetadataTupleMutationCryptoV1;
}>): Promise<PreparedOwnerMutation<M, A> | null> {
  const { current, mutation, crypto } = params;
  assertReviewedMetadataRevision(current, mutation);
  let updatedMetadata = current.value.metadata;
  let updatedAgentState = current.value.agentState;
  if (mutation.kind === 'metadata') {
    updatedMetadata = await applyMetadataUpdate(current.value.metadata, mutation.update);
    if (tupleValuesEqual(updatedMetadata, current.value.metadata)) {
      return null;
    }
  } else if (mutation.kind === 'agentState') {
    const baseAgentState = current.value.agentState ?? ({} as A);
    updatedAgentState = await mutation.update(baseAgentState);
    if (tupleValuesEqual(updatedAgentState, baseAgentState)) {
      return null;
    }
  }
  // An explicit `ownerMigration` keeps every value: the split is the change.
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
  const displayProjectionV1 = await prepareDisplayProjection({
    sharedMetadata, ownerMetadata: createdOwnerMetadata.ownerMetadata,
    sourceMetadataVersion: current.metadataVersion + 1, crypto,
    ...(mutation.kind === 'ensureDisplayProjection' ? { requireAvailableProof: true } : {}),
  });
  if (mutation.kind === 'ensureDisplayProjection' && !displayProjectionV1?.owner) {
    throw createTupleMutationError('Session display production requires shared and owner encoders', 'metadata_privacy_upgrade_required');
  }
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
    displayProjectionV1,
    ...(mutation.kind === 'ensureDisplayProjection'
      ? { displayProjectionV1Availability: { shared: true, owner: true } } : {}),
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
      displayProjectionV1: params.prepared.displayProjectionV1,
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
    displayProjectionV1: params.prepared.displayProjectionV1 === null ? null
      : { ...params.prepared.displayProjectionV1, sourceMetadataVersion: params.metadataVersion },
    ...(params.prepared.displayProjectionV1Availability
      ? { displayProjectionV1Availability: params.prepared.displayProjectionV1Availability } : {}),
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
  projectKey?: string;
}>): Promise<
  | PreparedOwnerMutation<M, A>
  | PreparedSharedEditorMutation<M>
  | null
> {
  const { current, mutation, crypto } = params;

  assertReviewedMetadataRevision(current, mutation);
  if (params.projectKey !== undefined && current.mode !== 'owner') {
    throw createTupleMutationError('Project publication requires a layout-one owner tuple', 'metadata_privacy_upgrade_required');
  }
  if (current.mode === 'legacy_owner') {
    throw createTupleMutationError(
      'Legacy Session metadata mutation delegate is unavailable',
      'metadata_privacy_upgrade_required',
    );
  }

  // A layout-1 tuple has already been migrated; the explicit request is complete.
  if (mutation.kind === 'ownerMigration') return null;

  if (mutation.kind === 'ensureDisplayProjection') {
    if (current.mode !== 'owner') {
      throw createTupleMutationError('Display backfill requires the full owner tuple', 'metadata_privacy_upgrade_required');
    }
    const parsed = SessionDisplayProjectionV1Schema.safeParse(current.displayProjectionV1);
    if (parsed.success && parsed.data.sourceMetadataVersion === current.metadataVersion
      && parsed.data.metadataLayoutVersion === current.metadataLayoutVersion && parsed.data.owner
      && current.displayProjectionV1Availability?.shared === true && current.displayProjectionV1Availability.owner === true) return null;
    const displayProjectionV1 = await prepareDisplayProjection({ current,
      sharedMetadata: current.value.sharedMetadata, ownerMetadata: current.value.ownerMetadata,
      sourceMetadataVersion: current.metadataVersion + 1, crypto, requireAvailableProof: true,
    });
    if (!displayProjectionV1?.owner) {
      throw createTupleMutationError('Session display production requires shared and owner encoders', 'metadata_privacy_upgrade_required');
    }
    return { mode: 'owner', value: current.value, displayProjectionV1,
      displayProjectionV1Availability: { shared: true, owner: true },
      sharedMetadataCiphertext: current.sharedMetadataCiphertext,
      ownerMetadataEnvelope: current.ownerMetadataEnvelope, agentStateCiphertext: current.agentStateCiphertext };
  }

  if (current.mode === 'shared_editor') {
    if (mutation.kind !== 'metadata') {
      throw createTupleMutationError(
        'Shared editors cannot mutate owner Agent state',
        'metadata_privacy_upgrade_required',
      );
    }
    const updatedMetadata = await applyMetadataUpdate(current.value.metadata, mutation.update);
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
      displayProjectionV1: await prepareDisplayProjection({ current, sharedMetadata: strictShared.data,
        sourceMetadataVersion: current.metadataVersion + 1, crypto }),
      sharedMetadataCiphertext:
        await crypto.encryptPayload(strictShared.data),
    };
  }

  let updatedMetadata = current.value.metadata;
  let updatedAgentState = current.value.agentState;
  if (mutation.kind === 'metadata') {
    updatedMetadata = await applyMetadataUpdate(current.value.metadata, mutation.update);
    if (params.projectKey === undefined && tupleValuesEqual(updatedMetadata, current.value.metadata)) {
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
  const canonicalMetadata = projectSessionOwnerCompatibilityViewV1({
    sharedMetadata,
    ownerMetadata,
  }) as unknown as M;
  const displayProjectionV1 = await prepareDisplayProjection({ current, sharedMetadata, ownerMetadata,
    sourceMetadataVersion: current.metadataVersion + 1, crypto });
  const ownerMetadataEnvelope = ownerMetadataChanged
    ? await crypto.encodeOwnerMetadata(ownerMetadata)
    : current.ownerMetadataEnvelope;
  return {
    mode: 'owner',
    displayProjectionV1,
    value: {
      metadata: canonicalMetadata,
      sharedMetadata,
      ownerMetadata,
      agentState: updatedAgentState,
    },
    sharedMetadataCiphertext: await crypto.encryptPayload(sharedMetadata),
    ownerMetadataEnvelope,
    // Metadata mutations carry the exact stored request bytes. Resealing an
    // unchanged Agent state would advance its version and stale in-flight
    // Follow originals even though no request changed.
    agentStateCiphertext: mutation.kind === 'metadata'
      ? current.agentStateCiphertext
      : updatedAgentState === null ? null : await crypto.encryptPayload(updatedAgentState),
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
      displayProjectionV1: prepared.displayProjectionV1,
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
      displayProjectionV1: prepared.displayProjectionV1,
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
    mutation: Exclude<SessionMetadataTupleMutationV1<M, A>, Readonly<{ kind: 'ensureDisplayProjection' }>>;
    crypto: SessionMetadataTupleMutationCryptoV1;
  }>,
): Promise<SessionMetadataTuplePatchV1 | null> {
  const prepared = await prepareTupleMutation<M, A>(params);
  return prepared === null
    ? null
    : buildPreparedSessionMetadataTuplePatchV1<M, A>(params.current, prepared);
}

/**
 * The transport-agnostic Session metadata tuple mutation/currentness owner.
 *
 * This owner applies the requested semantic mutation, splits owner/shared
 * projections, preserves an unchanged exact owner envelope, encrypts the
 * rebuilt tuple and its recipient-scoped display through typed client callbacks,
 * serializes one CAS PATCH, and
 * reapplies the same semantic mutation after an explicit conflict refresh.
 * Transport adapters only open/seal/encrypt, commit, refetch, and update state.
 *
 * Ordinary layout 0 delegates to the compatible legacy owner unless owner
 * migration currentness is available, in which case the mutation commits the
 * layout-0 → layout-1 split. An explicit `ownerMigration` request performs that
 * split with no value change. `ensureDisplayProjection` additionally repairs an
 * unavailable display from an authorized full-owner snapshot, requiring actual
 * Account-material currentness even for layout 1. Its leaf availability is
 * read-local proof, not a new authority or a wire field. Ordinary owner and
 * shared-editor conflicts retain their bounded retry behavior.
 */
export async function updateSessionMetadataTupleWithRetry<M, A>(
  params: Readonly<{
    initialSnapshot: SessionMetadataTupleMutationSnapshotV1<M, A>;
    mutation: SessionMetadataTupleMutationV1<M, A>;
    /** An already accepted owner-only row relationship; the caller supplies it only on a real change. */
    projectKey?: string;
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
  assertReviewedMetadataRevision(current, params.mutation);
  if (params.projectKey !== undefined && current.mode !== 'owner') {
    throw createTupleMutationError('Project publication requires a layout-one owner tuple', 'metadata_privacy_upgrade_required');
  }

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
      // Ensure cannot inherit an ordinary layout-one writer's mode-only input.
      // Its adapter proves actual Account material against captured currentness.
      const ensureCurrentness = params.mutation.kind === 'ensureDisplayProjection'
        ? await params.resolveOwnerMigrationCurrentness?.() ?? params.ownerMigrationCurrentness : undefined;
      if (params.mutation.kind === 'ensureDisplayProjection' && !ensureCurrentness) {
        throw createTupleMutationError('Session display owner currentness is unavailable', 'metadata_privacy_upgrade_required');
      }
      const prepared = await prepareLegacyOwnerMigration({
        current: source,
        mutation: params.mutation,
        crypto: params.crypto,
      });
      if (prepared === null) return source;
      params.assertCurrent?.();
      const ownerMigrationCurrentness =
        ensureCurrentness ?? await params.resolveOwnerMigrationCurrentness?.()
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
          && params.mutation.kind !== 'ensureDisplayProjection'
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
        && params.mutation.kind !== 'ensureDisplayProjection'
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
    if (params.mutation.kind === 'ownerMigration' || params.mutation.kind === 'ensureDisplayProjection') {
      throw createTupleMutationError(
        'Session metadata owner migration currentness is unavailable',
        'metadata_privacy_upgrade_required',
      );
    }
    if (!params.mutateLegacy) {
      throw createTupleMutationError(
        'Legacy Session metadata mutation delegate is unavailable',
        'metadata_privacy_upgrade_required',
      );
    }
    params.assertCurrent?.();
    if (params.mutation.kind === 'metadata') {
      const mutation = params.mutation;
      const updatedMetadata = await applyMetadataUpdate(current.value.metadata, mutation.update);
      if (tupleValuesEqual(updatedMetadata, current.value.metadata)) {
        return current;
      }
      params.assertCurrent?.();
      return await params.mutateLegacy({
        kind: 'metadata',
        current,
        updatedMetadata,
        mutation: { ...mutation, update: metadata => applyMetadataUpdate(metadata, mutation.update) },
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
    if (params.mutation.kind === 'ensureDisplayProjection') {
      const ownerCurrentness = await params.resolveOwnerMigrationCurrentness?.() ?? params.ownerMigrationCurrentness;
      if (current.mode !== 'owner' || !ownerCurrentness) {
        throw createTupleMutationError('Session display owner currentness is unavailable', 'metadata_privacy_upgrade_required');
      }
      params.assertCurrent?.();
    }
    const prepared:
      | PreparedOwnerMutation<M, A>
      | PreparedSharedEditorMutation<M>
      | null = await prepareTupleMutation({
      current,
      mutation: params.mutation,
      crypto: params.crypto,
      ...(params.projectKey !== undefined ? { projectKey: params.projectKey } : {}),
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
    const tuplePatch = buildPreparedSessionMetadataTuplePatchV1(current, prepared);
    const patch = tuplePatch.mode === 'owner' && params.projectKey !== undefined
      ? { ...tuplePatch, projectKey: params.projectKey } : tuplePatch;

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
        && params.mutation.kind !== 'ensureDisplayProjection'
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
        return buildCommittedOwnerSnapshot({ prepared,
          metadataVersion: result.metadataVersion, agentStateVersion: result.agentStateVersion });
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
        displayProjectionV1: prepared.displayProjectionV1 === null ? null
          : { ...prepared.displayProjectionV1, sourceMetadataVersion: result.metadataVersion },
        sharedMetadataCiphertext:
          prepared.sharedMetadataCiphertext,
        value: prepared.value,
      };
    }

    params.assertCurrent?.();
    if (attempt >= maxAttempts) break;
    // Read the retry snapshot after contention backoff. Waiting after the read
    // makes each retry stale again while the runner keeps publishing.
    await params.waitBeforeRetry?.({
      attempt,
      nextAttempt: attempt + 1,
      maxAttempts,
    });
    params.assertCurrent?.();
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
  }

  throw createTupleMutationError(
    'Metadata tuple update conflict',
    'metadata_tuple_conflict',
  );
}
