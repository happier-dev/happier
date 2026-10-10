import type { LocalServiceLauncherSnapshotV1, LocalServiceLaunchTargetV1 } from '@happier-dev/protocol';

import { expandHomeDirPath } from '../../../../utils/path/expandHomeDirPath';
import { isWorkspacePathWithin } from '../inventory/provenance';
import type { LocalServiceInventoryRegistry } from '../inventory/registry';
import { listLocalServicePreviewResources, type LocalServicePreviewRegistry } from '../preview/registry';
import type { LocalServiceLauncherRunTarget } from './runTargets';
import type { LocalServiceLauncherHistoryStore } from './leaves';
import { buildLocalServiceLauncherSnapshot, formatLocalServiceLauncherTitle } from './suggestions';
import type { createManagedServicesOwner, ProjectManagedServiceHandle } from '@/plugins/runtime/invocation/services/managedServicesOwner';

type ProjectManagedServicesFeed = Pick<ReturnType<typeof createManagedServicesOwner>, 'listProjectServices'>;

export type LocalServiceLauncherFeedSnapshotRequest = Readonly<{
    sessionId?: string;
    /** Host-only mutation read: an unresolved Workspace must not broaden to Machine scope. */
    requireWorkspaceScope?: true;
    projection?: 'managed_bindings';
    /** Explicit scope: `machine` skips workspace scoping; `workspace` (default) keeps it. */
    scope?: 'workspace' | 'machine';
    /** Session-less project scoping by repo root (canonicalized at this daemon boundary). */
    workspaceRoot?: string;
}>;

export type LocalServiceLauncherFeed = Readonly<{
    getSnapshot(request?: LocalServiceLauncherFeedSnapshotRequest): Promise<LocalServiceLauncherSnapshotV1>;
}>;

export type LocalServiceRunTargetsProvider =
    () => readonly LocalServiceLauncherRunTarget[] | Promise<readonly LocalServiceLauncherRunTarget[]>;

/**
 * Resolves the workspace PATH(s) a session id is anchored to. The feed turns a
 * per-request `sessionId` into a workspace-PATH scope (D1) — every service in that path
 * is kept regardless of which session started it; session is attribution, not a filter.
 */
export type LocalServiceSessionWorkspacePathsResolver =
    (sessionId: string) => readonly string[] | Promise<readonly string[]>;

export type CreateLocalServiceLauncherFeedInput = Readonly<{
    machineId: string;
    sessionId?: string;
    inventoryRegistry: LocalServiceInventoryRegistry;
    previewRegistry: LocalServicePreviewRegistry;
    runTargets?: readonly LocalServiceLauncherRunTarget[] | LocalServiceRunTargetsProvider;
    projectManagedServices?: ProjectManagedServicesFeed;
    history?: Pick<LocalServiceLauncherHistoryStore, 'isDismissed'>;
    onRunTargetsError?: (error: unknown) => void;
    terminateDetectedEnabled?: () => boolean;
    resolveSessionWorkspacePaths?: LocalServiceSessionWorkspacePathsResolver;
    now?: () => number;
}>;

function withoutLaunchActions(target: LocalServiceLaunchTargetV1): LocalServiceLaunchTargetV1 {
    const actions = target.actions.filter((action) => (
        action === 'terminate_detected' || action === 'register_preview' || action === 'open_preview'
    ));
    return actions.length === target.actions.length ? target : { ...target, actions };
}

function fenceExecutableAuthority(target: LocalServiceLaunchTargetV1): LocalServiceLaunchTargetV1 {
    // The feed does not own executable launch authority. Private-preview lifecycle actions
    // resolve an existing listener through the server access owner and remain reachable.
    return withoutLaunchActions(target);
}

function sourcePriority(target: LocalServiceLaunchTargetV1): number {
    if (target.source === 'managed_service' && target.serviceState !== 'stopped') return 0;
    if (target.source === 'registered_preview') return 0;
    if (target.source === 'inventory_entry' && target.browserTarget) return 1;
    if (target.source === 'inventory_entry') return 2;
    if (target.source === 'terminal_url') return 3;
    if (target.source === 'workspace_file_asset') return 4;
    if (target.source === 'recent') return 5;
    // Package scripts are inert suggestions (D6): rank lowest, below every running/openable
    // source, so static package.json reads never dominate actually-running services.
    if (target.source === 'package_script') return 6;
    return 7;
}

function managedTarget(handle: ProjectManagedServiceHandle): LocalServiceLaunchTargetV1 {
    const snapshot = handle.snapshot();
    const servingCurrent = handle.isCurrent();
    const selection = handle.declaration.selection;
    const unavailableReason = snapshot.state !== 'stopped' && snapshot.nativePhase === 'unknown'
        ? 'managed_service_native_state_unknown'
        : snapshot.state !== 'stopped' && snapshot.nativePhase === 'stopped'
            ? 'managed_service_native_cleanup_unconfirmed' : undefined;
    return {
        id: handle.serviceId, source: 'managed_service',
        sourceClass: { kind: 'managed_service', managedServiceId: handle.instanceId },
        machineId: handle.workspace.machineId, workspaceId: handle.workspace.id,
        workspace: { serverId: handle.workspace.serverId, workspaceId: handle.workspace.id,
            machineId: handle.workspace.machineId, rootPath: handle.workspace.rootPath },
        declaration: handle.declaration, cwd: handle.cwd,
        title: formatLocalServiceLauncherTitle(selection.kind === 'manifest' ? selection.name : selection.source.target),
        subtitle: handle.cwd, confidence: 'high',
        state: snapshot.state === 'starting' ? 'starting' : 'available',
        serviceState: snapshot.state,
        ...(unavailableReason ? { unavailableReason } : {}),
        ...(snapshot.startedAtMs !== null ? { startedAtMs: snapshot.startedAtMs } : {}),
        startedByAccountId: handle.requester.accountId,
        endpointKind: handle.endpointKind === 'none' && snapshot.baseUrl ? 'http' : handle.endpointKind,
        ...(snapshot.readiness ? { readiness: snapshot.readiness } : {}),
        ...(servingCurrent && !unavailableReason && snapshot.baseUrl ? { endpointUrl: snapshot.baseUrl } : {}),
        // Serving retirement does not settle native custody. The authenticated
        // Machine control path still owns Stop/retry for that exact occurrence.
        actions: snapshot.state !== 'stopped' ? ['manage'] : [],
    };
}

