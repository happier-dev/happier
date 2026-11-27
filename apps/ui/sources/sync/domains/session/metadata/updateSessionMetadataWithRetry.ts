import {
    updateSessionMetadataTupleWithRetry,
    type SessionMetadataLegacyOwnerMutationRequestV1,
    type SessionMetadataLegacyOwnerTupleMutationSnapshotV1,
    type SessionMetadataOwnerMigrationCurrentnessV1,
    type SessionMetadataTupleMutationCryptoV1,
    type SessionMetadataTupleMutationSnapshotV1,
} from '@happier-dev/cli-common/sessionMetadata';
import {
    SESSION_METADATA_LAYOUT_VERSION_V1,
    projectSessionMetadataAgentVocabularyWriteCompatibilityV1,
    type SessionMetadataInactiveModelIntentExpectationV1,
    type SessionMetadataInactiveModelIntentOwnerPatchV1,
    type SessionMetadataTuplePatchV1,
} from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { SessionTeamCredentialBindingMetadataPatchV1 } from '@happier-dev/protocol/teams/credentials/sessionBindingV1';
import type { UsageSessionTimingV1 } from '@happier-dev/protocol/usage/usageTimingV1';


export type UpdateMetadataAck = {
    result:
        | 'success'
        | 'version-mismatch'
        | 'session-active'
        | 'forbidden'
        | 'error'
        | 'metadata_privacy_upgrade_required';
    metadataLayoutVersion?: number;
    version?: number;
    agentStateVersion?: number;
    metadata?: string | null;
    message?: string;
};

function createForbiddenMetadataUpdateError(): Error & { code: 'forbidden' } {
    return Object.assign(new Error('Forbidden session metadata update'), {
        code: 'forbidden' as const,
    });
}

function createMetadataPrivacyUpgradeRequiredError(message?: string): Error & {
    code: 'metadata_privacy_upgrade_required';
} {
    return Object.assign(
        new Error(
            message
            || 'Session metadata must be upgraded before this mutation can be applied',
        ),
        { code: 'metadata_privacy_upgrade_required' as const },
    );
}

function createSessionActiveError(): Error & {
    code: 'session_active';
    retryable: false;
} {
    return Object.assign(
        new Error('Session became active before the model intent committed'),
        {
            code: 'session_active' as const,
            retryable: false as const,
        },
    );
}

function isAmbiguousTupleCommitError(error: unknown): boolean {
    return error instanceof Error
        && error.name === 'ServerFetchWriteTimeoutError';
}

export type SessionMetadataSnapshot<M> = {
    metadataLayoutVersion?: number;
    metadataVersion: number;
    metadata: M;
};

export type SessionMetadataLegacyUpdatePayload = Readonly<{
    sid: string;
    expectedVersion: number;
    metadata: string;
    usageTimingV1: UsageSessionTimingV1;
    sessionExpectation?: SessionMetadataInactiveModelIntentExpectationV1;
}>;

export type SessionMetadataUpdatePayload =
    | SessionMetadataLegacyUpdatePayload
    | SessionMetadataTuplePatchV1
    | SessionMetadataInactiveModelIntentOwnerPatchV1
    | SessionTeamCredentialBindingMetadataPatchV1;

export type SessionMetadataTeamCredentialBinding = Pick<SessionTeamCredentialBindingMetadataPatchV1,
    'operation' | 'teamCredentialBindings' | 'teamVisibilityGrantConsent'>;

type Layout1TupleSnapshot<M, A> =
    Extract<
        SessionMetadataTupleMutationSnapshotV1<M, A>,
        Readonly<{ metadataLayoutVersion: 1 }>
    >;
type TupleSnapshot<M, A> =
    SessionMetadataTupleMutationSnapshotV1<M, A>;
type LegacyOwnerSnapshot<M, A> =
    SessionMetadataLegacyOwnerTupleMutationSnapshotV1<M, A>;

/**
 * A semantic metadata change, or owner maintenance of the same captured tuple:
 * the layout-0 privacy split or a missing/unavailable display projection.
 */
export type SessionMetadataUpdateRequest<M> =
    | ((base: M, metadataRevision?: number) => M)
    | 'ownerMigration'
    | 'ensureDisplayProjection';

/**
 * UI adapter for the one shared Session metadata mutation/currentness owner.
 *
 * Exact snapshots are classified before this adapter runs. Ordinary layout-0
 * mutations delegate to the compatible legacy RPC owner, while layout-1
 * mutations delegate to the tuple owner. The callbacks contain only UI
 * encryption, transport, refetch, and local state work.
 */
