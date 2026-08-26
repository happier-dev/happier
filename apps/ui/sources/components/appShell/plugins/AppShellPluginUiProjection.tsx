import * as React from 'react';

import type { PluginMachineExecutionOriginV1 } from '@happier-dev/protocol';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import {
    applyInstalledAppShellPluginUiReactNativeExecutableAuthorityInvalidation,
} from '@/components/plugins/reactNative/projectionInvalidation';
import {
    machineContributionRegistryProjectionDescribe,
} from '@/sync/ops/machineContributionRegistryProjection';
import { storage, useAllMachines } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
} from '@/sync/domains/plugins/ui/projection';
import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/targets';
import {
    resolvePluginUiClientExecutablePlatform,
    resolvePluginUiProjectionPlatform,
    usePluginUiProjectionCurrentness,
    type PluginUiProjectionCurrentness,
    type PluginUiProjectionPhase,
} from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import {
    arePluginUiProjectionUnionMembersEquivalent,
    unionPluginUiProjections,
    type PluginUiProjectionUnion,
    type PluginUiProjectionUnionMember,
    type PluginUiProjectionUnionOriginSelections,
} from '@/sync/domains/plugins/ui/projectionUnion';
import {
    useActivePluginAccountAvailabilityReader,
    useActivePluginAccountAvailabilityReleaseClassifier,
} from '@/sync/domains/plugins/availability/projection';
import { usePluginMachineExecutionOriginSelection } from '@/sync/domains/machines/administration/usePluginExecutionOriginSelection';
import {
    captureActiveServerAccountScopeLifetime,
    type ActiveServerAccountScopeLifetime,
} from '@/sync/domains/scope/activeServerAccountScope';
import {
    selectPluginDestinationSurfacePlacements,
    selectRenderablePluginRightSidebarTabPlacements,
} from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import {
    PluginSurfaceDestinationNavigationBindingProvider,
    PluginSurfacePaneLaunchScope,
    usePluginSurfaceDestinationNavigationBinding,
    usePluginSurfaceDestinationNavigationBindingForScope,
    useRegisterPluginSurfaceDestinationNavigationOwner,
} from '@/components/plugins/surfaces/pluginSurfaceDestinationNavigation';
import { useAppScopeRightSidebarDestinationHandler } from '@/components/appShell/rightSidebar/appScopeRightSidebarNavigation';
import {
    resolvePluginAppPages,
    selectPluginAppPagePlacements,
} from './pluginAppPages';
import { usePluginAppPageDestinationHandler } from './pluginAppPageNavigation';
import { usePluginSettingsPageDestinationHandler } from '@/components/settings/plugins/pluginSettingsPageNavigation';
import { isMachineOnline } from '@/utils/sessions/machineUtils';
import {
    advanceConnectedAccountDescriptorProjectionState,
    createConnectedAccountDescriptorProjectionLoadingState,
    mergeConnectedAccountDescriptorProjections,
    readConnectedAccountDescriptorProjection,
    type ConnectedAccountDescriptorMachineProjection,
    type ConnectedAccountDescriptorProjectionResolution,
    type ConnectedAccountDescriptorProjectionState,
} from '@/sync/domains/connectedServices/connectedAccountDescriptorProjection';
import {
    getConnectedServiceRegistrySnapshot,
    installConnectedAccountDescriptorProjection,
    retireConnectedAccountDescriptorProjection,
    type ConnectedServiceRegistrySnapshot,
} from '@/sync/domains/connectedServices/connectedServiceRegistry';
import {
    reconcileAppShellProjectedClientExecutables,
    unloadAppShellProjectedClientExecutables,
} from './appShellClientExecutableActivation';
import {
    getBundledConversationRuntimeGenerationRevision,
    subscribeBundledConversationRuntimeGeneration,
} from '@/voice/registry/bundledConversationRuntimeGeneration';
import { resolveVoiceExecutionMachineIdFromState } from '@/voice/settings/executionMachine';

import { PluginAppPageLaunchInputScope } from './pluginAppPageNavigation';
import {
    createPluginLocalizedTextResolver,
    type PluginLocalizedTextResolver,
} from '@/sync/domains/plugins/ui/i18n';
import { getPreferredLanguage } from '@/text/i18n';

const APP_SHELL_PLUGIN_PROJECTION_TIMEOUT_MS = 5_000;
const CONNECTED_ACCOUNT_PROJECTION_REFRESH_INTERVAL_MS = 30_000;

export type AppShellPluginUiProjectionValue = Readonly<{
    pluginUiProjection: PluginUiProjectionModel | null;
    pluginBrowserProjection: PluginBrowserProjectionModel | null;
    phase: PluginUiProjectionPhase;
    interactionEnabled: boolean;
    machineId: string | null;
    serverId: string | null;
    platform: LocalServicePreviewPlatform;
    connectedAccountProjectionRevision?: number;
    connectedAccountProjectionState?: ConnectedAccountDescriptorProjectionState;
}>;

