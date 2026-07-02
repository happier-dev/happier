import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { startSingleFlightIntervalLoop, type SingleFlightIntervalLoopHandle } from '@/daemon/lifecycle/singleFlightIntervalLoop';
import { logger } from '@/ui/logger';
import {
    DEFAULT_LOCAL_SERVICE_CAPABILITIES,
    type FeatureDecision,
} from '@happier-dev/protocol';

import { createLocalServiceInventoryRegistry, type LocalServiceInventoryRegistry } from './inventory/registry';
import { createLocalServiceInventoryRoutes, type LocalServiceInventoryRoutes } from './inventory/routes';
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
import { readDarwinLocalServiceListeners } from './inventory/platform/darwin';
import { readWindowsLocalServiceListenersUnavailable } from './inventory/platform/windows';
import { createManagedLocalServiceRegistry, type ManagedLocalServiceRegistry } from './managed/registry';

type LocalServicesScanResult = Readonly<{
    listeners: readonly LocalServiceListenerFact[];
    processes: ReadonlyMap<number, LocalServiceProcessFact>;
    workspaces: readonly LocalServiceWorkspaceFact[];
    diagnostics: readonly LocalServiceInventoryDiagnostic[];
}>;

type LocalServicesScanner = () => Promise<LocalServicesScanResult>;

export type LocalServicesDaemonRuntime = Readonly<{
    inventoryRegistry: LocalServiceInventoryRegistry;
    managedRegistry: ManagedLocalServiceRegistry;
    inventoryRoutes: LocalServiceInventoryRoutes;
    refreshInventoryNow(): Promise<NormalizedLocalServiceInventorySnapshot>;
    stop(): void;
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

async function scanPlatformLocalServices(): Promise<LocalServicesScanResult> {
    if (process.platform === 'darwin') {
        const result = await readDarwinLocalServiceListeners({
            execFile: promisify(execFile),
        });
        return {
            listeners: result.listeners,
            processes: new Map(),
            workspaces: [],
            diagnostics: result.diagnostics,
        };
    }

    if (process.platform === 'win32') {
        const result = readWindowsLocalServiceListenersUnavailable();
        return {
            listeners: result.listeners,
            processes: new Map(),
            workspaces: [],
            diagnostics: result.diagnostics,
        };
    }

    return {
        listeners: [],
        processes: new Map(),
        workspaces: [],
        diagnostics: [{
            code: 'local_services_scanner_not_implemented',
            severity: 'warning',
            message: `No active local-service scanner is available for ${process.platform}.`,
        }],
    };
}

export function createLocalServicesDaemonRuntime(params: Readonly<{
    machineId: string;
    processEnv?: NodeJS.ProcessEnv;
    inventoryEnabled?: () => boolean;
    scan?: LocalServicesScanner;
    now?: () => number;
    refreshIntervalMs?: number;
    staleAfterMs?: number;
    startLoop?: boolean;
    onError?: (error: unknown) => void;
}>): LocalServicesDaemonRuntime {
    const inventoryRegistry = createLocalServiceInventoryRegistry();
    const managedRegistry = createManagedLocalServiceRegistry();
    const processEnv = params.processEnv ?? process.env;
    const now = params.now ?? (() => Date.now());
    const scan = params.scan ?? scanPlatformLocalServices;
    const staleAfterMs = params.staleAfterMs ?? DEFAULT_LOCAL_SERVICE_CAPABILITIES.inventory.staleAfterMs;
    const resolveDecision = (): FeatureDecision => resolveCliFeatureDecision({
        featureId: 'localServices.inventory',
        env: processEnv,
    });
    const isInventoryEnabled = params.inventoryEnabled ?? (() => resolveDecision().state === 'enabled');

    const refreshInventoryNow = async (): Promise<NormalizedLocalServiceInventorySnapshot> => {
        const previous = inventoryRegistry.getSnapshot();
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
        const snapshot = normalizeLocalServiceScan({
            machineId: params.machineId,
            now: generatedAt,
            previous,
            listeners: result.listeners,
            processes: result.processes,
            workspaces: result.workspaces,
            staleAfterMs,
        });
        const snapshotWithDiagnostics: NormalizedLocalServiceInventorySnapshot = {
            ...snapshot,
            diagnostics: result.diagnostics,
        };
        inventoryRegistry.replaceSnapshot(snapshotWithDiagnostics);
        for (const entry of snapshotWithDiagnostics.entries) {
            managedRegistry.applyInventoryEntry(entry);
        }
        return snapshotWithDiagnostics;
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

    return {
        inventoryRegistry,
        managedRegistry,
        inventoryRoutes,
        refreshInventoryNow,
        stop() {
            loop?.stop();
        },
    };
}