export async function updateSessionMetadataWithRetry<M, A = unknown>(
    params: {
        sessionId: string;
        metadataLayoutVersion?: number;
        getSession: () => SessionMetadataSnapshot<M> | null;
        refreshSessions: () => Promise<void>;
        emitUpdateMetadata: (
            payload: SessionMetadataUpdatePayload,
        ) => Promise<UpdateMetadataAck>;
        encryptMetadata?: (metadata: M) => Promise<string>;
        decryptMetadata?: (
            version: number,
            encrypted: string,
        ) => Promise<M | null>;
        applySessionMetadata?: (
            next: SessionMetadataSnapshot<M>,
        ) => void;
        acquireTupleSnapshot: () => Promise<TupleSnapshot<M, A>>;
        /** Exact, authorized full tuple already opened by this operation. */
        initialSnapshot?: TupleSnapshot<M, A>;
        tupleCrypto: SessionMetadataTupleMutationCryptoV1;
        getOwnerMigrationCurrentness?: () =>
            SessionMetadataOwnerMigrationCurrentnessV1 | undefined;
        applyTupleSnapshot: (
            next: Layout1TupleSnapshot<M, A>,
        ) => void;
        updater: SessionMetadataUpdateRequest<M>;
        sessionExpectation?:
            SessionMetadataInactiveModelIntentExpectationV1;
        teamCredentialBinding?: SessionMetadataTeamCredentialBinding;
        mutationIntent?: 'rename_session';
        expectedMetadataRevision?: number;
        botPausedAt?: number | null;
        onMetadataCommitted?: (revision: number) => void;
        assertCurrent?: () => void;
    },
): Promise<void> {
    const {
        sessionId,
        getSession,
        emitUpdateMetadata,
        updater,
    } = params;

    let initial = getSession();
    if (!initial) {
        await params.refreshSessions();
        initial = getSession();
        if (!initial) {
            throw new Error('Session metadata not available');
        }
    }
    const metadataLayoutVersion =
        initial.metadataLayoutVersion !== undefined
            ? initial.metadataLayoutVersion
            : params.metadataLayoutVersion !== undefined
                ? params.metadataLayoutVersion
                : 0;
    if (
        metadataLayoutVersion !== 0
        && metadataLayoutVersion !== SESSION_METADATA_LAYOUT_VERSION_V1
    ) {
        throw createMetadataPrivacyUpgradeRequiredError(
            `Unsupported Session metadata layout ${metadataLayoutVersion}`,
        );
    }

    const acquireTupleSnapshot = params.acquireTupleSnapshot;
    const tupleCrypto = params.tupleCrypto;
    const applyTupleSnapshot = params.applyTupleSnapshot;
    const exactInitial = params.initialSnapshot ?? await acquireTupleSnapshot();
    if (params.teamCredentialBinding && exactInitial.mode !== 'owner') {
        throw createMetadataPrivacyUpgradeRequiredError('Team credential binding requires Session owner metadata layout v1');
    }
    const mutateLegacy = async (
        request: SessionMetadataLegacyOwnerMutationRequestV1<M, A>,
    ): Promise<LegacyOwnerSnapshot<M, A> | Readonly<{
        result: 'conflict'; currentSnapshot: LegacyOwnerSnapshot<M, A>;
    }>> => {
        if (
            request.kind !== 'metadata'
            || !params.encryptMetadata
            || !params.decryptMetadata
            || !params.applySessionMetadata
        ) {
            throw createMetadataPrivacyUpgradeRequiredError(
                'Legacy Session metadata writer is unavailable',
            );
        }
        const encryptedMetadata = await params.encryptMetadata(
            projectSessionMetadataAgentVocabularyWriteCompatibilityV1(
                request.updatedMetadata,
            ),
        );
        const result = await emitUpdateMetadata({
            sid: sessionId,
            expectedVersion: request.current.metadataVersion,
            metadata: encryptedMetadata,
            usageTimingV1: request.usageTimingV1,
            ...(params.sessionExpectation
                ? { sessionExpectation: params.sessionExpectation }
                : {}),
        });
        if (result.result === 'success') {
            if (
                typeof result.version === 'number'
                && typeof result.metadata === 'string'
            ) {
                const decrypted = await params.decryptMetadata(
                    result.version,
                    result.metadata,
                );
                if (decrypted) {
                    params.applySessionMetadata({
                        metadataVersion: result.version,
                        metadata: decrypted,
                    });
                    return {
                        ...request.current,
                        metadataVersion: result.version,
                        metadataCiphertext: result.metadata,
                        value: {
                            ...request.current.value,
                            metadata: decrypted,
                        },
                    };
                }
            }
            await params.refreshSessions();
            const refreshed = await acquireTupleSnapshot();
            if (refreshed.mode !== 'legacy_owner') {
                throw createMetadataPrivacyUpgradeRequiredError(
                    'Legacy Session metadata changed layout after commit',
                );
            }
            return refreshed;
        }
        if (result.result === 'version-mismatch') {
            let current: TupleSnapshot<M, A> | null = null;
            if (
                typeof result.version === 'number'
                && typeof result.metadata === 'string'
            ) {
                const decrypted = await params.decryptMetadata(
                    result.version,
                    result.metadata,
                );
                if (decrypted) {
                    params.applySessionMetadata({
                        metadataVersion: result.version,
                        metadata: decrypted,
                    });
                    current = {
                        ...request.current,
                        metadataVersion: result.version,
                        metadataCiphertext: result.metadata,
                        value: {
                            ...request.current.value,
                            metadata: decrypted,
                        },
                    };
                }
            }
            if (!current) {
                await params.refreshSessions();
                current = await acquireTupleSnapshot();
            }
            if (current.mode !== 'legacy_owner') {
                throw createMetadataPrivacyUpgradeRequiredError(
                    'Legacy Session metadata changed layout during retry',
                );
            }
            return { result: 'conflict', currentSnapshot: current };
        }
        if (result.result === 'session-active') {
            await params.refreshSessions();
            throw createSessionActiveError();
        }
        if (result.result === 'forbidden') {
            throw createForbiddenMetadataUpdateError();
        }
        if (
            result.result === 'metadata_privacy_upgrade_required'
        ) {
            throw createMetadataPrivacyUpgradeRequiredError(
                result.message,
            );
        }
        throw new Error(
            result.message || 'Failed to update session metadata',
        );
    };
    const updated = await updateSessionMetadataTupleWithRetry<M, A>({
        initialSnapshot: exactInitial,
        mutation: updater === 'ownerMigration'
            ? { kind: 'ownerMigration' }
            : updater === 'ensureDisplayProjection'
            ? { kind: 'ensureDisplayProjection' }
            : { kind: 'metadata', update: updater, ...(params.expectedMetadataRevision !== undefined
                ? { expectedMetadataRevision: params.expectedMetadataRevision } : {}) },
        crypto: tupleCrypto,
        botPausedAt: params.botPausedAt,
        commit: async (patch) => {
            if ((params.sessionExpectation || params.teamCredentialBinding) && patch.mode !== 'owner') {
                throw createMetadataPrivacyUpgradeRequiredError(
                    'Inactive model intent requires Session owner metadata',
                );
            }
            const result = await emitUpdateMetadata(
                params.teamCredentialBinding && patch.mode === 'owner'
                    ? ({ ...patch, ...params.teamCredentialBinding, mode: 'owner_team_credential_binding',
                        ...(params.sessionExpectation ? { sessionExpectation: params.sessionExpectation } : {}),
                    } satisfies SessionTeamCredentialBindingMetadataPatchV1)
                    : params.sessionExpectation && patch.mode === 'owner'
                    ? ({
                        ...patch,
                        mode: 'owner_inactive_model_intent',
                        sessionExpectation: params.sessionExpectation,
                    } satisfies SessionMetadataInactiveModelIntentOwnerPatchV1)
                    : patch.mode === 'shared_editor' && params.mutationIntent
                        ? { ...patch, mutationIntent: params.mutationIntent }
                        : patch,
            );
            if (
                result.result === 'success'
                && result.metadataLayoutVersion
                    === SESSION_METADATA_LAYOUT_VERSION_V1
                && typeof result.version === 'number'
            ) {
                return {
                    result: 'success' as const,
                    metadataVersion: result.version,
                    ...(typeof result.agentStateVersion === 'number'
                        ? {
                            agentStateVersion:
                                result.agentStateVersion,
                        }
                        : {}),
                };
            }
            if (result.result === 'version-mismatch') {
                return { result: 'conflict' as const };
            }
            if (result.result === 'session-active') {
                await params.refreshSessions();
                throw createSessionActiveError();
            }
            if (result.result === 'forbidden') {
                throw createForbiddenMetadataUpdateError();
            }
            if (
                result.result
                    === 'metadata_privacy_upgrade_required'
            ) {
                throw createMetadataPrivacyUpgradeRequiredError(
                    result.message,
                );
            }
            throw new Error(
                result.message
                || 'Failed to update session metadata',
            );
        },
        refreshAfterConflict: async () =>
            await acquireTupleSnapshot(),
        isAmbiguousCommitError: isAmbiguousTupleCommitError,
        ownerMigrationCurrentness:
            params.getOwnerMigrationCurrentness?.(),
        mutateLegacy,
        assertCurrent: params.assertCurrent,
    });
    params.onMetadataCommitted?.(updated.metadataVersion);
    if (updated.metadataLayoutVersion === 0) {
        return;
    }
    applyTupleSnapshot(updated);
    return;
}