const EMPTY_APP_SHELL_PLUGIN_UI_PROJECTION_VALUE: AppShellPluginUiProjectionValue = Object.freeze({
    pluginUiProjection: null,
    pluginBrowserProjection: null,
    phase: 'unavailable',
    interactionEnabled: false,
    machineId: null,
    serverId: null,
    platform: 'web',
    connectedAccountProjectionRevision: 0,
    connectedAccountProjectionState: createConnectedAccountDescriptorProjectionLoadingState('unmounted'),
});

const AppShellPluginUiProjectionContext = React.createContext<AppShellPluginUiProjectionValue>(
    EMPTY_APP_SHELL_PLUGIN_UI_PROJECTION_VALUE,
);

export type AppShellPluginProjectionTarget = Readonly<{ machineId: string; serverId: string | null }>;

/**
 * F7 — every eligible online machine is an app-scope projection target.
 *
 * The predecessor picked ONE machine (online, prefer `active`, newest `activeAt`
 * first, take `[0]`), which made a plugin installed on machine A vanish the
 * moment machine B sent a keep-alive. `activeAt` is presence data and carries
 * neither user intent nor ownership of a contribution, so the app scope unions
 * every eligible member instead of ranking them. The result is ordered by
 * machine id so nothing about it depends on heartbeats.
 */
export function resolveAppShellPluginProjectionTargets(params: Readonly<{
    activeServerId: string | null;
    machines: ReadonlyArray<Machine>;
    nowMs?: number;
}>): readonly AppShellPluginProjectionTarget[] {
    const nowMs = params.nowMs ?? Date.now();
    const serverId = params.activeServerId && params.activeServerId.trim().length > 0
        ? params.activeServerId
        : null;
    return Object.freeze(params.machines
        .filter((machine) => (
            typeof machine.id === 'string'
            && machine.id.trim().length > 0
            && isMachineOnline(machine, nowMs)
        ))
        .map((machine) => Object.freeze({ machineId: machine.id, serverId }))
        .sort((left, right) => left.machineId.localeCompare(right.machineId)));
}

function resolveAppShellPluginExecutionOriginPluginIds(
    reader: ReturnType<typeof useActivePluginAccountAvailabilityReader>,
): readonly string[] {
    const admission = reader?.readMaterializations();
    if (admission?.kind !== 'available') return [];
    return Object.freeze([...new Set(admission.materializations.map((materialization) => materialization.pluginId))]
        .sort((left, right) => left.localeCompare(right)));
}

function areSamePluginExecutionOrigin(
    left: PluginMachineExecutionOriginV1 | null | undefined,
    right: PluginMachineExecutionOriginV1 | null,
): boolean {
    return left === right || (
        left !== null
        && left !== undefined
        && right !== null
        && left.serverIdentityId === right.serverIdentityId
        && left.materializationRef.machineId === right.materializationRef.machineId
        && left.materializationRef.materializationId === right.materializationRef.materializationId
        && left.materializationRef.pluginId === right.materializationRef.pluginId
    );
}

function arePluginExecutionOriginSelectionsEquivalent(
    left: PluginUiProjectionUnionOriginSelections,
    right: PluginUiProjectionUnionOriginSelections,
): boolean {
    if (left.size !== right.size) return false;
    for (const [pluginId, origin] of left) {
        if (!areSamePluginExecutionOrigin(origin, right.get(pluginId) ?? null)) return false;
    }
    return true;
}

export type AppShellAccountScopedPluginExecutionOriginReport = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    origin: PluginMachineExecutionOriginV1;
}>;

export type AppShellAccountScopedPluginUiCurrentnessReport = Readonly<{
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    currentness: PluginUiProjectionCurrentness;
}>;

function isCurrentAccountLifetime(
    lifetime: ActiveServerAccountScopeLifetime | null,
): boolean {
    return lifetime?.isCurrent() ?? true;
}

function accountLifetimeScopeKey(lifetime: ActiveServerAccountScopeLifetime | null): string {
    if (!lifetime) return 'no-active-account';
    // A React key only forces the selection child to remount at an actual
    // Account change. Exact lifetime identity remains the authoritative gate
    // below, including same-scope retirement/recreation.
    return JSON.stringify([lifetime.scope.serverId, lifetime.scope.accountId]);
}

/**
 * The AppShell's one cache boundary for Administration selections. It is a
 * projection cache, not a classifier: Account Availability and Administration
 * decide what the origin is; this only refuses a report from another Account
 * before the union can read it.
 */
export function selectCurrentAppShellPluginExecutionOrigins(input: Readonly<{
    reports: ReadonlyMap<string, AppShellAccountScopedPluginExecutionOriginReport>;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    admittedPluginIds: readonly string[];
}>): PluginUiProjectionUnionOriginSelections {
    const admittedPluginIds = new Set(input.admittedPluginIds);
    return new Map([...input.reports]
        .filter(([pluginId, report]) => (
            admittedPluginIds.has(pluginId)
            && report.accountLifetime === input.accountLifetime
            && isCurrentAccountLifetime(report.accountLifetime)
        ))
        .map(([pluginId, report]) => [pluginId, report.origin]));
}

