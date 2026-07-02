import {
    ExternalSessionAttachRequestSchema,
    ExternalSessionDetachRequestSchema,
    ExternalSessionFollowPolicySetRequestSchema,
    type ExternalSessionAttachResponse,
    type ExternalSessionDetachResponse,
    type ExternalSessionFollowPolicySetResponse,
} from '@happier-dev/protocol';

import { createManagedExternalSessionFollowLease } from '@/api/session/external/backgroundFollow/createManagedExternalSessionFollowLease';
import { updateSessionMetadataWithExternalSessionFollowPolicy } from '@/api/session/external/backgroundFollow/externalSessionBackgroundFollowMetadata';
import { validateDirectMachineSource } from '@/api/session/external/security/validateDirectMachineSource';
import { readCredentials } from '@/persistence';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';

import { resolveExternalSessionAttachLeaseTtlMs } from './actionConfiguration';
import type { ExternalSessionActionContext } from './externalSessionActionContext';
import { resolveExternalSessionSurfaceOps } from './providerOpsResolution';
import { externalSessionsError, internalErrorResponse } from './responseErrors';

export async function executeExternalSessionAttachAction(
    raw: unknown,
    context: ExternalSessionActionContext,
): Promise<ExternalSessionAttachResponse> {
    const parsed = ExternalSessionAttachRequestSchema.safeParse(raw);
    if (!parsed.success) return externalSessionsError('invalid_request') satisfies ExternalSessionAttachResponse;
    let validatedSource: Awaited<ReturnType<typeof validateDirectMachineSource>>;
    try {
        validatedSource = await validateDirectMachineSource({
            providerId: parsed.data.providerId,
            source: parsed.data.source,
            env: process.env,
        });
    } catch (error) {
        return internalErrorResponse('external_session_attach.validate_source', error, 'external_session_attach_failed') satisfies ExternalSessionAttachResponse;
    }
    if (!validatedSource.ok) {
        return externalSessionsError('invalid_request', validatedSource.error) satisfies ExternalSessionAttachResponse;
    }
    try {
        const providerOps = await resolveExternalSessionSurfaceOps(parsed.data.providerId);
        const attached = await context.followLeaseManager.attach({
            sessionId: parsed.data.sessionId,
            leaseId: parsed.data.leaseId,
            ttlMs: resolveExternalSessionAttachLeaseTtlMs(parsed.data.ttlMs),
            acquireFollowLease: providerOps.acquireFollowLease
                ? async () => {
                    return createManagedExternalSessionFollowLease({
                        sessionId: parsed.data.sessionId,
                        reason: 'attached_view',
                        acquireProviderFollowLease: () => providerOps.acquireFollowLease!({
                            source: validatedSource.source,
                            remoteSessionId: parsed.data.remoteSessionId,
                            reason: 'attached_view',
                            linkedSessionId: parsed.data.sessionId,
                        }),
                        emitExternalSessionTranscriptUpdate: context.emitExternalSessionTranscriptUpdate,
                        shouldProcessBackgroundFollowEffects: () => false,
                    });
                }
                : undefined,
        });
        return {
            ok: true,
            leaseId: attached.leaseId,
            expiresAtMs: attached.expiresAtMs,
            renewed: attached.renewed,
        } satisfies ExternalSessionAttachResponse;
    } catch (error) {
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
    let validatedSource: Awaited<ReturnType<typeof validateDirectMachineSource>>;
    try {
        validatedSource = await validateDirectMachineSource({
            providerId: parsed.data.providerId,
            source: parsed.data.source,
            env: process.env,
        });
    } catch (error) {
        return internalErrorResponse(
            'external_session_follow_policy_set.validate_source',
            error,
            'follow_policy_set_failed',
        ) satisfies ExternalSessionFollowPolicySetResponse;
    }
    if (!validatedSource.ok) {
        return externalSessionsError('invalid_request', validatedSource.error) satisfies ExternalSessionFollowPolicySetResponse;
    }

    let providerOps: Awaited<ReturnType<typeof resolveExternalSessionSurfaceOps>>;
    try {
        providerOps = await resolveExternalSessionSurfaceOps(parsed.data.providerId);
    } catch (error) {
        return internalErrorResponse(
            'external_session_follow_policy_set.provider_ops',
            error,
            'follow_policy_set_failed',
        ) satisfies ExternalSessionFollowPolicySetResponse;
    }

    if (parsed.data.enabled && !providerOps.acquireFollowLease) {
        return externalSessionsError('provider_unavailable', 'background_follow_not_supported') satisfies ExternalSessionFollowPolicySetResponse;
    }

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
        return externalSessionsError('provider_unavailable', 'not_authenticated') satisfies ExternalSessionFollowPolicySetResponse;
    }

    try {
        const rawSession = await fetchSessionById({
            token: credentials.token,
            sessionId: parsed.data.sessionId,
        }).catch(() => null);
        const updatedAtMs = Date.now();
        const persistFollowPolicy = async (): Promise<ExternalSessionFollowPolicySetResponse | null> => {
            if (!rawSession) {
                return null;
            }
            try {
                await updateSessionMetadataWithExternalSessionFollowPolicy({
                    token: credentials.token,
                    credentials,
                    sessionId: parsed.data.sessionId,
                    rawSession,
                    policy: parsed.data.enabled ? 'background_follow' : 'attached_only',
                    updatedAtMs,
                });
                return null;
            } catch (error) {
                return internalErrorResponse(
                    'external_session_follow_policy_set.persist',
                    error,
                    'follow_policy_persist_failed',
                ) satisfies ExternalSessionFollowPolicySetResponse;
            }
        };

        if (!parsed.data.enabled) {
            const persistError = await persistFollowPolicy();
            if (persistError) {
                return persistError;
            }
        }

        await context.followLeaseManager.setBackgroundFollowEnabled({
            sessionId: parsed.data.sessionId,
            enabled: parsed.data.enabled,
            acquireFollowLease: parsed.data.enabled && providerOps.acquireFollowLease
                ? async () => createManagedExternalSessionFollowLease({
                    sessionId: parsed.data.sessionId,
                    reason: 'background_follow',
                    acquireProviderFollowLease: () => providerOps.acquireFollowLease!({
                        source: validatedSource.source,
                        remoteSessionId: parsed.data.remoteSessionId,
                        reason: 'background_follow',
                        linkedSessionId: parsed.data.sessionId,
                    }),
                    emitExternalSessionTranscriptUpdate: context.emitExternalSessionTranscriptUpdate,
                    shouldProcessBackgroundFollowEffects: () =>
                        context.followLeaseManager.isBackgroundFollowEnabled(parsed.data.sessionId)
                        && context.followLeaseManager.countActiveLeases(parsed.data.sessionId) === 0,
                })
                : undefined,
        });

        if (parsed.data.enabled) {
            const persistError = await persistFollowPolicy();
            if (persistError) {
                await context.followLeaseManager.setBackgroundFollowEnabled({
                    sessionId: parsed.data.sessionId,
                    enabled: false,
                }).catch(() => {});
                return persistError;
            }
        }

        return {
            ok: true,
            enabled: parsed.data.enabled,
            leaseActive: context.followLeaseManager.hasBackgroundFollowLease(parsed.data.sessionId)
                || context.followLeaseManager.countActiveLeases(parsed.data.sessionId) > 0,
            updatedAtMs,
        } satisfies ExternalSessionFollowPolicySetResponse;
    } catch (error) {
        return internalErrorResponse(
            'external_session_follow_policy_set',
            error,
            'follow_policy_set_failed',
        ) satisfies ExternalSessionFollowPolicySetResponse;
    }
}
