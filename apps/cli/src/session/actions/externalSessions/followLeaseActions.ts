import {
    ExternalSessionAttachRequestSchema,
    ExternalSessionDetachRequestSchema,
    ExternalSessionFollowPolicySetRequestSchema,
    type ExternalSessionAttachResponse,
    type ExternalSessionDetachResponse,
    type ExternalSessionFollowPolicySetResponse,
} from '@happier-dev/protocol';

import {
    emitExternalSessionTranscriptRefreshInvalidation,
} from '@/api/session/external/secureRefresh/emitExternalSessionTranscriptRefreshInvalidation';
import {
    updateSessionMetadataWithExternalSessionFollowPolicy,
} from '@/api/session/external/backgroundFollow/externalSessionBackgroundFollowMetadata';
import {
    acquireCanonicalExternalSessionFollowLease,
    canAttemptCanonicalExternalSessionLiveFollow,
} from '@/api/session/external/leases/acquireCanonicalExternalSessionFollowLease';
import {
    resolveExternalSessionObservationLinkInput,
} from '@/api/session/external/leases/resolveExternalSessionObservationLinkInput';
import { validateExternalMachineSource } from '@/api/session/external/security/validateExternalMachineSource';
import {
    loadLinkedExternalSession,
    loadLinkedExternalSessionFromRaw,
    loadPersistedLinkedExternalSession,
} from '@/api/session/external/takeover/loadLinkedExternalSession';
import { readStoredCredentials } from '@/persistence';

import {
    resolveDefaultMaxBytes,
    resolveDefaultMaxItems,
    resolveExternalSessionAttachLeaseTtlMs,
} from './actionConfiguration';
import type { ExternalSessionActionContext } from './externalSessionActionContext';
import { resolveGenerationBoundExternalSessionFollowSurface } from './providerOpsResolution';
import {
    externalSessionsError,
    internalErrorResponse,
    mapExternalSessionCorridorFailureToExternalSessionsError,
} from './responseErrors';

export async function executeExternalSessionAttachAction(
    raw: unknown,
    context: ExternalSessionActionContext,
): Promise<ExternalSessionAttachResponse> {
    const parsed = ExternalSessionAttachRequestSchema.safeParse(raw);
    if (!parsed.success) return externalSessionsError('invalid_request') satisfies ExternalSessionAttachResponse;
    const credentials = await readStoredCredentials().catch(() => null);
    if (!credentials) {
        return externalSessionsError('agent_unavailable', 'not_authenticated') satisfies ExternalSessionAttachResponse;
    }
    try {
        const loaded = await loadLinkedExternalSession({
            credentials,
            sessionId: parsed.data.sessionId,
            machineId: parsed.data.machineId,
            expectedIdentity: {
                agentId: parsed.data.agentId,
                machineId: parsed.data.machineId,
                remoteSessionId: parsed.data.remoteSessionId,
                source: parsed.data.source,
            },
        });
        if (!loaded.ok) {
            return externalSessionsError(loaded.errorCode, loaded.error) satisfies ExternalSessionAttachResponse;
        }
        let validatedSource: Awaited<ReturnType<typeof validateExternalMachineSource>>;
        try {
            validatedSource = await validateExternalMachineSource({
                agentId: loaded.session.agentId,
                source: loaded.session.source,
                env: process.env,
            });
        } catch (error) {
            const typedFailure = mapExternalSessionCorridorFailureToExternalSessionsError(error);
            if (typedFailure) return typedFailure satisfies ExternalSessionAttachResponse;
            return internalErrorResponse('external_session_attach.validate_source', error, 'external_session_attach_failed') satisfies ExternalSessionAttachResponse;
        }
        if (!validatedSource.ok) {
            return externalSessionsError(validatedSource.errorCode ?? 'invalid_request', validatedSource.error) satisfies ExternalSessionAttachResponse;
        }
        const { providerOps, resource } =
            await resolveGenerationBoundExternalSessionFollowSurface(
                loaded.session.agentId,
                loaded.session.linkGeneration,
            );
        const observation = await resolveExternalSessionObservationLinkInput({
            linked: loaded.session,
            sessionId: parsed.data.sessionId,
        });
        const canObserveTranscript =
            canAttemptCanonicalExternalSessionLiveFollow({
                observation,
                resource,
                providerOps,
            });
        const attached = await context.followLeaseManager.attach({
            sessionId: parsed.data.sessionId,
            leaseId: parsed.data.leaseId,
            ttlMs: resolveExternalSessionAttachLeaseTtlMs(parsed.data.ttlMs),
            acceptedTailCursor: typeof parsed.data.acceptedTailCursor === 'string'
                ? parsed.data.acceptedTailCursor
                : null,
            resource,
            requestTranscriptRefresh: context.emitExternalSessionTranscriptUpdate
                ? async (cursor, isCurrent) => {
                    if (!isCurrent()) return;
                    await emitExternalSessionTranscriptRefreshInvalidation({
                        sessionId: parsed.data.sessionId,
                        cursor,
                        isCurrent,
                        deviceLocalSecretStorage:
                            context.deviceLocalSecretStorage,
                        emitExternalSessionTranscriptUpdate:
                            context.emitExternalSessionTranscriptUpdate,
                    });
                }
                : undefined,
            acquireFollowLease: canObserveTranscript
                ? async (reacquisitionCursor) => await acquireCanonicalExternalSessionFollowLease({
                    sessionId: parsed.data.sessionId,
                    machineId: parsed.data.machineId,
                    linked: loaded.session,
                    resource,
                    observation: observation!,
                    providerOps,
                    initialCursor:
                        reacquisitionCursor ?? parsed.data.acceptedTailCursor ?? null,
                    maxBytes: resolveDefaultMaxBytes(),
                    maxItems: Math.min(200, resolveDefaultMaxItems()),
                    observationProjection: context.observationProjection,
                    credentials,
                })
                : undefined,
        });
        return {
            ok: true,
            leaseId: attached.leaseId,
            expiresAtMs: attached.expiresAtMs,
            renewed: attached.renewed,
            ...(attached.acceptedTailCursor
                ? { acceptedTailCursor: attached.acceptedTailCursor }
                : {}),
        } satisfies ExternalSessionAttachResponse;
    } catch (error) {
        const typedFailure = mapExternalSessionCorridorFailureToExternalSessionsError(error);
        if (typedFailure) return typedFailure satisfies ExternalSessionAttachResponse;
        return internalErrorResponse('external_session_attach', error, 'external_session_attach_failed') satisfies ExternalSessionAttachResponse;
    }
}