/** Same Account fence for the AppShell's per-machine currentness reports. */
export function selectCurrentAppShellPluginUiCurrentness(input: Readonly<{
    reports: ReadonlyMap<string, AppShellAccountScopedPluginUiCurrentnessReport>;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
}>): ReadonlyMap<string, PluginUiProjectionCurrentness> {
    return new Map([...input.reports]
        .filter(([, report]) => (
            report.accountLifetime === input.accountLifetime
            && isCurrentAccountLifetime(report.accountLifetime)
        ))
        .map(([machineId, report]) => [machineId, report.currentness]));
}

async function applyAppShellProjectionInvalidation(previous: PluginUiProjectionModel, next: PluginUiProjectionModel): Promise<void> {
    await applyInstalledAppShellPluginUiReactNativeExecutableAuthorityInvalidation(previous, next);
}

export async function settleAppShellPluginRuntimeUpdate(input: Readonly<{
    invalidate: () => Promise<void>;
    activate: () => Promise<void>;
    isCancelled: () => boolean;
}>): Promise<void> {
    try {
        if (input.isCancelled()) return;
        await input.invalidate();
        if (!input.isCancelled()) await input.activate();
    } catch {
        // Projection/activation failures fail closed and must not escape a React effect.
    }
}

export function AppShellPluginUiProjectionValueProvider(props: Readonly<{
    value: AppShellPluginUiProjectionValue;
    children: React.ReactNode;
}>): React.ReactElement {
    return (
        <AppShellPluginUiProjectionContext.Provider value={props.value}>
            {/*
              * The launch input a plugin page is opened with is scoped HERE, by
              * that page's stamped union contribution: a bounded argument is
              * addressed to one page, produced by its own generation and
              * machine, for one server/account. The app-wide union has no
              * authority of its own; binding to the contribution owner retires
              * the input when any of those facts changes.
              */}
            <PluginAppPageLaunchInputScope
                pluginUiProjection={props.value.pluginUiProjection}
            >
                {props.children}
            </PluginAppPageLaunchInputScope>
        </AppShellPluginUiProjectionContext.Provider>
    );
}

