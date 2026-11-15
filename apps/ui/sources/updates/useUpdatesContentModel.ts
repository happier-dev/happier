import { useLayoutPresentationActive } from '@/components/ui/presentation/PluginSurfaceFocusEligibility';
import { useOptionalScreenIsFocused } from '@/utils/navigation/useOptionalScreenIsFocused';
import { useInstalledUpdates } from './useInstalledUpdates';
import type { StoreUpdateRowFacts } from '@/components/store/updates/StoreUpdateRow';
import * as React from 'react';
import { ManagedMachineActionOutputSchemasV1, unwrapManagedMachineReadV1 } from '@happier-dev/protocol/machines/managed/actionsV1';

import { useReleaseNotesLauncher, useReleaseNotesUnread } from '@/changelog/releaseNotes';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { getServerProfileById } from '@/sync/domains/server/serverProfiles';
import { useHomeDisplayLabel } from '@/components/settings/server/homeDisplayName';
import { selectMachineAgentUpdateFacts, useMachineAgentsByMachine } from '@/agents/machineAgents/useMachineAgents';
import { useMachineUpdateFactsBackground } from './useMachineUpdateFactsBackground';
import { useActiveMachineFacts, useActiveServerAccountScope } from '@/sync/domains/state/storage';
import { isMachineSelectableForFleet } from '@/sync/domains/machines/administration/fleetUnion';
import { isMachineVisibleForLaunchSelection } from '@/sync/domains/machines/identity/filterVisibleMachines';
import { useMachineReachabilityRevision } from '@/sync/domains/machines/reachability/useMachineReachabilityRevision';
import { useMachinePresenceNowMs } from '@/hooks/machine/useMachinePresenceNowMs';
import { useMachinePresenceSummaries } from '@/sync/domains/machines/reachability/useMachinePresenceSummary';
import { storage } from '@/sync/domains/state/storageStore';
import { resolveSessionMachineId } from '@/sync/domains/session/external/resolveSessionMachineId';
import { useMountedActionExecution } from '@/components/approvals/useMountedActionExecution';
import { requireActionSuccess } from '@/sync/ops/actions/actionResult';
import { registerUpdatesActionOwner, type UpdatesActionOwner } from './updatesActionRuntime';
import { isUpdateItemActionable } from './items/updateItem';
import { getInstallablesRegistryEntries } from '@/capabilities/installablesRegistry';
import { serverAccountScopeKeySuffix } from '@/sync/domains/scope/serverAccountScope';
import { selectActiveServerAccountScopeForServer } from '@/sync/domains/scope/activeServerAccountScope';

import { buildMachineUpdateGroups, readUpdatableInstallables, type UpdatesGroup } from './buildMachineUpdateGroups';
import { buildUpdatesSummary, type UpdatesSummary } from './items/buildUpdatesSummary';
import type { UpdateItem } from './items/updateItem';
import { useMachinesCapabilitySnapshots } from './machineCapabilitySnapshots';
import { markUpdateCompletionsSeen, refreshMachineUpdateFacts, runMachineItemUpdate, useMachineUpdateRuns, useUnseenUpdateCompletions, useUpdateBatch, useUpdateCheck, type UpdateAllProgress } from './machineUpdateRuns';
import { useAppUpdateStatus } from './useAppUpdateStatus';
import { useThisComputerCliUpdate } from './useThisComputerCliUpdate';

export type { UpdatesGroup };

export type { UpdateAllProgress } from './machineUpdateRuns';

export type UpdatesContentModel = Readonly<{
    homeLabel?: string;
    summary: UpdatesSummary;
    groups: readonly UpdatesGroup[];
    /** The newest check behind these rows: the app's own, or any machine's update facts. */
    checkedAt: number | null;
    /** Online machines whose tools have not all answered yet (the header's "not checked" line). */
    uncheckedMachineCount: number;
    /** Machines with sessions running now: their service-restarting rows say so, quietly. */
    sessionsRunningOn: ReadonlySet<string>;
    runItem: (item: UpdateItem) => Promise<void>;
    /** Updates everything waiting on one machine, in the same per-machine order as Update all. */
    updateGroup: (group: UpdatesGroup) => Promise<void>;
    updateAll: () => Promise<void>;
    stopAfterCurrent: () => void;
    batch: UpdateAllProgress | null;
    checking: boolean;
    checkNow: () => void;
    skipAppVersion: (() => void) | null;
    /** Release notes stay reachable from the This app group (R13 (e)). */
    openWhatsNew: () => void;
    whatsNewUnread: boolean;
    /** What each group's Store item rows (`group.storeItems`) review through: the installed-updates owner's facts. */
    storeRows: StoreUpdateRowFacts;
}>;

