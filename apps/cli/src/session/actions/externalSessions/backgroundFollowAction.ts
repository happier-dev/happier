import { ExternalSessionBackgroundFollowActionInputV1Schema, ExternalSessionFollowPolicySetRequestSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import type { ExternalSessionFollowPolicySetResponse } from '@happier-dev/protocol';
import { updateSessionMetadataWithExternalSessionFollowPolicy } from '@/api/session/external/backgroundFollow/externalSessionBackgroundFollowMetadata';
import { canAttemptCanonicalExternalSessionLiveFollow } from '@/api/session/external/leases/acquireCanonicalExternalSessionFollowLease';
import { resolveExternalSessionObservationLinkInput } from '@/api/session/external/leases/resolveExternalSessionObservationLinkInput';
import { validateExternalMachineSource } from '@/api/session/external/security/validateExternalMachineSource';
import { loadLinkedExternalSessionFromRaw, loadPersistedLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import { readStoredCredentials } from '@/persistence';
import type { ExternalSessionActionContext } from './externalSessionActionContext';
import { resolveOccurrenceBoundExternalSessionFollowSurface } from './providerOpsResolution';
import { externalSessionsError, internalErrorResponse, mapExternalSessionCorridorFailureToExternalSessionsError } from './responseErrors';

export async function executeExternalSessionFollowPolicySetAction(
    raw: unknown,
    context: Pick<ExternalSessionActionContext, 'followLeaseManager' | 'observationProjection' | 'reconcilePassiveFollowSession'>,
): Promise<ExternalSessionFollowPolicySetResponse> {
    const parsed = ExternalSessionFollowPolicySetRequestSchema.safeParse(raw);
    const semantic = parsed.success ? null : ExternalSessionBackgroundFollowActionInputV1Schema.safeParse(raw);
    const admitted = parsed.success ? parsed.data : semantic?.success ? semantic.data : null;
    if (!admitted) return externalSessionsError('invalid_request') satisfies ExternalSessionFollowPolicySetResponse;

    const credentials = await readStoredCredentials().catch(() => null);
    if (!credentials) {
        return externalSessionsError('agent_unavailable', 'not_authenticated') satisfies ExternalSessionFollowPolicySetResponse;
    }

    try {
        const persisted = await loadPersistedLinkedExternalSession({
            credentials,
            sessionId: admitted.sessionId,
            ...(parsed.success ? {
                machineId: parsed.data.machineId,
                expectedIdentity: {
                    agentId: parsed.data.agentId,
                    machineId: parsed.data.machineId,
                    remoteSessionId: parsed.data.remoteSessionId,
                    source: parsed.data.source,
                },
            } : {}),
        });
        if (!persisted.ok) {
            return externalSessionsError(
                persisted.errorCode,
                persisted.error,
            ) satisfies ExternalSessionFollowPolicySetResponse;
        }
        const rawSession = persisted.session.rawSession;
        // Semantic callers select the current persisted link. Released RPC
        // callers retain their captured identity precondition above.
        const request = {
            machineId: persisted.session.machineId,
            agentId: persisted.session.agentId,
            remoteSessionId: persisted.session.remoteSessionId,
            source: persisted.session.source,
            ...admitted,
        };
        const updatedAtMs = Date.now();
        const persistFollowPolicy = async (): Promise<ExternalSessionFollowPolicySetResponse | null> => {
            try {
                await updateSessionMetadataWithExternalSessionFollowPolicy({
                    token: credentials.token,
                    credentials,
                    sessionId: request.sessionId,
                    rawSession,
                    policy: request.enabled ? 'background_follow' : 'attached_only',
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
                request.sessionId,
            );
            if (result?.status === 'settled') return null;
            return externalSessionsError(
                'agent_unavailable',
                !result || result.status === 'unavailable'
                    ? 'follow_policy_reconciliation_unavailable'
                    : 'follow_policy_reconciliation_stale',
            ) satisfies ExternalSessionFollowPolicySetResponse;
        };
        const successResponse = (): ExternalSessionFollowPolicySetResponse => ({
            ok: true,
            enabled: request.enabled,
            leaseActive:
                context.followLeaseManager.hasBackgroundFollowLease(
                    request.sessionId,
                )
                || context.followLeaseManager.countActiveLeases(
                    request.sessionId,
                ) > 0,
            updatedAtMs,
        });
        const archived =
            typeof rawSession.archivedAt === 'number'
            && Number.isFinite(rawSession.archivedAt);

        if (!request.enabled || archived) {
            const persistError = await persistFollowPolicy();
            if (persistError) return persistError;
            const reconcileError = await reconcilePassiveFollow();
            return reconcileError ?? successResponse();
        }

        let validatedSource: Awaited<
            ReturnType<typeof validateExternalMachineSource>
        >;
        try {
            validatedSource = await validateExternalMachineSource({
                agentId: request.agentId,
                source: request.source,
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
            machineId: request.machineId,
            expectedIdentity: {
                agentId: request.agentId,
                machineId: request.machineId,
                remoteSessionId: request.remoteSessionId,
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
            await resolveOccurrenceBoundExternalSessionFollowSurface(
                loaded.session.agentId,
                loaded.session.linkGeneration,
            );
        const observation = await resolveExternalSessionObservationLinkInput({
            linked: loaded.session,
            sessionId: request.sessionId,
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
        const persistError = await persistFollowPolicy();
        if (persistError) return persistError;
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