export function AppShellPluginUiProjectionProvider(props: Readonly<{
    children: React.ReactNode;
}>): React.ReactElement {
    const machines = useAllMachines();
    const activeServer = useActiveServerSnapshot();
    // The union is an Account-scoped consumer even when its server id does not
    // change. Capturing the incumbent lifetime gives every report a synchronous
    // fence before Account B renders under the same server/machine coordinates.
    const accountLifetime = captureActiveServerAccountScopeLifetime();
    const currentAccountLifetimeKey = accountLifetimeScopeKey(accountLifetime);
    const availabilityReader = useActivePluginAccountAvailabilityReader();
    // F7 has one release classifier: Account Availability. It is passed
    // directly into Administration's canonical exact-origin selection hook;
    // AppShell never infers release/content validity from a projection.
    const classifyRelease = useActivePluginAccountAvailabilityReleaseClassifier();
    const executionOriginPluginIds = React.useMemo(
        () => resolveAppShellPluginExecutionOriginPluginIds(availabilityReader),
        [availabilityReader],
    );
    const executionOriginPluginIdsKey = executionOriginPluginIds.join('\n');
    const [reportedOriginsByPluginId, setReportedOriginsByPluginId] = React.useState<
        ReadonlyMap<string, AppShellAccountScopedPluginExecutionOriginReport>
    >(() => new Map());
    const publishPluginExecutionOrigin = React.useCallback((
        pluginId: string,
        reportLifetime: ActiveServerAccountScopeLifetime | null,
        origin: PluginMachineExecutionOriginV1 | null,
    ) => {
        if (!isCurrentAccountLifetime(reportLifetime)) return;
        setReportedOriginsByPluginId((previous) => {
            const current = previous.get(pluginId) ?? null;
            if (
                current?.accountLifetime === reportLifetime
                && areSamePluginExecutionOrigin(current.origin, origin)
            ) return previous;
            const next = new Map(previous);
            if (origin) next.set(pluginId, Object.freeze({ accountLifetime: reportLifetime, origin }));
            else next.delete(pluginId);
            return next;
        });
    }, []);
    // A child reports only the canonical selection state for its own plugin.
    // Intersect by the current Availability admission synchronously, so a late
    // effect from an old Account projection cannot retain a stale origin for
    // even one render after Availability has withdrawn it.
    const selectedOriginsByPluginId = React.useMemo<PluginUiProjectionUnionOriginSelections>(() => {
        return selectCurrentAppShellPluginExecutionOrigins({
            reports: reportedOriginsByPluginId,
            accountLifetime,
            admittedPluginIds: executionOriginPluginIds,
        });
    }, [accountLifetime, executionOriginPluginIdsKey, reportedOriginsByPluginId]);
    const projectionTargets = React.useMemo(() => resolveAppShellPluginProjectionTargets({
        activeServerId: activeServer.serverId,
        machines,
    }), [activeServer.serverId, machines]);
    const [currentnessByMachineId, setCurrentnessByMachineId] = React.useState<
        ReadonlyMap<string, AppShellAccountScopedPluginUiCurrentnessReport>
    >(() => new Map());
    const publishMachineProjectionCurrentness = React.useCallback((
        machineId: string,
        reportLifetime: ActiveServerAccountScopeLifetime | null,
        currentness: PluginUiProjectionCurrentness,
    ) => {
        if (!isCurrentAccountLifetime(reportLifetime)) return;
        setCurrentnessByMachineId((previous) => {
            const current = previous.get(machineId) ?? null;
            if (current?.accountLifetime === reportLifetime && current.currentness === currentness) return previous;
            const next = new Map(previous);
            next.set(machineId, Object.freeze({ accountLifetime: reportLifetime, currentness }));
            return next;
        });
    }, []);
    // A machine that leaves the eligible set leaves the union with it, so its
    // last-known projection can never be re-admitted when it comes back before
    // its own probe has re-described it.
    React.useEffect(() => {
        const eligibleMachineIds = new Set(projectionTargets.map((projectionTarget) => projectionTarget.machineId));
        setCurrentnessByMachineId((previous) => (
            [...previous.keys()].every((machineId) => eligibleMachineIds.has(machineId))
                ? previous
                : new Map([...previous].filter(([machineId]) => eligibleMachineIds.has(machineId)))
        ));
    }, [projectionTargets]);
    const currentnessForActiveAccountByMachineId = React.useMemo(() => (
        selectCurrentAppShellPluginUiCurrentness({
            reports: currentnessByMachineId,
            accountLifetime,
        })
    ), [accountLifetime, currentnessByMachineId]);
    const projectionUnion = useStableAppShellPluginUiProjectionUnion(
        projectionTargets.map((projectionTarget) => {
            const currentness = currentnessForActiveAccountByMachineId.get(projectionTarget.machineId);
            return {
                machineId: projectionTarget.machineId,
                serverId: projectionTarget.serverId,
                projection: currentness?.pluginUiProjection ?? null,
                // A registered target has an owner hook, but that child may
                // not have published its first report yet. It is pending, not
                // unavailable, so restored app destinations preserve intent.
                phase: currentness?.phase ?? 'establishing',
                interactionEnabled: currentness?.interactionEnabled ?? false,
            };
        }),
        selectedOriginsByPluginId,
    );
    const { interactionEnabled, phase, pluginUiProjection } = projectionUnion;
    const platform = resolvePluginUiProjectionPlatform();
    const clientExecutablePlatform = resolvePluginUiClientExecutablePlatform();
    // §3.2 keeps the browser projection machine-scoped: it describes ONE
    // machine's browser targets, so it is published only when the union has a
    // single member — never merged into a machine-less bag.
    const pluginBrowserProjection = projectionUnion.machineId
        ? currentnessForActiveAccountByMachineId.get(projectionUnion.machineId)?.pluginBrowserProjection ?? null
        : null;
    const voiceExecutionMachineId = storage(resolveVoiceExecutionMachineIdFromState);
    // Voice execution stays bound to the USER-selected execution machine. When
    // that machine is already a union member its probe owns the description; a
    // voice machine outside the eligible set (active but past the presence
    // grace) still gets its own dedicated currentness.
    const voiceMachineIsUnionMember = Boolean(voiceExecutionMachineId) && projectionTargets.some(
        (projectionTarget) => projectionTarget.machineId === voiceExecutionMachineId,
    );
    const voiceUnionMember = voiceMachineIsUnionMember && voiceExecutionMachineId
        ? currentnessForActiveAccountByMachineId.get(voiceExecutionMachineId)
        : undefined;
    // Membership, not publication: a member whose probe has not published yet
    // must not be double-described by a second dedicated subscription. The
    // disabled dedicated hook is exactly the inert placeholder for that gap.
    const requiresDedicatedVoiceProjection = Boolean(voiceExecutionMachineId) && !voiceMachineIsUnionMember;
    const dedicatedVoiceProjectionCurrentness = usePluginUiProjectionCurrentness({
        machineId: voiceExecutionMachineId,
        serverId: activeServer.serverId,
        enabled: requiresDedicatedVoiceProjection,
    });
    const voiceProjectionCurrentness = voiceUnionMember ?? dedicatedVoiceProjectionCurrentness;
    const {
        interactionEnabled: voiceInteractionEnabled,
        machineId: voiceMachineId,
        pluginUiProjection: voicePluginUiProjection,
        serverId: voiceServerId,
    } = voiceProjectionCurrentness;
    const connectedAccountScopeKey = activeServer.serverId?.trim() || 'default';
    const voiceRuntimeGenerationRevision = React.useSyncExternalStore(
        subscribeBundledConversationRuntimeGeneration,
        getBundledConversationRuntimeGenerationRevision,
        getBundledConversationRuntimeGenerationRevision,
    );
    const [connectedAccountProjectionRevision, setConnectedAccountProjectionRevision] = React.useState(0);
    const [connectedAccountProjectionState, setConnectedAccountProjectionState] = React.useState<ConnectedAccountDescriptorProjectionState>(
        () => createConnectedAccountDescriptorProjectionLoadingState(connectedAccountScopeKey),
    );
    const connectedAccountProjectionStateRef = React.useRef(connectedAccountProjectionState);
    const installedConnectedAccountLifetimeRef = React.useRef<
        ActiveServerAccountScopeLifetime | null | undefined
    >(undefined);

    const commitConnectedAccountProjection = React.useCallback((
        lifetime: ActiveServerAccountScopeLifetime | null,
        resolution: ConnectedAccountDescriptorProjectionResolution,
    ) => {
        if (
            installedConnectedAccountLifetimeRef.current !== lifetime
            || !isCurrentAccountLifetime(lifetime)
        ) return;
        const previous = connectedAccountProjectionStateRef.current;
        const next = advanceConnectedAccountDescriptorProjectionState(previous, resolution);
        if (next === previous) return;
        connectedAccountProjectionStateRef.current = next;
        installConnectedAccountDescriptorProjection(next, lifetime);
        setConnectedAccountProjectionState(next);
        setConnectedAccountProjectionRevision((revision) => revision + 1);
    }, []);

    React.useEffect(() => {
        const previous = connectedAccountProjectionStateRef.current;
        // An Account lifetime is the authoritative fence when it exists. A
        // pre-profile AppShell has no Account scope to capture, so retain the
        // incumbent server-scope comparison for that explicitly unscoped
        // lifecycle; otherwise a server switch from `null` to `null` would
        // leave its old descriptor projection installed.
        if (
            installedConnectedAccountLifetimeRef.current === accountLifetime
            && (accountLifetime !== null || previous.scopeKey === connectedAccountScopeKey)
        ) return;
        const next = previous.scopeKey === connectedAccountScopeKey
            ? previous
            : createConnectedAccountDescriptorProjectionLoadingState(connectedAccountScopeKey);
        installedConnectedAccountLifetimeRef.current = accountLifetime;
        connectedAccountProjectionStateRef.current = next;
        installConnectedAccountDescriptorProjection(next, accountLifetime);
        setConnectedAccountProjectionState(next);
        setConnectedAccountProjectionRevision((revision) => revision + 1);
    }, [accountLifetime, connectedAccountScopeKey]);

    React.useEffect(() => {
        if (!accountLifetime) return;
        return accountLifetime.onRetire(() => {
            if (installedConnectedAccountLifetimeRef.current !== accountLifetime) return;
            // Retirement can run synchronously while Account B is rendering.
            // Mutate only owner-local refs and the module projection here; the
            // next effect publishes React state for Account B without a
            // render-phase update.
            installedConnectedAccountLifetimeRef.current = undefined;
            connectedAccountProjectionStateRef.current =
                createConnectedAccountDescriptorProjectionLoadingState(connectedAccountScopeKey);
            retireConnectedAccountDescriptorProjection(accountLifetime);
        }).dispose;
    }, [accountLifetime, connectedAccountScopeKey]);

    React.useEffect(() => () => {
        const unmounted = createConnectedAccountDescriptorProjectionLoadingState('unmounted');
        installedConnectedAccountLifetimeRef.current = undefined;
        connectedAccountProjectionStateRef.current = unmounted;
        installConnectedAccountDescriptorProjection(unmounted);
    }, []);

    // The connected-account union is addressed by machine id, so it must react to
    // the online machine set and not to machine-record identity. Presence keep-alives
    // republish every Machine object on their own cadence; depending on the array
    // would re-describe every machine and restart the scheduled refresh each time.
    const onlineMachineIdsKey = React.useMemo(() => (
        machines
            .filter((machine) => isMachineOnline(machine, Date.now()))
            .map((machine) => machine.id)
            .sort((left, right) => left.localeCompare(right))
            .join('\n')
    ), [machines]);
    const hasMachines = machines.length > 0;
    // Online membership also ages out without any store update, so the scheduled
    // refresh re-reads the latest machines instead of a set frozen at effect time.
    const machinesRef = React.useRef(machines);
    React.useEffect(() => {
        machinesRef.current = machines;
    }, [machines]);

    React.useEffect(() => {
        let cancelled = false;
        let refreshInFlight = false;
        const retirement = accountLifetime?.onRetire(() => {
            cancelled = true;
        });
        const refresh = async (): Promise<void> => {
            if (refreshInFlight) return;
            refreshInFlight = true;
            try {
                const onlineMachines = machinesRef.current
                    .filter((machine) => isMachineOnline(machine, Date.now()))
                    .sort((left, right) => left.id.localeCompare(right.id));
                const settledByMachine = await Promise.allSettled(onlineMachines.map(async (machine): Promise<ConnectedAccountDescriptorMachineProjection> => {
                    const result = await machineContributionRegistryProjectionDescribe(machine.id, {
                        serverId: activeServer.serverId,
                        timeoutMs: APP_SHELL_PLUGIN_PROJECTION_TIMEOUT_MS,
                    });
                    if (!result.supported) {
                        return { kind: 'error', reason: result.reason === 'not-supported' ? 'unsupported' : 'transport' };
                    }
                    return readConnectedAccountDescriptorProjection(result.projection);
                }));
                if (cancelled || !isCurrentAccountLifetime(accountLifetime)) return;
                const byMachine = settledByMachine.map((result): ConnectedAccountDescriptorMachineProjection => (
                    result.status === 'fulfilled'
                        ? result.value
                        : { kind: 'error', reason: 'transport' }
                ));
                commitConnectedAccountProjection(
                    accountLifetime,
                    mergeConnectedAccountDescriptorProjections(byMachine),
                );
            } finally {
                refreshInFlight = false;
            }
        };
        void refresh();
        const refreshTimer = hasMachines
            ? setInterval(() => { void refresh(); }, CONNECTED_ACCOUNT_PROJECTION_REFRESH_INTERVAL_MS)
            : null;
        return () => {
            cancelled = true;
            retirement?.dispose();
            if (refreshTimer) clearInterval(refreshTimer);
        };
    }, [accountLifetime, activeServer.serverId, commitConnectedAccountProjection, hasMachines, onlineMachineIdsKey]);
    const appliedProjectionRef = React.useRef<PluginUiProjectionModel>(EMPTY_PLUGIN_UI_PROJECTION);
    const pluginRuntimeUpdateTailRef = React.useRef<Promise<void>>(Promise.resolve());
    const appNavigationBinding = usePluginSurfaceDestinationNavigationBindingForScope({
        placements: pluginUiProjection
            ? selectPluginDestinationSurfacePlacements(pluginUiProjection)
            : [],
        settingsPages: pluginUiProjection
            ? Object.values(pluginUiProjection.settingsPagesById)
            : [],
        targetKind: 'app',
        accountLifetime,
    });
    const appNavigationBindingRef = React.useRef(appNavigationBinding);
    appNavigationBindingRef.current = appNavigationBinding;
    const readAppNavigationBinding = React.useCallback(() => appNavigationBindingRef.current, []);

    React.useEffect(() => {
        const next = pluginUiProjection ?? EMPTY_PLUGIN_UI_PROJECTION;
        let cancelled = false;
        // This is the one production serial caller. It always reconciles the
        // complete app Action set, and layers the optional Voice family into
        // that same transaction rather than allowing Voice currentness to gate
        // unrelated Action activation.
        const update = pluginRuntimeUpdateTailRef.current.then(async () => {
            await settleAppShellPluginRuntimeUpdate({
                invalidate: async () => {
                    const applied = appliedProjectionRef.current;
                    if (applied === next) return;
                    await applyAppShellProjectionInvalidation(applied, next);
                    appliedProjectionRef.current = next;
                },
                isCancelled: () => cancelled,
                activate: async () => {
                    await reconcileAppShellProjectedClientExecutables({
                        projection: next,
                        platform: clientExecutablePlatform,
                        voice: voiceInteractionEnabled && voiceMachineId && voicePluginUiProjection
                            ? Object.freeze({
                                projection: voicePluginUiProjection,
                                machineId: voiceMachineId,
                                serverId: voiceServerId,
                            })
                            : null,
                        reader: availabilityReader,
                        accountLifetime,
                        readNavigationBinding: readAppNavigationBinding,
                        isCurrent: () => !cancelled,
                    });
                },
            });
        });
        pluginRuntimeUpdateTailRef.current = update;
        return () => { cancelled = true; };
    }, [
        pluginUiProjection,
        clientExecutablePlatform,
        voiceInteractionEnabled,
        voiceMachineId,
        voicePluginUiProjection,
        voiceRuntimeGenerationRevision,
        voiceServerId,
        availabilityReader,
        accountLifetime,
        readAppNavigationBinding,
    ]);

    React.useEffect(() => () => {
        const previous = appliedProjectionRef.current;
        appliedProjectionRef.current = EMPTY_PLUGIN_UI_PROJECTION;
        void applyAppShellProjectionInvalidation(previous, EMPTY_PLUGIN_UI_PROJECTION).catch(() => {
            // Unmount must remain safe if cache invalidation fails.
        });
        // The executable host is process-global while this update tail belongs
        // to one component instance. Fence every exact-authority leaf so a
        // pending Action or Voice activation cannot publish on remount.
        void unloadAppShellProjectedClientExecutables().catch(() => {
            // Authority is synchronously fenced before cleanup awaits plugin disposal.
        });
    }, []);

    const value = React.useMemo<AppShellPluginUiProjectionValue>(() => ({
        pluginUiProjection,
        pluginBrowserProjection,
        phase,
        interactionEnabled,
        machineId: projectionUnion.machineId,
        serverId: projectionUnion.serverId,
        platform,
        connectedAccountProjectionRevision,
        connectedAccountProjectionState,
    }), [connectedAccountProjectionRevision, connectedAccountProjectionState, interactionEnabled, phase, platform, pluginBrowserProjection, pluginUiProjection, projectionUnion.machineId, projectionUnion.serverId]);
    return (
        <AppShellPluginUiProjectionValueProvider value={value}>
            {projectionTargets.map((projectionTarget) => (
                <AppShellPluginUiMachineProjection
                    key={`${currentAccountLifetimeKey}:${projectionTarget.serverId ?? 'default'}:${projectionTarget.machineId}`}
                    machineId={projectionTarget.machineId}
                    serverId={projectionTarget.serverId}
                    accountLifetime={accountLifetime}
                    onCurrentness={publishMachineProjectionCurrentness}
                />
            ))}
            {executionOriginPluginIds.map((pluginId) => (
                <AppShellPluginExecutionOriginSelection
                    key={`${currentAccountLifetimeKey}:${pluginId}`}
                    pluginId={pluginId}
                    accountLifetime={accountLifetime}
                    classifyRelease={classifyRelease}
                    onOrigin={publishPluginExecutionOrigin}
                />
            ))}
            <PluginSurfaceDestinationNavigationBindingProvider binding={appNavigationBinding}>
                {/*
                  * The app-scope pane handoff scope is app-lifetime because its
                  * producer is: a plugin can open an app right-sidebar tab before
                  * that route exists, and the bounded launch input has to survive
                  * the navigation that mounts it. Cockpit routes still establish
                  * their own narrower scope inside this one.
                  */}
                <PluginSurfacePaneLaunchScope>
                    <AppShellPluginSurfaceNavigationOwners />
                    {props.children}
                </PluginSurfacePaneLaunchScope>
            </PluginSurfaceDestinationNavigationBindingProvider>
        </AppShellPluginUiProjectionValueProvider>
    );
}