function sortTargets(targets: readonly LocalServiceLaunchTargetV1[]): readonly LocalServiceLaunchTargetV1[] {
    return [...targets].sort((a, b) => (
        sourcePriority(a) - sourcePriority(b)
        || a.title.localeCompare(b.title)
        || a.id.localeCompare(b.id)
    ));
}

async function resolveRunTargets(
    value: CreateLocalServiceLauncherFeedInput['runTargets'],
    onError: CreateLocalServiceLauncherFeedInput['onRunTargetsError'],
): Promise<readonly LocalServiceLauncherRunTarget[]> {
    if (!value) return [];
    if (typeof value !== 'function') return value;

    try {
        return await value();
    } catch (error) {
        onError?.(error);
        return [];
    }
}

async function resolveScopePaths(input: Readonly<{
    scope: 'workspace' | 'machine' | undefined;
    workspaceRoot: string | undefined;
    resolver: CreateLocalServiceLauncherFeedInput['resolveSessionWorkspacePaths'];
    sessionId: string | undefined;
}>): Promise<readonly string[] | undefined> {
    // Explicit machine scope: full machine view, no workspace filtering.
    if (input.scope === 'machine') {
        return undefined;
    }
    // Session-less project scoping: canonicalize the raw UI workspaceRoot at this daemon
    // boundary (expand `~/...`/`~\...`) before it is used for path containment. Never pass
    // a raw UI path straight into filtering (root path-canonicalization rule).
    if (input.workspaceRoot) {
        return [expandHomeDirPath(input.workspaceRoot)];
    }
    if (!input.resolver || !input.sessionId) return undefined;
    const paths = await input.resolver(input.sessionId);
    return paths.length > 0 ? paths : undefined;
}

export function createLocalServiceLauncherFeed(
    input: CreateLocalServiceLauncherFeedInput,
): LocalServiceLauncherFeed {
    const now = input.now ?? (() => Date.now());
    return {
        async getSnapshot(request) {
            if (request?.projection === 'managed_bindings' && !input.projectManagedServices) {
                throw Object.assign(new Error('Project Service binding owner is unavailable'), {
                    code: 'project_service_bindings_unavailable',
                });
            }
            const sessionId = request?.sessionId ?? input.sessionId;
            const workspaceScopePaths = await resolveScopePaths({
                scope: request?.scope,
                workspaceRoot: request?.workspaceRoot,
                resolver: input.resolveSessionWorkspacePaths,
                sessionId,
            });
            if (request?.requireWorkspaceScope && !workspaceScopePaths?.length) {
                throw Object.assign(new Error('Local service workspace scope is unavailable'), {
                    code: 'local_service_workspace_scope_unavailable',
                });
            }
            if (request?.projection === 'managed_bindings') {
                const targets = input.projectManagedServices!.listProjectServices({ requireComplete: true,
                    ...(workspaceScopePaths?.length === 1 ? { workspaceRoot: workspaceScopePaths[0] } : {}) })
                    .filter(handle => handle.isCurrent() && handle.workspace.machineId === input.machineId
                        && (!workspaceScopePaths || workspaceScopePaths.some(root => isWorkspacePathWithin(root, handle.cwd))))
                    .map(managedTarget);
                return { v: 1, machineId: input.machineId, updatedAt: now(), targets: sortTargets(targets) };
            }
            const snapshot = buildLocalServiceLauncherSnapshot({
                machineId: input.machineId,
                sessionId,
                ...(workspaceScopePaths ? { workspaceScopePaths } : {}),
                updatedAt: now(),
                runTargets: await resolveRunTargets(input.runTargets, input.onRunTargetsError),
                inventoryEntries: input.inventoryRegistry.getSnapshot().entries,
                previewResources: listLocalServicePreviewResources(input.previewRegistry),
                terminateDetectedEnabled: input.terminateDetectedEnabled?.() === true,
            });
            const managed = (input.projectManagedServices?.listProjectServices() ?? [])
                .filter(handle => handle.workspace.machineId === input.machineId
                    && (!workspaceScopePaths || workspaceScopePaths.some(root => isWorkspacePathWithin(root, handle.cwd))))
                .map(managedTarget);
            const managedIds = new Set(managed.map(target => target.id));
            return {
                ...snapshot,
                targets: [...sortTargets([
                    ...snapshot.targets.filter(target => !managedIds.has(target.id)).map(fenceExecutableAuthority),
                    ...managed,
                ]).filter(target => !input.history?.isDismissed(target.id))],
            };
        },
    };
}
