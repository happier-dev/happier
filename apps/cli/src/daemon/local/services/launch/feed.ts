import type { LocalServiceLauncherSnapshotV1, LocalServiceLaunchTargetV1 } from '@happier-dev/protocol';

import { expandHomeDirPath } from '../../../../utils/path/expandHomeDirPath';
import type { LocalServiceInventoryRegistry } from '../inventory/registry';
import type { ManagedLocalServiceRegistry } from '../managed/registry';
import type { ManagedLocalServiceStartDeclarationRegistry } from '../managed/startDeclarations';
import { listLocalServicePreviewResources, type LocalServicePreviewRegistry } from '../preview/registry';
import type { LocalServiceRunTarget } from '../managed/scripts';
import { buildLocalServiceLauncherSnapshot } from './suggestions';

const DEFAULT_RUN_TARGETS_TIMEOUT_MS = 1_000;

export type LocalServiceLauncherFeedSnapshotRequest = Readonly<{
    sessionId?: string;
    /** Explicit scope: `machine` skips workspace scoping; `workspace` (default) keeps it. */
    scope?: 'workspace' | 'machine';
    /** Session-less project scoping by repo root (canonicalized at this daemon boundary). */
    workspaceRoot?: string;
}>;

export type LocalServiceLauncherFeed = Readonly<{
    getSnapshot(request?: LocalServiceLauncherFeedSnapshotRequest): Promise<LocalServiceLauncherSnapshotV1>;
}>;

export type LocalServiceRunTargetsProvider =
    () => readonly LocalServiceRunTarget[] | Promise<readonly LocalServiceRunTarget[]>;

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
    managedRegistry: ManagedLocalServiceRegistry;
    isManagedServiceVisible?: (serviceId: string) => boolean;
    previewRegistry: LocalServicePreviewRegistry;
    startDeclarations?: Pick<ManagedLocalServiceStartDeclarationRegistry, 'listLaunchTargets'>;
    runTargets?: readonly LocalServiceRunTarget[] | LocalServiceRunTargetsProvider;
    runTargetsTimeoutMs?: number;
    onRunTargetsError?: (error: unknown) => void;
    terminateDetectedEnabled?: () => boolean;
    resolveSessionWorkspacePaths?: LocalServiceSessionWorkspacePathsResolver;
    now?: () => number;
}>;

function withoutActions(target: LocalServiceLaunchTargetV1): LocalServiceLaunchTargetV1 {
    return target.actions.length === 0 ? target : { ...target, actions: [] };
}

function withoutPreviewActions(target: LocalServiceLaunchTargetV1): LocalServiceLaunchTargetV1 {
    const actions = target.actions.filter((action) => action === 'terminate_detected');
    return actions.length === target.actions.length ? target : { ...target, actions };
}

function unavailable(
    target: LocalServiceLaunchTargetV1,
    unavailableReason: string,
): LocalServiceLaunchTargetV1 {
    const next = withoutActions(target);
    const { browserTarget, ...rest } = next;
    void browserTarget;
    return {
        ...rest,
        state: 'unavailable',
        unavailableReason,
        actions: [],
    };
}

function fenceExecutableAuthority(target: LocalServiceLaunchTargetV1): LocalServiceLaunchTargetV1 {
    if (
        target.source === 'managed_service'
        && target.state === 'available'
        && target.actions.length === 1
        && target.actions[0] === 'start'
    ) {
        return target;
    }
    if (
        target.source === 'inventory_entry'
        && target.state === 'available'
        && target.actions.includes('open')
        && target.browserTarget
    ) {
        // Product-owned local open: a listening loopback entry carrying an externalUrl
        // browserTarget + `open` action survives the fence intact, decoupled from preview/
        // exposure gating. Only exposure (register_preview/open_preview) stays preview-gated.
        return target;
    }
    const next = withoutPreviewActions(target);
    if (
        next.source === 'inventory_entry'
        && next.state === 'available'
        && !next.browserTarget
        && next.actions.length === 0
    ) {
        return unavailable(next, 'preview_registration_unavailable');
    }
    if (next.source === 'managed_service' && next.state === 'available' && !next.browserTarget) {
        return unavailable(next, 'managed_preview_unavailable');
    }
    return next;
}

function sourcePriority(target: LocalServiceLaunchTargetV1): number {
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

function sortTargets(targets: readonly LocalServiceLaunchTargetV1[]): readonly LocalServiceLaunchTargetV1[] {
    return [...targets].sort((a, b) => (
        sourcePriority(a) - sourcePriority(b)
        || a.title.localeCompare(b.title)
        || a.id.localeCompare(b.id)
    ));
}

function createRunTargetsTimeoutError(timeoutMs: number): Error {
    const error = new Error(`Local-service run-target discovery timed out after ${timeoutMs}ms`);
    error.name = 'LocalServiceRunTargetsTimeoutError';
    return error;
}

async function resolveRunTargets(
    value: CreateLocalServiceLauncherFeedInput['runTargets'],
    options: Readonly<{
        timeoutMs: number;
        onError: CreateLocalServiceLauncherFeedInput['onRunTargetsError'];
    }>,
): Promise<readonly LocalServiceRunTarget[]> {
    if (!value) return [];
    if (typeof value !== 'function') return value;

    let timeout: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    try {
        const runTargets = Promise.resolve(value());
        const bounded = new Promise<readonly LocalServiceRunTarget[]>((resolve) => {
            timeout = setTimeout(() => {
                timedOut = true;
                resolve([]);
            }, Math.max(0, options.timeoutMs));
        });
        const result = await Promise.race([runTargets, bounded]);
        if (timedOut) {
            options.onError?.(createRunTargetsTimeoutError(Math.max(0, options.timeoutMs)));
        }
        return result;
    } catch (error) {
        options.onError?.(error);
        return [];
    } finally {
        if (timeout) clearTimeout(timeout);
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
    const runTargetsTimeoutMs = input.runTargetsTimeoutMs ?? DEFAULT_RUN_TARGETS_TIMEOUT_MS;
    return {
        async getSnapshot(request) {
            const sessionId = request?.sessionId ?? input.sessionId;
            const managedServices = input.managedRegistry.listServices()
                .filter((service) => input.isManagedServiceVisible?.(service.id) !== false);
            const activeServiceIds = new Set(managedServices.map((service) => service.id));
            const workspaceScopePaths = await resolveScopePaths({
                scope: request?.scope,
                workspaceRoot: request?.workspaceRoot,
                resolver: input.resolveSessionWorkspacePaths,
                sessionId,
            });
            const snapshot = buildLocalServiceLauncherSnapshot({
                machineId: input.machineId,
                sessionId,
                ...(workspaceScopePaths ? { workspaceScopePaths } : {}),
                updatedAt: now(),
                runTargets: await resolveRunTargets(input.runTargets, {
                    timeoutMs: runTargetsTimeoutMs,
                    onError: input.onRunTargetsError,
                }),
                inventoryEntries: input.inventoryRegistry.getSnapshot().entries,
                managedServices,
                previewResources: listLocalServicePreviewResources(input.previewRegistry),
                terminateDetectedEnabled: input.terminateDetectedEnabled?.() === true,
            });
            const startDeclarationTargets = input.startDeclarations?.listLaunchTargets({
                activeServiceIds,
            }) ?? [];
            return {
                ...snapshot,
                targets: [...sortTargets([
                    ...snapshot.targets,
                    ...startDeclarationTargets,
                ].map(fenceExecutableAuthority))],
            };
        },
    };
}
