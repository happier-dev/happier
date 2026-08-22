import { resolveCliFeatureDecision, type CliServerFeaturesSnapshot } from '@/features/featureDecisionService';
import { startSingleFlightIntervalLoop, type SingleFlightIntervalLoopHandle } from '@/daemon/lifecycle/singleFlightIntervalLoop';
import { listSessionMarkers } from '@/daemon/sessionRegistry';
import { logger } from '@/ui/logger';
import {
    DEFAULT_LOCAL_SERVICE_CAPABILITIES,
    type FeatureDecision,
    isLocalServiceActionConfirmationNonceV1,
} from '@happier-dev/protocol';

import { createLocalServiceInventoryRegistry, type LocalServiceInventoryRegistry } from './inventory/registry';
import { createLocalServiceInventoryRoutes, type LocalServiceInventoryRoutes } from './inventory/routes';
import {
    createLocalServicePreviewRegistry,
    registerLocalServicePreview,
    unregisterLocalServicePreview,
    type LocalServicePreviewRegistry,
} from './preview/registry';
import { createLocalServicePreviewRoutes, type LocalServicePreviewRoutes } from './preview/routes';
import { createLocalServiceActionRoutes, type LocalServiceActionRoutes } from './actions/routes';
import {
    createTerminateDetectedService,
} from './actions/terminate';
import { createOsProcessControl } from './actions/osProcessControl';
import { createLocalServiceLauncherFeed } from './launch/feed';
import {
    createLocalServiceLauncherLeafRoutes,
    createLocalServiceLauncherHistoryStore,
} from './launch/leaves';
import { createLocalServiceLauncherRoutes, type LocalServiceLauncherRoutes } from './launch/routes';
import {
    normalizeLocalServiceScan,
    type LocalServiceInventoryDiagnostic,
    type LocalServiceListenerFact,
    type NormalizedLocalServiceInventorySnapshot,
} from './inventory/scanner';
import type {
    LocalServiceWorkspaceFact,
} from './inventory/provenance';
import {
    mergeLocalServiceWorkspaceFacts,
    resolveLocalServiceWorkspaceFactsFromSessionMarkers,
    resolveSessionWorkspacePathsFromSessionMarkers,
} from './inventory/workspaces';
import {
    getSharedTerminalProcessRegistry,
    type TerminalProcessRegistry,
} from './inventory/terminalRegistry';
import {
    discoverLocalServiceRunTargets,
    type LocalServiceRunTarget,
} from './managed/scripts';
import {
    scanPlatformLocalServices,
    type LocalServicesScanResult,
} from './inventory/platform/scan';
import { enrichLocalServiceInventoryPageTitles, type LocalPageTitleEnricher } from './inventory/pageTitle';
import {
    createLocalServiceEndpointEnricher,
    type LocalServiceEndpointEnricher,
} from './inventory/endpoint';
import {
    createManagedLocalServiceRegistry,
    type ManagedLocalServiceRegistry,
} from './managed/registry';
import {
    createLocalServiceManagedRoutes,
    type LocalServiceManagedRoutes,
} from './managed/routes';
import {
    createHostedWebStaticAssetLifecycle,
    type HostedWebStaticAssetLifecycle,
    type HostedWebStaticAssetLifecycleContribution,
    type HostedWebStaticAssetLifecycleOptions,
    type HostedWebStaticAssetLifecycleSyncResult,
} from './plugins/staticAssets/lifecycle';

type LocalServicesScanner = () => Promise<LocalServicesScanResult>;

type LocalServiceWorkspaceFactsProvider =
    () => Promise<readonly LocalServiceWorkspaceFact[]> | readonly LocalServiceWorkspaceFact[];

export type LocalServicesDaemonRuntime = Readonly<{
    inventoryRegistry: LocalServiceInventoryRegistry;
    managedRegistry: ManagedLocalServiceRegistry;
    previewRegistry: LocalServicePreviewRegistry;
    /**
     * The shared terminal->port registration store. Daemon startup hands this same
     * instance to the terminal RPC handlers so spawn-time registration writes to the
     * exact store the scanner queries.
     */
    terminalRegistry: TerminalProcessRegistry;
    inventoryRoutes: LocalServiceInventoryRoutes;
    launcherRoutes: LocalServiceLauncherRoutes;
    managedRoutes: LocalServiceManagedRoutes;
    previewRoutes: LocalServicePreviewRoutes;
    actionRoutes: LocalServiceActionRoutes;
    refreshInventoryNow(): Promise<NormalizedLocalServiceInventorySnapshot>;
    syncHostedWebStaticAssets(
        contributions: readonly HostedWebStaticAssetLifecycleContribution[],
    ): Promise<HostedWebStaticAssetLifecycleSyncResult>;
    hostedWebStaticAssetsSnapshot(): HostedWebStaticAssetLifecycleSyncResult;
    stopHostedWebStaticAssets(): Promise<void>;
    stop(): Promise<void>;
}>;

