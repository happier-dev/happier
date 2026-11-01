import type { LocalServiceLauncherSnapshotV1, LocalServiceLaunchTargetV1 } from '@happier-dev/protocol';

import { expandHomeDirPath } from '../../../../utils/path/expandHomeDirPath';
import { isWorkspacePathWithin } from '../inventory/provenance';
import type { LocalServiceInventoryRegistry } from '../inventory/registry';
import type { NormalizedLocalServiceInventoryEntry } from '../inventory/scanner';
import { buildLocalServicePreviewBrowserTarget, listLocalServicePreviewResources, type LocalServicePreviewRegistry } from '../preview/registry';
import { waitForChangeOrDeadline } from '@/daemon/lifecycle/waitForChangeOrDeadline';
import type { LocalServiceLauncherRunTarget, LocalServiceRunTargetDiscoveryOptions } from './runTargets';
import type { LocalServiceLauncherHistoryStore } from './leaves';
import { buildLocalServiceLauncherSnapshot, formatLocalServiceLauncherTitle } from './suggestions';
import type { createManagedServicesOwner, ProjectManagedServiceHandle } from '@/plugins/runtime/invocation/services/managedServicesOwner';
import { selectManagedOwnedTreeEndpoint } from '@/plugins/runtime/invocation/services/managedOwnedTreeEndpoint';

type ProjectManagedServicesFeed = Pick<ReturnType<typeof createManagedServicesOwner>, 'listProjectServices' | 'readProcessRoots'>;

export type LocalServiceLauncherFeedSnapshotRequest = Readonly<{
    sessionId?: string;
    /** Host-only mutation read: an unresolved Workspace must not broaden to Machine scope. */
    requireWorkspaceScope?: true;
    projection?: 'managed_bindings';
    /** Host-only material update: use admitted discovery facts and live supervisor state. */
    discovery?: 'cached';
    /** Explicit scope: `machine` skips workspace scoping; `workspace` (default) keeps it. */
    scope?: 'workspace' | 'machine';
    /** Session-less project scoping by repo root (canonicalized at this daemon boundary). */
    workspaceRoot?: string;
}>;

export type LocalServiceLauncherFeed = Readonly<{
    getSnapshot(request?: LocalServiceLauncherFeedSnapshotRequest,
        inventoryEntries?: readonly NormalizedLocalServiceInventoryEntry[]): Promise<LocalServiceLauncherSnapshotV1>;
}>;

export type LocalServiceRunTargetsProvider =
    (workspaceRoots?: readonly string[], options?: LocalServiceRunTargetDiscoveryOptions) => readonly LocalServiceLauncherRunTarget[] | Promise<readonly LocalServiceLauncherRunTarget[]>;

/**
 * Resolves the workspace PATH(s) a session id is anchored to. The feed turns a
 * per-request `sessionId` into a workspace-PATH scope (D1) — every service in that path
 * is kept regardless of which session started it; session is attribution, not a filter.
 */
export type LocalServiceSessionWorkspacePathsResolver =
    (sessionId: string) => readonly string[] | Promise<readonly string[]>;

