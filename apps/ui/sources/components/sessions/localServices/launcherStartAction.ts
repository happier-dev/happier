import * as React from 'react';

import type {
    DaemonLocalServiceLauncherStartRequestV1,
    RuntimeActionExecute,
} from '@happier-dev/protocol';
import { DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import type { ProjectExecutionChoiceV1 } from '@happier-dev/protocol/workspaces/projectWorkerPreferencesV1';

import type {
    LocalServiceLauncherSnapshot,
    LocalServiceLaunchTarget,
} from '@/sync/domains/local/services/launch';
import { executeLocalServiceActionWithAdmission, isLocalServiceActionAdmissionCurrent, readLocalServiceSetupConsentReview, type LocalServiceActionAdmission } from './localServiceActionAdmission';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';

function normalizeNonEmptyString(value: string | null | undefined): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
}

function hasStartAction(target: LocalServiceLaunchTarget): boolean {
    return target.actions.includes('start');
}

export function buildLocalServiceLauncherStartRequest(input: Readonly<{
    target: LocalServiceLaunchTarget;
    machineId?: string | null;
    sessionId?: string | null;
    workspaceId?: string | null;
    choice?: ProjectExecutionChoiceV1;
    expectedEffectDigest?: string;
}>): DaemonLocalServiceLauncherStartRequestV1 {
    const machineId = normalizeNonEmptyString(input.target.machineId)
        ?? normalizeNonEmptyString(input.machineId)
        ?? '';
    const sessionId = normalizeNonEmptyString(input.sessionId)
        ?? normalizeNonEmptyString(input.target.sessionId);
    const workspaceId = input.target.workspace?.workspaceId ?? normalizeNonEmptyString(input.workspaceId)
        ?? normalizeNonEmptyString(input.target.workspaceId);

    return {
        machineId,
        targetId: input.target.id,
        ...(sessionId ? { sessionId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(input.target.workspace ? { workspace: input.target.workspace } : {}),
        ...(input.target.declaration ? { declaration: input.target.declaration } : {}),
        ...(input.choice ? { choice: input.choice } : {}),
        ...(input.expectedEffectDigest ? { expectedEffectDigest: input.expectedEffectDigest } : {}),
    };
}

export function readSuccessfulLocalServiceLauncherStartSnapshot(
    value: unknown,
    request: DaemonLocalServiceLauncherStartRequestV1,
): LocalServiceLauncherSnapshot | null {
    const parsed = DaemonLocalServiceLauncherStartResponseV1Schema.safeParse(value);
    if (!parsed.success) return null;

    const response = parsed.data;
    if (
        response.status !== 'succeeded'
        || response.machineId !== request.machineId
        || response.targetId !== request.targetId
        || (request.sessionId && response.snapshot.sessionId !== request.sessionId)
    ) {
        return null;
    }

    return response.snapshot;
}

export function useLocalServiceLauncherStartAction(
    context: Readonly<{
        runtimeActionExecute?: RuntimeActionExecute | null;
        machineId?: string | null;
        sessionId?: string | null;
        workspaceId?: string | null;
        serverId?: string | null;
        applyLauncherSnapshot?: (snapshot: LocalServiceLauncherSnapshot) => void;
    }> & LocalServiceActionAdmission,
): ((target: LocalServiceLaunchTarget, choice?: ProjectExecutionChoiceV1, expectedEffectDigest?: string) => Promise<unknown>) | undefined {
    const machineId = normalizeNonEmptyString(context.machineId);
    const sessionId = normalizeNonEmptyString(context.sessionId);
    const workspaceId = normalizeNonEmptyString(context.workspaceId);
    const serverId = normalizeNonEmptyString(context.serverId);
    const runtimeActionExecute = context.runtimeActionExecute ?? undefined;
    const applyLauncherSnapshot = context.applyLauncherSnapshot;

    return React.useMemo(() => {
        if (!runtimeActionExecute) {
            return undefined;
        }
        return async (target: LocalServiceLaunchTarget, choice?: ProjectExecutionChoiceV1, expectedEffectDigest?: string) => {
            if (target.workspace && serverId && !areServerProfileIdentifiersEquivalent(target.workspace.serverId, serverId)) {
                return { ok: false, errorCode: 'server_scope_mismatch', error: 'server_scope_mismatch' };
            }
            if ((!hasStartAction(target) && !(target.workspace && target.declaration))
                || (target.source === 'package_script' && !(target.workspace && target.declaration))) {
                return undefined;
            }
            let request = buildLocalServiceLauncherStartRequest({
                target,
                machineId,
                sessionId,
                workspaceId,
                choice,
                expectedEffectDigest,
            });
            if (!normalizeNonEmptyString(request.machineId) || !normalizeNonEmptyString(request.targetId)) {
                return undefined;
            }
            const requestServerId = target.workspace?.serverId ?? serverId;
            const dispatch = () => executeLocalServiceActionWithAdmission({ execute: runtimeActionExecute, admission: context, request: {
                actionId: 'localServices.launcher.start',
                input: request,
                context: {
                    ...(sessionId ? { defaultSessionId: sessionId } : {}),
                    ...(requestServerId ? { serverId: requestServerId } : {}),
                    surface: 'ui',
                },
            } });
            let result = await dispatch();
            for (;;) {
                const review = DaemonLocalServiceLauncherStartResponseV1Schema.safeParse(result);
                const matchingResponse = review.success && review.data.machineId === request.machineId && review.data.targetId === request.targetId
                    ? review.data : undefined;
                const consent = readLocalServiceSetupConsentReview(result, matchingResponse);
                if (consent && context.reviewSetupConsent && isLocalServiceActionAdmissionCurrent(context)) {
                    const prepared = await context.reviewSetupConsent({ actionId: 'localServices.launcher.start', target, consent,
                        ...(context.signal ? { signal: context.signal } : {}) });
                    if (!prepared || !isLocalServiceActionAdmissionCurrent(context)) break;
                    result = await dispatch();
                    continue;
                }
                if (!review.success || review.data.machineId !== request.machineId || review.data.targetId !== request.targetId
                    || review.data.status !== 'denied' || !['project_service_effect_review_required', 'project_service_effect_changed'].includes(review.data.reasonCode ?? '')
                    || review.data.reviewedEffect === undefined || !review.data.reviewedEffectDigest || !context.reviewEffect
                    || !isLocalServiceActionAdmissionCurrent(context)) break;
                const accepted = await context.reviewEffect({ actionId: 'localServices.launcher.start', target,
                    reviewedEffect: review.data.reviewedEffect, reviewedEffectDigest: review.data.reviewedEffectDigest,
                    ...(context.signal ? { signal: context.signal } : {}),
                });
                if (!accepted || !isLocalServiceActionAdmissionCurrent(context)) break;
                request = { ...request, expectedEffectDigest: review.data.reviewedEffectDigest };
                result = await dispatch();
            }
            const snapshot = readSuccessfulLocalServiceLauncherStartSnapshot(result, request);
            if (snapshot) {
                applyLauncherSnapshot?.(snapshot);
            }
            return result;
        };
    }, [applyLauncherSnapshot, machineId, runtimeActionExecute, serverId, sessionId, workspaceId,
        context.expectedAccountId, context.signal, context.isCurrent, context.reviewEffect, context.reviewSetupConsent, context.onApprovalPending]);
}