function markSnapshotEntriesStale(
    snapshot: NormalizedLocalServiceInventorySnapshot,
): NormalizedLocalServiceInventorySnapshot['entries'] {
    return snapshot.entries.map((entry) => (
        entry.state === 'gone'
            ? entry
            : { ...entry, state: 'stale' as const }
    ));
}

function disabledInventorySnapshot(input: Readonly<{
    previous: NormalizedLocalServiceInventorySnapshot;
    machineId: string;
    now: number;
    decision: FeatureDecision;
}>): NormalizedLocalServiceInventorySnapshot {
    return {
        ...input.previous,
        machineId: input.previous.machineId === 'unknown' ? input.machineId : input.previous.machineId,
        generatedAt: input.now,
        refreshState: 'idle',
        entries: markSnapshotEntriesStale(input.previous),
        diagnostics: [{
            code: input.decision.state === 'enabled'
                ? 'local_services_inventory_feature_disabled'
                : `local_services_inventory_${input.decision.blockerCode}`,
            severity: 'info',
        }],
    };
}

const LOCAL_SERVICE_LISTENER_SCAN_FAILURE_CODES = new Set([
    'darwin_lsof_scan_failed',
    'linux_procfs_scan_failed',
    'windows_netstat_scan_failed',
]);
function hasAuthoritativeListenerFacts(input: Readonly<{
    listeners: readonly LocalServiceListenerFact[];
    diagnostics: readonly LocalServiceInventoryDiagnostic[];
}>): boolean {
    if (input.listeners.length > 0) return true;
    return !input.diagnostics.some((diagnostic) => (
        LOCAL_SERVICE_LISTENER_SCAN_FAILURE_CODES.has(diagnostic.code)
    ));
}

function nonAuthoritativeInventorySnapshot(input: Readonly<{
    previous: NormalizedLocalServiceInventorySnapshot;
    machineId: string;
    now: number;
    diagnostics: readonly LocalServiceInventoryDiagnostic[];
}>): NormalizedLocalServiceInventorySnapshot {
    return {
        ...input.previous,
        machineId: input.previous.machineId === 'unknown' ? input.machineId : input.previous.machineId,
        generatedAt: input.now,
        refreshState: 'error',
        diagnostics: input.diagnostics,
    };
}

function emptyHostedWebStaticAssetSnapshot(): HostedWebStaticAssetLifecycleSyncResult {
    return Object.freeze({
        active: Object.freeze([]),
        diagnostics: Object.freeze([]),
    });
}

function hostedWebStaticAssetsUnavailableSnapshot(
    contributions: readonly HostedWebStaticAssetLifecycleContribution[],
): HostedWebStaticAssetLifecycleSyncResult {
    return Object.freeze({
        active: Object.freeze([]),
        diagnostics: Object.freeze(contributions.map((contribution) => Object.freeze({
            severity: 'error' as const,
            code: 'static_asset_server_start_failed' as const,
            pluginId: contribution.pluginId,
            contributionId: contribution.contributionId,
            diagnostics: Object.freeze(['hosted_web_static_asset_lifecycle_unavailable']),
        }))),
    });
}

async function readDaemonSessionWorkspaceFacts(machineId: string): Promise<readonly LocalServiceWorkspaceFact[]> {
    return resolveLocalServiceWorkspaceFactsFromSessionMarkers(await listSessionMarkers(), machineId);
}

