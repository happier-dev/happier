import * as React from 'react';

import type {
    DaemonLocalServiceLauncherStartRequestV1,
    RuntimeActionExecute,
} from '@happier-dev/protocol';
import { DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol';

import type {
    LocalServiceLauncherSnapshot,
    LocalServiceLaunchTarget,
} from '@/sync/domains/local/services/launch';

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
}>): DaemonLocalServiceLauncherStartRequestV1 {
    const machineId = normalizeNonEmptyString(input.target.machineId)
        ?? normalizeNonEmptyString(input.machineId)
        ?? '';
    const sessionId = normalizeNonEmptyString(input.sessionId)
        ?? normalizeNonEmptyString(input.target.sessionId);
    const workspaceId = normalizeNonEmptyString(input.workspaceId)
        ?? normalizeNonEmptyString(input.target.workspaceId);

    return {
        machineId,
        targetId: input.target.id,
        ...(sessionId ? { sessionId } : {}),
        ...(workspaceId ? { workspaceId } : {}),
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
    }>,
): ((target: LocalServiceLaunchTarget) => Promise<unknown>) | undefined {
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
        return async (target: LocalServiceLaunchTarget) => {
            if (!hasStartAction(target)) {
                return undefined;
            }
            const request = buildLocalServiceLauncherStartRequest({
                target,
                machineId,
                sessionId,
                workspaceId,
            });
            if (!normalizeNonEmptyString(request.machineId) || !normalizeNonEmptyString(request.targetId)) {
                return undefined;
            }
            const result = await runtimeActionExecute({
                actionId: 'localServices.launcher.start',
                input: request,
                context: {
                    ...(sessionId ? { defaultSessionId: sessionId } : {}),
                    ...(serverId ? { serverId } : {}),
                    surface: 'ui',
                },
            });
            const snapshot = readSuccessfulLocalServiceLauncherStartSnapshot(result, request);
            if (snapshot) {
                applyLauncherSnapshot?.(snapshot);
            }
            return result;
        };
    }, [applyLauncherSnapshot, machineId, runtimeActionExecute, serverId, sessionId, workspaceId]);
}
