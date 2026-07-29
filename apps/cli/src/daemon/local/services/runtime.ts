import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readFile, readdir, readlink } from 'node:fs/promises';
import { normalize, resolve } from 'node:path';

import { resolveCliFeatureDecision, type CliServerFeaturesSnapshot } from '@/features/featureDecisionService';
import { startSingleFlightIntervalLoop, type SingleFlightIntervalLoopHandle } from '@/daemon/lifecycle/singleFlightIntervalLoop';
import { readProcessIdentityByPid } from '@/daemon/processIdentity';
import {
    ManagedLocalServiceRunAttachmentV1Schema,
    hashProcessCommand,
    listSessionMarkers,
    type ManagedLocalServiceRunAttachmentV1,
} from '@/daemon/sessionRegistry';
import { logger } from '@/ui/logger';
import { canonicalAbsolutePathsEqual } from '@/utils/path/expandHomeDirPath';
import {
    DEFAULT_LOCAL_SERVICE_CAPABILITIES,
    type FeatureDecision,
    isLocalServiceActionConfirmationNonceV1,
    type LocalServicePreviewInitialPathV1,
    type LocalServicePreviewResourceV1,
} from '@happier-dev/protocol';
import type {
    ExecProcessHandleV1,
    ExecRuntimeServiceV1,
    LocalServiceDeclarationV1,
    LocalServiceRuntimeSnapshotV1,
} from '@/plugins/runtime/exec/privateContract';

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
import type { LocalServiceActionExecutionOutcome } from './actions/executor';
import {
    createTerminateDetectedService,
    type TerminateProcessControl,
} from './actions/terminate';
import { createOsProcessControl } from './actions/osProcessControl';
import { createLocalServiceLauncherFeed } from './launch/feed';
import {
    createLocalServiceLauncherLeafRoutes,
    createLocalServiceLauncherHistoryStore,
} from './launch/leaves';
import { createLocalServiceLauncherRoutes, type LocalServiceLauncherRoutes } from './launch/routes';
import { createPluginLocalServicesBridgeControlRoutes, type PluginLocalServicesBridgeControlRoutes } from './pluginBridgeRoutes';
import {
    normalizeLocalServiceScan,
    type LocalServiceInventoryDiagnostic,
    type LocalServiceListenerFact,
    type NormalizedLocalServiceInventorySnapshot,
} from './inventory/scanner';
import type {
    LocalServiceProcessFact,
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
import { readDarwinLocalServiceListeners } from './inventory/platform/darwin';
import { readLinuxLocalServiceListeners } from './inventory/platform/linux';
import { readWindowsLocalServiceListeners } from './inventory/platform/windows';
import { enrichLocalServiceInventoryPageTitles, type LocalPageTitleEnricher } from './inventory/pageTitle';
import {
    createLocalServiceEndpointEnricher,
    type LocalServiceEndpointEnricher,
} from './inventory/endpoint';
import {
    createManagedLocalServiceRegistry,
    type ManagedLocalServiceRegistry,
    type ManagedLocalServiceRuntimeState,
} from './managed/registry';
import {
    createLocalServiceManagedRoutes,
    type LocalServiceManagedRoutes,
} from './managed/routes';
import {
    createManagedLocalServiceStartDeclarationRegistry,
    type ManagedLocalServiceOwnerContext,
    type ManagedLocalServiceStartDeclaration,
} from './managed/startDeclarations';
import {
    resolveManagedLocalServiceRestartRequest,
    type ManagedLocalServiceRestartPolicy,
} from './managed/restart';
import { resolveLocalServiceRouteName } from './managed/names';
import { createLocalServicePortAllocator } from './managed/ports';
import {
    buildLocalServiceLaunchEnvironment,
    buildRuntimePortArgs,
    LOCAL_SERVICE_ENV,
} from './managed/environment';
import { resolveManagedLocalServiceHealthTarget } from './managed/health';
import { createLocalServiceRouteLockStore } from './managed/locks';
import { selectManagedLocalServiceCleanupIds } from './managed/cleanup';
import { buildLocalServicePortPlan } from './managed/portPlan';
import { createLocalServiceLifecycleGuard } from './managed/lifecycleGuard';
import { createManagedHealthMonitor } from './managed/healthMonitor';
import {
    createHostedWebStaticAssetLifecycle,
    type HostedWebStaticAssetLifecycle,
    type HostedWebStaticAssetLifecycleContribution,
    type HostedWebStaticAssetLifecycleOptions,
    type HostedWebStaticAssetLifecycleSyncResult,
} from './plugins/staticAssets/lifecycle';
import { createHostedWebManagedLocalServicePreviewResource } from './plugins/hostedWeb';

type LocalServicesScanResult = Readonly<{
    listeners: readonly LocalServiceListenerFact[];
    processes: ReadonlyMap<number, LocalServiceProcessFact>;
    workspaces: readonly LocalServiceWorkspaceFact[];
    diagnostics: readonly LocalServiceInventoryDiagnostic[];
}>;

type LocalServicesScanner = () => Promise<LocalServicesScanResult>;

type LocalServiceWorkspaceFactsProvider =
    () => Promise<readonly LocalServiceWorkspaceFact[]> | readonly LocalServiceWorkspaceFact[];

export type PluginLocalServicesBridgeContext = Readonly<{
    pluginId: string;
    contributionId: string;
    sessionId: string;
    title: string;
    initialPath?: LocalServicePreviewInitialPathV1;
}>;

export type TrustedManagedLocalServiceOwnerContext = ManagedLocalServiceOwnerContext;

type PluginManagedLocalServiceLaunchIntent = Readonly<{
    serviceKey: string;
    context: TrustedManagedLocalServiceOwnerContext;
    declaration: LocalServiceDeclarationV1;
    restartPolicy: ManagedLocalServiceRestartPolicy;
    exec?: Pick<ExecRuntimeServiceV1, 'spawn'>;
}>;

/**
 * Daemon-memory proof for one exact run already owned by the canonical managed
 * local-service lifecycle. This is deliberately not serializable Provider
 * state: a replacement daemon that cannot read this owner must rematerialize.
 */
export type TrustedManagedLocalServiceOwnedRun = Readonly<{
    serviceKey: string;
    runId: number;
    snapshot: LocalServiceRuntimeSnapshotV1;
    process: Readonly<{
        pid: number;
        startedAt: number;
        processStartTimeMs?: number;
        processCommandHash?: string;
    }>;
    host: string | null;
    port: number | null;
}>;

export type TrustedManagedLocalServiceStopResult =
    | Readonly<{ status: 'stopped' }>
    | Readonly<{ status: 'stale' | 'unavailable' }>;

export type TrustedManagedLocalServiceTransferResult =
    | Readonly<{ status: 'transferred' }>
    | Readonly<{ status: 'stale' | 'unavailable' }>;

export type TrustedManagedLocalServiceAuthorityFinalizationResult =
    | Readonly<{ ok: true }>
    | Readonly<{ ok: false; reasonCode: string }>;

// Default loopback port range for daemon-allocated assign-and-inject services. Kept above the
// IANA registered range and clear of the common dev-server ports the scanner already sees.
const MANAGED_LOCAL_SERVICE_PORT_RANGE = Object.freeze({ start: 45_000, end: 45_999 });
const DEFAULT_MANAGED_LOCAL_SERVICE_HOST = '127.0.0.1';

// The assigned launch facts for a live assign-and-inject run. `runId` is the monotonic
// run-identity stamp so a stale exit/health tick (older run) cannot tear down a newer run.
type ManagedAssignedLaunch = Readonly<{
    routeName: string;
    host: string;
    port: number;
    runId: number;
    healthCheck: LocalServiceDeclarationV1['healthCheck'];
    startedAt: number;
}>;

type ExecLaunchInputV1 = LocalServiceDeclarationV1['launch'];
type ExecRuntimeLaunchInput = Parameters<ExecRuntimeServiceV1['spawn']>[0];

function assertExecRuntimeLaunchSupported(
    launch: ExecLaunchInputV1,
): asserts launch is ExecRuntimeLaunchInput {
    if (
        launch.kind === 'managed-installable'
        && launch.sourcePreference === 'system-first'
    ) {
        throw new Error(
            'Managed local services require a host-managed executable source',
        );
    }
}

/** Read the existing env off a launch input (the `ipc` kind carries none). */
function launchEnv(launch: ExecLaunchInputV1): Readonly<Record<string, string | undefined>> {
    return launch.kind === 'ipc' ? {} : (launch.env ?? {});
}

/**
 * Merge injected env + appended framework args into a launch input. The `ipc` kind carries
 * neither, so it is returned unchanged (assign-and-inject services never use `ipc`).
 */
function withLaunchEnvAndArgs(
    launch: ExecLaunchInputV1,
    env: Readonly<Record<string, string>>,
    extraArgs: readonly string[],
): ExecLaunchInputV1 {
    if (launch.kind === 'ipc') return launch;
    const mergedEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(launch.env ?? {})) {
        if (value !== undefined) mergedEnv[key] = value;
    }
    for (const [key, value] of Object.entries(env)) {
        mergedEnv[key] = value;
    }
    const mergedArgs = extraArgs.length > 0 ? [...(launch.args ?? []), ...extraArgs] : launch.args;
    return {
        ...launch,
        env: mergedEnv,
        ...(mergedArgs ? { args: mergedArgs } : {}),
    };
}

export type PluginLocalServicesDaemonBridge = Readonly<{
    declare?(declaration: LocalServiceDeclarationV1): Promise<LocalServiceRuntimeSnapshotV1 | void>;
    start(declaration: LocalServiceDeclarationV1): Promise<LocalServiceRuntimeSnapshotV1>;
    get?(id: string): Promise<LocalServiceRuntimeSnapshotV1 | null>;
    stop?(id: string): Promise<void>;
}>;

export type LocalServicesPreviewEndpointRegistrationResult =
    | Readonly<{
        ok: true;
        resource: LocalServicePreviewResourceV1;
        accessUrl: string;
        expiresAt: number;
    }>
    | Readonly<{
        ok: false;
        reasonCode: string;
    }>;