/**
 * The app route, Settings route and app right sidebar remain their own
 * incumbent navigation owners. This renderless bridge only registers those
 * existing adapters with the one app-target binding; it owns no router state or
 * destination choice.
 *
 * Every app-target container registers here, at app lifetime, because that is
 * what makes a plugin's FIRST `openSurface` reach a destination whose screen is
 * not mounted yet. A container registered from its own leaf could only ever be
 * opened once that leaf was already on screen.
 */
function AppShellPluginSurfaceNavigationOwners(): null {
    const projection = useAppShellPluginUiProjection();
    const localize = useProjectedPluginLocalizedTextResolver();
    const binding = usePluginSurfaceDestinationNavigationBinding();
    const pages = React.useMemo(() => resolvePluginAppPages({
        placements: selectPluginAppPagePlacements(projection.pluginUiProjection),
        localize,
    }), [localize, projection.pluginUiProjection]);
    const openPage = usePluginAppPageDestinationHandler({ pages });
    const openSettingsPage = usePluginSettingsPageDestinationHandler({
        projection: projection.pluginUiProjection,
    });
    const openRightSidebarTab = useAppScopeRightSidebarDestinationHandler();
    const pageOwner = React.useMemo(() => ({
        container: 'appPage' as const,
        handler: openPage,
    }), [openPage]);
    const settingsOwner = React.useMemo(() => ({
        container: 'settingsPage' as const,
        handler: openSettingsPage,
    }), [openSettingsPage]);
    const rightSidebarOwner = React.useMemo(() => ({
        container: 'rightSidebarTab' as const,
        handler: openRightSidebarTab,
    }), [openRightSidebarTab]);
    useRegisterPluginSurfaceDestinationNavigationOwner(pageOwner, binding);
    useRegisterPluginSurfaceDestinationNavigationOwner(settingsOwner, binding);
    useRegisterPluginSurfaceDestinationNavigationOwner(rightSidebarOwner, binding);
    return null;
}

