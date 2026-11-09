import { ExternalSessionAttachRequestSchema, ExternalSessionDetachRequestSchema } from '@happier-dev/protocol/sessions/external/daemonRpcV1';
import type { ExternalSessionAttachResponse, ExternalSessionDetachResponse } from '@happier-dev/protocol';

import {
    emitExternalSessionTranscriptRefreshInvalidation,
} from '@/api/session/external/secureRefresh/emitExternalSessionTranscriptRefreshInvalidation';
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
} from '@/api/session/external/takeover/loadLinkedExternalSession';
import { readStoredCredentials } from '@/persistence';
import { EXTERNAL_SESSIONS_INVOCATION_POLICY } from '@/session/external/agentExternalSessionsInvocation';

import {
    resolveExternalSessionAttachLeaseTtlMs,
} from './actionConfiguration';
import type { ExternalSessionActionContext } from './externalSessionActionContext';
import { resolveOccurrenceBoundExternalSessionFollowSurface } from './providerOpsResolution';
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
            await resolveOccurrenceBoundExternalSessionFollowSurface(
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
                    maxBytes: EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxSerializedBytes,
                    maxItems: EXTERNAL_SESSIONS_INVOCATION_POLICY.readAfterTranscript.maxItems,
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

export { executeExternalSessionFollowPolicySetAction } from './backgroundFollowAction';