export type ManagedLocalServicesRuntimeOptions = Readonly<{
    exec: Pick<ExecRuntimeServiceV1, 'spawn'>;
    signal?: AbortSignal;
    detectAfterLaunchReadinessTimeoutMs?: number;
    registerPreviewEndpoint?: (
        resource: LocalServicePreviewResourceV1,
    ) => Promise<LocalServicesPreviewEndpointRegistrationResult> | LocalServicesPreviewEndpointRegistrationResult;
    unregisterPreviewEndpoint?: (previewId: string) => Promise<void> | void;
    /** Optional loopback port range for daemon-allocated assign-and-inject services. */
    portRange?: Readonly<{ start: number; end: number }>;
    /**
     * Optional override for the assign-and-inject health probe (defaults to a binary-safe
     * loopback TCP-connect / HTTP GET). Tests inject a deterministic probe here.
     */
    healthProbe?: (input: Readonly<{ host: string; port: number; path?: string; timeoutMs: number }>) => Promise<boolean>;
    /**
     * Reconstructs supervision for an already-verified process. Verification remains
     * SVC09-owned; this boundary only supplies an OS process handle after proof succeeds.
     */
    reattachProcess?: (
        attachment: ManagedLocalServiceRunAttachmentV1,
    ) => Promise<ExecProcessHandleV1>;
    reattachProcessControl?: TerminateProcessControl;
    reattachTerminationGraceMs?: number;
}>;

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
    pluginBridgeRoutes: PluginLocalServicesBridgeControlRoutes;
    trustedManagedLocalServices: Readonly<{
        start(input: Readonly<{
            context: TrustedManagedLocalServiceOwnerContext;
            declaration: LocalServiceDeclarationV1;
            exec: Pick<ExecRuntimeServiceV1, 'spawn'>;
        }>): Promise<LocalServiceRuntimeSnapshotV1>;
        startOwned(input: Readonly<{
            context: TrustedManagedLocalServiceOwnerContext;
            declaration: LocalServiceDeclarationV1;
            exec: Pick<ExecRuntimeServiceV1, 'spawn'>;
        }>): Promise<TrustedManagedLocalServiceOwnedRun | null>;
        readOwnedRun(input: Readonly<{
            context: TrustedManagedLocalServiceOwnerContext;
            serviceId: string;
        }>): TrustedManagedLocalServiceOwnedRun | null;
        reattachVerifiedRun(input: Readonly<{
            context: TrustedManagedLocalServiceOwnerContext;
            declaration: LocalServiceDeclarationV1;
            attachment: ManagedLocalServiceRunAttachmentV1;
            verifyMaterialization: () => Promise<boolean>;
            verifyReadiness?: () => Promise<boolean>;
            verifyExecutableArtifact?: (input: Readonly<{
                observedExecutablePath: string;
                declaredExecutablePath: string;
            }>) => Promise<boolean>;
        }>): Promise<
            | Readonly<{ ok: true; ownedRun: TrustedManagedLocalServiceOwnedRun }>
                | Readonly<{ ok: false; reasonCode: string }>
        >;
        finalizeReattachedAuthority(
            run: TrustedManagedLocalServiceOwnedRun,
            commit: () => void,
        ): Promise<TrustedManagedLocalServiceAuthorityFinalizationResult>;
        registerOwnedCleanup(
            run: Pick<TrustedManagedLocalServiceOwnedRun, 'serviceKey' | 'runId'>,
            cleanup: () => void | Promise<void>,
            options?: Readonly<{
                phase?: 'beforeProcessStop' | 'afterProcessStop';
            }>,
        ): boolean;
        transferOwned(run: Pick<TrustedManagedLocalServiceOwnedRun, 'serviceKey' | 'runId'>):
            Promise<TrustedManagedLocalServiceTransferResult>;
        stopOwned(run: Pick<TrustedManagedLocalServiceOwnedRun, 'serviceKey' | 'runId'>):
            Promise<TrustedManagedLocalServiceStopResult>;
    }>;
    refreshInventoryNow(): Promise<NormalizedLocalServiceInventorySnapshot>;
    syncHostedWebStaticAssets(
        contributions: readonly HostedWebStaticAssetLifecycleContribution[],
    ): Promise<HostedWebStaticAssetLifecycleSyncResult>;
    hostedWebStaticAssetsSnapshot(): HostedWebStaticAssetLifecycleSyncResult;
    stopHostedWebStaticAssets(): Promise<void>;
    createPluginLocalServicesBridge(context: PluginLocalServicesBridgeContext): PluginLocalServicesDaemonBridge;
    stop(options?: Readonly<{ disposition?: 'permanent' | 'transfer' }>): Promise<void>;
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
const LOCAL_SERVICE_PROCESS_SCAN_FAILURE_CODES = new Set([
    'darwin_process_fact_scan_failed',
    'linux_procfs_scan_failed',
    'windows_process_fact_scan_failed',
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

const PLUGIN_LOCAL_SERVICE_DAEMON_BRIDGE_UNAVAILABLE_DIAGNOSTIC = Object.freeze({
    code: 'PLUGIN_LOCAL_SERVICE_DAEMON_BRIDGE_UNAVAILABLE',
    severity: 'warning' as const,
    message: 'Plugin local-service launch requires the daemon managed local-services substrate.',
});

const PLUGIN_LOCAL_SERVICE_UNSUPPORTED_LAUNCH_MODE_DIAGNOSTIC = Object.freeze({
    code: 'PLUGIN_LOCAL_SERVICE_UNSUPPORTED_LAUNCH_MODE',
    severity: 'error' as const,
    message: 'The daemon local-services bridge currently supports detect-after-launch services only.',
});

const PLUGIN_LOCAL_SERVICE_START_FAILED_DIAGNOSTIC = Object.freeze({
    code: 'PLUGIN_LOCAL_SERVICE_START_FAILED',
    severity: 'error' as const,
    message: 'Daemon local-service launch failed before preview correlation completed.',
});

const PLUGIN_LOCAL_SERVICE_PROCESS_PID_UNAVAILABLE_DIAGNOSTIC = Object.freeze({
    code: 'PLUGIN_LOCAL_SERVICE_PROCESS_PID_UNAVAILABLE',
    severity: 'error' as const,
    message: 'Daemon local-service launch did not return a process id for inventory correlation.',
});

const PLUGIN_LOCAL_SERVICE_PREVIEW_ENDPOINT_UNAVAILABLE_DIAGNOSTIC = Object.freeze({
    code: 'PLUGIN_LOCAL_SERVICE_PREVIEW_ENDPOINT_UNAVAILABLE',
    severity: 'warning' as const,
    message: 'Managed local-service preview URL minting is unavailable.',
});

const PLUGIN_LOCAL_SERVICE_PREVIEW_REGISTRY_FAILED_DIAGNOSTIC = Object.freeze({
    code: 'PLUGIN_LOCAL_SERVICE_PREVIEW_REGISTRY_FAILED',
    severity: 'warning' as const,
    message: 'Managed local-service preview registration was rejected by the daemon preview registry.',
});

type PluginLocalServiceDiagnostic = LocalServiceRuntimeSnapshotV1['diagnostics'][number];

function previewEndpointRegistrationFailedDiagnostic(reasonCode: string): PluginLocalServiceDiagnostic {
    return {
        code: 'PLUGIN_LOCAL_SERVICE_PREVIEW_ENDPOINT_REGISTRATION_FAILED',
        severity: 'warning',
        message: reasonCode,
    };
}

function stoppedPluginLocalServiceSnapshot(id: string): LocalServiceRuntimeSnapshotV1 {
    return Object.freeze({
        id,
        phase: 'stopped' as const,
        diagnostics: Object.freeze([]),
    });
}

function failedPluginLocalServiceSnapshot(
    id: string,
    diagnostic: PluginLocalServiceDiagnostic,
): LocalServiceRuntimeSnapshotV1 {
    return Object.freeze({
        id,
        phase: 'failed' as const,
        diagnostics: Object.freeze([Object.freeze({ ...diagnostic })]),
    });
}

function freezePluginLocalServiceDiagnostics(
    diagnostics: readonly PluginLocalServiceDiagnostic[],
): readonly PluginLocalServiceDiagnostic[] {
    return Object.freeze(diagnostics.map((diagnostic) => Object.freeze({ ...diagnostic })));
}

function snapshotFromManagedState(
    state: ManagedLocalServiceRuntimeState,
    options: Readonly<{
        id?: string;
        url?: string;
        diagnostics?: readonly PluginLocalServiceDiagnostic[];
    }> = {},
): LocalServiceRuntimeSnapshotV1 {
    const snapshot: {
        id: string;
        phase: LocalServiceRuntimeSnapshotV1['phase'];
        inventoryId?: string;
        port?: number;
        url?: string;
        diagnostics: readonly PluginLocalServiceDiagnostic[];
    } = {
        id: options.id ?? state.id,
        phase: state.phase,
        diagnostics: freezePluginLocalServiceDiagnostics(options.diagnostics ?? state.diagnostics),
    };
    if (state.inventoryId) {
        snapshot.inventoryId = state.inventoryId;
    }
    if (typeof state.port === 'number') {
        snapshot.port = state.port;
    }
    if (options.url) {
        snapshot.url = options.url;
    }
    return Object.freeze(snapshot);
}

function pluginManagedServiceKey(
    context: TrustedManagedLocalServiceOwnerContext,
    serviceId: string,
): string {
    return typeof context.sessionId === 'string'
        ? JSON.stringify([
            context.pluginId,
            context.contributionId,
            context.sessionId,
            serviceId,
        ])
        : JSON.stringify([
            context.pluginId,
            context.contributionId,
            'operation',
            context.operationId,
            serviceId,
        ]);
}

function pluginManagedWorkspaceKey(
    context: TrustedManagedLocalServiceOwnerContext,
): string {
    return typeof context.sessionId === 'string'
        ? context.sessionId
        : `operation:${context.operationId}`;
}

function canonicalExecutablePath(path: string): string {
    const canonical = normalize(resolve(path.trim()));
    return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}

async function scanPlatformLocalServices(): Promise<LocalServicesScanResult> {
    if (process.platform === 'darwin') {
        const result = await readDarwinLocalServiceListeners({
            execFile: promisify(execFile),
        });
        return {
            listeners: result.listeners,
            processes: result.processes,
            workspaces: [],
            diagnostics: result.diagnostics,
        };
    }

    if (process.platform === 'win32') {
        const result = await readWindowsLocalServiceListeners({
            execFile: promisify(execFile),
        });
        return {
            listeners: result.listeners,
            processes: result.processes,
            workspaces: [],
            diagnostics: result.diagnostics,
        };
    }

    const result = await readLinuxLocalServiceListeners({
        readFile,
        readdir,
        readlink,
    });
    return {
        listeners: result.listeners,
        processes: result.processes,
        workspaces: [],
        diagnostics: result.diagnostics,
    };
}

async function readDaemonSessionWorkspaceFacts(): Promise<readonly LocalServiceWorkspaceFact[]> {
    return resolveLocalServiceWorkspaceFactsFromSessionMarkers(await listSessionMarkers());
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
    managedLocalServices?: ManagedLocalServicesRuntimeOptions;
    readManagedProcessIdentityByPid?: typeof readProcessIdentityByPid;
}>): LocalServicesDaemonRuntime {
    const inventoryRegistry = createLocalServiceInventoryRegistry();
    // Shared daemon-process terminal->port registry: the same instance the PTY session
    // manager writes to on spawn. The scanner consults it for deterministic, attributed
    // workspace scoping. Defaults to the process singleton; tests inject a fresh one.
    const terminalRegistry = params.terminalRegistry ?? getSharedTerminalProcessRegistry();
    const managedRegistry = createManagedLocalServiceRegistry();
    const previewRegistry = createLocalServicePreviewRegistry();
    const runtimeStopController = new AbortController();
    const pluginManagedSnapshots = new Map<string, LocalServiceRuntimeSnapshotV1>();
    const pluginManagedProcesses = new Map<string, ExecProcessHandleV1>();
    const pluginManagedProcessIdentities = new Map<string, Readonly<{
        processStartTimeMs: number;
        processCommandHash: string;
        reattachedOwnership?: Readonly<{
            attachment: ManagedLocalServiceRunAttachmentV1;
            expectedExecutablePath: string;
        }>;
    }>>();
    const pluginManagedProcessMonitorStops = new Map<string, () => void>();
    const pluginManagedOwnedCleanups = new Map<string, Readonly<{
        runId: number;
        beforeProcessStop: Array<() => void | Promise<void>>;
        afterProcessStop: Array<() => void | Promise<void>>;
    }>>();
    const pluginManagedPreviewIds = new Map<string, string>();
    const operationManagedServiceKeys = new Set<string>();
    const pluginManagedLaunchIntents = new Map<string, PluginManagedLocalServiceLaunchIntent>();
    const pluginManagedStartDeclarations = createManagedLocalServiceStartDeclarationRegistry();
    // Assign-and-inject substrate (LSV-2). Module-scoped so reservations/route-locks/run-ids
    // persist across a keep-alive restart of the same serviceKey but are released on stop/exit/failure.
    const managedPortAllocator = createLocalServicePortAllocator({
        range: params.managedLocalServices?.portRange ?? { start: MANAGED_LOCAL_SERVICE_PORT_RANGE.start, end: MANAGED_LOCAL_SERVICE_PORT_RANGE.end },
        // Binary-safe synchronous availability: consult the observed inventory snapshot for
        // currently-listening loopback ports + the allocator's own reservation set (no bind,
        // no TOCTOU). The post-spawn health monitor doubles as bind confirmation.
        isPortAvailable: (port) => !inventoryListeningPorts().has(port),
    });
    const managedRouteLockStore = createLocalServiceRouteLockStore();
    const managedLifecycleGuard = createLocalServiceLifecycleGuard();
    // serviceKey -> the assigned launch facts for the live assign-and-inject run (used for
    // route-lock + port release on stop/exit/failure, and to feed the health monitor).
    const pluginManagedAssignedLaunches = new Map<string, ManagedAssignedLaunch>();
    // serviceKey -> when it entered a terminal phase (for stale-entry cleanup on the loop).
    const pluginManagedTerminalAt = new Map<string, number>();
    const processEnv = params.processEnv ?? process.env;
    const now = params.now ?? (() => Date.now());
    const scan = params.scan ?? scanPlatformLocalServices;
    const reattachProcessControl = params.managedLocalServices?.reattachProcessControl
        ?? createOsProcessControl({ scan });

    type ReattachedProcessStatus = 'current' | 'absent' | 'mismatch' | 'unverifiable';

    class ReattachedManagedProcessOwnershipError extends Error {
        readonly code = 'reattached_managed_process_ownership_unverified';

        constructor(readonly status: Exclude<ReattachedProcessStatus, 'current' | 'absent'>) {
            super(`reattached_managed_process_${status}`);
            this.name = 'ReattachedManagedProcessOwnershipError';
        }
    }

    async function inspectReattachedProcessStatus(input: Readonly<{
        attachment: ManagedLocalServiceRunAttachmentV1;
        expectedExecutablePath: string;
    }>): Promise<ReattachedProcessStatus> {
        let current: LocalServicesScanResult;
        try {
            current = await scan();
        } catch {
            return 'unverifiable';
        }
        const listener = current.listeners.find((candidate) => (
            candidate.address === input.attachment.endpoint.host
            && candidate.port === input.attachment.endpoint.port
            && candidate.protocol === 'tcp'
        ));
        const processFact = current.processes.get(input.attachment.process.pid);
        if (!processFact) {
            const occupied = current.listeners.some((candidate) => (
                candidate.port === input.attachment.endpoint.port
                && candidate.protocol === 'tcp'
            ));
            if (occupied) return 'mismatch';
            if (current.diagnostics.some((diagnostic) => (
                LOCAL_SERVICE_LISTENER_SCAN_FAILURE_CODES.has(diagnostic.code)
                || LOCAL_SERVICE_PROCESS_SCAN_FAILURE_CODES.has(diagnostic.code)
            ))) {
                return 'unverifiable';
            }
            try {
                return await reattachProcessControl.isProcessAlive(
                    input.attachment.process.pid,
                )
                    ? 'mismatch'
                    : 'absent';
            } catch {
                return 'unverifiable';
            }
        }
        const command = processFact?.command?.trim() ?? '';
        const executablePath = processFact?.executablePath?.trim() ?? '';
        return listener?.pid === input.attachment.process.pid
            && processFact?.processStartTimeMs
                === input.attachment.process.processStartTimeMs
            && command.length > 0
            && hashProcessCommand(command)
                === input.attachment.process.processCommandHash
            && executablePath.length > 0
            && canonicalExecutablePath(executablePath)
                === canonicalExecutablePath(input.expectedExecutablePath)
            && (
                !processFact.cwd
                || canonicalAbsolutePathsEqual(
                    processFact.cwd,
                    input.attachment.materialization.rootDir,
                )
            )
            ? 'current'
            : 'mismatch';
    }

    function createDefaultReattachedProcessHandle(input: Readonly<{
        serviceKey: string;
        attachment: ManagedLocalServiceRunAttachmentV1;
        expectedExecutablePath: string;
    }>): ExecProcessHandleV1 {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | null = null;
        let resolveExit!: (result: {
            exitCode: number | null;
            signal: string | null;
            stdout: string;
            stderr: string;
        }) => void;
        let rejectExit!: (error: unknown) => void;
        const exit = new Promise<{
            exitCode: number | null;
            signal: string | null;
            stdout: string;
            stderr: string;
        }>((resolvePromise, rejectPromise) => {
            resolveExit = resolvePromise;
            rejectExit = rejectPromise;
        });
        const stopMonitor = (): void => {
            stopped = true;
            if (timer) clearTimeout(timer);
            timer = null;
            if (pluginManagedProcessMonitorStops.get(input.serviceKey) === stopMonitor) {
                pluginManagedProcessMonitorStops.delete(input.serviceKey);
            }
        };
        const schedule = (): void => {
            if (stopped) return;
            timer = setTimeout(() => {
                void inspectReattachedProcessStatus(input).then((status) => {
                    if (status === 'absent') {
                        stopMonitor();
                        resolveExit({
                            exitCode: null,
                            signal: null,
                            stdout: '',
                            stderr: '',
                        });
                        return;
                    }
                    if (status !== 'current') {
                        stopMonitor();
                        rejectExit(new ReattachedManagedProcessOwnershipError(status));
                        return;
                    }
                    schedule();
                }).catch(() => {
                    stopMonitor();
                    rejectExit(new ReattachedManagedProcessOwnershipError('unverifiable'));
                });
            }, 1_000);
            timer.unref?.();
        };
        pluginManagedProcessMonitorStops.set(input.serviceKey, stopMonitor);
        schedule();

        return Object.freeze({
            pid: input.attachment.process.pid,
            exit,
            async writeStdin(): Promise<void> {
                throw new Error('reattached_managed_process_stdin_unavailable');
            },
            // A synchronous kill affordance cannot perform the mandatory identity
            // revalidation. Canonical managed shutdown calls the guarded async dispose.
            kill(): void {},
            async dispose(): Promise<void> {
                const initialStatus = await inspectReattachedProcessStatus(input);
                if (initialStatus === 'absent') {
                    stopMonitor();
                    return;
                }
                if (initialStatus !== 'current') {
                    throw new ReattachedManagedProcessOwnershipError(initialStatus);
                }
                const current = await reattachProcessControl.probeListener({
                    host: input.attachment.endpoint.host,
                    port: input.attachment.endpoint.port,
                });
                if (
                    !current
                    || current.pid !== input.attachment.process.pid
                    || current.startTime !== input.attachment.process.processStartTimeMs
                    || !current.command
                    || hashProcessCommand(current.command.trim())
                        !== input.attachment.process.processCommandHash
                ) {
                    throw new ReattachedManagedProcessOwnershipError('mismatch');
                }
                // The process-control probe intentionally accepts compatible wildcard
                // listeners for general termination. Re-scan the attachment's exact
                // loopback host immediately before signaling so that broader rebinding
                // or PID reuse during the probe cannot inherit this stop authority.
                const preSignalStatus = await inspectReattachedProcessStatus(input);
                if (preSignalStatus === 'absent') {
                    stopMonitor();
                    return;
                }
                if (preSignalStatus !== 'current') {
                    throw new ReattachedManagedProcessOwnershipError(preSignalStatus);
                }
                stopMonitor();
                const graceMs = Math.max(
                    0,
                    params.managedLocalServices?.reattachTerminationGraceMs ?? 4_000,
                );
                if (reattachProcessControl.platform === 'windows') {
                    await reattachProcessControl.terminateWindowsTree({
                        pid: input.attachment.process.pid,
                        force: false,
                    });
                    await reattachProcessControl.wait(graceMs);
                    const postGraceStatus = await inspectReattachedProcessStatus(input);
                    if (postGraceStatus === 'current') {
                        await reattachProcessControl.terminateWindowsTree({
                            pid: input.attachment.process.pid,
                            force: true,
                        });
                        await reattachProcessControl.wait(graceMs);
                        const postForceStatus =
                            await inspectReattachedProcessStatus(input);
                        if (postForceStatus === 'current') {
                            throw new Error(
                                'reattached_managed_process_stop_incomplete',
                            );
                        }
                        if (postForceStatus !== 'absent') {
                            throw new ReattachedManagedProcessOwnershipError(
                                postForceStatus,
                            );
                        }
                    } else if (postGraceStatus !== 'absent') {
                        throw new ReattachedManagedProcessOwnershipError(postGraceStatus);
                    }
                } else {
                    await reattachProcessControl.signal({
                        pid: input.attachment.process.pid,
                        signal: 'SIGTERM',
                        group: false,
                    });
                    await reattachProcessControl.wait(graceMs);
                    const postGraceStatus = await inspectReattachedProcessStatus(input);
                    if (postGraceStatus === 'current') {
                        await reattachProcessControl.signal({
                            pid: input.attachment.process.pid,
                            signal: 'SIGKILL',
                            group: false,
                        });
                        await reattachProcessControl.wait(graceMs);
                        const postForceStatus =
                            await inspectReattachedProcessStatus(input);
                        if (postForceStatus === 'current') {
                            throw new Error(
                                'reattached_managed_process_stop_incomplete',
                            );
                        }
                        if (postForceStatus !== 'absent') {
                            throw new ReattachedManagedProcessOwnershipError(
                                postForceStatus,
                            );
                        }
                    } else if (postGraceStatus !== 'absent') {
                        throw new ReattachedManagedProcessOwnershipError(postGraceStatus);
                    }
                }
            },
        });
    }
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
    const workspaceFacts = params.workspaceFacts ?? (params.scan ? undefined : readDaemonSessionWorkspaceFacts);
    const staleAfterMs = params.staleAfterMs ?? DEFAULT_LOCAL_SERVICE_CAPABILITIES.inventory.staleAfterMs;
    // Currently-listening loopback ports observed by the scanner — the binary-safe, no-TOCTOU
    // input to the port allocator's availability check.
    function inventoryListeningPorts(): ReadonlySet<number> {
        const ports = new Set<number>();
        for (const entry of inventoryRegistry.getSnapshot().entries) {
            if (entry.state === 'listening' && entry.address.kind === 'loopback') {
                ports.add(entry.port);
            }
        }
        return ports;
    }
    // Daemon-internal health monitor (refinement 2): ticked from the existing inventory loop,
    // no second timer. Transitions update both the registry phase and the bridge snapshot.
    const managedHealthMonitor = createManagedHealthMonitor({
        now,
        ...(params.managedLocalServices?.healthProbe ? { probe: params.managedLocalServices.healthProbe } : {}),
        onTransition: ({ serviceKey, runId, pid, phase }) => {
            if (!managedLifecycleGuard.isCurrentRun(serviceKey, runId)) return;
            const next = managedRegistry.markHealthPhase({ serviceId: serviceKey, pid, phase });
            if (!next) return;
            const previous = pluginManagedSnapshots.get(serviceKey);
            pluginManagedSnapshots.set(serviceKey, snapshotFromManagedState(next, {
                id: previous?.id ?? pluginManagedSnapshotId(serviceKey),
                ...(previous?.url ? { url: previous.url } : {}),
            }));
        },
    });
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

    // Ticked from the inventory loop (no second timer): run one health-monitor pass over live
    // assign-and-inject services, then prune stale stopped/failed managed entries.
    async function tickManagedHealthAndCleanup(): Promise<void> {
        const monitored = managedRegistry.listServices()
            .filter((service) => service.launchMode === 'assignAndInject'
                && (service.phase === 'running' || service.phase === 'unhealthy')
                && typeof service.port === 'number'
                && typeof service.host === 'string')
            .map((service) => {
                const assigned = pluginManagedAssignedLaunches.get(service.id);
                const healthCheck = assigned?.healthCheck ?? { kind: 'none' as const };
                return {
                    serviceKey: service.id,
                    runId: managedLifecycleGuard.currentRunId(service.id),
                    pid: service.process.pid,
                    host: service.host as string,
                    port: service.port as number,
                    startedAt: assigned?.startedAt ?? service.process.startedAt,
                    healthCheck: healthCheck.kind === 'http'
                        ? { kind: 'http' as const, ...(healthCheck.path ? { path: healthCheck.path } : {}), ...(healthCheck.timeoutMs ? { timeoutMs: healthCheck.timeoutMs } : {}) }
                        : healthCheck.kind === 'command'
                            ? { kind: 'command' as const, ...(healthCheck.timeoutMs ? { timeoutMs: healthCheck.timeoutMs } : {}) }
                            : { kind: 'none' as const },
                };
            });
        try {
            await managedHealthMonitor.tick(monitored);
        } catch (error) {
            params.onError?.(error);
        }

        // Stale cleanup: terminal (stopped/failed) managed entries older than staleAfterMs.
        const cleanupCandidates = managedRegistry.listServices()
            .filter((service) => service.phase === 'failed' || service.phase === 'stopped')
            .map((service) => {
                const declaration = pluginManagedStartDeclarations.getByServiceKey(service.id);
                return {
                    id: service.id,
                    phase: service.phase,
                    updatedAt: pluginManagedTerminalAt.get(service.id) ?? 0,
                    staleAfterMs: declaration?.declaration.cleanup.staleAfterMs
                        ?? DEFAULT_LOCAL_SERVICE_CAPABILITIES.inventory.staleAfterMs,
                };
            });
        const staleIds = selectManagedLocalServiceCleanupIds({ now: now(), services: cleanupCandidates });
        for (const id of staleIds) {
            managedRegistry.stopIntentional(id);
            pluginManagedTerminalAt.delete(id);
            pluginManagedSnapshots.delete(id);
        }
    }

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
        for (const entry of snapshotWithDiagnostics.entries) {
            managedRegistry.applyInventoryEntry(entry);
        }
        // Publish only after the canonical managed registry has consumed the same snapshot so
        // one-shot readiness subscribers observe the committed lifecycle transition.
        inventoryRegistry.replaceSnapshot(snapshotWithDiagnostics);
        await tickManagedHealthAndCleanup();
        return snapshotWithDiagnostics;
    };

    // Single-flight + coalesce manual refreshes onto one in-flight scan. The periodic loop
    // tick, the RPC manual-refresh route (`refreshSnapshot`), and the bare managed-launch
    // callers all share this guard, so concurrent callers await the same machine-wide
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
                const workspaceRoots = (await readDaemonSessionWorkspaceFacts())
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
        resolveSessionWorkspacePathsFromSessionMarkers(await listSessionMarkers(), sessionId);
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
        isManagedServiceVisible: (serviceId) => !operationManagedServiceKeys.has(serviceId),
        previewRegistry,
        startDeclarations: {
            listLaunchTargets: (input) => pluginManagedStartDeclarations.listLaunchTargets({
                ...input,
                isStartable: canStartPluginManagedDeclaration,
            }),
        },
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
        resolveStartTarget: resolvePluginManagedLauncherStartTarget,
        startManagedDeclaration: async (declaration) => startPluginManagedDeclarationFromLauncher(declaration),
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
        managedStopEnabled: () => true,
        managedRestartEnabled: (service) => canRestartPluginManagedService(service.id),
        verifyConfirmationNonce: isLocalServiceActionConfirmationNonceV1,
        stopManagedService: async ({ service }) => stopPluginManagedService(service.id),
        restartManagedService: async ({ service }) => restartPluginManagedService(service.id),
        terminateDetectedService,
    });
    const managedRoutes = createLocalServiceManagedRoutes({
        machineId: params.machineId,
        registry: managedRegistry,
        now,
        resolveSupportedActions: (service) => {
            const supported: Array<'stop_managed' | 'restart_managed'> = [];
            if (canStopPluginManagedService(service.id)) supported.push('stop_managed' as const);
            if (canRestartPluginManagedService(service.id)) supported.push('restart_managed' as const);
            return supported;
        },
    });
    const pluginBridgeRoutes = createPluginLocalServicesBridgeControlRoutes({
        createPluginLocalServicesBridge,
    });

    async function unregisterManagedPreview(serviceId: string): Promise<void> {
        const previewId = pluginManagedPreviewIds.get(serviceId);
        if (!previewId) return;
        unregisterLocalServicePreview(previewRegistry, previewId);
        await params.managedLocalServices?.unregisterPreviewEndpoint?.(previewId);
        pluginManagedPreviewIds.delete(serviceId);
    }

    async function runPluginManagedOwnedCleanups(
        serviceKey: string,
        runId: number,
        phase: 'beforeProcessStop' | 'afterProcessStop',
    ): Promise<void> {
        const owned = pluginManagedOwnedCleanups.get(serviceKey);
        if (!owned || owned.runId !== runId) return;
        const cleanups = [...owned[phase]];
        const failures: unknown[] = [];
        for (let index = cleanups.length - 1; index >= 0; index -= 1) {
            const cleanup = cleanups[index];
            if (!cleanup) continue;
            try {
                await cleanup();
                const current =
                    pluginManagedOwnedCleanups.get(serviceKey);
                if (current === owned && current.runId === runId) {
                    const currentIndex =
                        current[phase].lastIndexOf(cleanup);
                    if (currentIndex >= 0) {
                        current[phase].splice(currentIndex, 1);
                    }
                }
            } catch (error) {
                failures.push(error);
            }
        }
        if (failures.length > 0) {
            throw new AggregateError(
                failures,
                'managed_local_service_owned_cleanup_incomplete',
            );
        }
        if (
            phase === 'afterProcessStop'
            && owned.beforeProcessStop.length === 0
            && owned.afterProcessStop.length === 0
            && pluginManagedOwnedCleanups.get(serviceKey) === owned
        ) {
            pluginManagedOwnedCleanups.delete(serviceKey);
        }
    }

    async function disposeManagedProcess(serviceId: string): Promise<void> {
        const processHandle = pluginManagedProcesses.get(serviceId);
        if (!processHandle) return;
        await processHandle.dispose();
        pluginManagedProcessMonitorStops.get(serviceId)?.();
        pluginManagedProcesses.delete(serviceId);
        pluginManagedProcessIdentities.delete(serviceId);
    }

    function canStopPluginManagedService(serviceId: string): boolean {
        return pluginManagedProcesses.has(serviceId) || pluginManagedPreviewIds.has(serviceId);
    }

    function pluginManagedSnapshotId(serviceId: string): string {
        const existing = pluginManagedSnapshots.get(serviceId);
        if (existing) return existing.id;
        try {
            const parsed = JSON.parse(serviceId) as unknown;
            if (
                Array.isArray(parsed)
                && typeof parsed[parsed.length - 1] === 'string'
                && parsed[parsed.length - 1].trim().length > 0
            ) {
                return parsed[parsed.length - 1];
            }
        } catch {
            // Service ids are not all JSON plugin keys; fall back to the opaque id.
        }
        return serviceId;
    }

    // Canonical route-name owner (names.ts) — handles the 63-char DNS clamp + hash suffix the
    // prior duplicated inline route-name code lacked. Both launch modes route through the single
    // owner `resolveLocalServiceRouteName`.
    function managedServiceRouteName(
        context: TrustedManagedLocalServiceOwnerContext,
        declaration: LocalServiceDeclarationV1,
    ): string {
        return resolveLocalServiceRouteName({
            ownerKey: `${context.pluginId}:${context.contributionId}`,
            serviceId: declaration.id,
            workspaceKey: pluginManagedWorkspaceKey(context),
        });
    }

    function createPluginManagedLaunchIntent(
        context: TrustedManagedLocalServiceOwnerContext,
        declaration: LocalServiceDeclarationV1,
        exec?: Pick<ExecRuntimeServiceV1, 'spawn'>,
    ): PluginManagedLocalServiceLaunchIntent {
        return Object.freeze({
            serviceKey: pluginManagedServiceKey(context, declaration.id),
            context,
            declaration,
            restartPolicy: { kind: 'manual', strategy: 'same_launch' } as const,
            ...(exec ? { exec } : {}),
        });
    }

    function declarePluginManagedStartDeclaration(
        context: TrustedManagedLocalServiceOwnerContext,
        declaration: LocalServiceDeclarationV1,
    ): ManagedLocalServiceStartDeclaration {
        const serviceKey = pluginManagedServiceKey(context, declaration.id);
        if (typeof context.operationId === 'string') {
            operationManagedServiceKeys.add(serviceKey);
        }
        return pluginManagedStartDeclarations.declare({
            machineId: params.machineId,
            serviceKey,
            context,
            declaration,
            declaredAt: now(),
        });
    }

    function resolvePluginManagedStartSupport(
        declaration: ManagedLocalServiceStartDeclaration,
    ): Readonly<{
        ok: true;
        managedLocalServices: ManagedLocalServicesRuntimeOptions;
    }> | Readonly<{
        ok: false;
        reasonCode: string;
    }> {
        // detectAfterLaunch + assignAndInject are productized; externalRegistered stays denied.
        if (declaration.declaration.launchMode.kind === 'externalRegistered') {
            return { ok: false, reasonCode: 'start_launch_mode_unsupported' };
        }
        const managedLocalServices = params.managedLocalServices;
        if (!managedLocalServices) {
            return { ok: false, reasonCode: 'start_runtime_unavailable' };
        }
        if (managedLocalServices.signal?.aborted === true) {
            return { ok: false, reasonCode: 'start_signal_aborted' };
        }
        return { ok: true, managedLocalServices };
    }

    function canStartPluginManagedDeclaration(
        declaration: ManagedLocalServiceStartDeclaration,
    ): boolean {
        return resolvePluginManagedStartSupport(declaration).ok;
    }

    function resolvePluginManagedLauncherStartTarget(
        request: Readonly<{
            machineId: string;
            targetId: string;
            sessionId?: string;
            workspaceId?: string;
        }>,
    ): Readonly<
        | { ok: true; declaration: ManagedLocalServiceStartDeclaration }
        | { ok: false; reasonCode: string }
    > {
        const declaration = pluginManagedStartDeclarations.getByTargetId(request.targetId);
        if (!declaration) {
            return { ok: false, reasonCode: 'launcher_target_unknown' };
        }
        if (declaration.machineId !== request.machineId) {
            return { ok: false, reasonCode: 'wrong_machine' };
        }
        if (typeof declaration.context.operationId === 'string') {
            return { ok: false, reasonCode: 'launcher_target_unknown' };
        }
        if (request.sessionId && request.sessionId !== declaration.context.sessionId) {
            return { ok: false, reasonCode: 'wrong_session' };
        }
        const support = resolvePluginManagedStartSupport(declaration);
        if (!support.ok) {
            return { ok: false, reasonCode: support.reasonCode };
        }
        return { ok: true, declaration };
    }

    function resolvePluginManagedRestartSupport(serviceId: string): Readonly<{
        ok: true;
        intent: PluginManagedLocalServiceLaunchIntent;
        managedLocalServices: ManagedLocalServicesRuntimeOptions;
    }> | Readonly<{
        ok: false;
        reasonCode: string;
    }> {
        const intent = pluginManagedLaunchIntents.get(serviceId);
        if (!intent) {
            return { ok: false, reasonCode: 'restart_launch_intent_unavailable' };
        }
        const decision = resolveManagedLocalServiceRestartRequest({
            serviceId,
            policy: intent.restartPolicy,
        });
        if (!decision.ok) {
            return { ok: false, reasonCode: decision.reason };
        }
        const managedLocalServices = params.managedLocalServices;
        if (!managedLocalServices) {
            return { ok: false, reasonCode: 'restart_runtime_unavailable' };
        }
        if (managedLocalServices.signal?.aborted === true) {
            return { ok: false, reasonCode: 'restart_signal_aborted' };
        }
        if (intent.declaration.launchMode.kind === 'externalRegistered') {
            return { ok: false, reasonCode: 'restart_launch_mode_unsupported' };
        }
        if (
            !pluginManagedProcesses.has(serviceId)
            && !pluginManagedPreviewIds.has(serviceId)
        ) {
            return { ok: false, reasonCode: 'restart_owner_unavailable' };
        }
        return { ok: true, intent, managedLocalServices };
    }

    function canRestartPluginManagedService(serviceId: string): boolean {
        return resolvePluginManagedRestartSupport(serviceId).ok;
    }

    // Release the port reservation + route-lock for a live assign-and-inject run. Called only
    // on stop / process-exit / failure — NOT on a keep-alive restart (asymmetric
    // port-stability, worktree-bootstrap.ts:764-771): the allocator memoizes by serviceKey, so
    // a restart that does not release re-reserves the same port and the route-lock re-claim is
    // idempotent for the same name+serviceKey.
    function releaseAssignedLaunchResources(serviceKey: string): void {
        const assigned = pluginManagedAssignedLaunches.get(serviceKey);
        if (!assigned) return;
        managedRouteLockStore.release({ name: assigned.routeName, serviceId: serviceKey });
        managedPortAllocator.release(serviceKey);
        managedHealthMonitor.prune(serviceKey);
        pluginManagedAssignedLaunches.delete(serviceKey);
    }

    function attachPluginManagedProcessExit(
        serviceKey: string,
        declaration: LocalServiceDeclarationV1,
        processHandle: ExecProcessHandleV1,
        runId: number,
    ): void {
        void processHandle.exit.then((result) => {
            // Run-identity guard (refinement 5): a stale exit from a superseded run must not
            // tear down the newer run that now owns this serviceKey (complements the registry
            // pid guard at the runtime/preview/port-release layer).
            if (!managedLifecycleGuard.isCurrentRun(serviceKey, runId)) {
                return;
            }
            managedRegistry.handleProcessExit({
                serviceId: serviceKey,
                pid: processHandle.pid ?? -1,
                exitCode: result.exitCode,
            });
            const managedState = managedRegistry.getService(serviceKey);
            if (managedState) {
                releaseAssignedLaunchResources(serviceKey);
                pluginManagedTerminalAt.set(serviceKey, now());
                pluginManagedSnapshots.set(serviceKey, snapshotFromManagedState(managedState, {
                    id: declaration.id,
                }));
            }
        }).catch((error) => {
            if (
                error instanceof ReattachedManagedProcessOwnershipError
                && managedLifecycleGuard.isCurrentRun(serviceKey, runId)
            ) {
                const state = managedRegistry.getService(serviceKey);
                if (state?.process.pid === processHandle.pid) {
                    const fenced = managedRegistry.markProcessOwnershipUnverified({
                        serviceId: serviceKey,
                        pid: state.process.pid,
                    });
                    if (fenced) {
                        pluginManagedSnapshots.set(serviceKey, snapshotFromManagedState(
                            fenced,
                            { id: declaration.id },
                        ));
                    }
                }
            }
            params.onError?.(error);
        });
    }

    function waitForPluginManagedReadiness(input: Readonly<{
        serviceKey: string;
        processHandle: ExecProcessHandleV1;
    }>): Promise<ManagedLocalServiceRuntimeState | null> {
        const initial = managedRegistry.getService(input.serviceKey);
        if (!initial || initial.phase !== 'detecting') {
            return Promise.resolve(initial);
        }
        const configuredTimeoutMs = params.managedLocalServices?.detectAfterLaunchReadinessTimeoutMs;
        const timeoutMs = typeof configuredTimeoutMs === 'number' && Number.isFinite(configuredTimeoutMs)
            ? Math.max(1, Math.trunc(configuredTimeoutMs))
            : (params.refreshIntervalMs ?? DEFAULT_LOCAL_SERVICE_CAPABILITIES.inventory.refreshIntervalMs) + 1_000;
        const signals = [
            params.managedLocalServices?.signal,
            runtimeStopController.signal,
        ].filter((signal): signal is AbortSignal => signal !== undefined);

        return new Promise((resolve) => {
            let settled = false;
            let unsubscribe: () => void = () => undefined;
            const onAbort = () => finish();
            const cleanup = () => {
                unsubscribe();
                clearTimeout(timeout);
                for (const signal of signals) signal.removeEventListener('abort', onAbort);
            };
            const finish = () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(managedRegistry.getService(input.serviceKey));
            };
            const observe = () => {
                const state = managedRegistry.getService(input.serviceKey);
                if (!state || state.phase !== 'detecting') finish();
            };
            const timeout = setTimeout(finish, timeoutMs);
            (timeout as unknown as { unref?: () => void }).unref?.();
            unsubscribe = inventoryRegistry.subscribe(observe);
            for (const signal of signals) signal.addEventListener('abort', onAbort, { once: true });
            void input.processHandle.exit.then(finish, finish);
            if (signals.some((signal) => signal.aborted)) {
                finish();
                return;
            }
            observe();
        });
    }

    function stopPluginManagedService(
        serviceId: string,
        snapshotIdHint?: string,
    ): Promise<LocalServiceActionExecutionOutcome> {
        return managedLifecycleGuard.run(serviceId, () => stopPluginManagedServiceInner(serviceId, snapshotIdHint));
    }

    async function stopPluginManagedServiceInner(
        serviceId: string,
        snapshotIdHint?: string,
    ): Promise<LocalServiceActionExecutionOutcome> {
        if (
            !pluginManagedProcesses.has(serviceId)
            && !pluginManagedPreviewIds.has(serviceId)
        ) {
            return { status: 'denied', reasonCode: 'managed_stop_owner_unavailable' };
        }
        const snapshotId = snapshotIdHint ?? pluginManagedSnapshotId(serviceId);
        const runId = managedLifecycleGuard.currentRunId(serviceId);
        let ownedCleanupFailed = false;
        try {
            await runPluginManagedOwnedCleanups(
                serviceId,
                runId,
                'beforeProcessStop',
            );
        } catch (error) {
            params.onError?.(error);
            return {
                status: 'failed',
                reasonCode: 'managed_stop_authority_retirement_failed',
            };
        }
        try {
            await disposeManagedProcess(serviceId);
            await unregisterManagedPreview(serviceId);
        } catch (error) {
            if (error instanceof ReattachedManagedProcessOwnershipError) {
                const state = managedRegistry.getService(serviceId);
                if (state) {
                    managedRegistry.markProcessOwnershipUnverified({
                        serviceId,
                        pid: state.process.pid,
                    });
                    pluginManagedSnapshots.set(serviceId, snapshotFromManagedState(
                        managedRegistry.getService(serviceId) ?? state,
                        { id: snapshotId },
                    ));
                }
            }
            params.onError?.(error);
            return { status: 'failed', reasonCode: 'managed_stop_owner_failed' };
        }
        try {
            await runPluginManagedOwnedCleanups(
                serviceId,
                runId,
                'afterProcessStop',
            );
        } catch (error) {
            ownedCleanupFailed = true;
            params.onError?.(error);
        }
        const stopped = managedRegistry.stopIntentional(serviceId);
        if (!stopped.ok) {
            return { status: 'denied', reasonCode: 'unknown_managed_service' };
        }
        // Stop releases the port + route lock (asymmetric vs restart) and the run identity.
        releaseAssignedLaunchResources(serviceId);
        managedLifecycleGuard.forget(serviceId);
        pluginManagedLaunchIntents.delete(serviceId);
        pluginManagedSnapshots.set(serviceId, stoppedPluginLocalServiceSnapshot(snapshotId));
        return ownedCleanupFailed
            ? { status: 'failed', reasonCode: 'managed_stop_owner_cleanup_failed' }
            : { status: 'succeeded' };
    }

    // Augmented launch + assigned facts for the assign-and-inject branch, or a typed failure.
    type PreparedAssignAndInjectLaunch =
        | Readonly<{ ok: true; launch: LocalServiceDeclarationV1['launch']; assigned: ManagedAssignedLaunch }>
        | Readonly<{ ok: false; reasonCode: string; diagnostic: PluginLocalServiceDiagnostic }>;

    // Build the per-group port plan, env (PORT/HOST + peer <NAME>_PORT/_URL), framework args,
    // and claim the canonical route name for an assign-and-inject service. Reuses the existing
    // serviceKey port reservation (memoized) so a keep-alive restart reuses the same port.
    function prepareAssignAndInjectLaunch(
        context: TrustedManagedLocalServiceOwnerContext,
        declaration: LocalServiceDeclarationV1,
        serviceKey: string,
        runId: number,
    ): PreparedAssignAndInjectLaunch {
        const launchMode = declaration.launchMode;
        if (launchMode.kind !== 'assignAndInject') {
            return {
                ok: false,
                reasonCode: 'start_launch_mode_unsupported',
                diagnostic: { ...PLUGIN_LOCAL_SERVICE_UNSUPPORTED_LAUNCH_MODE_DIAGNOSTIC },
            };
        }
        const host = declaration.hostPolicy.host ?? DEFAULT_MANAGED_LOCAL_SERVICE_HOST;
        // One exact owner scope (session or bounded operation). NEVER workspace-global.
        const groupDeclarations = pluginManagedStartDeclarations
            .listByOwnerContext(context)
            .filter((entry) => entry.declaration.launchMode.kind === 'assignAndInject')
            .map((entry) => ({ serviceKey: entry.serviceKey, declaration: entry.declaration }));
        // Ensure the service being started is in the plan even before it is declared.
        const declarations = groupDeclarations.some((entry) => entry.serviceKey === serviceKey)
            ? groupDeclarations
            : [...groupDeclarations, { serviceKey, declaration }];

        const plan = buildLocalServicePortPlan({ declarations, host, allocator: managedPortAllocator });
        if (!plan.ok) {
            const diagnostic: PluginLocalServiceDiagnostic = plan.reason === 'env_name_collision'
                ? { code: 'PLUGIN_LOCAL_SERVICE_ENV_NAME_COLLISION', severity: 'error', message: plan.collision.envName }
                : { code: 'PLUGIN_LOCAL_SERVICE_PORT_UNAVAILABLE', severity: 'error', message: plan.reason };
            return {
                ok: false,
                reasonCode: plan.reason === 'env_name_collision' ? 'start_env_name_collision' : 'start_port_unavailable',
                diagnostic,
            };
        }
        const selfEntry = plan.entries.find((entry) => entry.serviceId === declaration.id);
        if (!selfEntry) {
            return {
                ok: false,
                reasonCode: 'start_port_unavailable',
                diagnostic: { code: 'PLUGIN_LOCAL_SERVICE_PORT_UNAVAILABLE', severity: 'error', message: 'port_plan_self_missing' },
            };
        }

        const routeName = resolveLocalServiceRouteName({
            ownerKey: `${context.pluginId}:${context.contributionId}`,
            serviceId: declaration.id,
            workspaceKey: pluginManagedWorkspaceKey(context),
        });
        const claim = managedRouteLockStore.claim({ name: routeName, serviceId: serviceKey });
        if (!claim.ok) {
            return {
                ok: false,
                reasonCode: 'start_route_name_claimed',
                diagnostic: { code: 'PLUGIN_LOCAL_SERVICE_ROUTE_NAME_CLAIMED', severity: 'error', message: routeName },
            };
        }

        // Defense-in-depth: a non-loopback http health target is a misconfiguration — fail the
        // launch (and free the route lock) rather than spawn something we will never probe. The
        // monitor also refuses to probe non-loopback targets (health.ts loopback-by-contract).
        if (declaration.healthCheck.kind === 'http') {
            const healthTarget = resolveManagedLocalServiceHealthTarget({
                host,
                port: selfEntry.port,
                path: declaration.healthCheck.path ?? '/',
            });
            if (!healthTarget.ok) {
                managedRouteLockStore.release({ name: routeName, serviceId: serviceKey });
                return {
                    ok: false,
                    reasonCode: 'start_health_target_invalid',
                    diagnostic: { code: 'PLUGIN_LOCAL_SERVICE_HEALTH_TARGET_INVALID', severity: 'error', message: healthTarget.reason },
                };
            }
        }

        // Own PORT/HOST/URL env (environment.ts) + peer <NAME>_PORT/<NAME>_URL injection.
        const injectKeys = launchMode.environment?.inject ?? [LOCAL_SERVICE_ENV.PORT, LOCAL_SERVICE_ENV.HOST];
        const ownEnv = buildLocalServiceLaunchEnvironment({
            baseEnv: launchEnv(declaration.launch),
            host,
            port: selfEntry.port,
            inject: injectKeys,
        });
        const peerEnv: Record<string, string> = {};
        for (const entry of plan.entries) {
            if (entry.serviceId === declaration.id) continue;
            peerEnv[`${entry.envName}_${LOCAL_SERVICE_ENV.PORT}`] = String(entry.port);
            peerEnv[`${entry.envName}_URL`] = entry.url;
        }
        const framePortArgs = buildRuntimePortArgs({ adapter: 'none', host, port: selfEntry.port, expoLanMode: false });
        const launch = withLaunchEnvAndArgs(declaration.launch, { ...ownEnv, ...peerEnv }, framePortArgs);
        return {
            ok: true,
            launch,
            assigned: {
                routeName,
                host,
                port: selfEntry.port,
                runId,
                healthCheck: declaration.healthCheck,
                startedAt: now(),
            },
        };
    }

    function restartPluginManagedService(serviceId: string): Promise<LocalServiceActionExecutionOutcome> {
        return managedLifecycleGuard.run(serviceId, () => restartPluginManagedServiceInner(serviceId));
    }

    async function restartPluginManagedServiceInner(serviceId: string): Promise<LocalServiceActionExecutionOutcome> {
        const support = resolvePluginManagedRestartSupport(serviceId);
        if (!support.ok) {
            return { status: 'denied', reasonCode: support.reasonCode };
        }
        const { intent, managedLocalServices } = support;
        const launchMode = intent.declaration.launchMode;
        if (launchMode.kind === 'externalRegistered') {
            return { status: 'denied', reasonCode: 'restart_launch_mode_unsupported' };
        }
        try {
            await unregisterManagedPreview(serviceId);
            await disposeManagedProcess(serviceId);
            managedRegistry.stopIntentional(serviceId);
            // Keep-alive restart: do NOT release the port/route lock (asymmetric port-stability).
        } catch (error) {
            params.onError?.(error);
            return { status: 'failed', reasonCode: 'managed_restart_owner_failed' };
        }

        // New run identity for the respawn (stale exits of the old run now short-circuit).
        const runId = managedLifecycleGuard.nextRunId(serviceId);

        let launchInput = intent.declaration.launch;
        let assigned: ManagedAssignedLaunch | null = null;
        if (launchMode.kind === 'assignAndInject') {
            const prepared = prepareAssignAndInjectLaunch(intent.context, intent.declaration, serviceId, runId);
            if (!prepared.ok) {
                pluginManagedSnapshots.set(serviceId, failedPluginLocalServiceSnapshot(intent.declaration.id, prepared.diagnostic));
                return { status: 'failed', reasonCode: `managed_restart_${prepared.reasonCode}` };
            }
            launchInput = prepared.launch;
            assigned = prepared.assigned;
        }

        let processHandle: ExecProcessHandleV1;
        try {
            assertExecRuntimeLaunchSupported(launchInput);
            processHandle = await (intent.exec ?? managedLocalServices.exec).spawn(launchInput, {
                signal: managedLocalServices.signal,
            });
        } catch (error) {
            params.onError?.(error);
            pluginManagedSnapshots.set(serviceId, failedPluginLocalServiceSnapshot(
                intent.declaration.id,
                PLUGIN_LOCAL_SERVICE_START_FAILED_DIAGNOSTIC,
            ));
            return { status: 'failed', reasonCode: 'managed_restart_start_failed' };
        }

        if (typeof processHandle.pid !== 'number') {
            await processHandle.dispose();
            pluginManagedSnapshots.set(serviceId, failedPluginLocalServiceSnapshot(
                intent.declaration.id,
                PLUGIN_LOCAL_SERVICE_PROCESS_PID_UNAVAILABLE_DIAGNOSTIC,
            ));
            return { status: 'failed', reasonCode: 'managed_restart_process_pid_unavailable' };
        }

        pluginManagedProcesses.set(serviceId, processHandle);
        attachPluginManagedProcessExit(serviceId, intent.declaration, processHandle, runId);
        pluginManagedLaunchIntents.set(serviceId, intent);

        let managedState: ManagedLocalServiceRuntimeState;
        if (launchMode.kind === 'assignAndInject' && assigned) {
            pluginManagedAssignedLaunches.set(serviceId, { ...assigned, runId });
            managedState = managedRegistry.startAssignAndInject({
                id: serviceId,
                owner: { kind: 'plugin', pluginId: intent.context.pluginId },
                process: { pid: processHandle.pid, startedAt: assigned.startedAt },
                routeName: assigned.routeName,
                host: assigned.host,
                port: assigned.port,
            });
        } else {
            managedState = managedRegistry.startDetectAfterLaunch({
                id: serviceId,
                owner: { kind: 'plugin', pluginId: intent.context.pluginId },
                minimumConfidence: launchMode.kind === 'detectAfterLaunch' ? launchMode.minimumConfidence ?? 'medium' : 'medium',
                process: { pid: processHandle.pid, startedAt: now() },
                routeName: managedServiceRouteName(intent.context, intent.declaration),
            });
            await refreshInventoryNow();
            managedState = managedRegistry.getService(serviceId) ?? managedState;
        }

        const snapshot = await registerManagedPreview(
            intent.context,
            intent.declaration,
            managedState,
            serviceId,
        );
        pluginManagedSnapshots.set(serviceId, snapshot);
        return { status: 'succeeded' };
    }

    type PluginManagedStartResult = Readonly<
        | { status: 'succeeded'; snapshot: LocalServiceRuntimeSnapshotV1 }
        | { status: 'denied' | 'failed'; reasonCode: string; snapshot: LocalServiceRuntimeSnapshotV1 }
    >;

    function startPluginManagedDeclaration(
        declarationEntry: ManagedLocalServiceStartDeclaration,
        exec?: Pick<ExecRuntimeServiceV1, 'spawn'>,
    ): Promise<PluginManagedStartResult> {
        return managedLifecycleGuard.run(
            declarationEntry.serviceKey,
            () => startPluginManagedDeclarationInner(declarationEntry, exec),
        );
    }

    async function startPluginManagedDeclarationInner(
        declarationEntry: ManagedLocalServiceStartDeclaration,
        exec?: Pick<ExecRuntimeServiceV1, 'spawn'>,
    ): Promise<PluginManagedStartResult> {
        const support = resolvePluginManagedStartSupport(declarationEntry);
        const serviceKey = declarationEntry.serviceKey;
        const declaration = declarationEntry.declaration;
        if (!support.ok) {
            const diagnostic = support.reasonCode === 'start_launch_mode_unsupported'
                ? PLUGIN_LOCAL_SERVICE_UNSUPPORTED_LAUNCH_MODE_DIAGNOSTIC
                : PLUGIN_LOCAL_SERVICE_DAEMON_BRIDGE_UNAVAILABLE_DIAGNOSTIC;
            const snapshot = failedPluginLocalServiceSnapshot(declaration.id, diagnostic);
            pluginManagedSnapshots.set(serviceKey, snapshot);
            return { status: 'denied', reasonCode: support.reasonCode, snapshot };
        }

        try {
            await unregisterManagedPreview(serviceKey);
            await disposeManagedProcess(serviceKey);
            managedRegistry.stopIntentional(serviceKey);
            // A fresh start releases any prior assigned port/route lock; a keep-alive restart
            // (restartPluginManagedService) does NOT (asymmetric port-stability).
            releaseAssignedLaunchResources(serviceKey);
        } catch (error) {
            params.onError?.(error);
            const snapshot = failedPluginLocalServiceSnapshot(
                declaration.id,
                PLUGIN_LOCAL_SERVICE_START_FAILED_DIAGNOSTIC,
            );
            pluginManagedSnapshots.set(serviceKey, snapshot);
            return { status: 'failed', reasonCode: 'managed_start_owner_failed', snapshot };
        }

        const launchMode = declaration.launchMode;
        if (launchMode.kind === 'externalRegistered') {
            const snapshot = failedPluginLocalServiceSnapshot(
                declaration.id,
                PLUGIN_LOCAL_SERVICE_UNSUPPORTED_LAUNCH_MODE_DIAGNOSTIC,
            );
            pluginManagedSnapshots.set(serviceKey, snapshot);
            return { status: 'denied', reasonCode: 'start_launch_mode_unsupported', snapshot };
        }

        // New run identity for this spawn (stale exits of any prior run short-circuit).
        const runId = managedLifecycleGuard.nextRunId(serviceKey);

        let launchInput = declaration.launch;
        let assigned: ManagedAssignedLaunch | null = null;
        if (launchMode.kind === 'assignAndInject') {
            const prepared = prepareAssignAndInjectLaunch(declarationEntry.context, declaration, serviceKey, runId);
            if (!prepared.ok) {
                const snapshot = failedPluginLocalServiceSnapshot(declaration.id, prepared.diagnostic);
                pluginManagedSnapshots.set(serviceKey, snapshot);
                return { status: 'failed', reasonCode: `managed_start_${prepared.reasonCode}`, snapshot };
            }
            launchInput = prepared.launch;
            assigned = prepared.assigned;
        }

        let processHandle: ExecProcessHandleV1;
        try {
            assertExecRuntimeLaunchSupported(launchInput);
            processHandle = await (exec ?? support.managedLocalServices.exec).spawn(launchInput, {
                signal: support.managedLocalServices.signal,
            });
        } catch (error) {
            params.onError?.(error);
            releaseAssignedLaunchResources(serviceKey);
            const snapshot = failedPluginLocalServiceSnapshot(
                declaration.id,
                PLUGIN_LOCAL_SERVICE_START_FAILED_DIAGNOSTIC,
            );
            pluginManagedSnapshots.set(serviceKey, snapshot);
            return { status: 'failed', reasonCode: 'managed_start_failed', snapshot };
        }

        if (typeof processHandle.pid !== 'number') {
            await processHandle.dispose();
            releaseAssignedLaunchResources(serviceKey);
            const snapshot = failedPluginLocalServiceSnapshot(
                declaration.id,
                PLUGIN_LOCAL_SERVICE_PROCESS_PID_UNAVAILABLE_DIAGNOSTIC,
            );
            pluginManagedSnapshots.set(serviceKey, snapshot);
            return { status: 'failed', reasonCode: 'managed_start_process_pid_unavailable', snapshot };
        }

        pluginManagedProcesses.set(serviceKey, processHandle);
        pluginManagedLaunchIntents.set(
            serviceKey,
            createPluginManagedLaunchIntent(declarationEntry.context, declaration, exec),
        );
        attachPluginManagedProcessExit(serviceKey, declaration, processHandle, runId);

        let managedState: ManagedLocalServiceRuntimeState;
        if (launchMode.kind === 'assignAndInject' && assigned) {
            pluginManagedAssignedLaunches.set(serviceKey, { ...assigned, runId });
            managedState = managedRegistry.startAssignAndInject({
                id: serviceKey,
                owner: { kind: 'plugin', pluginId: declarationEntry.context.pluginId },
                process: { pid: processHandle.pid, startedAt: assigned.startedAt },
                routeName: assigned.routeName,
                host: assigned.host,
                port: assigned.port,
            });
        } else {
            managedState = managedRegistry.startDetectAfterLaunch({
                id: serviceKey,
                owner: { kind: 'plugin', pluginId: declarationEntry.context.pluginId },
                minimumConfidence: launchMode.kind === 'detectAfterLaunch' ? launchMode.minimumConfidence ?? 'medium' : 'medium',
                process: { pid: processHandle.pid, startedAt: now() },
                routeName: managedServiceRouteName(declarationEntry.context, declaration),
            });
            await refreshInventoryNow();
            managedState = managedRegistry.getService(serviceKey) ?? managedState;
        }

        const snapshot = await registerManagedPreview(
            declarationEntry.context,
            declaration,
            managedState,
            serviceKey,
        );
        pluginManagedSnapshots.set(serviceKey, snapshot);
        return { status: 'succeeded', snapshot };
    }

    async function startPluginManagedDeclarationFromLauncher(
        declaration: ManagedLocalServiceStartDeclaration,
    ): Promise<Readonly<{ status: 'succeeded' } | { status: 'denied' | 'failed'; reasonCode: string }>> {
        const result = await startPluginManagedDeclaration(declaration);
        return result.status === 'succeeded'
            ? { status: 'succeeded' }
            : { status: result.status, reasonCode: result.reasonCode };
    }

    async function registerManagedPreview(
        context: TrustedManagedLocalServiceOwnerContext,
        declaration: LocalServiceDeclarationV1,
        state: ManagedLocalServiceRuntimeState,
        serviceKey: string,
    ): Promise<LocalServiceRuntimeSnapshotV1> {
        if (state.phase !== 'running' || typeof state.port !== 'number') {
            return snapshotFromManagedState(state, { id: declaration.id });
        }
        if (typeof context.operationId === 'string') {
            return snapshotFromManagedState(state, { id: declaration.id });
        }

        await unregisterManagedPreview(serviceKey);
        const previewInput = createHostedWebManagedLocalServicePreviewResource({
            pluginId: context.pluginId,
            contributionId: context.contributionId,
            serviceId: declaration.id,
            sessionId: context.sessionId,
            machineId: params.machineId,
            endpoint: { scheme: 'http', host: state.host ?? '127.0.0.1', port: state.port },
            title: context.title,
            initialPath: context.initialPath,
        });
        const localRegistration = registerLocalServicePreview(previewRegistry, previewInput);
        if (!localRegistration.ok) {
            return snapshotFromManagedState(state, {
                id: declaration.id,
                diagnostics: [PLUGIN_LOCAL_SERVICE_PREVIEW_REGISTRY_FAILED_DIAGNOSTIC],
            });
        }
        pluginManagedPreviewIds.set(serviceKey, localRegistration.resource.previewId);

        const registerPreviewEndpoint = params.managedLocalServices?.registerPreviewEndpoint;
        if (!registerPreviewEndpoint) {
            return snapshotFromManagedState(state, {
                id: declaration.id,
                diagnostics: [PLUGIN_LOCAL_SERVICE_PREVIEW_ENDPOINT_UNAVAILABLE_DIAGNOSTIC],
            });
        }

        let endpointRegistration: Awaited<ReturnType<NonNullable<ManagedLocalServicesRuntimeOptions['registerPreviewEndpoint']>>>;
        try {
            endpointRegistration = await registerPreviewEndpoint(localRegistration.resource);
        } catch (error) {
            params.onError?.(error);
            return snapshotFromManagedState(state, {
                id: declaration.id,
                diagnostics: [
                    previewEndpointRegistrationFailedDiagnostic('preview_endpoint_registration_rejected'),
                ],
            });
        }
        if (!endpointRegistration.ok) {
            return snapshotFromManagedState(state, {
                id: declaration.id,
                diagnostics: [
                    previewEndpointRegistrationFailedDiagnostic(endpointRegistration.reasonCode),
                ],
            });
        }
        return snapshotFromManagedState(state, {
            id: declaration.id,
            url: endpointRegistration.accessUrl,
            diagnostics: [],
        });
    }

    function createPluginLocalServicesBridge(context: PluginLocalServicesBridgeContext): PluginLocalServicesDaemonBridge {
        return Object.freeze({
            async declare(declaration: LocalServiceDeclarationV1): Promise<LocalServiceRuntimeSnapshotV1> {
                const declarationEntry = declarePluginManagedStartDeclaration(context, declaration);
                const serviceKey = declarationEntry.serviceKey;
                const existing = pluginManagedSnapshots.get(serviceKey);
                if (existing) return existing;
                const snapshot = stoppedPluginLocalServiceSnapshot(declaration.id);
                pluginManagedSnapshots.set(serviceKey, snapshot);
                return snapshot;
            },
            async start(declaration: LocalServiceDeclarationV1): Promise<LocalServiceRuntimeSnapshotV1> {
                const declarationEntry = declarePluginManagedStartDeclaration(context, declaration);
                const result = await startPluginManagedDeclaration(declarationEntry);
                return result.snapshot;
            },
            async get(id: string): Promise<LocalServiceRuntimeSnapshotV1 | null> {
                const serviceKey = pluginManagedServiceKey(context, id);
                const managedState = managedRegistry.getService(serviceKey);
                if (!managedState) {
                    return pluginManagedSnapshots.get(serviceKey) ?? null;
                }
                const previous = pluginManagedSnapshots.get(serviceKey);
                const snapshotOptions: {
                    id: string;
                    url?: string;
                    diagnostics?: readonly PluginLocalServiceDiagnostic[];
                } = { id };
                if (previous?.url) {
                    snapshotOptions.url = previous.url;
                    snapshotOptions.diagnostics = [];
                } else if (previous) {
                    snapshotOptions.diagnostics = previous.diagnostics;
                }
                const snapshot = snapshotFromManagedState(managedState, snapshotOptions);
                pluginManagedSnapshots.set(serviceKey, snapshot);
                return snapshot;
            },
            async stop(id: string): Promise<void> {
                const serviceKey = pluginManagedServiceKey(context, id);
                const stopped = await stopPluginManagedService(serviceKey, id);
                if (stopped.status === 'denied') {
                    pluginManagedLaunchIntents.delete(serviceKey);
                    pluginManagedSnapshots.set(serviceKey, stoppedPluginLocalServiceSnapshot(id));
                }
            },
        });
    }

    function readTrustedManagedLocalServiceOwnedRun(input: Readonly<{
        context: TrustedManagedLocalServiceOwnerContext;
        serviceId: string;
    }>): TrustedManagedLocalServiceOwnedRun | null {
        const serviceKey = pluginManagedServiceKey(input.context, input.serviceId);
        const runId = managedLifecycleGuard.currentRunId(serviceKey);
        const state = managedRegistry.getService(serviceKey);
        const processHandle = pluginManagedProcesses.get(serviceKey);
        if (
            runId < 1
            || !state
            || (state.phase !== 'detecting' && state.phase !== 'running' && state.phase !== 'unhealthy')
            || !processHandle
            || processHandle.pid !== state.process.pid
        ) {
            return null;
        }
        const previous = pluginManagedSnapshots.get(serviceKey);
        const processIdentity = pluginManagedProcessIdentities.get(serviceKey);
        const snapshot = snapshotFromManagedState(state, {
            id: input.serviceId,
            ...(previous?.url ? { url: previous.url, diagnostics: previous.diagnostics } : {}),
        });
        return Object.freeze({
            serviceKey,
            runId,
            snapshot,
            process: Object.freeze({
                ...state.process,
                ...(processIdentity
                    ? {
                        processStartTimeMs: processIdentity.processStartTimeMs,
                        processCommandHash: processIdentity.processCommandHash,
                    }
                    : {}),
            }),
            host: state.host ?? null,
            port: state.port ?? null,
        });
    }

    async function startTrustedManagedLocalService(input: Readonly<{
        context: TrustedManagedLocalServiceOwnerContext;
        declaration: LocalServiceDeclarationV1;
        exec: Pick<ExecRuntimeServiceV1, 'spawn'>;
    }>): Promise<Readonly<{
        snapshot: LocalServiceRuntimeSnapshotV1;
        ownedRun: TrustedManagedLocalServiceOwnedRun | null;
    }>> {
        const declarationEntry = declarePluginManagedStartDeclaration(input.context, input.declaration);
        const outcome = await managedLifecycleGuard.run(declarationEntry.serviceKey, async () => {
            const result = await startPluginManagedDeclarationInner(declarationEntry, input.exec);
            let snapshot = result.snapshot;
            if (snapshot.phase === 'detecting') {
                const processHandle = pluginManagedProcesses.get(declarationEntry.serviceKey);
                if (processHandle) {
                    const managedState = await waitForPluginManagedReadiness({
                        serviceKey: declarationEntry.serviceKey,
                        processHandle,
                    });
                    if (managedState) {
                        snapshot = await registerManagedPreview(
                            declarationEntry.context,
                            input.declaration,
                            managedState,
                            declarationEntry.serviceKey,
                        );
                        pluginManagedSnapshots.set(declarationEntry.serviceKey, snapshot);
                    }
                }
            }
            const processHandle = pluginManagedProcesses.get(declarationEntry.serviceKey);
            if (typeof processHandle?.pid === 'number') {
                const processIdentity = await (
                    params.readManagedProcessIdentityByPid ?? readProcessIdentityByPid
                )(processHandle.pid);
                const processCommand = processIdentity?.command.trim() ?? '';
                if (
                    processIdentity?.processStartTimeMs !== undefined
                    && processCommand
                ) {
                    pluginManagedProcessIdentities.set(declarationEntry.serviceKey, {
                        processStartTimeMs: processIdentity.processStartTimeMs,
                        processCommandHash: hashProcessCommand(processCommand),
                    });
                }
            }
            return Object.freeze({
                snapshot,
                ownedRun: readTrustedManagedLocalServiceOwnedRun({
                    context: input.context,
                    serviceId: input.declaration.id,
                }),
            });
        });
        if (typeof input.context.operationId === 'string' && !outcome.ownedRun) {
            operationManagedServiceKeys.delete(declarationEntry.serviceKey);
            pluginManagedStartDeclarations.removeByServiceKey(declarationEntry.serviceKey);
        }
        return outcome;
    }

    async function probeReattachedManagedLocalServiceReadiness(input: Readonly<{
        declaration: LocalServiceDeclarationV1;
        host: string;
        port: number;
    }>): Promise<boolean> {
        if (input.declaration.healthCheck.kind !== 'http') {
            // The authoritative exact listener scan is the readiness proof for services
            // without an HTTP readiness contract.
            return true;
        }
        const timeoutMs = input.declaration.healthCheck.timeoutMs ?? 500;
        const path = input.declaration.healthCheck.path ?? '/';
        if (params.managedLocalServices?.healthProbe) {
            return await params.managedLocalServices.healthProbe({
                host: input.host,
                port: input.port,
                path,
                timeoutMs,
            });
        }
        const target = resolveManagedLocalServiceHealthTarget({
            host: input.host,
            port: input.port,
            path,
        });
        if (!target.ok) return false;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
        try {
            const response = await fetch(target.url, {
                method: 'GET',
                signal: controller.signal,
            });
            return response.ok;
        } catch {
            return false;
        } finally {
            clearTimeout(timeout);
        }
    }

    async function reattachTrustedManagedLocalService(input: Readonly<{
        context: TrustedManagedLocalServiceOwnerContext;
        declaration: LocalServiceDeclarationV1;
        attachment: ManagedLocalServiceRunAttachmentV1;
        verifyMaterialization: () => Promise<boolean>;
        verifyReadiness?: () => Promise<boolean>;
        verifyExecutableArtifact?: (input: Readonly<{
            observedExecutablePath: string;
            declaredExecutablePath: string;
        }>) => Promise<boolean>;
    }>): Promise<
        | Readonly<{ ok: true; ownedRun: TrustedManagedLocalServiceOwnedRun }>
        | Readonly<{ ok: false; reasonCode: string }>
    > {
        const parsedAttachment = ManagedLocalServiceRunAttachmentV1Schema.safeParse(input.attachment);
        if (!parsedAttachment.success) {
            return { ok: false, reasonCode: 'attachment_invalid' };
        }
        const attachment = parsedAttachment.data;
        if (
            typeof input.context.sessionId !== 'string'
            || input.declaration.launchMode.kind !== 'assignAndInject'
            || input.declaration.launch.kind !== 'binary'
            || input.declaration.hostPolicy.kind !== 'loopback'
            || (input.declaration.hostPolicy.host ?? DEFAULT_MANAGED_LOCAL_SERVICE_HOST) !== attachment.endpoint.host
        ) {
            return { ok: false, reasonCode: 'declaration_mismatch' };
        }
        const expectedExecutablePath = input.declaration.launch.executablePath;
        const reattachProcess = params.managedLocalServices?.reattachProcess;
        const serviceKey = pluginManagedServiceKey(input.context, input.declaration.id);
        return await managedLifecycleGuard.run(serviceKey, async () => {
            if (pluginManagedProcesses.has(serviceKey) || managedRegistry.getService(serviceKey)) {
                return { ok: false as const, reasonCode: 'owner_already_active' };
            }

            let currentScan: LocalServicesScanResult;
            try {
                currentScan = await scan();
            } catch {
                return { ok: false as const, reasonCode: 'listener_scan_failed' };
            }
            const listener = currentScan.listeners.find((candidate) => (
                candidate.address === attachment.endpoint.host
                && candidate.port === attachment.endpoint.port
                && candidate.protocol === 'tcp'
            ));
            if (!listener || listener.pid !== attachment.process.pid) {
                return { ok: false as const, reasonCode: 'listener_identity_mismatch' };
            }
            const processFact = currentScan.processes.get(attachment.process.pid);
            const currentCommand = processFact?.command?.trim() ?? '';
            if (
                !processFact
                || processFact.processStartTimeMs !== attachment.process.processStartTimeMs
                || !currentCommand
                || hashProcessCommand(currentCommand) !== attachment.process.processCommandHash
            ) {
                return { ok: false as const, reasonCode: 'process_identity_mismatch' };
            }
            const observedExecutablePath = processFact.executablePath?.trim() ?? '';
            let executableArtifactVerified = false;
            if (observedExecutablePath) {
                executableArtifactVerified = input.verifyExecutableArtifact
                    ? await input.verifyExecutableArtifact({
                        observedExecutablePath,
                        declaredExecutablePath: expectedExecutablePath,
                    }).catch(() => false)
                    : canonicalExecutablePath(observedExecutablePath)
                        === canonicalExecutablePath(expectedExecutablePath);
            }
            if (!executableArtifactVerified) {
                return { ok: false as const, reasonCode: 'executable_artifact_mismatch' };
            }
            if (
                processFact.cwd
                && !canonicalAbsolutePathsEqual(
                    processFact.cwd,
                    attachment.materialization.rootDir,
                )
            ) {
                return { ok: false as const, reasonCode: 'materialization_root_mismatch' };
            }

            let materializationVerified = false;
            try {
                materializationVerified = await input.verifyMaterialization();
            } catch {
                materializationVerified = false;
            }
            if (!materializationVerified) {
                return { ok: false as const, reasonCode: 'materialization_verification_failed' };
            }
            const readinessVerified = input.verifyReadiness
                ? await input.verifyReadiness().catch(() => false)
                : await probeReattachedManagedLocalServiceReadiness({
                    declaration: input.declaration,
                    host: attachment.endpoint.host,
                    port: attachment.endpoint.port,
                });
            if (!readinessVerified) {
                return { ok: false as const, reasonCode: 'readiness_failed' };
            }

            // Artifact, materialization, and readiness proofs are asynchronous. Re-read the
            // exact OS-owned listener/process identity after them so PID reuse or listener
            // replacement during proof cannot be registered as the attachment's surviving run.
            let finalScan: LocalServicesScanResult;
            try {
                finalScan = await scan();
            } catch {
                return { ok: false as const, reasonCode: 'listener_scan_failed' };
            }
            const finalListener = finalScan.listeners.find((candidate) => (
                candidate.address === attachment.endpoint.host
                && candidate.port === attachment.endpoint.port
                && candidate.protocol === 'tcp'
            ));
            if (!finalListener || finalListener.pid !== attachment.process.pid) {
                return { ok: false as const, reasonCode: 'listener_identity_mismatch' };
            }
            const finalProcessFact = finalScan.processes.get(attachment.process.pid);
            const finalCommand = finalProcessFact?.command?.trim() ?? '';
            if (
                !finalProcessFact
                || finalProcessFact.processStartTimeMs
                    !== attachment.process.processStartTimeMs
                || !finalCommand
                || hashProcessCommand(finalCommand)
                    !== attachment.process.processCommandHash
            ) {
                return { ok: false as const, reasonCode: 'process_identity_mismatch' };
            }
            if (
                !finalProcessFact.executablePath
                || canonicalExecutablePath(finalProcessFact.executablePath)
                    !== canonicalExecutablePath(observedExecutablePath)
            ) {
                return { ok: false as const, reasonCode: 'executable_artifact_mismatch' };
            }
            if (
                finalProcessFact.cwd
                && !canonicalAbsolutePathsEqual(
                    finalProcessFact.cwd,
                    attachment.materialization.rootDir,
                )
            ) {
                return { ok: false as const, reasonCode: 'materialization_root_mismatch' };
            }

            const routeName = managedServiceRouteName(input.context, input.declaration);
            const routeClaim = managedRouteLockStore.claim({
                name: routeName,
                serviceId: serviceKey,
            });
            if (!routeClaim.ok) {
                return { ok: false as const, reasonCode: 'route_name_claimed' };
            }
            const portClaim = managedPortAllocator.adoptVerified({
                serviceId: serviceKey,
                port: attachment.endpoint.port,
            });
            if (!portClaim.ok) {
                managedRouteLockStore.release({ name: routeName, serviceId: serviceKey });
                return { ok: false as const, reasonCode: 'port_unavailable' };
            }

            let processHandle: ExecProcessHandleV1;
            try {
                processHandle = reattachProcess
                    ? await reattachProcess(attachment)
                    : createDefaultReattachedProcessHandle({
                        serviceKey,
                        attachment,
                        // The initial artifact proof may deliberately accept a
                        // retained A executable while the replacement daemon's
                        // current declaration points at B. Supervision remains
                        // pinned to the exact observed-and-proved A path.
                        expectedExecutablePath: observedExecutablePath,
                    });
            } catch {
                managedPortAllocator.release(serviceKey);
                managedRouteLockStore.release({ name: routeName, serviceId: serviceKey });
                return { ok: false as const, reasonCode: 'process_supervision_failed' };
            }
            if (processHandle.pid !== attachment.process.pid) {
                managedPortAllocator.release(serviceKey);
                managedRouteLockStore.release({ name: routeName, serviceId: serviceKey });
                return { ok: false as const, reasonCode: 'process_supervision_identity_mismatch' };
            }
            // Supervision reconstruction is an awaited external boundary. Reuse the exact
            // OS-owned identity proof after it returns so replacement during that wait cannot
            // inherit route, registry, request-auth, or later termination authority.
            const supervisedProcessStatus = await inspectReattachedProcessStatus({
                attachment,
                expectedExecutablePath: observedExecutablePath,
            });
            if (supervisedProcessStatus !== 'current') {
                // The default reconstructed handle starts only a daemon-local observer.
                // Retire that observer without disposing or signaling the now-unverified PID.
                pluginManagedProcessMonitorStops.get(serviceKey)?.();
                managedPortAllocator.release(serviceKey);
                managedRouteLockStore.release({ name: routeName, serviceId: serviceKey });
                return {
                    ok: false as const,
                    reasonCode: supervisedProcessStatus === 'unverifiable'
                        ? 'listener_scan_failed'
                        : 'process_identity_mismatch',
                };
            }

            const declarationEntry = declarePluginManagedStartDeclaration(
                input.context,
                input.declaration,
            );
            const runId = managedLifecycleGuard.nextRunId(serviceKey);
            const startedAt = now();
            pluginManagedProcesses.set(serviceKey, processHandle);
            pluginManagedProcessIdentities.set(serviceKey, {
                processStartTimeMs: attachment.process.processStartTimeMs,
                processCommandHash: attachment.process.processCommandHash,
                reattachedOwnership: Object.freeze({
                    attachment,
                    expectedExecutablePath: observedExecutablePath,
                }),
            });
            pluginManagedLaunchIntents.set(
                serviceKey,
                createPluginManagedLaunchIntent(input.context, input.declaration),
            );
            pluginManagedAssignedLaunches.set(serviceKey, {
                routeName,
                host: attachment.endpoint.host,
                port: attachment.endpoint.port,
                runId,
                healthCheck: input.declaration.healthCheck,
                startedAt,
            });
            const managedState = managedRegistry.startAssignAndInject({
                id: serviceKey,
                owner: { kind: 'plugin', pluginId: input.context.pluginId },
                process: { pid: attachment.process.pid, startedAt },
                routeName,
                host: attachment.endpoint.host,
                port: attachment.endpoint.port,
            });
            attachPluginManagedProcessExit(
                serviceKey,
                declarationEntry.declaration,
                processHandle,
                runId,
            );
            const snapshot = await registerManagedPreview(
                input.context,
                input.declaration,
                managedState,
                serviceKey,
            );
            pluginManagedSnapshots.set(serviceKey, snapshot);
            const ownedRun = readTrustedManagedLocalServiceOwnedRun({
                context: input.context,
                serviceId: input.declaration.id,
            });
            if (!ownedRun) {
                return { ok: false as const, reasonCode: 'owner_registration_failed' };
            }
            return { ok: true as const, ownedRun };
        });
    }

    function readCurrentReattachedOwnershipProof(
        run: TrustedManagedLocalServiceOwnedRun,
    ): Readonly<{
        attachment: ManagedLocalServiceRunAttachmentV1;
        expectedExecutablePath: string;
    }> | null {
        const state = managedRegistry.getService(run.serviceKey);
        const processHandle = pluginManagedProcesses.get(run.serviceKey);
        const processIdentity = pluginManagedProcessIdentities.get(run.serviceKey);
        if (
            !managedLifecycleGuard.isCurrentRun(run.serviceKey, run.runId)
            || state?.phase !== 'running'
            || !processHandle
            || processHandle.pid !== run.process.pid
            || state.process.pid !== run.process.pid
            || !processIdentity
            || processIdentity.processStartTimeMs
                !== run.process.processStartTimeMs
            || processIdentity.processCommandHash
                !== run.process.processCommandHash
            || state.host !== run.host
            || state.port !== run.port
            || !processIdentity.reattachedOwnership
        ) {
            return null;
        }
        return processIdentity.reattachedOwnership;
    }

    async function finalizeTrustedManagedLocalServiceAuthority(
        run: TrustedManagedLocalServiceOwnedRun,
        commit: () => void,
    ): Promise<TrustedManagedLocalServiceAuthorityFinalizationResult> {
        return await managedLifecycleGuard.run(run.serviceKey, async () => {
            const ownership = readCurrentReattachedOwnershipProof(run);
            if (!ownership) {
                return { ok: false as const, reasonCode: 'owner_not_current' };
            }
            const status = await inspectReattachedProcessStatus(ownership);
            if (status !== 'current') {
                return {
                    ok: false as const,
                    reasonCode: status === 'unverifiable'
                        ? 'listener_scan_failed'
                        : 'process_identity_mismatch',
                };
            }
            // The exact OS proof above is the final await before request-auth authority.
            // Re-check daemon memory after the scan, then synchronously hand the one-shot
            // commit back to its registry owner while this lifecycle guard remains held.
            if (!readCurrentReattachedOwnershipProof(run)) {
                return { ok: false as const, reasonCode: 'owner_not_current' };
            }
            commit();
            return { ok: true as const };
        });
    }

    async function transferTrustedManagedLocalService(
        run: Pick<TrustedManagedLocalServiceOwnedRun, 'serviceKey' | 'runId'>,
    ): Promise<TrustedManagedLocalServiceTransferResult> {
        return await managedLifecycleGuard.run(run.serviceKey, async () => {
            if (!managedLifecycleGuard.isCurrentRun(run.serviceKey, run.runId)) {
                return { status: 'stale' as const };
            }
            const state = managedRegistry.getService(run.serviceKey);
            const processHandle = pluginManagedProcesses.get(run.serviceKey);
            if (!state || !processHandle || processHandle.pid !== state.process.pid) {
                return { status: 'unavailable' as const };
            }
            try {
                await unregisterManagedPreview(run.serviceKey);
            } catch (error) {
                pluginManagedPreviewIds.delete(run.serviceKey);
                try {
                    (params.onError ?? ((reason) => {
                        logger.debug(
                            '[DAEMON RUN] Managed local-service preview cleanup failed during supervision transfer',
                            reason,
                        );
                    }))(error);
                } catch (reportError) {
                    logger.debug(
                        '[DAEMON RUN] Managed local-service transfer diagnostic reporting failed',
                        reportError,
                    );
                }
            }
            // Detach daemon-memory supervision only. The survivor remains alive and no
            // process signal, capability cleanup, or materialization cleanup is issued.
            pluginManagedProcesses.delete(run.serviceKey);
            pluginManagedProcessMonitorStops.get(run.serviceKey)?.();
            pluginManagedProcessIdentities.delete(run.serviceKey);
            pluginManagedLaunchIntents.delete(run.serviceKey);
            releaseAssignedLaunchResources(run.serviceKey);
            managedRegistry.stopIntentional(run.serviceKey);
            pluginManagedSnapshots.delete(run.serviceKey);
            pluginManagedTerminalAt.delete(run.serviceKey);
            operationManagedServiceKeys.delete(run.serviceKey);
            pluginManagedStartDeclarations.removeByServiceKey(run.serviceKey);
            pluginManagedOwnedCleanups.delete(run.serviceKey);
            managedLifecycleGuard.forget(run.serviceKey);
            return { status: 'transferred' as const };
        });
    }

    const trustedManagedLocalServices = Object.freeze({
        async start(input: Readonly<{
            context: TrustedManagedLocalServiceOwnerContext;
            declaration: LocalServiceDeclarationV1;
            exec: Pick<ExecRuntimeServiceV1, 'spawn'>;
        }>): Promise<LocalServiceRuntimeSnapshotV1> {
            return (await startTrustedManagedLocalService(input)).snapshot;
        },
        async startOwned(input: Readonly<{
            context: TrustedManagedLocalServiceOwnerContext;
            declaration: LocalServiceDeclarationV1;
            exec: Pick<ExecRuntimeServiceV1, 'spawn'>;
        }>): Promise<TrustedManagedLocalServiceOwnedRun | null> {
            return (await startTrustedManagedLocalService(input)).ownedRun;
        },
        readOwnedRun(input: Readonly<{
            context: TrustedManagedLocalServiceOwnerContext;
            serviceId: string;
        }>): TrustedManagedLocalServiceOwnedRun | null {
            return readTrustedManagedLocalServiceOwnedRun(input);
        },
        async reattachVerifiedRun(input: Readonly<{
            context: TrustedManagedLocalServiceOwnerContext;
            declaration: LocalServiceDeclarationV1;
            attachment: ManagedLocalServiceRunAttachmentV1;
            verifyMaterialization: () => Promise<boolean>;
            verifyReadiness?: () => Promise<boolean>;
            verifyExecutableArtifact?: (input: Readonly<{
                observedExecutablePath: string;
                declaredExecutablePath: string;
            }>) => Promise<boolean>;
        }>) {
            return await reattachTrustedManagedLocalService(input);
        },
        async finalizeReattachedAuthority(
            run: TrustedManagedLocalServiceOwnedRun,
            commit: () => void,
        ): Promise<TrustedManagedLocalServiceAuthorityFinalizationResult> {
            return await finalizeTrustedManagedLocalServiceAuthority(run, commit);
        },
        registerOwnedCleanup(
            run: Pick<TrustedManagedLocalServiceOwnedRun, 'serviceKey' | 'runId'>,
            cleanup: () => void | Promise<void>,
            options: Readonly<{
                phase?: 'beforeProcessStop' | 'afterProcessStop';
            }> = {},
        ): boolean {
            if (
                !managedLifecycleGuard.isCurrentRun(run.serviceKey, run.runId)
                || !pluginManagedProcesses.has(run.serviceKey)
            ) {
                return false;
            }
            const existing = pluginManagedOwnedCleanups.get(run.serviceKey);
            if (existing && existing.runId !== run.runId) return false;
            const phase = options.phase ?? 'afterProcessStop';
            if (existing) {
                existing[phase].push(cleanup);
            } else {
                pluginManagedOwnedCleanups.set(run.serviceKey, {
                    runId: run.runId,
                    beforeProcessStop:
                        phase === 'beforeProcessStop' ? [cleanup] : [],
                    afterProcessStop:
                        phase === 'afterProcessStop' ? [cleanup] : [],
                });
            }
            return true;
        },
        async transferOwned(
            run: Pick<TrustedManagedLocalServiceOwnedRun, 'serviceKey' | 'runId'>,
        ): Promise<TrustedManagedLocalServiceTransferResult> {
            return await transferTrustedManagedLocalService(run);
        },
        async stopOwned(
            run: Pick<TrustedManagedLocalServiceOwnedRun, 'serviceKey' | 'runId'>,
        ): Promise<TrustedManagedLocalServiceStopResult> {
            return managedLifecycleGuard.run(run.serviceKey, async () => {
                if (!managedLifecycleGuard.isCurrentRun(run.serviceKey, run.runId)) {
                    return { status: 'stale' as const };
                }
                const state = managedRegistry.getService(run.serviceKey);
                const processHandle = pluginManagedProcesses.get(run.serviceKey);
                if (!state || !processHandle || processHandle.pid !== state.process.pid) {
                    return { status: 'unavailable' as const };
                }
                const result = await stopPluginManagedServiceInner(
                    run.serviceKey,
                    pluginManagedSnapshots.get(run.serviceKey)?.id,
                );
                if (result.status === 'succeeded') {
                    operationManagedServiceKeys.delete(run.serviceKey);
                    pluginManagedStartDeclarations.removeByServiceKey(run.serviceKey);
                }
                return result.status === 'succeeded'
                    ? { status: 'stopped' as const }
                    : { status: 'unavailable' as const };
            });
        },
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
        pluginBridgeRoutes,
        trustedManagedLocalServices,
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
        createPluginLocalServicesBridge,
        async stop(options: Readonly<{ disposition?: 'permanent' | 'transfer' }> = {}) {
            runtimeStopController.abort();
            loop?.stop();
            const shutdownFailures: unknown[] = [];
            if (options.disposition === 'transfer') {
                const currentRuns = [...pluginManagedProcesses.keys()].map((serviceKey) => ({
                    serviceKey,
                    runId: managedLifecycleGuard.currentRunId(serviceKey),
                }));
                await Promise.all(currentRuns.map(async (run) => {
                    const result = await transferTrustedManagedLocalService(run);
                    if (result.status !== 'transferred' && result.status !== 'stale') {
                        const error = new Error(
                            `managed_local_service_transfer_${result.status}`,
                        );
                        shutdownFailures.push(error);
                        (params.onError ?? ((reason) => {
                            logger.debug('[DAEMON RUN] Managed local-service supervision transfer failed', reason);
                        }))(error);
                    }
                }));
            } else {
                const currentRuns = [...pluginManagedProcesses.keys()].map((serviceKey) => ({
                    serviceKey,
                    runId: managedLifecycleGuard.currentRunId(serviceKey),
                }));
                await Promise.all(currentRuns.map(async (run) => {
                    try {
                        const result = await trustedManagedLocalServices.stopOwned(run);
                        if (result.status !== 'stopped' && result.status !== 'stale') {
                            throw new Error(`managed_local_service_stop_${result.status}`);
                        }
                    } catch (error) {
                        shutdownFailures.push(error);
                        (params.onError ?? ((reason) => {
                            logger.debug('[DAEMON RUN] Hosted-web managed local-service process shutdown failed', reason);
                        }))(error);
                    }
                }));
            }
            await Promise.all([...pluginManagedPreviewIds.keys()]
                .filter((serviceId) => !pluginManagedProcesses.has(serviceId))
                .map(async (serviceId) => {
                    try {
                        await unregisterManagedPreview(serviceId);
                    } catch (error) {
                        (params.onError ?? ((reason) => {
                            logger.debug('[DAEMON RUN] Hosted-web managed local-service preview shutdown failed', reason);
                        }))(error);
                    }
                }));
            try {
                await hostedWebStaticAssets?.stop();
            } catch (error) {
                (params.onError ?? ((reason) => {
                    logger.debug('[DAEMON RUN] Hosted-web static asset shutdown failed', reason);
                }))(error);
            }
            if (shutdownFailures.length > 0) {
                throw new AggregateError(
                    shutdownFailures,
                    'managed_local_service_shutdown_incomplete',
                );
            }
        },
    };
}