/**
 * One eligible machine's plugin-UI projection, published into the app-scope
 * union.
 *
 * Per-machine currentness — reconnect epochs, daemon state versions, projection
 * invalidation revisions and executable authority — stays owned by
 * `usePluginUiProjectionCurrentness`. A union across N machines needs N of those
 * subscriptions and React has no way to call a hook per member, so each member
 * is one renderless child. This adds no second currentness owner, no polling and
 * no parallel registry: it is the hook, once per machine.
 */
function AppShellPluginUiMachineProjection(props: Readonly<{
    machineId: string;
    serverId: string | null;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    onCurrentness: (
        machineId: string,
        accountLifetime: ActiveServerAccountScopeLifetime | null,
        currentness: PluginUiProjectionCurrentness,
    ) => void;
}>): null {
    const currentness = usePluginUiProjectionCurrentness({
        machineId: props.machineId,
        serverId: props.serverId,
    });
    const { accountLifetime, machineId, onCurrentness } = props;
    React.useEffect(() => {
        onCurrentness(machineId, accountLifetime, currentness);
    }, [accountLifetime, currentness, machineId, onCurrentness]);
    return null;
}

/**
 * One renderless consumer of Administration's exact-origin owner. Dynamic
 * plugin materializations need dynamic hook instances, so each admitted plugin
 * gets a child; this component has no local classifier, election, persistence,
 * or fallback path. Its published `selected` state is the only thing the
 * app-scope union is allowed to consume.
 */
