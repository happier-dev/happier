import {
    ExternalSessionStatusGetRequestSchema,
    type ExternalAgentObservationSnapshotV1,
    type ExternalSessionStatusGetResponse,
} from '@happier-dev/protocol';

import {
    resolveExternalSessionObservationLinkInput,
} from '@/api/session/external/leases/resolveExternalSessionObservationLinkInput';
import { inspectExternalSessionDestructiveQuiescence } from '@/api/session/external/takeover/inspectExternalSessionDestructiveQuiescence';
import {
    loadLinkedExternalSession,
    type LoadedLinkedExternalSession,
} from '@/api/session/external/takeover/loadLinkedExternalSession';
import { isExternalTakeoverLaunchAvailable } from '@/api/session/external/takeover/resolveExternalTakeoverSpawnOptions';
import {
    resolveExternalLinkedTakeoverWriterSafety,
} from '@/api/session/external/takeover/resolveExternalLinkedTakeoverWriterSafety';
import { validateExternalMachineSource } from '@/api/session/external/security/validateExternalMachineSource';
import { readStoredCredentials } from '@/persistence';

import type { ExternalSessionActionContext } from './externalSessionActionContext';
import {
    isExternalSessionHostedAdmissionAvailable,
} from './importActivationFence';
import {
    externalSessionsError,
    internalErrorResponse,
    mapExternalSessionProviderFailureToExternalSessionsError,
} from './responseErrors';

function mapExternalAgentSnapshotToLegacyActivity(
    snapshot: ExternalAgentObservationSnapshotV1 | null,
): 'running' | 'active_recently' | 'idle' | 'unknown' {
    switch (snapshot?.status) {
        case 'working':
            return 'running';
        case 'recentlyActive':
            return 'active_recently';
        case 'idle':
            return 'idle';
        case 'waiting':
        case 'retrying':
        case 'unknown':
        case undefined:
            return 'unknown';
    }
}

async function reconcileExternalAgentStatus(params: Readonly<{
    context: ExternalSessionActionContext;
    linked: LoadedLinkedExternalSession;
    sessionId: string;
}>): Promise<ExternalAgentObservationSnapshotV1 | null> {
    const statusLinkInput = await resolveExternalSessionObservationLinkInput({
        linked: params.linked,
        sessionId: params.sessionId,
    });

    if (!statusLinkInput) return null;
    try {
        const result = await params.context.observationProjection.reconcileStatusLink(
            statusLinkInput,
        );
        return result.snapshot;
    } catch {
        return null;
    }
}

export async function executeExternalSessionStatusGetAction(
    raw: unknown,
    context: ExternalSessionActionContext,
): Promise<ExternalSessionStatusGetResponse> {
    const parsed = ExternalSessionStatusGetRequestSchema.safeParse(raw);
    if (!parsed.success) return externalSessionsError('invalid_request') satisfies ExternalSessionStatusGetResponse;
    let linked: LoadedLinkedExternalSession | null = null;
    let canTakeOverPersist = false;
    try {
        const credentials = await readStoredCredentials().catch(() => null);
        if (credentials) {
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
            if (loaded.ok) {
                let validatedSource: Awaited<
                    ReturnType<typeof validateExternalMachineSource>
                >;
                try {
                    validatedSource = await validateExternalMachineSource({
                        agentId: loaded.session.agentId,
                        source: loaded.session.source,
                        env: process.env,
                    });
                } catch (error) {
                    const providerFailure = mapExternalSessionProviderFailureToExternalSessionsError(error);
                    if (providerFailure) return providerFailure satisfies ExternalSessionStatusGetResponse;
                    return internalErrorResponse(
                        'external_session_status_get.validate_source',
                        error,
                        'external_session_status_get_failed',
                    ) satisfies ExternalSessionStatusGetResponse;
                }
                if (!validatedSource.ok) {
                    return externalSessionsError(
                        validatedSource.errorCode ?? 'invalid_request',
                        validatedSource.error,
                    ) satisfies ExternalSessionStatusGetResponse;
                }
                linked = loaded.session;
            }
        }

        if (linked) {
            canTakeOverPersist = await isExternalTakeoverLaunchAvailable(
                linked.agentId,
            );
        }
    } catch {
        canTakeOverPersist = false;
    }

    const externalAgent = linked
        ? await reconcileExternalAgentStatus({
            context,
            linked,
            sessionId: parsed.data.sessionId,
        })
        : null;
    const activityValue = mapExternalAgentSnapshotToLegacyActivity(externalAgent);
    const quiescence = linked
        ? await inspectExternalSessionDestructiveQuiescence({
            linked,
            linkedSessionId: parsed.data.sessionId,
            machineId: parsed.data.machineId,
        })
        : null;
    const runnerActive = quiescence?.status === 'verified_running';
    const trustedPid = runnerActive
        ? quiescence.ownerMarker?.pid ?? null
        : null;
    let externalLinkedTakeoverWriterSafe = false;
    if (linked && quiescence?.permitsAdmission === true) {
        try {
            externalLinkedTakeoverWriterSafe =
                await resolveExternalLinkedTakeoverWriterSafety(linked.agentId)
                === 'native_prevention';
        } catch {
            externalLinkedTakeoverWriterSafe = false;
        }
    }
    let persistedTakeoverActivationAdmitted = false;
    if (canTakeOverPersist && quiescence?.permitsAdmission === true) {
        try {
            persistedTakeoverActivationAdmitted =
                isExternalSessionHostedAdmissionAvailable(
                    context.getServerFeaturesSnapshot?.(),
                );
        } catch {
            persistedTakeoverActivationAdmitted = false;
        }
    }

    return {
        ok: true,
        machineOnline: true,
        runnerActive,
        activity: activityValue,
        canTakeOverDirect:
            quiescence?.permitsAdmission === true
            && externalLinkedTakeoverWriterSafe,
        canTakeOverPersist: persistedTakeoverActivationAdmitted,
        canForceStop: false,
        trustedPid,
        externalAgent,
        ...(externalAgent?.status === 'recentlyActive'
            ? { lastKnownActivityAtMs: externalAgent.observedAtMs }
            : {}),
    } satisfies ExternalSessionStatusGetResponse;
}