export type CreateLocalServiceLauncherFeedInput = Readonly<{
    machineId: string;
    accountId?: string;
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
        ...(handle.execution ? { execution: handle.execution } : {}),
        title: formatLocalServiceLauncherTitle(selection.kind === 'manifest' ? selection.name : selection.source.target),
        subtitle: handle.cwd, confidence: 'high',
        state: snapshot.state === 'starting' ? 'starting' : 'available',
        serviceState: snapshot.state,
        // The supervisor owns sanitization and retention bounds. Publish only its
        // presentation fields while failed; private details/remediation stay local.
        ...((snapshot.state === 'failed' || snapshot.state === 'unhealthy') && snapshot.diagnostics.length > 0
            ? { diagnostics: snapshot.diagnostics.map(({ code, severity, message }) => ({
                code, severity, ...(message !== undefined ? { message } : {}),
            })) } : {}),
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

function sortTargets(targets: readonly LocalServiceLaunchTargetV1[]): LocalServiceLaunchTargetV1[] {
    return [...targets].sort((a, b) => (
        sourcePriority(a) - sourcePriority(b)
        || a.title.localeCompare(b.title)
        || a.id.localeCompare(b.id)
    ));
}

async function resolveRunTargets(
    value: CreateLocalServiceLauncherFeedInput['runTargets'],
    onError: CreateLocalServiceLauncherFeedInput['onRunTargetsError'],
    workspaceRoots?: readonly string[],
    options?: LocalServiceRunTargetDiscoveryOptions,
): Promise<readonly LocalServiceLauncherRunTarget[] | undefined> {
    if (!value) return [];
    if (typeof value !== 'function') return value;

    try {
        return await value(workspaceRoots, options);
    } catch (error) {
        onError?.(error);
        return undefined;
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
): LocalServiceLauncherFeed & Readonly<{
    refreshRunTargets(workspaceRoots?: readonly string[], signal?: AbortSignal, options?: LocalServiceRunTargetDiscoveryOptions): Promise<void>;
}> {
    const now = input.now ?? (() => Date.now());
    // Custody can settle before the next scan. Retain only correlations proven
    // against native roots for the cached provenance object, never an address or
    // PID tombstone that could hide a fresh listener after process reuse.
    const cachedInventoryOwners = new WeakMap<NonNullable<NormalizedLocalServiceInventoryEntry['provenance']>, string>();
    // Discovery and native lifecycle advance independently. A native readiness/exit
    // publication projects the last discovery observation without repeating its I/O.
    // Keep suggestions separate at ingestion so Machine reads never walk the retained
    // checkout × script collection, including after a Workspace read or watch update.
    let observedDeclarations: readonly LocalServiceLauncherRunTarget[] = [];
    let observedPackageScripts: readonly LocalServiceLauncherRunTarget[] = [];
    let discovery = Promise.resolve();
    const refreshRunTargets = (workspaceRoots?: readonly string[], signal?: AbortSignal, options?: LocalServiceRunTargetDiscoveryOptions): Promise<void> => {
        const read = discovery.then(async () => {
            if (signal?.aborted) return;
            const observation = resolveRunTargets(input.runTargets, input.onRunTargetsError, workspaceRoots, options).then(targets => {
                // A retired read can finish native I/O, but may neither hold a
                // fresh viewer nor replace its admitted declarations afterward.
                if (signal?.aborted || targets === undefined) return;
                const declarations: LocalServiceLauncherRunTarget[] = [];
                const packageScripts: LocalServiceLauncherRunTarget[] = [];
                for (const target of targets) {
                    if ('launchIntent' in target || target.packageScript) packageScripts.push(target);
                    else declarations.push(target);
                }
                const replaceObservation = (current: readonly LocalServiceLauncherRunTarget[], next: readonly LocalServiceLauncherRunTarget[]) => workspaceRoots ? [
                    ...current.filter(target => !workspaceRoots.some(root => isWorkspacePathWithin(root, target.cwd))),
                    ...next.filter(target => workspaceRoots.some(root => isWorkspacePathWithin(root, target.cwd))),
                ] : next;
                observedDeclarations = replaceObservation(observedDeclarations, declarations);
                // A declarations-only read has no new observation of Workspace suggestions.
                if (options?.includePackageScripts !== false) {
                    observedPackageScripts = replaceObservation(observedPackageScripts, packageScripts);
                }
            });
            if (signal) await waitForChangeOrDeadline({ signal, waitForChange: () => observation });
            else await observation;
        });
        discovery = read.catch(() => undefined);
        return read;
    };
    return {
        refreshRunTargets,
        async getSnapshot(request, observedInventoryEntries) {
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
            const bindingsOnly = request?.projection === 'managed_bindings';
            const includePackageScripts = request?.scope !== 'machine';
            // Complete bindings read cached listener evidence without waiting for discovery.
            // Both projections must retain the same managed identity and preview presentation.
            if (!bindingsOnly && request?.discovery !== 'cached') {
                await refreshRunTargets(workspaceScopePaths, undefined, { includePackageScripts });
            }
            const runTargets = bindingsOnly ? [] : includePackageScripts
                ? [...observedDeclarations, ...observedPackageScripts] : observedDeclarations;
            // The scan publisher projects this same observation before deciding whether to wake
            // readers. Ordinary reads use the registry's annotated, visible inventory.
            const inventoryEntries = observedInventoryEntries ?? input.inventoryRegistry.getSnapshot().entries;
            const previewResources = listLocalServicePreviewResources(input.previewRegistry);
            const managedPreviews = new Map(previewResources.flatMap(resource => resource.machineId === input.machineId && resource.serviceTarget
                ? [[resource.serviceTarget.managedServiceId, resource] as const] : []));
            const snapshot = buildLocalServiceLauncherSnapshot({
                machineId: input.machineId,
                accountId: input.accountId,
                sessionId,
                ...(workspaceScopePaths ? { workspaceScopePaths } : {}),
                updatedAt: now(),
                runTargets,
                inventoryEntries,
                previewResources,
                terminateDetectedEnabled: input.terminateDetectedEnabled?.() === true,
            });
            const processRoots = input.projectManagedServices?.readProcessRoots() ?? [];
            const inventoryTargets = new Map(snapshot.targets.flatMap(target => target.sourceClass?.kind === 'inventory_entry'
                ? [[target.sourceClass.inventoryEntryId, target] as const] : []));
            const correlatedInventoryIds = new Set<string>();
            const handles = bindingsOnly ? await input.projectManagedServices!.listProjectServices({ requireComplete: true,
                ...(workspaceScopePaths?.length === 1 ? { workspaceRoot: workspaceScopePaths[0] } : {}) })
                : input.projectManagedServices?.listProjectServices() ?? [];
            const managed = handles
                .filter(handle => (!bindingsOnly || handle.isCurrent()) && handle.workspace.machineId === input.machineId
                    && (!workspaceScopePaths || workspaceScopePaths.some(root => isWorkspacePathWithin(root, handle.cwd))))
                .map(handle => {
                    const nativeTarget = managedTarget(handle);
                    const preview = nativeTarget.endpointUrl ? managedPreviews.get(handle.instanceId) : undefined;
                    const target = preview ? { ...nativeTarget,
                        browserTarget: preview.browserTarget ?? buildLocalServicePreviewBrowserTarget(preview),
                        actions: [...nativeTarget.actions, 'open_preview' as const],
                    } : nativeTarget;
                    const root = processRoots.find(root => root.live === true && root.owner.kind === 'service'
                        && root.owner.serviceId === handle.instanceId);
                    if (!root) return target;
                    // Correlate each binding independently: several interfaces can belong to
                    // one occurrence. This does not select or change its advertised endpoint.
                    const owned = inventoryEntries.filter(entry => entry.machineId === input.machineId
                        && entry.state === 'listening' && inventoryTargets.has(entry.id)
                        && selectManagedOwnedTreeEndpoint({ entries: [entry], managedPid: root.pid, minimumConfidence: 'high' }));
                    for (const entry of owned) {
                        correlatedInventoryIds.add(entry.id);
                        if (entry.provenance) cachedInventoryOwners.set(entry.provenance, handle.serviceId);
                    }
                    // Retiring serving authority does not make its cached listeners
                    // independent targets, but it must still remove preview authority.
                    if (!handle.isCurrent() || target.unavailableReason) return target;
                    // Prefer a direct-root binding for listener presentation. Preview identity
                    // comes only from this occurrence, never from an address-matched listener.
                    const entry = owned.sort((a, b) => Number(b.provenance?.process?.pid === root.pid) - Number(a.provenance?.process?.pid === root.pid)
                        || a.id.localeCompare(b.id))[0];
                    const listener = entry ? inventoryTargets.get(entry.id) : undefined;
                    if (!entry || !listener) return target;
                    return { ...target,
                        sourceClass: { kind: 'managed_service' as const, managedServiceId: handle.instanceId, inventoryEntryId: entry.id },
                        subtitle: listener.subtitle, kind: listener.kind, commandPreview: listener.commandPreview,
                        actions: [...target.actions, ...listener.actions.filter(action => action === 'register_preview')],
                    };
                });
            if (bindingsOnly) return { v: 1, machineId: input.machineId, updatedAt: snapshot.updatedAt, targets: sortTargets(managed) };
            const managedIds = new Set(managed.map(target => target.id));
            const declaredIds = new Set([...snapshot.targets, ...managed]
                .filter(target => target.declaration).map(target => target.id));
            for (const entry of inventoryEntries) {
                const ownerId = entry.provenance ? cachedInventoryOwners.get(entry.provenance) : undefined;
                // Undeclared inventory remains independently discoverable after Stop.
                if (ownerId && declaredIds.has(ownerId)) correlatedInventoryIds.add(entry.id);
            }
            return {
                ...snapshot,
                targets: [...sortTargets([
                    ...snapshot.targets.filter(target => !managedIds.has(target.id)
                        && !(target.sourceClass?.kind === 'inventory_entry' && correlatedInventoryIds.has(target.sourceClass.inventoryEntryId)))
                        .map(fenceExecutableAuthority),
                    ...managed,
                ]).filter(target => !input.history?.isDismissed(target.id))],
            };
        },
    };
}
