import { DaemonLocalServiceLauncherStartResponseV1Schema } from '@happier-dev/protocol/local/services/launcher/v1';
import type { DaemonLocalServiceLauncherStartRequestV1, DaemonLocalServiceLauncherStartResponseV1, LocalServiceLauncherSnapshotV1 } from '@happier-dev/protocol';
import type { RpcHandlerContext } from '@/api/rpc/types';
import type { RuntimeActionExecuteArgs } from '@happier-dev/protocol';
import type { JsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import type { LocalServiceManagedServiceActionTargetV1 } from '@happier-dev/protocol/local/services/actions/v1';

import type { LocalServiceLauncherFeed } from './feed';
import type { LocalServiceLauncherHistoryStore } from './leaves';

export type LocalServiceLauncherStartTarget = (
    request: DaemonLocalServiceLauncherStartRequestV1,
    ingress?: RpcHandlerContext,
    actionContext?: RuntimeActionExecuteArgs['context'],
    executeCanonicalAction?: RuntimeActionExecuteArgs['executeCanonicalAction'],
) => Promise<DaemonLocalServiceLauncherStartResponseV1>;

export type LocalServiceLauncherStartResolution<TDeclaration = unknown> = Readonly<
    | { ok: true; declaration: TDeclaration }
    | { ok: false; reasonCode: string; reviewedEffect?: JsonValue; reviewedEffectDigest?: string }
>;

export type LocalServiceLauncherStartExecutionOutcome = Readonly<
    | { status: 'succeeded'; currentTarget?: LocalServiceManagedServiceActionTargetV1 }
    | { status: 'denied' | 'failed'; reasonCode: string; reviewedEffect?: JsonValue; reviewedEffectDigest?: string }
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

async function readSnapshot(
    input: Pick<CreateLocalServiceLauncherStartTargetInput, 'feed' | 'now'>,
    request: DaemonLocalServiceLauncherStartRequestV1,
    actualWorkspaceId?: string,
): Promise<Readonly<
    | { ok: true; snapshot: LocalServiceLauncherSnapshotV1; machineMatches: boolean }
    | { ok: false; response: DaemonLocalServiceLauncherStartResponseV1 }
>> {
    try {
        const rawSnapshot = await input.feed.getSnapshot({
            ...(request.sessionId ? { sessionId: request.sessionId } : {}),
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
    } catch {
        return {
            ok: false,
            response: response({
                request,
                status: 'failed',
                reasonCode: 'launcher_snapshot_unavailable',
                snapshot: emptyRequestBoundSnapshot(request, input.now?.() ?? Date.now()),
            }),
        };
    }
}

export function createLocalServiceLauncherStartTarget<TDeclaration = unknown>(
    input: CreateLocalServiceLauncherStartTargetInput<TDeclaration>,
): LocalServiceLauncherStartTarget {
    const now = input.now ?? (() => Date.now());
    return async (request, ingress, actionContext, executeCanonicalAction) => {
        const snapshotResult = await readSnapshot({ feed: input.feed, now }, request);
        if (!snapshotResult.ok) {
            return snapshotResult.response;
        }
        const snapshot = snapshotResult.snapshot;
        if (!snapshotResult.machineMatches) {
            return response({
                request,
                status: 'denied',
                reasonCode: 'wrong_machine',
                snapshot,
            });
        }

        const target = snapshot.targets.find((candidate) => candidate.id === request.targetId);
        const resolution = await input.resolveStartTarget?.(request, ingress, actionContext, executeCanonicalAction);
        if (resolution && !resolution.ok && resolution.reasonCode !== 'launcher_target_unknown') {
            return response({
                request,
                status: 'denied',
                reasonCode: resolution.reasonCode,
                ...(resolution.reviewedEffect !== undefined ? { reviewedEffect: resolution.reviewedEffect } : {}),
                ...(resolution.reviewedEffectDigest ? { reviewedEffectDigest: resolution.reviewedEffectDigest } : {}),
                snapshot,
            });
        }

        const scopeDenial = targetScopeDenial(target, request);
        if (scopeDenial) {
            return response({ request, status: 'denied', reasonCode: scopeDenial, snapshot });
        }
        // Presentation/history is not execution authority. Only a fresh admitted Project
        // declaration may start without an enabled or visible suggestion.
        const admittedProjectDeclaration = resolution?.ok === true && request.workspace !== undefined && request.declaration !== undefined;
        if (!target && !admittedProjectDeclaration) {
            return response({
                request,
                status: 'denied',
                reasonCode: resolution?.ok ? 'launcher_start_unsupported' : 'launcher_target_unknown',
                snapshot,
            });
        }
        if (target?.source === 'package_script' && !admittedProjectDeclaration) {
            return response({
                request,
                status: 'denied',
                reasonCode: 'package_script_start_unavailable',
                snapshot,
            });
        }
        if (target && !target.actions.includes('start') && !admittedProjectDeclaration) {
            return response({
                request,
                status: 'denied',
                reasonCode: 'launcher_start_unsupported',
                snapshot,
            });
        }
        if (!resolution?.ok || !input.startManagedDeclaration) {
            return response({
                request,
                status: 'denied',
                reasonCode: 'launcher_start_declaration_unavailable',
                snapshot,
            });
        }

        let outcome: LocalServiceLauncherStartExecutionOutcome;
        try {
            outcome = await input.startManagedDeclaration(resolution.declaration, request, ingress, actionContext, executeCanonicalAction);
        } catch {
            outcome = { status: 'failed', reasonCode: 'managed_start_failed' };
        }
        if (outcome.status === 'succeeded') input.history?.record(request.targetId);

        const postStartSnapshot = await readSnapshot({ feed: input.feed, now }, request,
            outcome.status === 'succeeded' && request.workspace?.machineId !== request.machineId
                ? outcome.currentTarget?.workspaceId : undefined);
        const responseSnapshot = postStartSnapshot.ok
            ? postStartSnapshot.snapshot
            : emptyRequestBoundSnapshot(request, now());
        return response({
            request,
            status: outcome.status,
            ...(outcome.status === 'succeeded' ? {} : { reasonCode: outcome.reasonCode }),
            ...(outcome.status === 'succeeded' && outcome.currentTarget ? { currentTarget: outcome.currentTarget } : {}),
            ...(outcome.status !== 'succeeded' && outcome.reviewedEffect !== undefined ? { reviewedEffect: outcome.reviewedEffect } : {}),
            ...(outcome.status !== 'succeeded' && outcome.reviewedEffectDigest ? { reviewedEffectDigest: outcome.reviewedEffectDigest } : {}),
            snapshot: responseSnapshot,
        });
    };
}