export async function executeExternalSessionDetachAction(
    raw: unknown,
    context: ExternalSessionActionContext,
): Promise<ExternalSessionDetachResponse> {
    const parsed = ExternalSessionDetachRequestSchema.safeParse(raw);
    if (!parsed.success) return externalSessionsError('invalid_request') satisfies ExternalSessionDetachResponse;
    const detached = await context.followLeaseManager.detach({
        sessionId: parsed.data.sessionId,
        leaseId: parsed.data.leaseId,
    });
    return {
        ok: true,
        detached: detached.detached,
    } satisfies ExternalSessionDetachResponse;
}

export async function executeExternalSessionFollowPolicySetAction(
    raw: unknown,
    context: ExternalSessionActionContext,
): Promise<ExternalSessionFollowPolicySetResponse> {
    const parsed = ExternalSessionFollowPolicySetRequestSchema.safeParse(raw);
    if (!parsed.success) return externalSessionsError('invalid_request') satisfies ExternalSessionFollowPolicySetResponse;

    const credentials = await readStoredCredentials().catch(() => null);
    if (!credentials) {
        return externalSessionsError('agent_unavailable', 'not_authenticated') satisfies ExternalSessionFollowPolicySetResponse;
    }

    try {
        const persisted = await loadPersistedLinkedExternalSession({
            credentials,
            sessionId: parsed.data.sessionId,
            machineId: parsed.data.machineId,
            expectedIdentity: {
                agentId: parsed.data.agentId,
                machineId: parsed.data.machineId,
                remoteSessionId: parsed.data.remoteSessionId,
                source: parsed.data.source,
            },
        });
        if (!persisted.ok) {
            return externalSessionsError(
                persisted.errorCode,
                persisted.error,
            ) satisfies ExternalSessionFollowPolicySetResponse;
        }
        const rawSession = persisted.session.rawSession;
        const updatedAtMs = Date.now();
        const persistFollowPolicy = async (): Promise<ExternalSessionFollowPolicySetResponse | null> => {
            try {
                await updateSessionMetadataWithExternalSessionFollowPolicy({
                    token: credentials.token,
                    credentials,
                    sessionId: parsed.data.sessionId,
                    rawSession,
                    policy: parsed.data.enabled ? 'background_follow' : 'attached_only',
                    updatedAtMs,
                    expectedLinkGeneration: persisted.session.linkGeneration,
                });
                return null;
            } catch (error) {
                if (
                    error instanceof Error
                    && (
                        error.message === 'linked_session_reconciliation_required'
                        || error.message === 'linked_session_identity_mismatch'
                    )
                ) {
                    return externalSessionsError(
                        'invalid_request',
                        error.message,
                    ) satisfies ExternalSessionFollowPolicySetResponse;
                }
                return internalErrorResponse(
                    'external_session_follow_policy_set.persist',
                    error,
                    'follow_policy_persist_failed',
                ) satisfies ExternalSessionFollowPolicySetResponse;
            }
        };
        const reconcilePassiveFollow = async (): Promise<
            ExternalSessionFollowPolicySetResponse | null
        > => {
            const result = await context.reconcilePassiveFollowSession?.(
                parsed.data.sessionId,
            );
            if (!result || result.status === 'settled') return null;
            return externalSessionsError(
                'agent_unavailable',
                result.status === 'unavailable'
                    ? 'follow_policy_reconciliation_unavailable'
                    : 'follow_policy_reconciliation_stale',
            ) satisfies ExternalSessionFollowPolicySetResponse;
        };
        const successResponse = (): ExternalSessionFollowPolicySetResponse => ({
            ok: true,
            enabled: parsed.data.enabled,
            leaseActive:
                context.followLeaseManager.hasBackgroundFollowLease(
                    parsed.data.sessionId,
                )
                || context.followLeaseManager.countActiveLeases(
                    parsed.data.sessionId,
                ) > 0,
            updatedAtMs,
        });
        const archived =
            typeof rawSession.archivedAt === 'number'
            && Number.isFinite(rawSession.archivedAt);

        if (!parsed.data.enabled) {
            const persistError = await persistFollowPolicy();
            if (persistError) return persistError;
            if (archived) {
                await context.followLeaseManager.archiveSession({
                    sessionId: parsed.data.sessionId,
                });
            }
            await context.followLeaseManager.setBackgroundFollowEnabled({
                sessionId: parsed.data.sessionId,
                enabled: false,
            });
            const reconcileError = await reconcilePassiveFollow();
            return reconcileError ?? successResponse();
        }

        if (archived) {
            const persistError = await persistFollowPolicy();
            if (persistError) return persistError;
            await context.followLeaseManager.archiveSession({
                sessionId: parsed.data.sessionId,
                preserveBackgroundFollow: true,
            });
            const reconcileError = await reconcilePassiveFollow();
            return reconcileError ?? successResponse();
        }

        let validatedSource: Awaited<
            ReturnType<typeof validateExternalMachineSource>
        >;
        try {
            validatedSource = await validateExternalMachineSource({
                agentId: parsed.data.agentId,
                source: parsed.data.source,
                env: process.env,
            });
        } catch (error) {
            const typedFailure = mapExternalSessionCorridorFailureToExternalSessionsError(error);
            if (typedFailure) return typedFailure satisfies ExternalSessionFollowPolicySetResponse;
            return internalErrorResponse(
                'external_session_follow_policy_set.validate_source',
                error,
                'follow_policy_set_failed',
            ) satisfies ExternalSessionFollowPolicySetResponse;
        }
        if (!validatedSource.ok) {
            return externalSessionsError(
                validatedSource.errorCode ?? 'invalid_request',
                validatedSource.error,
            ) satisfies ExternalSessionFollowPolicySetResponse;
        }
        const loaded = await loadLinkedExternalSessionFromRaw({
            credentials,
            rawSession,
            accountEncryptionMode: persisted.session.accountEncryptionMode,
            machineId: parsed.data.machineId,
            expectedIdentity: {
                agentId: parsed.data.agentId,
                machineId: parsed.data.machineId,
                remoteSessionId: parsed.data.remoteSessionId,
                source: validatedSource.source,
            },
        });
        if (!loaded.ok) {
            return externalSessionsError(
                loaded.errorCode,
                loaded.error,
            ) satisfies ExternalSessionFollowPolicySetResponse;
        }
        const { providerOps, resource } =
            await resolveGenerationBoundExternalSessionFollowSurface(
                loaded.session.agentId,
                loaded.session.linkGeneration,
            );
        const observation = await resolveExternalSessionObservationLinkInput({
            linked: loaded.session,
            sessionId: parsed.data.sessionId,
        });
        const canObserveTranscript =
            canAttemptCanonicalExternalSessionLiveFollow({
                observation,
                resource,
                providerOps,
            });
        if (!canObserveTranscript) {
            return externalSessionsError(
                'agent_unavailable',
                'background_follow_not_supported',
            ) satisfies ExternalSessionFollowPolicySetResponse;
        }
        await context.followLeaseManager.setBackgroundFollowEnabled({
            sessionId: parsed.data.sessionId,
            enabled: true,
            resource,
            acquireFollowLease:
                async (reacquisitionCursor) =>
                    await acquireCanonicalExternalSessionFollowLease({
                    sessionId: parsed.data.sessionId,
                    machineId: parsed.data.machineId,
                    linked: loaded.session,
                    resource,
                    observation: observation!,
                    providerOps,
                    initialCursor: reacquisitionCursor,
                    maxBytes: resolveDefaultMaxBytes(),
                    maxItems: Math.min(200, resolveDefaultMaxItems()),
                    observationProjection: context.observationProjection,
                    credentials,
                }),
        });

        const persistError = await persistFollowPolicy();
        if (persistError) {
            await context.followLeaseManager.setBackgroundFollowEnabled({
                sessionId: parsed.data.sessionId,
                enabled: false,
            }).catch(() => {});
            return persistError;
        }
        const reconcileError = await reconcilePassiveFollow();
        return reconcileError ?? successResponse();
    } catch (error) {
        const typedFailure = mapExternalSessionCorridorFailureToExternalSessionsError(error);
        if (typedFailure) return typedFailure satisfies ExternalSessionFollowPolicySetResponse;
        return internalErrorResponse(
            'external_session_follow_policy_set',
            error,
            'follow_policy_set_failed',
        ) satisfies ExternalSessionFollowPolicySetResponse;
    }
}