function AppShellPluginExecutionOriginSelection(props: Readonly<{
    pluginId: string;
    accountLifetime: ActiveServerAccountScopeLifetime | null;
    classifyRelease: ReturnType<typeof useActivePluginAccountAvailabilityReleaseClassifier>;
    onOrigin: (
        pluginId: string,
        accountLifetime: ActiveServerAccountScopeLifetime | null,
        origin: PluginMachineExecutionOriginV1 | null,
    ) => void;
}>): null {
    const selection = usePluginMachineExecutionOriginSelection({
        pluginId: props.pluginId,
        classifyRelease: props.classifyRelease,
    });
    const origin = selection.state.kind === 'selected' ? selection.state.origin : null;
    React.useEffect(() => {
        props.onOrigin(props.pluginId, props.accountLifetime, origin);
    }, [origin, props.accountLifetime, props.onOrigin, props.pluginId]);
    return null;
}

/**
 * The app-scope union, rebuilt only when a member actually changed.
 *
 * `usePluginUiProjectionCurrentness` already returns the SAME projection object
 * while a machine's generation is unchanged, so identity-comparing the members
 * gives the union the same referential stability a single-machine projection
 * had — which is what keeps runtime invalidation and activation from re-running
 * on every presence keep-alive.
 */
function useStableAppShellPluginUiProjectionUnion(
    members: readonly PluginUiProjectionUnionMember[],
    selectedOriginsByPluginId: PluginUiProjectionUnionOriginSelections,
): PluginUiProjectionUnion {
    const settled = React.useRef<Readonly<{
        members: readonly PluginUiProjectionUnionMember[];
        selectedOriginsByPluginId: PluginUiProjectionUnionOriginSelections;
        union: PluginUiProjectionUnion;
    }> | null>(null);
    if (
        settled.current === null
        || !arePluginUiProjectionUnionMembersEquivalent(settled.current.members, members)
        || !arePluginExecutionOriginSelectionsEquivalent(
            settled.current.selectedOriginsByPluginId,
            selectedOriginsByPluginId,
        )
    ) {
        settled.current = {
            members,
            selectedOriginsByPluginId,
            union: unionPluginUiProjections(members, selectedOriginsByPluginId),
        };
    }
    return settled.current.union;
}

