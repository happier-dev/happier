import * as React from 'react';
import { useShallow } from 'zustand/react/shallow';

import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { resolveMachineDaemonReadServerId } from '@/sync/domains/machines/useMachineDaemonReadTarget';
import { useServerCredentialAccountScopeBinding } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { storage } from '@/sync/domains/state/storage';
import { retainDeep } from '@/sync/domains/state/structuralSharing';
import { useIsMachineListSettled } from '@/sync/store/hooks';
import { resolveVisibleMachinesForActiveServerFromState } from '@/sync/store/domains/machines/resolveMachinesForActiveServerFromState';
import { getLocalServiceInventoryState, subscribeLocalServiceInventoryStore } from '@/sync/domains/local/services/inventory/sharedStore';
import { selectLocalServiceInventoryPresentationRows } from '@/sync/domains/local/services/inventory/store';
import { getLocalServiceLauncherState, subscribeLocalServiceLauncherStore,
    type LocalServiceLauncherStoreKeyInput } from '@/sync/domains/local/services/launch/sharedStore';
import { selectLocalServiceLaunchTargets } from '@/sync/domains/local/services/launch/store';
import { buildLocalServiceRows, selectLocalServiceRunningCount, type ServiceRowStatus } from '@/sync/domains/local/services/serviceRow';
import { readLocalServiceDiagnostics } from '@/sync/domains/local/services/presentation';
import { describeMachinePresenceSummary } from '@/utils/sessions/machinePresenceLine';
import { resolveLocalServicesGlanceRows, type LocalServicesGlanceRow } from './glanceModels';

export type AppLocalServicesDegradedFact = Readonly<{ kind: 'offline'; machineId: string; machineName: string; nativeWord?: string | null }>
    | Readonly<{ kind: 'unavailable'; machineId: string; machineName: string; reasonCode: string }>;
export type AppLocalServicesGlanceState = Readonly<{
    kind: 'loading' | 'ready';
    scope: 'app';
    rows: readonly (LocalServicesGlanceRow & Readonly<{ machineId: string; machineName: string; status: ServiceRowStatus }>)[];
    runningCount: number;
    degraded: readonly AppLocalServicesDegradedFact[];
    /** Machines whose services were read: with none, an empty list is not known to be empty. */
    listedMachineCount: number;
}>;

type MachineFeed = Readonly<{ machineId: string;
    inventory: ReturnType<typeof getLocalServiceInventoryState>;
    launcher: ReturnType<typeof getLocalServiceLauncherState> }>;

