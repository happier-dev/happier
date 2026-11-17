import { recordFailureCause } from '@/diagnostics/recordFailureCause';
import { DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import type { DaemonLocalServiceLauncherStartRequestV1, DaemonLocalServiceLauncherStartResponseV1, LocalServiceLauncherSnapshotV1 } from '@happier-dev/protocol';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { RuntimeActionExecuteArgs } from '@happier-dev/protocol';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { LocalServiceManagedServiceActionTargetV1 } from '@happier-dev/protocol/local/services/actions/v1';
import type { LocalServiceNativePrerequisiteV1, LocalServiceEstablishmentFailureV1 } from '@happier-dev/protocol/local/services/launcher/v1';

import type { LocalServiceLauncherFeed } from './feed';
import type { LocalServiceLauncherHistoryStore } from './leaves';
import { logger } from '@/ui/logger';
import { projectActionFailureCauseV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { createLocalServiceLauncherSnapshotReader } from './snapshotReader';

export type LocalServiceLauncherStartTarget = (
    request: DaemonLocalServiceLauncherStartRequestV1,
    ingress?: RpcHandlerContext,
    actionContext?: RuntimeActionExecuteArgs['context'],
    executeCanonicalAction?: RuntimeActionExecuteArgs['executeCanonicalAction'],
) => Promise<DaemonLocalServiceLauncherStartResponseV1>;

export type LocalServiceLauncherStartResolution<TDeclaration = unknown> = Readonly<
    | { ok: true; declaration: TDeclaration }
    | { ok: false; reasonCode: string; prerequisite?: LocalServiceNativePrerequisiteV1; establishmentFailure?: LocalServiceEstablishmentFailureV1; reviewedEffect?: JsonValue; reviewedEffectDigest?: string }
>;

export type LocalServiceLauncherStartExecutionOutcome = Readonly<
    | { status: 'succeeded'; currentTarget?: LocalServiceManagedServiceActionTargetV1 }
    | { status: 'denied' | 'failed'; reasonCode: string; prerequisite?: LocalServiceNativePrerequisiteV1; establishmentFailure?: LocalServiceEstablishmentFailureV1; reviewedEffect?: JsonValue; reviewedEffectDigest?: string }
>;

export type CreateLocalServiceLauncherStartTargetInput<TDeclaration = unknown> = Readonly<{
    feed: Pick<LocalServiceLauncherFeed, 'getSnapshot'>;
    history?: Pick<LocalServiceLauncherHistoryStore, 'record'>;
    resolveStartTarget?: (
        request: DaemonLocalServiceLauncherStartRequestV1,
        ingress?: RpcHandlerContext,
        actionContext?: RuntimeActionExecuteArgs['context'],
        executeCanonicalAction?: RuntimeActionExecuteArgs['executeCanonicalAction'],
    ) => LocalServiceLauncherStartResolution<TDeclaration> | Promise<LocalServiceLauncherStartResolution<TDeclaration>>;
    startManagedDeclaration?: (
        declaration: TDeclaration,
        request: DaemonLocalServiceLauncherStartRequestV1,
        ingress?: RpcHandlerContext,
        actionContext?: RuntimeActionExecuteArgs['context'],
        executeCanonicalAction?: RuntimeActionExecuteArgs['executeCanonicalAction'],
    ) => Promise<LocalServiceLauncherStartExecutionOutcome>;
    now?: () => number;
}>;

function emptyRequestBoundSnapshot(
    request: DaemonLocalServiceLauncherStartRequestV1,
    updatedAt: number,
): LocalServiceLauncherSnapshotV1 {
    return {
        v: 1,
        machineId: request.machineId,
        ...(request.sessionId ? { sessionId: request.sessionId } : {}),
        updatedAt,
        targets: [],
    };
}

function bindSnapshotToRequest(
    snapshot: LocalServiceLauncherSnapshotV1,
    request: DaemonLocalServiceLauncherStartRequestV1,
): LocalServiceLauncherSnapshotV1 {
    if (snapshot.machineId === request.machineId) {
        return snapshot;
    }
    return emptyRequestBoundSnapshot(request, snapshot.updatedAt);
}

function response(input: Readonly<{
    request: DaemonLocalServiceLauncherStartRequestV1;
    status: DaemonLocalServiceLauncherStartResponseV1['status'];
    reasonCode?: string;
    prerequisite?: LocalServiceNativePrerequisiteV1;
    establishmentFailure?: LocalServiceEstablishmentFailureV1;
    reviewedEffect?: JsonValue;
    reviewedEffectDigest?: string;
    currentTarget?: LocalServiceManagedServiceActionTargetV1;
    snapshot: LocalServiceLauncherSnapshotV1;
}>): DaemonLocalServiceLauncherStartResponseV1 {
    return DaemonLocalServiceLauncherStartResponseV1Schema.parse({
        protocolVersion: 1,
        machineId: input.request.machineId,
        targetId: input.request.targetId,
        status: input.status,
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        ...(input.prerequisite ? { prerequisite: input.prerequisite } : {}),
        ...(input.establishmentFailure ? { establishmentFailure: input.establishmentFailure } : {}),
        ...(input.reviewedEffect !== undefined ? { reviewedEffect: input.reviewedEffect } : {}),
        ...(input.reviewedEffectDigest ? { reviewedEffectDigest: input.reviewedEffectDigest } : {}),
        ...(input.currentTarget ? { currentTarget: input.currentTarget } : {}),
        snapshot: input.snapshot,
    });
}

function targetScopeDenial(
    target: LocalServiceLauncherSnapshotV1['targets'][number] | undefined,
    request: DaemonLocalServiceLauncherStartRequestV1,
): string | null {
    if (!target) return null;
    if (target.machineId !== request.machineId) return 'wrong_machine';
    if (request.sessionId && target.sessionId && target.sessionId !== request.sessionId) {
        return 'wrong_session';
    }
    if (request.workspaceId && target.workspaceId && target.workspaceId !== request.workspaceId) {
        return 'wrong_workspace';
    }
    return null;
}

/** Complete a published selection; declaration admission still reads authoritative workspace files. */
export function completeLocalServiceLauncherStartRequest(
    request: DaemonLocalServiceLauncherStartRequestV1,
    snapshot: LocalServiceLauncherSnapshotV1,
): DaemonLocalServiceLauncherStartRequestV1 {
    if (request.workspace && request.declaration) return request;
    if (snapshot.machineId !== request.machineId) return request;
    const target = snapshot.targets.find(candidate => candidate.id === request.targetId);
    if (!target || targetScopeDenial(target, request)) return request;
    return { ...request,
        ...(request.workspace === undefined && target.workspace ? { workspace: target.workspace } : {}),
        ...(request.declaration === undefined && target.declaration ? { declaration: target.declaration } : {}),
    };
}


async function readSnapshot(
    input: Readonly<{ feed: Promise<Pick<LocalServiceLauncherFeed, 'getSnapshot'>> }>
        & Pick<CreateLocalServiceLauncherStartTargetInput, 'now'>,
    request: DaemonLocalServiceLauncherStartRequestV1,
    actualWorkspaceId?: string,
    managedBindingsOnly = false,
    cachedDiscovery = false,
): Promise<Readonly<
    | { ok: true; snapshot: LocalServiceLauncherSnapshotV1; machineMatches: boolean }
    | { ok: false; response: DaemonLocalServiceLauncherStartResponseV1 }
>> {
    try {
        const feed = await input.feed;
        const rawSnapshot = await feed.getSnapshot({
            ...(request.sessionId ? { sessionId: request.sessionId } : {}),
            // Exact Project declarations are freshly admitted by the declaration
            // owner below. Listener/suggestion discovery contributes no authority;
            // retain the supervisor's current binding and scope checks directly.
            ...(managedBindingsOnly ? { projection: 'managed_bindings' as const } : {}),
            ...(cachedDiscovery ? { discovery: 'cached' as const } : {}),
            ...(actualWorkspaceId ? { scope: 'machine' as const }
                : request.workspace ? { workspaceRoot: request.workspace.rootPath } : {}),
        });
        const scopedSnapshot = actualWorkspaceId
            ? { ...rawSnapshot, targets: rawSnapshot.targets.filter(target => target.workspaceId === actualWorkspaceId) }
            : rawSnapshot;
        return {
            ok: true,
            snapshot: bindSnapshotToRequest(scopedSnapshot, request),
            machineMatches: rawSnapshot.machineId === request.machineId,
        };
    } catch (error) {
        const credentialsUnavailable = error instanceof Error && error.message === 'requester_credentials_unavailable';
        return {
            ok: false,
            response: recordFailureCause(error, credentialsUnavailable ? 'service.launch.requester_credentials' : 'service.launch.snapshot', response({
                request,
                status: credentialsUnavailable ? 'denied' : 'failed',
                reasonCode: credentialsUnavailable ? error.message : 'launcher_snapshot_unavailable',
                snapshot: emptyRequestBoundSnapshot(request, input.now?.() ?? Date.now()),
            })),
        };
    }
}

export function createLocalServiceLauncherStartTarget<TDeclaration = unknown>(
    input: CreateLocalServiceLauncherStartTargetInput<TDeclaration>,
): LocalServiceLauncherStartTarget {
    const now = input.now ?? (() => Date.now());
    return async (request, ingress, actionContext, executeCanonicalAction) => {
        const snapshotInput = { feed: createLocalServiceLauncherSnapshotReader({
            feed: input.feed, machineId: request.machineId, ingress, serverId: actionContext?.serverId, readScope: 'requester_managed_services',
        }), now };
        const phase = async <T>(name: string, read: () => T | Promise<T>): Promise<T> => {
            const startedAt = performance.now();
            let status: 'completed' | 'failed' = 'failed';
            try { const result = await read(); status = 'completed'; return result; }
            finally { logger.debug('[ProjectService] launch phase', { phase: name, status,
                requestId: actionContext?.actionRequestId, machineId: request.machineId, targetId: request.targetId,
                durationMs: Math.round(performance.now() - startedAt) }); }
        };
        const suppliedDeclaration = request.workspace !== undefined && request.declaration !== undefined;
        // Start consumes the target already published by discovery. Re-discovering
        // every Machine package here adds no execution authority; the declaration
        // owner freshly admits the selected workspace and manifest below.
        const snapshotResult = await phase('launcher_snapshot', () => readSnapshot(snapshotInput, request, undefined, suppliedDeclaration, request.workspace === undefined));
        if (!snapshotResult.ok) {
            return snapshotResult.response;
        }
        const snapshot = snapshotResult.snapshot;
        request = completeLocalServiceLauncherStartRequest(request, snapshot);
        const exactDeclaration = request.workspace !== undefined && request.declaration !== undefined;
        const respond = async (value: Parameters<typeof response>[0]) => {
            if (!exactDeclaration) return response(value);
            // Action responses are published as complete launcher snapshots by
            // clients. A mutation-only preflight projection must not erase sibling
            // declarations or presentation targets from that response.
            const complete = await phase('response_snapshot', () => readSnapshot(snapshotInput, request, undefined, false, true));
            return response({ ...value, snapshot: complete.ok ? complete.snapshot : emptyRequestBoundSnapshot(request, now()) });
        };
        if (!snapshotResult.machineMatches) {
            return respond({
                request,
                status: 'denied',
                reasonCode: 'wrong_machine',
                snapshot,
            });
        }

        const target = snapshot.targets.find((candidate) => candidate.id === request.targetId);
        const resolution = await phase('declaration_review', () => input.resolveStartTarget?.(request, ingress, actionContext, executeCanonicalAction));
        if (resolution && !resolution.ok && resolution.reasonCode !== 'launcher_target_unknown') {
            return respond({
                request,
                status: 'denied',
                reasonCode: resolution.reasonCode,
                ...(resolution.prerequisite ? { prerequisite: resolution.prerequisite } : {}),
                ...(resolution.reviewedEffect !== undefined ? { reviewedEffect: resolution.reviewedEffect } : {}),
                ...(resolution.reviewedEffectDigest ? { reviewedEffectDigest: resolution.reviewedEffectDigest } : {}),
                snapshot,
            });
        }

        const scopeDenial = targetScopeDenial(target, request);
        if (scopeDenial) {
            return respond({ request, status: 'denied', reasonCode: scopeDenial, snapshot });
        }
        // Presentation/history is not execution authority. Only a fresh admitted Project
        // declaration may start without an enabled or visible suggestion.
        const admittedProjectDeclaration = resolution?.ok === true && request.workspace !== undefined && request.declaration !== undefined;
        if (!target && !admittedProjectDeclaration) {
            return respond({
                request,
                status: 'denied',
                reasonCode: resolution?.ok ? 'launcher_start_unsupported' : 'launcher_target_unknown',
                snapshot,
            });
        }
        if (target?.source === 'package_script' && !admittedProjectDeclaration) {
            return respond({
                request,
                status: 'denied',
                reasonCode: 'package_script_start_unavailable',
                snapshot,
            });
        }
        if (target && !target.actions.includes('start') && !admittedProjectDeclaration) {
            return respond({
                request,
                status: 'denied',
                reasonCode: 'launcher_start_unsupported',
                snapshot,
            });
        }
        if (!resolution?.ok || !input.startManagedDeclaration) {
            return respond({
                request,
                status: 'denied',
                reasonCode: 'launcher_start_declaration_unavailable',
                snapshot,
            });
        }

        let outcome: LocalServiceLauncherStartExecutionOutcome;
        try {
            outcome = await phase('managed_start', () => input.startManagedDeclaration!(resolution.declaration, request, ingress, actionContext, executeCanonicalAction));
        } catch (error) {
            logger.warnLocalFile('[local-service] Start failed', projectActionFailureCauseV1(error, 'local_service.start', { allowUnknownErrorCode: false }));
            outcome = { status: 'failed', reasonCode: 'managed_start_failed' };
        }
        if (outcome.status === 'succeeded') input.history?.record(request.targetId);

        // The supervisor has just settled readiness. Return its current state with
        // every admitted sibling target; unrelated listener discovery is not a
        // prerequisite for acknowledging this exact Project mutation.
        const postStartSnapshot = await phase('response_snapshot', () => readSnapshot(snapshotInput, request,
            outcome.status === 'succeeded' && request.workspace?.machineId !== request.machineId
                ? outcome.currentTarget?.workspaceId : undefined, false, exactDeclaration));
        const responseSnapshot = postStartSnapshot.ok
            ? postStartSnapshot.snapshot
            : emptyRequestBoundSnapshot(request, now());
        return response({
            request,
            // A denial above precedes Service establishment. Once the native
            // starter is invoked, failure may retain cleanup custody; preserve
            // that distinction for Move and other callers observing Start.
            status: outcome.status === 'denied' ? 'failed' : outcome.status,
            ...(outcome.status === 'succeeded' ? {} : { reasonCode: outcome.reasonCode }),
            ...(outcome.status !== 'succeeded' && outcome.prerequisite ? { prerequisite: outcome.prerequisite } : {}),
            ...(outcome.status !== 'succeeded' && outcome.establishmentFailure ? { establishmentFailure: outcome.establishmentFailure } : {}),
            ...(outcome.status === 'succeeded' && outcome.currentTarget ? { currentTarget: outcome.currentTarget } : {}),
            ...(outcome.status !== 'succeeded' && outcome.reviewedEffect !== undefined ? { reviewedEffect: outcome.reviewedEffect } : {}),
            ...(outcome.status !== 'succeeded' && outcome.reviewedEffectDigest ? { reviewedEffectDigest: outcome.reviewedEffectDigest } : {}),
            snapshot: responseSnapshot,
        });
    };
}