export function createLocalServicesDaemonRuntime(params: Readonly<{
    machineId: string;
    processEnv?: NodeJS.ProcessEnv;
    inventoryEnabled?: () => boolean;
    /**
     * Provider for the daemon's server-features snapshot. `localServices.inventory` is now
     * server-represented, so the inventory gate must respect the server decision (mirrors the
     * connected-service quotas daemon gate). The runtime refreshes this on each inventory tick
     * and caches the latest result; when it returns undefined or fails the decision is
     * fail-closed and the daemon does not scan. Ignored when `inventoryEnabled` is supplied
     * (tests inject a deterministic gate directly).
     */
    resolveServerFeaturesSnapshot?: () => Promise<CliServerFeaturesSnapshot | undefined> | CliServerFeaturesSnapshot | undefined;
    scan?: LocalServicesScanner;
    now?: () => number;
    pageTitleEnricher?: LocalPageTitleEnricher;
    endpointEnricher?: LocalServiceEndpointEnricher;
    refreshIntervalMs?: number;
    staleAfterMs?: number;
    startLoop?: boolean;
    onError?: (error: unknown) => void;
    workspaceFacts?: LocalServiceWorkspaceFactsProvider;
    terminalRegistry?: TerminalProcessRegistry;
    runTargets?: () => Promise<readonly LocalServiceRunTarget[]> | readonly LocalServiceRunTarget[];
    resolveSessionWorkspacePaths?: (sessionId: string) => Promise<readonly string[]> | readonly string[];
    hostedWebStaticAssets?: Omit<HostedWebStaticAssetLifecycleOptions, 'registerPreview' | 'unregisterPreview'>;
}>): LocalServicesDaemonRuntime {
    const inventoryRegistry = createLocalServiceInventoryRegistry();
    // Shared daemon-process terminal->port registry: the same instance the PTY session
    // manager writes to on spawn. The scanner consults it for deterministic, attributed
    // workspace scoping. Defaults to the process singleton; tests inject a fresh one.
    const terminalRegistry = params.terminalRegistry ?? getSharedTerminalProcessRegistry();
    const managedRegistry = createManagedLocalServiceRegistry();
    const previewRegistry = createLocalServicePreviewRegistry();
    const processEnv = params.processEnv ?? process.env;
    const now = params.now ?? (() => Date.now());
    const scan = params.scan ?? scanPlatformLocalServices;
    const endpointEnricher = params.endpointEnricher ?? (
        params.scan
            ? null
            : createLocalServiceEndpointEnricher({
                now,
                timeoutMs: 250,
                concurrency: 8,
                successTtlMs: 30_000,
                failureTtlMs: 5_000,
            })
    );
    const workspaceFacts = params.workspaceFacts
        ?? (params.scan ? undefined : async () => await readDaemonSessionWorkspaceFacts(params.machineId));
    const staleAfterMs = params.staleAfterMs ?? DEFAULT_LOCAL_SERVICE_CAPABILITIES.inventory.staleAfterMs;
    // `localServices.inventory` is server-represented (default-allow): the server is the gate.
    // We cache the latest server-features snapshot (refreshed on each inventory tick) and resolve
    // the decision against it. With no snapshot the decision is fail-closed (probe_failed) and the
    // daemon does not scan — matching the connected-service quotas daemon gate.
    let cachedServerFeaturesSnapshot: CliServerFeaturesSnapshot | undefined;
    const resolveDecision = (): FeatureDecision => resolveCliFeatureDecision({
        featureId: 'localServices.inventory',
        env: processEnv,
        ...(cachedServerFeaturesSnapshot ? { serverSnapshot: cachedServerFeaturesSnapshot } : {}),
    });
    const isInventoryEnabled = params.inventoryEnabled ?? (() => resolveDecision().state === 'enabled');
    // Refresh the cached server-features snapshot from the daemon-supplied provider. Best-effort:
    // a thrown/failed provider keeps the previous snapshot (or none), so the gate stays fail-closed
    // rather than flapping. Skipped entirely when a deterministic `inventoryEnabled` gate is set.
    const refreshServerFeaturesSnapshot = async (): Promise<void> => {
        if (params.inventoryEnabled || !params.resolveServerFeaturesSnapshot) return;
        try {
            const next = await params.resolveServerFeaturesSnapshot();
            if (next) cachedServerFeaturesSnapshot = next;
        } catch (error) {
            params.onError?.(error);
        }
    };
    const hostedWebStaticAssets: HostedWebStaticAssetLifecycle | null = params.hostedWebStaticAssets
        ? createHostedWebStaticAssetLifecycle({
            ...params.hostedWebStaticAssets,
            registerPreview: (resource) => registerLocalServicePreview(previewRegistry, resource),
            unregisterPreview: (previewId) => unregisterLocalServicePreview(previewRegistry, previewId),
        })
        : null;

    const runInventoryRefresh = async (): Promise<NormalizedLocalServiceInventorySnapshot> => {
        const previous = inventoryRegistry.getSnapshot();
        // Refresh the server-features snapshot before resolving the gate so a server that toggled
        // the bit takes effect on the next tick (the refresh loop keeps it current).
        await refreshServerFeaturesSnapshot();
        const generatedAt = now();
        const decision = resolveDecision();
        if (!isInventoryEnabled()) {
            const snapshot = disabledInventorySnapshot({
                previous,
                machineId: params.machineId,
                now: generatedAt,
                decision,
            });
            inventoryRegistry.replaceSnapshot(snapshot);
            return snapshot;
        }

        const result = await scan();
        if (!hasAuthoritativeListenerFacts(result)) {
            const snapshot = nonAuthoritativeInventorySnapshot({
                previous,
                machineId: params.machineId,
                now: generatedAt,
                diagnostics: result.diagnostics,
            });
            inventoryRegistry.replaceSnapshot(snapshot);
            return snapshot;
        }

        const workspaceDiagnostics: LocalServiceInventoryDiagnostic[] = [];
        let daemonWorkspaces: readonly LocalServiceWorkspaceFact[] = [];
        if (workspaceFacts) {
            try {
                daemonWorkspaces = await workspaceFacts();
            } catch (error) {
                workspaceDiagnostics.push({
                    code: 'local_services_workspace_facts_failed',
                    severity: 'warning',
                    message: error instanceof Error ? error.message : String(error),
                });
            }
        }
        const snapshot = normalizeLocalServiceScan({
            machineId: params.machineId,
            now: generatedAt,
            previous,
            listeners: result.listeners,
            processes: result.processes,
            workspaces: mergeLocalServiceWorkspaceFacts(result.workspaces, daemonWorkspaces),
            terminalRegistry,
            staleAfterMs,
        });
        let snapshotWithDiagnostics: NormalizedLocalServiceInventorySnapshot = {
            ...snapshot,
            diagnostics: [...result.diagnostics, ...workspaceDiagnostics],
        };
        if (endpointEnricher) {
            snapshotWithDiagnostics = await endpointEnricher.enrich(snapshotWithDiagnostics);
        }
        if (params.pageTitleEnricher) {
            snapshotWithDiagnostics = await enrichLocalServiceInventoryPageTitles({
                snapshot: snapshotWithDiagnostics,
                enricher: params.pageTitleEnricher,
            });
        }
        managedRegistry.applyInventoryEntries(snapshotWithDiagnostics.entries);
        // Publish only after the canonical managed registry has consumed the same snapshot so
        // one-shot readiness subscribers observe the committed lifecycle transition.
        inventoryRegistry.replaceSnapshot(snapshotWithDiagnostics);
        return snapshotWithDiagnostics;
    };

    // Single-flight + coalesce manual refreshes onto one in-flight scan. The periodic loop
    // tick and the RPC manual-refresh route (`refreshSnapshot`) share this guard, so concurrent
    // callers await the same machine-wide
    // `lsof`/`/proc`/`netstat` scan and resolve to the same snapshot instead of stacking a
    // second scan on a busy daemon. Mirrors the `runTargetsInFlight` coalescing pattern below.
    let currentRefresh: Promise<NormalizedLocalServiceInventorySnapshot> | null = null;
    const refreshInventoryNow = (): Promise<NormalizedLocalServiceInventorySnapshot> => {
        if (currentRefresh) {
            return currentRefresh;
        }
        currentRefresh = (async () => {
            try {
                return await runInventoryRefresh();
            } finally {
                currentRefresh = null;
            }
        })();
        return currentRefresh;
    };

    const loop: SingleFlightIntervalLoopHandle | null = params.startLoop === false
        ? null
        : startSingleFlightIntervalLoop({
            intervalMs: params.refreshIntervalMs ?? DEFAULT_LOCAL_SERVICE_CAPABILITIES.inventory.refreshIntervalMs,
            task: async () => {
                await refreshInventoryNow();
            },
            onError: params.onError ?? ((error) => logger.debug('[DAEMON RUN] Local-service inventory refresh failed', error)),
            unref: true,
        });

    const inventoryRoutes = createLocalServiceInventoryRoutes({
        registry: inventoryRegistry,
        refreshSnapshot: refreshInventoryNow,
    });
    const previewRoutes = createLocalServicePreviewRoutes({
        machineId: params.machineId,
        registry: previewRegistry,
        inventoryRegistry,
        now,
    });
    // Workspace-scoped package-script discovery (LSV-6). Reads package.json files only
    // (binary-safe: no node/package-manager spawn). Single-flighted + short-TTL cached so
    // the recursive fs walk does not re-run on every launcher snapshot request.
    const RUN_TARGETS_CACHE_TTL_MS = 5_000;
    let runTargetsCache: { value: readonly LocalServiceRunTarget[]; at: number } | null = null;
    let runTargetsInFlight: Promise<readonly LocalServiceRunTarget[]> | null = null;
    const defaultRunTargetsProvider = async (): Promise<readonly LocalServiceRunTarget[]> => {
        const fresh = runTargetsCache && now() - runTargetsCache.at < RUN_TARGETS_CACHE_TTL_MS;
        if (fresh && runTargetsCache) {
            return runTargetsCache.value;
        }
        if (runTargetsInFlight) {
            return runTargetsInFlight;
        }
        runTargetsInFlight = (async () => {
            try {
                const workspaceRoots = (await readDaemonSessionWorkspaceFacts(params.machineId))
                    .map((fact) => fact.path)
                    .filter((root) => root.length > 0);
                const value = workspaceRoots.length > 0
                    ? await discoverLocalServiceRunTargets({ roots: workspaceRoots })
                    : [];
                runTargetsCache = { value, at: now() };
                return value;
            } catch (error) {
                params.onError?.(error);
                return runTargetsCache?.value ?? [];
            } finally {
                runTargetsInFlight = null;
            }
        })();
        return runTargetsInFlight;
    };
    const runTargetsProvider = params.runTargets ?? defaultRunTargetsProvider;
    const defaultResolveSessionWorkspacePaths = async (sessionId: string): Promise<readonly string[]> =>
        resolveSessionWorkspacePathsFromSessionMarkers(await listSessionMarkers(), sessionId, params.machineId);
    const resolveSessionWorkspacePaths = params.resolveSessionWorkspacePaths ?? defaultResolveSessionWorkspacePaths;
    // Terminate-detected (LSV-2): the daemon owns the only path that signals a process it did
    // not spawn. The capability is fail-closed default-off and resolved against the server
    // feature decision (`localServices.actions.terminate`) wherever the daemon advertises or
    // executes the action.
    const isTerminateEnabled = (): boolean => resolveCliFeatureDecision({
        featureId: 'localServices.actions.terminate',
        env: processEnv,
        ...(cachedServerFeaturesSnapshot ? { serverSnapshot: cachedServerFeaturesSnapshot } : {}),
    }).state === 'enabled';

    const launcherFeed = createLocalServiceLauncherFeed({
        machineId: params.machineId,
        inventoryRegistry,
        managedRegistry,
        previewRegistry,
        runTargets: runTargetsProvider,
        onRunTargetsError: params.onError,
        terminateDetectedEnabled: isTerminateEnabled,
        resolveSessionWorkspacePaths,
        now,
    });
    // Launcher leaf actions (LSV-1): openPreview/registerPreview reuse the canonical launcher
    // feed + private-preview owner; history.clear empties the daemon-owned launcher history.
    const launcherHistory = createLocalServiceLauncherHistoryStore();
    const launcherLeafRoutes = createLocalServiceLauncherLeafRoutes({
        machineId: params.machineId,
        feed: launcherFeed,
        previewRoutes,
        history: launcherHistory,
    });
    const launcherRoutes = createLocalServiceLauncherRoutes({
        feed: launcherFeed,
        leaves: launcherLeafRoutes,
    });
    // The executor itself layers identity-tuple TOCTOU revalidation, graceful-then-force
    // signalling, and post-release verification over the real OS process-control adapter.
    const terminateDetectedService = createTerminateDetectedService(
        createOsProcessControl({ scan }),
    );
    const actionRoutes = createLocalServiceActionRoutes({
        machineId: params.machineId,
        inventoryRegistry,
        managedRegistry,
        terminateEnabled: isTerminateEnabled,
        verifyConfirmationNonce: isLocalServiceActionConfirmationNonceV1,
        terminateDetectedService,
    });
    const managedRoutes = createLocalServiceManagedRoutes({
        machineId: params.machineId,
        registry: managedRegistry,
        now,
    });

    return {
        inventoryRegistry,
        managedRegistry,
        previewRegistry,
        terminalRegistry,
        inventoryRoutes,
        launcherRoutes,
        managedRoutes,
        previewRoutes,
        actionRoutes,
        refreshInventoryNow,
        syncHostedWebStaticAssets: async (contributions) => {
            if (!hostedWebStaticAssets) {
                return hostedWebStaticAssetsUnavailableSnapshot(contributions);
            }
            return await hostedWebStaticAssets.sync(contributions);
        },
        hostedWebStaticAssetsSnapshot: () => (
            hostedWebStaticAssets?.snapshot() ?? emptyHostedWebStaticAssetSnapshot()
        ),
        stopHostedWebStaticAssets: async () => {
            await hostedWebStaticAssets?.stop();
        },
        async stop() {
            loop?.stop();
            try {
                await hostedWebStaticAssets?.stop();
            } catch (error) {
                (params.onError ?? ((reason) => {
                    logger.debug('[DAEMON RUN] Hosted-web static asset shutdown failed', reason);
                }))(error);
            }
        },
    };
}