/** Visible Home demand borrows the Services owners' exact Machine subscriptions and retained states. */
export function useAppLocalServicesGlance(inputServerId: string): AppLocalServicesGlanceState {
    const serverId = resolveMachineDaemonReadServerId(inputServerId);
    const presented = useLayoutPresentationActive();
    const { binding, resolution } = useServerCredentialAccountScopeBinding(serverId);
    const machineIds = storage(useShallow(state => resolveVisibleMachinesForActiveServerFromState(state, { serverId }).map(machine => machine.id)));
    const settled = useIsMachineListSettled(serverId);
    const presence = useMachinePresenceSummaries(serverId, machineIds);
    const onlineIdsKey = JSON.stringify(machineIds.filter((_id, index) => presence[index]?.reachability === 'reachable'));
    const keys = React.useMemo<readonly LocalServiceLauncherStoreKeyInput[]>(() => binding
        ? (JSON.parse(onlineIdsKey) as string[]).map(machineId => ({ machineId, serverId, scope: 'machine',
            accountId: binding.accountId, credentialKey: binding.credentialKey })) : [], [binding, onlineIdsKey, serverId]);
    const project = React.useCallback((feeds: readonly MachineFeed[]): AppLocalServicesGlanceState => {
        const rows: AppLocalServicesGlanceState['rows'][number][] = [];
        const degraded: AppLocalServicesDegradedFact[] = [];
        let pending = !settled;
        let runningCount = 0;
        let listedMachineCount = 0;
        const feedsByMachine = new Map(feeds.map(feed => [feed.machineId, feed]));
        for (let index = 0; index < machineIds.length; index++) {
            const machineId = machineIds[index]!;
            const fact = presence[index];
            const machineName = fact?.name ?? machineId;
            if (fact?.reachability === 'unreachable') {
                degraded.push({ kind: 'offline', machineId, machineName, nativeWord: describeMachinePresenceSummary(fact).nativeWord });
                continue;
            }
            const feed = feedsByMachine.get(machineId);
            if (!feed) {
                if (fact?.reachability === 'unknown' || resolution.kind === 'resolving' || resolution.kind === 'bound' && !binding) pending = true;
                else degraded.push({ kind: 'unavailable', machineId, machineName, reasonCode: 'unavailable' });
                continue;
            }
            const services = buildLocalServiceRows({ inventoryRows: selectLocalServiceInventoryPresentationRows(feed.inventory),
                launchTargets: selectLocalServiceLaunchTargets(feed.launcher), sessionId: null, scope: 'machine' });
            const projected = resolveLocalServicesGlanceRows(services, 'machine');
            for (let rowIndex = 0; rowIndex < projected.length; rowIndex++) {
                const row = projected[rowIndex]!;
                rows.push({ ...row, id: JSON.stringify([machineId, row.id]), machineId, machineName,
                    status: services[rowIndex]!.status });
            }
            runningCount += selectLocalServiceRunningCount(services);
            const diagnostic = readLocalServiceDiagnostics(feed.inventory.diagnostics);
            const reasonCode = feed.inventory.refreshState === 'error'
                ? (diagnostic.find(reason => reason.severity === 'error') ?? diagnostic[0])?.code
                : feed.launcher.refreshStatus === 'error' ? feed.launcher.refreshError : null;
            if (reasonCode) degraded.push({ kind: 'unavailable', machineId, machineName, reasonCode });
            else listedMachineCount += 1;
            if (feed.inventory.generatedAt === null && feed.inventory.refreshState !== 'error'
                || feed.launcher.updatedAt === null && feed.launcher.refreshStatus !== 'error') pending = true;
        }
        return { kind: pending && rows.length === 0 ? 'loading' : 'ready', scope: 'app', rows, runningCount, degraded, listedMachineCount };
    }, [binding, machineIds, presence, resolution.kind, settled]);
    // Retain the view before React observes it; inventory cursors and unrelated listeners
    // remain available in the canonical stores without scheduling an equal Home view.
    const snapshot = React.useRef<Readonly<{
        feeds: readonly MachineFeed[];
        project: typeof project;
        state: AppLocalServicesGlanceState;
    }> | null>(null);
    const getSnapshot = React.useCallback(() => {
        const feeds = binding?.isCurrent() ? keys.map(key => ({ machineId: key.machineId,
            inventory: getLocalServiceInventoryState(key), launcher: getLocalServiceLauncherState(key) })) : [];
        const previous = snapshot.current;
        if (previous?.project === project && feeds.length === previous.feeds.length && feeds.every((feed, index) => {
            const old = previous.feeds[index];
            return old && feed.machineId === old.machineId && feed.inventory === old.inventory && feed.launcher === old.launcher;
        })) return previous.state;
        const state = retainDeep(previous?.state, project(feeds));
        snapshot.current = { feeds, project, state };
        return state;
    }, [binding, keys, project]);
    const subscribe = React.useCallback((notify: () => void) => {
        if (!presented || !binding?.isCurrent()) return () => {};
        const releases = keys.map(key => {
            let releaseLauncher: (() => void) | undefined;
            const changed = () => {
                const inventory = getLocalServiceInventoryState(key);
                // Home needs one Machine answer after the initial scan observation, including
                // failure. Starting earlier makes that observation invalidate a redundant read.
                if (!releaseLauncher && inventory.refreshState !== 'refreshing'
                    && (inventory.generatedAt !== null || inventory.refreshState === 'error')) {
                    releaseLauncher = subscribeLocalServiceLauncherStore(key, notify);
                }
                notify();
            };
            const releaseInventory = subscribeLocalServiceInventoryStore(key, changed);
            changed();
            return () => { releaseInventory(); releaseLauncher?.(); };
        });
        const release = () => { for (const dispose of releases) dispose(); };
        const retirement = binding.onRetire(() => { release(); notify(); });
        return () => { retirement.dispose(); release(); };
    }, [binding, keys, presented]);
    return React.useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
