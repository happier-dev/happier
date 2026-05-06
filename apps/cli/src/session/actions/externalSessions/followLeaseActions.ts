import {
    DirectSessionAttachRequestSchema,
    DirectSessionDetachRequestSchema,
    DirectSessionFollowPolicySetRequestSchema,
    type DirectSessionAttachResponse,
    type DirectSessionDetachResponse,
    type DirectSessionFollowPolicySetResponse,
} from '@happier-dev/protocol';

import { createManagedDirectSessionFollowLease } from '@/api/session/external/backgroundFollow/createManagedDirectSessionFollowLease';
import { updateSessionMetadataWithDirectSessionFollowPolicy } from '@/api/session/external/backgroundFollow/directSessionBackgroundFollowMetadata';
import { validateDirectMachineSource } from '@/api/session/external/security/validateDirectMachineSource';
import { readCredentials } from '@/persistence';
import { fetchSessionById } from '@/session/transport/http/sessionsHttp';

import { resolveDirectSessionAttachLeaseTtlMs } from './actionConfiguration';
import type { ExternalSessionActionContext } from './externalSessionActionContext';
import { getDirectSessionProviderOps } from './providerOpsResolution';
import { directSessionsError, internalErrorResponse } from './responseErrors';

export async function executeExternalSessionAttachAction(
    raw: unknown,
    context: ExternalSessionActionContext,
): Promise<DirectSessionAttachResponse> {
    const parsed = DirectSessionAttachRequestSchema.safeParse(raw);
    if (!parsed.success) return directSessionsError('invalid_request') satisfies DirectSessionAttachResponse;
    let validatedSource: Awaited<ReturnType<typeof validateDirectMachineSource>>;
    try {
        validatedSource = await validateDirectMachineSource({
            providerId: parsed.data.providerId,
            source: parsed.data.source,
            env: process.env,
        });
    } catch (error) {
        return internalErrorResponse('direct_session_attach.validate_source', error, 'direct_session_attach_failed') satisfies DirectSessionAttachResponse;
    }
    if (!validatedSource.ok) {
        return directSessionsError('invalid_request', validatedSource.error) satisfies DirectSessionAttachResponse;
    }
    try {
        const providerOps = await getDirectSessionProviderOps(parsed.data.providerId);
        const attached = await context.followLeaseManager.attach({
            sessionId: parsed.data.sessionId,
            leaseId: parsed.data.leaseId,
            ttlMs: resolveDirectSessionAttachLeaseTtlMs(parsed.data.ttlMs),
            acquireFollowLease: providerOps.acquireFollowLease
                ? async () => {
                    return createManagedDirectSessionFollowLease({
                        sessionId: parsed.data.sessionId,
                        reason: 'attached_view',
                        acquireProviderFollowLease: () => providerOps.acquireFollowLease!({
                            source: validatedSource.source,
                            remoteSessionId: parsed.data.remoteSessionId,
                            reason: 'attached_view',
                        }),
                        emitDirectSessionTranscriptUpdate: context.emitDirectSessionTranscriptUpdate,
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
        } satisfies DirectSessionAttachResponse;
    } catch (error) {
        return internalErrorResponse('direct_session_attach', error, 'direct_session_attach_failed') satisfies DirectSessionAttachResponse;
    }
}

export async function executeExternalSessionDetachAction(
    raw: unknown,
    context: ExternalSessionActionContext,
): Promise<DirectSessionDetachResponse> {
    const parsed = DirectSessionDetachRequestSchema.safeParse(raw);
    if (!parsed.success) return directSessionsError('invalid_request') satisfies DirectSessionDetachResponse;
    const detached = await context.followLeaseManager.detach({
        sessionId: parsed.data.sessionId,
        leaseId: parsed.data.leaseId,
    });
    return {
        ok: true,
        detached: detached.detached,
    } satisfies DirectSessionDetachResponse;
}

export async function executeExternalSessionFollowPolicySetAction(
    raw: unknown,
    context: ExternalSessionActionContext,
): Promise<DirectSessionFollowPolicySetResponse> {
    const parsed = DirectSessionFollowPolicySetRequestSchema.safeParse(raw);
    if (!parsed.success) return directSessionsError('invalid_request') satisfies DirectSessionFollowPolicySetResponse;
    let validatedSource: Awaited<ReturnType<typeof validateDirectMachineSource>>;
    try {
        validatedSource = await validateDirectMachineSource({
            providerId: parsed.data.providerId,
            source: parsed.data.source,
            env: process.env,
        });
    } catch (error) {
        return internalErrorResponse(
            'direct_session_follow_policy_set.validate_source',
            error,
            'follow_policy_set_failed',
        ) satisfies DirectSessionFollowPolicySetResponse;
    }
    if (!validatedSource.ok) {
        return directSessionsError('invalid_request', validatedSource.error) satisfies DirectSessionFollowPolicySetResponse;
    }

    let providerOps: Awaited<ReturnType<typeof getDirectSessionProviderOps>>;
    try {
        providerOps = await getDirectSessionProviderOps(parsed.data.providerId);
    } catch (error) {
        return internalErrorResponse(
            'direct_session_follow_policy_set.provider_ops',
            error,
            'follow_policy_set_failed',
        ) satisfies DirectSessionFollowPolicySetResponse;
    }

    if (parsed.data.enabled && !providerOps.acquireFollowLease) {
        return directSessionsError('provider_unavailable', 'background_follow_not_supported') satisfies DirectSessionFollowPolicySetResponse;
    }

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
        return directSessionsError('provider_unavailable', 'not_authenticated') satisfies DirectSessionFollowPolicySetResponse;
    }

    try {
        const rawSession = await fetchSessionById({
            token: credentials.token,
            sessionId: parsed.data.sessionId,
        }).catch(() => null);
        const updatedAtMs = Date.now();
        const persistFollowPolicy = async (): Promise<DirectSessionFollowPolicySetResponse | null> => {
            if (!rawSession) {
                return null;
            }
            try {
                await updateSessionMetadataWithDirectSessionFollowPolicy({
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
                    'direct_session_follow_policy_set.persist',
                    error,
                    'follow_policy_persist_failed',
                ) satisfies DirectSessionFollowPolicySetResponse;
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
                ? async () => createManagedDirectSessionFollowLease({
                    sessionId: parsed.data.sessionId,
                    reason: 'background_follow',
                    acquireProviderFollowLease: () => providerOps.acquireFollowLease!({
                        source: validatedSource.source,
                        remoteSessionId: parsed.data.remoteSessionId,
                        reason: 'background_follow',
                    }),
                    emitDirectSessionTranscriptUpdate: context.emitDirectSessionTranscriptUpdate,
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
        } satisfies DirectSessionFollowPolicySetResponse;
    } catch (error) {
        return internalErrorResponse(
            'direct_session_follow_policy_set',
            error,
            'follow_policy_set_failed',
        ) satisfies DirectSessionFollowPolicySetResponse;
    }
}
