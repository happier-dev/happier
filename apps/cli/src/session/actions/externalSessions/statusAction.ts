import {
    ExternalSessionStatusGetRequestSchema,
    type ExternalSessionStatusGetResponse,
} from '@happier-dev/protocol';

import { listSessionMarkers } from '@/daemon/sessionRegistry';
import { findTrustedExternalSessionOwner } from '@/api/session/external/takeover/findTrustedExternalSessionOwner';
import { loadLinkedExternalSession } from '@/api/session/external/takeover/loadLinkedExternalSession';
import { resolveDirectTakeoverSpawnOptions } from '@/api/session/external/takeover/resolveDirectTakeoverSpawnOptions';
import { validateDirectMachineSource } from '@/api/session/external/security/validateDirectMachineSource';
import { readCredentials } from '@/persistence';

import { resolveRecentActivityWindowMs } from './actionConfiguration';
import type { ExternalSessionActionContext } from './externalSessionActionContext';
import { resolveExternalSessionSurfaceOps } from './providerOpsResolution';
import { isPidAlive } from './processLiveness';
import { externalSessionsError, internalErrorResponse } from './responseErrors';

export async function executeExternalSessionStatusGetAction(
    raw: unknown,
    context: ExternalSessionActionContext,
): Promise<ExternalSessionStatusGetResponse> {
    const parsed = ExternalSessionStatusGetRequestSchema.safeParse(raw);
    if (!parsed.success) return externalSessionsError('invalid_request') satisfies ExternalSessionStatusGetResponse;
    let validatedSource: Awaited<ReturnType<typeof validateDirectMachineSource>>;
    try {
        validatedSource = await validateDirectMachineSource({
            providerId: parsed.data.providerId,
            source: parsed.data.source,
            env: process.env,
        });
    } catch (error) {
        return internalErrorResponse(
            'external_session_status_get.validate_source',
            error,
            'external_session_status_get_failed',
        ) satisfies ExternalSessionStatusGetResponse;
    }
    if (!validatedSource.ok) {
        return externalSessionsError('invalid_request', validatedSource.error) satisfies ExternalSessionStatusGetResponse;
    }
    const nowMs = Date.now();
    const recentWindowMs = resolveRecentActivityWindowMs();
    let activityValue: 'running' | 'active_recently' | 'idle' | 'unknown' = 'unknown';
    let lastKnownActivityAtMs: number | undefined = undefined;
    let runnerActive = false;
    let trustedPid: number | null = null;
    let canForceStop = false;

    const markers = await listSessionMarkers().catch(() => []);
    const liveMarkers = markers.filter((m) => Number.isFinite(m.pid) && m.pid > 0 && isPidAlive(m.pid));

    runnerActive = liveMarkers.some((m) => m.happySessionId === parsed.data.sessionId);

    if (!runnerActive) {
        const owner = findTrustedExternalSessionOwner({
            markers: liveMarkers,
            providerId: parsed.data.providerId,
            remoteSessionId: parsed.data.remoteSessionId,
            isPidAlive,
        });
        if (owner) {
            trustedPid = owner.pid;
            canForceStop = true;
        }
    }

    try {
        const providerOps = await resolveExternalSessionSurfaceOps(parsed.data.providerId);
        const res = providerOps.getActivity
            ? await providerOps.getActivity({
            source: validatedSource.source,
            remoteSessionId: parsed.data.remoteSessionId,
        })
            : null;
        if (!res) {
            throw new Error('external_session_activity_not_supported');
        }
        if (typeof res.lastActivityAtMs === 'number' && Number.isFinite(res.lastActivityAtMs) && res.lastActivityAtMs >= 0) {
            lastKnownActivityAtMs = res.lastActivityAtMs;
            const ageMs = nowMs - res.lastActivityAtMs;
            activityValue = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= recentWindowMs ? 'active_recently' : 'idle';
        }
        if (res.isRunning) {
            activityValue = 'running';
        }
    } catch {
        activityValue = 'unknown';
    }

    if (runnerActive) {
        activityValue = 'running';
    }

    const cachedTakeoverReadiness = context.takeoverReadiness.read(parsed.data.sessionId);
    let canTakeOverPersist = cachedTakeoverReadiness ?? true;
    if (cachedTakeoverReadiness === null) {
        try {
            const credentials = await readCredentials().catch(() => null);
            if (!credentials) {
                canTakeOverPersist = false;
            } else {
                const linked = await loadLinkedExternalSession({
                    credentials,
                    sessionId: parsed.data.sessionId,
                    machineId: parsed.data.machineId,
                });
                if (!linked.ok) {
                    canTakeOverPersist = false;
                } else {
                    const takeoverOptions = await resolveDirectTakeoverSpawnOptions({
                        linked: linked.session,
                        sessionId: parsed.data.sessionId,
                    });
                    canTakeOverPersist = takeoverOptions !== null;
                }
            }
        } catch {
            canTakeOverPersist = false;
        }
        context.takeoverReadiness.write(parsed.data.sessionId, canTakeOverPersist);
    }

    return {
        ok: true,
        machineOnline: true,
        runnerActive,
        activity: activityValue,
        canTakeOverDirect: !runnerActive,
        canTakeOverPersist,
        canForceStop,
        trustedPid,
        ...(lastKnownActivityAtMs !== undefined ? { lastKnownActivityAtMs } : {}),
    } satisfies ExternalSessionStatusGetResponse;
}