/** The machines with an active session, as one stable key (the canonical session state). */
function selectSessionsRunningKey(state: ReturnType<typeof storage.getState>): string {
    const ids = new Set<string>();
    for (const session of Object.values(state.sessions)) {
        const machineId = session.active ? resolveSessionMachineId(session.metadata ?? null) : null;
        if (machineId) ids.add(machineId);
    }
    return [...ids].sort().join('\u0000');
}

/**
 * The Updates surface's detail model, mounted only while the popover or the screen is open
 * (`apps/ui/AGENTS.md`): it asks each online machine for its agent CLI and helper versions through
 * the machine capability cache's own freshness policy, lists every row in the fixed order
 * This app → This computer → other machines, and runs actions through their canonical executors.
 */
export function useUpdatesContentModel(options: Readonly<{
    /**
     * One Machine's rows only (its Security tab): only that Machine is read and asked, the This app group is
     * left out. Every mounted surface exposes its rows to the shared action dispatcher;
     * the Updates surface owns marking completions seen.
     */
    machineId?: string;
}> = {}): UpdatesContentModel {
    const only = options.machineId ?? null;
    const app = useAppUpdateStatus();
    const appItem = app.model.item;
    const thisComputer = useThisComputerCliUpdate();
    const allMachines = useActiveMachineFacts();
    const machines = React.useMemo(
        () => only === null ? allMachines : allMachines.filter((machine) => machine.id === only),
        [allMachines, only],
    );
    // One server scope for the rows, their facts, their runs and their refreshes.
    const serverId = useActiveServerSnapshot().serverId;
    const homeLabel = useHomeDisplayLabel(getServerProfileById(serverId));
    const activeScope = useActiveServerAccountScope();
    const activeHomeScope = selectActiveServerAccountScopeForServer(activeScope, serverId);
    const execution = useMountedActionExecution(serverId);
    const updateScope = execution.ready && activeHomeScope?.accountId === execution.binding?.scope.accountId
        ? execution.binding?.scope ?? null : null;
    const installedQuery = React.useMemo(() => ({ scope: activeHomeScope, machine: only
        ? { serverIdentityId: serverId, machineId: only } : null, projectKey: null }), [activeHomeScope, only, serverId]);
    const installedTarget = React.useMemo(() => only ? { kind: 'machine' as const, machineId: only } : undefined, [only]);
    const layoutPresented = useLayoutPresentationActive();
    const screenFocused = useOptionalScreenIsFocused() !== false;
    const installed = useInstalledUpdates(installedQuery, layoutPresented && screenFocused, installedTarget);
    const reachabilityRevision = useMachineReachabilityRevision();
    const presenceNowMs = useMachinePresenceNowMs(machines);
    const { execute: executeAction, isCurrent } = execution;
    const runs = useMachineUpdateRuns(serverId);
    const releaseNotes = useReleaseNotesUnread();
    const releaseNotesLauncher = useReleaseNotesLauncher();

    const installables = React.useMemo(readUpdatableInstallables, []);

    const onlineMachineIds = React.useMemo(() => {
        const ids = machines.filter((machine) => machine.id !== thisComputer.machineId && isMachineSelectableForFleet(updateScope, machine, presenceNowMs)).map((machine) => machine.id);
        if (thisComputer.machineId && (only === null || only === thisComputer.machineId)) ids.unshift(thisComputer.machineId);
        return ids;
    }, [machines, only, thisComputer.machineId, updateScope, reachabilityRevision, presenceNowMs]);
    // Every machine's cached detect (offline ones keep their last-known rows); only online ones are asked.
    const machineIds = React.useMemo(() => machines.map((machine) => machine.id), [machines]);
    // Only the open surface displays last-seen values. Canonical presence
    // summaries publish those timestamps only while a Machine is unreachable.
    const presence = useMachinePresenceSummaries(serverId, machineIds);
    // One Machine's Security tab shows only its Happier row, so it never asks for its agents.
    const machineAgents = useMachineAgentsByMachine({ serverId, machineIds, load: only === null,
        alwaysOnlineMachineId: thisComputer.machineId }, selectMachineAgentUpdateFacts);
    const snapshots = useMachinesCapabilitySnapshots(serverId, machineIds, activeHomeScope?.accountId);
    // Opening the surface asks each online machine through the cache's existing freshness policy.
    useMachineUpdateFactsBackground({ serverId, accountId: activeHomeScope?.accountId, machineIds: onlineMachineIds });

    // This computer's group belongs to the surface only when it is the selected Machine (or no Machine is).
    const ownsThisComputer = only === null || only === thisComputer.machineId;
    const { groups, remotes, uncheckedMachineCount, factsCheckedAt } = React.useMemo(() => {
        const built = buildMachineUpdateGroups({
            accountScope: updateScope,
            storeUpdates: installed.view,
            machines,
            thisMachineId: ownsThisComputer ? thisComputer.machineId : null,
            thisComputerItem: ownsThisComputer ? thisComputer.item : null,
            runs,
            machineAgents,
            snapshots,
            installables,
        });
        const app: UpdatesGroup = { id: 'app', kind: 'app', machineName: null, machineId: null, online: true, lastSeenAt: null, items: [appItem] };
        return { groups: only === null ? [app, ...built.groups] : built.groups, remotes: built.remotes, uncheckedMachineCount: built.uncheckedMachineCount, factsCheckedAt: built.checkedAt };
    }, [appItem, installed.view, installables, machineAgents, machines, only, ownsThisComputer, runs, snapshots, thisComputer.item, thisComputer.machineId, updateScope, reachabilityRevision, presenceNowMs, presence]);

    const allItems = React.useMemo(() => groups.flatMap((group) => group.items), [groups]);
    // Open Updates shows every result, so the pill's "Updated" is seen; a completion that lands
    // while the surface stays open is seen too (its row says so).
    const completions = useUnseenUpdateCompletions(updateScope);
    React.useEffect(() => {
        if (only === null) markUpdateCompletionsSeen(updateScope);
    }, [completions, only, updateScope]);
    // The same coverage the always-mounted summary ranks with, so the open header never says
    // "Up to date" while the pill says some tools were not checked.
    const summary = React.useMemo(
        () => buildUpdatesSummary(allItems, new Map(), { uncheckedMachineCount }),
        [allItems, uncheckedMachineCount],
    );

    const lastUpdateSignatureByMachine = React.useMemo(
        () => new Map(remotes.map((remote) => [remote.machine.id, remote.lastUpdateSignature])),
        [remotes],
    );
    const executeItem = React.useCallback(async (item: UpdateItem) => {
        if (item.subject.kind === 'app') return app.run();
        const managedRef = item.subject.kind === 'happier-cli'
            ? allMachines.find(machine => machine.id === item.machineId)?.managedMachineRef : null;
        if (managedRef) {
            // Managed guests consume acquire's Home payload and lifecycle, never
            // the guest's public release-channel self-updater.
            const read = await executeAction('machines.managed.get', managedRef);
            requireActionSuccess(read, 'machines.managed.get');
            const machine = unwrapManagedMachineReadV1(ManagedMachineActionOutputSchemasV1['machines.managed.get'].parse(read.result));
            const updated = await executeAction('machines.managed.bootstrap.retry', {
                ...managedRef, expectedIntentRevision: machine.intentRevision,
            });
            requireActionSuccess(updated, 'machines.managed.bootstrap.retry');
            return;
        }
        if (item.subject.kind === 'happier-cli' && item.machineId === thisComputer.machineId) return thisComputer.run();
        const machineId = item.machineId;
        if (!machineId || !updateScope) return;
        await runMachineItemUpdate(item, { scope: updateScope, lastUpdateSignature: lastUpdateSignatureByMachine.get(machineId) });
    }, [allMachines, app, executeAction, lastUpdateSignatureByMachine, updateScope, thisComputer]);

    // Intent goes through the configurable Action policy; admitted updater progress stays inline.
    const runItem = React.useCallback(async (item: UpdateItem) => {
        if (item.action.kind !== 'run') return;
        if (item.subject.kind === 'app') {
            const verb = item.action.verb;
            await executeAction(verb === 'retry' ? 'app.updates.retry' : verb === 'restart' ? 'app.updates.restart' : 'app.updates.update', {});
            return;
        }
        if (item.subject.kind === 'happier-cli') {
            await executeAction('machines.cli.update', { target: item.machineId === thisComputer.machineId
                ? { kind: 'local' } : { kind: 'machine', machineId: item.machineId } });
            return;
        }
        if (item.subject.kind === 'agent-cli') {
            await executeAction('machines.agents.install', { machineId: item.machineId, agentId: item.subject.agentId,
                intent: 'update', consent: { vendorRecipe: true } });
            return;
        }
        if (item.subject.kind === 'installable') {
            const key = item.subject.key;
            const entry = getInstallablesRegistryEntries().find(candidate => candidate.key === key);
            if (entry) await executeAction('machines.capabilities.install', { machineId: item.machineId,
                capabilityId: entry.capabilityId, method: 'upgrade' });
        }
    }, [executeAction, thisComputer.machineId]);

    const { batch } = useUpdateBatch(updateScope, allItems, executeItem);
    const updateAll = React.useCallback(async () => {
        const itemIds = allItems.filter(isUpdateItemActionable).map(item => item.id);
        if (itemIds.length) await executeAction('updates.batch.start', { groupId: null, itemIds });
    }, [allItems, executeAction]);
    const updateGroup = React.useCallback(async (group: UpdatesGroup) => {
        const itemIds = group.items.filter(isUpdateItemActionable).map(item => item.id);
        if (itemIds.length) await executeAction('updates.batch.start', { groupId: group.id, itemIds });
    }, [executeAction]);
    const stopAfterCurrent = React.useCallback(() => { void executeAction('updates.batch.stop', {}); }, [executeAction]);

    const check = React.useCallback(async () => {
        if (!updateScope || !isCurrent()) return;
        const requests = [app.checkNow(), installed.checkNow()];
        // Explicit Check is also recovery: its reply can clear a failed request observation.
        for (const machine of machines) {
            if (isMachineVisibleForLaunchSelection(machine) && machine.availability?.kind !== 'locked') {
                requests.push(refreshMachineUpdateFacts(serverId, machine.id, { accountScope: updateScope }));
            }
        }
        const results = await Promise.allSettled(requests);
        for (const result of results) if (result.status === 'rejected') throw result.reason;
    }, [app.checkNow, installed.checkNow, isCurrent, machines, serverId, updateScope]);
    const { checking, checkNow: runCheck } = useUpdateCheck(updateScope ? serverAccountScopeKeySuffix(updateScope) : serverId, check);
    const checkNow = React.useCallback(() => { void executeAction('updates.check', {}); }, [executeAction]);
    const skipAppVersion = React.useCallback(() => {
        if (appItem.latestVersion) void executeAction('app.updates.skip', { version: appItem.latestVersion });
    }, [appItem.latestVersion, executeAction]);
    const actionOwner = React.useRef<UpdatesActionOwner>({ scope: updateScope, groups, check: runCheck, executeItem });
    actionOwner.current = { scope: updateScope, groups, check: runCheck, executeItem };
    React.useEffect(() => registerUpdatesActionOwner(() => actionOwner.current), []);

    const sessionsRunningKey = storage(selectSessionsRunningKey);
    const sessionsRunningOn = React.useMemo(
        () => new Set(sessionsRunningKey ? sessionsRunningKey.split('\u0000') : []),
        [sessionsRunningKey],
    );
    const checkedAt = app.checkedAt == null && factsCheckedAt == null ? null : Math.max(app.checkedAt ?? 0, factsCheckedAt ?? 0);

    const { execute: storeExecute, getSignal: storeGetSignal, ready: storeReady } = installed.execution;
    const storeApplied = installed.browserExtension.continuation;
    const storeRows = React.useMemo<StoreUpdateRowFacts>(() => ({ input: installedQuery, execute: storeExecute,
        getSignal: storeGetSignal, ready: storeReady, onApplied: storeApplied }),
    [installedQuery, storeApplied, storeExecute, storeGetSignal, storeReady]);
    return React.useMemo(() => ({
        homeLabel,
        summary,
        groups,
        checkedAt,
        uncheckedMachineCount,
        sessionsRunningOn,
        runItem,
        updateGroup,
        updateAll,
        stopAfterCurrent,
        batch,
        checkNow,
        checking,
        skipAppVersion: app.skipVersion ? skipAppVersion : null,
        openWhatsNew: releaseNotesLauncher.openWhatsNew,
        whatsNewUnread: releaseNotes.hasUnread,
        storeRows,
    }), [app.skipVersion, batch, checkNow, checkedAt, checking, groups, homeLabel, releaseNotesLauncher.openWhatsNew, releaseNotes.hasUnread, runItem, sessionsRunningOn, skipAppVersion, stopAfterCurrent, storeRows, summary, uncheckedMachineCount, updateAll, updateGroup]);
}