export function useAppShellPluginUiProjection(): AppShellPluginUiProjectionValue {
    return React.useContext(AppShellPluginUiProjectionContext);
}

export function useProjectedConnectedServicesRegistry(): ConnectedServiceRegistrySnapshot {
    useAppShellPluginUiProjection().connectedAccountProjectionRevision;
    return getConnectedServiceRegistrySnapshot();
}

/** Binds plugin-authored text to the exact current app-scope projection and locale. */
export function useProjectedPluginLocalizedTextResolver(): PluginLocalizedTextResolver {
    const projection = useAppShellPluginUiProjection().pluginUiProjection;
    const locale = getPreferredLanguage();
    return React.useMemo(
        () => createPluginLocalizedTextResolver({ projection, locale }),
        [locale, projection],
    );
}

/**
 * Whether the active app-shell projection has at least one renderable
 * `app.rightSidebarTab` placement. Drives the decision to mount the tabbed
 * `AppScopeRightSidebar` in the app-shell right pane. Uses the SAME renderable
 * selector (`availability === 'available'` + policy gate) the sidebar itself
 * consumes, so the host never mounts an empty/fail-closed tabbed sidebar.
 */
export function useAppShellHasRenderableRightSidebarTabPlacements(): boolean {
    const projection = useAppShellPluginUiProjection();
    return React.useMemo(() => (
        (projection.phase === 'current' || projection.phase === 'retainedOffline')
            && projection.pluginUiProjection
            ? selectRenderablePluginRightSidebarTabPlacements(projection.pluginUiProjection, 'app').length > 0
            : false
    ), [projection.phase, projection.pluginUiProjection]);
}
