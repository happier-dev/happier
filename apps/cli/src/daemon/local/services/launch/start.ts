import {
    DaemonLocalServiceLauncherStartResponseV1Schema,
    type DaemonLocalServiceLauncherStartRequestV1,
    type DaemonLocalServiceLauncherStartResponseV1,
    type LocalServiceLauncherSnapshotV1,
} from '@happier-dev/protocol';

import type { LocalServiceLauncherFeed } from './feed';

export type LocalServiceLauncherStartTarget = (
    request: DaemonLocalServiceLauncherStartRequestV1
) => Promise<DaemonLocalServiceLauncherStartResponseV1>;

export type LocalServiceLauncherStartResolution<TDeclaration = unknown> = Readonly<
    | { ok: true; declaration: TDeclaration }
    | { ok: false; reasonCode: string }
>;

export type LocalServiceLauncherStartExecutionOutcome = Readonly<
    | { status: 'succeeded' }
    | { status: 'denied' | 'failed'; reasonCode: string }
>;

export type CreateLocalServiceLauncherStartTargetInput<TDeclaration = unknown> = Readonly<{
    feed: Pick<LocalServiceLauncherFeed, 'getSnapshot'>;
    resolveStartTarget?: (
        request: DaemonLocalServiceLauncherStartRequestV1
    ) => LocalServiceLauncherStartResolution<TDeclaration>;
    startManagedDeclaration?: (
        declaration: TDeclaration,
        request: DaemonLocalServiceLauncherStartRequestV1
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
    snapshot: LocalServiceLauncherSnapshotV1;
}>): DaemonLocalServiceLauncherStartResponseV1 {
    return DaemonLocalServiceLauncherStartResponseV1Schema.parse({
        protocolVersion: 1,
        machineId: input.request.machineId,
        targetId: input.request.targetId,
        status: input.status,
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
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
): Promise<Readonly<
    | { ok: true; snapshot: LocalServiceLauncherSnapshotV1; machineMatches: boolean }
    | { ok: false; response: DaemonLocalServiceLauncherStartResponseV1 }
>> {
    try {
        const rawSnapshot = await input.feed.getSnapshot();
        return {
            ok: true,
            snapshot: bindSnapshotToRequest(rawSnapshot, request),
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
    return async (request) => {
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
        const resolution = input.resolveStartTarget?.(request);
        if (resolution && !resolution.ok && resolution.reasonCode !== 'launcher_target_unknown') {
            return response({
                request,
                status: 'denied',
                reasonCode: resolution.reasonCode,
                snapshot,
            });
        }

        const scopeDenial = targetScopeDenial(target, request);
        if (scopeDenial) {
            return response({ request, status: 'denied', reasonCode: scopeDenial, snapshot });
        }
        if (!target) {
            return response({
                request,
                status: 'denied',
                reasonCode: resolution?.ok ? 'launcher_start_unsupported' : 'launcher_target_unknown',
                snapshot,
            });
        }
        if (target?.source === 'package_script') {
            return response({
                request,
                status: 'denied',
                reasonCode: 'package_script_start_unavailable',
                snapshot,
            });
        }
        if (target && !target.actions.includes('start')) {
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
            outcome = await input.startManagedDeclaration(resolution.declaration, request);
        } catch {
            outcome = { status: 'failed', reasonCode: 'managed_start_failed' };
        }

        const postStartSnapshot = await readSnapshot({ feed: input.feed, now }, request);
        const responseSnapshot = postStartSnapshot.ok
            ? postStartSnapshot.snapshot
            : emptyRequestBoundSnapshot(request, now());
        return response({
            request,
            status: outcome.status,
            ...(outcome.status === 'succeeded' ? {} : { reasonCode: outcome.reasonCode }),
            snapshot: responseSnapshot,
        });
    };
}
