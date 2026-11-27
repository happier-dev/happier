import * as React from 'react';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import type { PluginProjectedActionV2 } from '@happier-dev/protocol/daemon/contributionRegistryProjection';
import { getPluginMachineExecutionOriginRef } from '@happier-dev/protocol/machines/administration/pluginMachineExecutionOriginV1';
import { useAppShellPluginUiProjection, type AppShellPluginUiProjectionValue } from '@/components/appShell/plugins/AppShellPluginUiProjection';
import { subscribeCommittedAppShellPluginUiExecutionOriginCandidates } from '@/components/appShell/plugins/committedPluginUiProjection';
import { useOptionalCurrentUiContextReader } from '@/components/appShell/currentUiContext/CurrentUiContextProvider';
import { usePluginSurfaceDestinationNavigationBinding } from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { usePluginUiClientExecutableRegistrationRevision } from '@/components/plugins/reactNative/clientExecutableContributions';
import { createPluginContributedActionController, type PluginContributedActionController, type PluginContributedActionCurrentSnapshot } from '@/components/plugins/actions/pluginContributedActionController';
import { useSessionMachineControlTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { useDaemonMergedProjectionInputs } from '@/agents/backendCatalog/useDaemonMergedProjectionInputs';
import { buildV2PluginProjectionById } from '@/agents/backendCatalog/daemonContributionRegistryProjectionAdapters';
import { useServerCredentialAccountScopeBindings } from '@/sync/domains/scope/useServerCredentialAccountScopes';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { createPluginUiProjectedActionResolver } from '@/sync/domains/plugins/ui/projection';
import { readPluginUiContributionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import { readPluginUiAccountExecutableOrigin } from '@/sync/domains/plugins/ui/projectionOrigins';
import { usePluginLocalizedTextResolver } from '@/sync/domains/plugins/ui/i18n';
import { usePluginAccountAvailabilityReader } from '@/sync/domains/plugins/availability/projection';
import { usePluginExecutionOriginProjectionDemand } from '@/sync/domains/machines/administration/usePluginExecutionOriginProjectionDemand';
import type { MachineAdministrationTargetV1 } from '@happier-dev/protocol/account/settings/machineAdministrationSelectionsV1';
import type { ActiveServerAccountScopeLifetime } from '@/sync/domains/scope/activeServerAccountScope';
import { useMachineListForServerSelection } from '@/sync/domains/state/storage';
import { canManageMachine } from '@/sync/domains/machines/canManageMachine';
import type { Machine } from '@/sync/domains/state/storageTypes';

// Both palette scopes present Action forms, including input types and Resources.
const COMMAND_PALETTE_PROJECTION_SECTIONS = ['actionsById', 'familiesById.pluginUi', 'familiesById.inputTypes', 'resourcesById'] as const;

const selectAccountLifetime = (value: AppShellPluginUiProjectionValue) => value.accountLifetime;
const selectManageAffordances = (machines: readonly Machine[]) => JSON.stringify(machines.map(machine => [machine.id, canManageMachine(machine)]));
const selectProjectedActions = (value: AppShellPluginUiProjectionValue) => value.pluginUiProjection?.actionsById;

function hasGlobalPalettePlacement(action: Pick<PluginProjectedActionV2, 'scopes' | 'surfaces' | 'placementBindings'>): boolean {
    return action.scopes.includes('global') && action.surfaces.includes('ui') && action.placementBindings?.includes('commandPalette') === true;
}

/**
 * Search discovers Actions; Administration and AppShell still select their executable origins.
 * Demand reads only the Account lifetime and the installed declarations: every Machine answer it
 * acquires republishes the AppShell projection, and that must not redraw the demand itself.
 */
export function CommandPalettePluginActionProjectionDemand() {
    const accountLifetime = useAppShellPluginUiProjection(selectAccountLifetime);
    const availability = usePluginAccountAvailabilityReader(accountLifetime?.scope ?? null);
    const installed = availability?.readInstalledPlugins();
    const targets = React.useMemo(() => {
        const byTarget = new Map<string, MachineAdministrationTargetV1>();
        if (installed?.kind === 'available') for (const plugin of installed.plugins) for (const installation of plugin.installations) {
            const declaration = installation.declaration;
            // An unknown source-bound declaration cannot prove that it has no Actions.
            if (declaration && !declaration.contributes?.actions?.some(hasGlobalPalettePlacement)) continue;
            const { serverIdentityId, machineId } = installation.materialization;
            byTarget.set(JSON.stringify([serverIdentityId, machineId]), { serverIdentityId, machineId });
        }
        return [...byTarget.values()];
    }, [installed]);
    return React.createElement(React.Fragment, null,
        React.createElement(GlobalPaletteActionOriginDemands),
        targets.map(target => React.createElement(CommandPaletteMachineActionProjectionDemand, {
            key: JSON.stringify([target.serverIdentityId, target.machineId]), target, accountLifetime,
        })),
    );
}

function GlobalPaletteActionOriginDemands() {
    const actions = useAppShellPluginUiProjection(selectProjectedActions);
    const pluginIds = new Set<string>();
    for (const action of Object.values(actions ?? {})) {
        if (hasGlobalPalettePlacement(action) && !readPluginUiAccountExecutableOrigin(action)) pluginIds.add(action.pluginId);
    }
    return React.createElement(React.Fragment, null, [...pluginIds].map(pluginId =>
        React.createElement(GlobalPaletteActionOriginDemand, { key: pluginId, pluginId })));
}

function GlobalPaletteActionOriginDemand({ pluginId }: Readonly<{ pluginId: string }>): null {
    // Keep Administration's selected origin published while this palette can invoke its Actions.
    React.useEffect(() => subscribeCommittedAppShellPluginUiExecutionOriginCandidates(pluginId, () => {}), [pluginId]);
    return null;
}

type MachineActionProjectionDemandProps = Readonly<{
    target: MachineAdministrationTargetV1;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
}>;

const CommandPaletteMachineActionProjectionDemand = React.memo(function CommandPaletteMachineActionProjectionDemand(props: MachineActionProjectionDemandProps) {
    usePluginExecutionOriginProjectionDemand(props.target, {
        accountLifetime: props.accountLifetime,
        sections: COMMAND_PALETTE_PROJECTION_SECTIONS,
        observe: false,
    });
    return null;
}, (left: MachineActionProjectionDemandProps, right: MachineActionProjectionDemandProps) => left.accountLifetime === right.accountLifetime
    && left.target.serverIdentityId === right.target.serverIdentityId && left.target.machineId === right.target.machineId);

/**
 * Home Search consumes the AppShell's selected Action union. Each Action keeps
 * that publication's exact host; a Session route keeps its own Machine instead.
 */
export type CommandPalettePluginActionPresentation = Readonly<{
    controller: PluginContributedActionController;
    scope: 'global' | 'session';
    signal: AbortSignal;
}>;

/** The AppShell facts the palette reads: Home, Account and the projection model (never executable diagnostics). */
const selectPaletteAppShellFacts = (value: AppShellPluginUiProjectionValue) => ({
    serverId: value.serverId,
    accountLifetime: value.accountLifetime,
    pluginUiProjection: value.pluginUiProjection,
});

export function useCommandPalettePluginActionPresentation(activeSessionId: string | null, presented: boolean): CommandPalettePluginActionPresentation | undefined {
    const appShellProjection = useAppShellPluginUiProjection(selectPaletteAppShellFacts);
    const currentUiContextReader = useOptionalCurrentUiContextReader();
    const destinationNavigation = usePluginSurfaceDestinationNavigationBinding();
    const clientExecutableRegistrationRevision = usePluginUiClientExecutableRegistrationRevision();
    const sessionMachineTarget = useSessionMachineControlTarget(activeSessionId ?? '');
    const scope = activeSessionId ? 'session' as const : 'global' as const;
    const machineId = activeSessionId ? sessionMachineTarget?.machineId ?? null : null;
    const serverId = activeSessionId
        ? resolvePreferredServerIdForSessionId(activeSessionId) ?? null
        : appShellProjection.serverId;
    const routedBindings = useServerCredentialAccountScopeBindings(activeSessionId && serverId ? [serverId] : []);
    const manageAffordances = useMachineListForServerSelection(serverId ?? '', selectManageAffordances);
    const accountLifetime = activeSessionId ? routedBindings.values().next().value ?? null : appShellProjection.accountLifetime;
    const projection = useDaemonMergedProjectionInputs({
        accountLifetime,
        machineId,
        serverId,
        sections: COMMAND_PALETTE_PROJECTION_SECTIONS,
        enabled: activeSessionId !== null && machineId !== null,
        load: presented,
    });
    const pluginUiProjection = activeSessionId
        ? projection.phase === 'ready' ? projection.inputs?.pluginUiProjection ?? null : null
        : appShellProjection.pluginUiProjection;
    // Keyed by the app projection alone: entering or leaving a Session does not change it, so it must not
    // rebuild (a full presentation/schema pass over every projected Action) on each Session switch.
    const appUiProjection = appShellProjection.pluginUiProjection;
    const appPluginProjectionById = React.useMemo(() => appUiProjection
        ? buildV2PluginProjectionById({ generation: appUiProjection.generation,
            actionsById: appUiProjection.actionsById, installedPackagesById: appUiProjection.installedPackagesById,
            resourcesById: appUiProjection.resourcesById }) : null,
    [appUiProjection?.actionsById, appUiProjection?.installedPackagesById, appUiProjection?.resourcesById]);
    // A Session palette never reads the app-scope map; its changes must not republish the Session snapshot.
    const globalPluginProjectionById = activeSessionId ? null : appPluginProjectionById;
    const localize = usePluginLocalizedTextResolver({ projection: pluginUiProjection });
    const appShellProjectionRef = React.useRef(appShellProjection);
    appShellProjectionRef.current = appShellProjection;
    const snapshotRef = React.useRef<PluginContributedActionCurrentSnapshot | null>(null);
    // This scope follows authority identity, not catalog metadata. The shared
    // controller re-resolves metadata/availability at open time, while a
    // target or Account transition retires any live form/action.
    const actionScope = React.useMemo(() => new AbortController(), [
        activeSessionId,
        accountLifetime,
        machineId,
        activeSessionId ? projection.phase : null,
        serverId,
    ]);
    React.useEffect(() => () => actionScope.abort(), [actionScope]);
    const snapshot = React.useMemo<PluginContributedActionCurrentSnapshot | null>(() => {
        const inputs = projection.inputs;
        const generation = inputs?.pluginProjectionV2?.generation;
        if (activeSessionId && (
            machineId === null
            || projection.phase !== 'ready'
            || !inputs
            || generation === null
            || generation === undefined
        )) {
            return null;
        }
        const pluginProjectionById = activeSessionId ? inputs?.pluginProjectionById : globalPluginProjectionById;
        if (!pluginProjectionById || !pluginUiProjection || !accountLifetime) return null;
        const resolveContributedAction = createPluginUiProjectedActionResolver(pluginUiProjection.actionsById);
        const current: PluginContributedActionCurrentSnapshot = {
            pluginProjectionById,
            pluginUiProjection,
            localize,
            resolveContributedAction,
            host: {
                machineId,
                serverId,
                ...(activeSessionId ? { sessionId: activeSessionId } : {}),
                signal: actionScope.signal,
                accountLifetime,
                ...(destinationNavigation ? { openSurface: destinationNavigation.openSurface } : {}),
                ...(currentUiContextReader
                    ? { readCurrentUiContext: currentUiContextReader.readCurrentUiContext }
                    : {}),
                isCurrent: () => (
                    snapshotRef.current?.host.signal === actionScope.signal
                    && actionScope.signal.aborted === false
                    && accountLifetime?.isCurrent() !== false
                ),
                // The app palette consumes an Action only from its selected
                // app-scope origin. A Session palette already has its exact
                // Session machine/currentness owner and must not acquire a
                // second app-scope selection gate.
                isActionCurrent: (identity: Readonly<{ pluginId: string; localId: string }>) => {
                    const action = resolveContributedAction(identity);
                    if (!action || snapshotRef.current?.resolveContributedAction?.(identity) !== action) return false;
                    if (activeSessionId) return true;
                    const projectedAction = appShellProjectionRef.current.pluginUiProjection?.actionsById[
                        buildQualifiedPluginContributionKey(identity)
                    ];
                    // Account release custody is already selected by AppShell;
                    // it does not borrow a Machine execution origin.
                    if (readPluginUiAccountExecutableOrigin(projectedAction)) return true;
                    const origin = readPluginUiContributionOrigin(projectedAction);
                    const exactRef = origin?.executionOrigin ? getPluginMachineExecutionOriginRef(origin.executionOrigin) : null;
                    return origin?.interactionEnabled === true && origin.phase === 'current'
                        && exactRef?.pluginId === identity.pluginId && exactRef.machineId === origin.machineId;
                },
            },
        };
        return current;
    }, [
        accountLifetime,
        globalPluginProjectionById,
        actionScope,
        activeSessionId,
        currentUiContextReader,
        destinationNavigation,
        localize,
        machineId,
        projection.inputs,
        projection.phase,
        pluginUiProjection,
        serverId,
    ]);
    snapshotRef.current = snapshot;
    const controller = React.useMemo(() => createPluginContributedActionController({
        resolveCurrent: identity => {
            const current = snapshotRef.current;
            if (!current || current.host.sessionId || !identity) return current;
            const action = current.resolveContributedAction?.(identity);
            const accountOrigin = readPluginUiAccountExecutableOrigin(action);
            if (accountOrigin) return { ...current, host: { ...current.host, machineId: null, serverId: accountOrigin.serverId } };
            const origin = readPluginUiContributionOrigin(action);
            return origin ? { ...current, host: { ...current.host, machineId: origin.machineId, serverId: origin.serverId } } : null;
        },
    }), [clientExecutableRegistrationRevision, manageAffordances]);

    return React.useMemo(() => (
        snapshot
            ? { controller, scope, signal: actionScope.signal }
            : undefined
    ), [actionScope.signal, controller, scope, snapshot]);
}

