import * as React from 'react';

import { PluginSurfacePlacementStack } from '@/components/plugins/surfaces';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import {
    applyInstalledAppShellPluginUiReactNativeRuntimeProjectionInvalidation,
} from '@/components/plugins/reactNative/projectionInvalidation';
import { getInstalledPluginUiExecutableModuleHost } from '@/components/plugins/reactNative/executableModuleHost';
import {
    machineContributionRegistryProjectionDescribe,
} from '@/sync/ops/machineContributionRegistryProjection';
import { storage, useAllMachines } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import type { LocalServicePreviewPlatform } from '@/sync/domains/local/services/preview/url';
import {
    EMPTY_PLUGIN_UI_PROJECTION,
    type PluginUiProjectionModel,
    type PluginUiSurfacePlacementProjection,
} from '@/sync/domains/plugins/ui/projection';
import type { PluginBrowserProjectionModel } from '@/sync/domains/plugins/browser/targets';
import { usePluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';
import {
    selectRenderablePluginRightSidebarTabPlacements,
    selectRenderablePluginSurfacePlacementsForPlacement,
} from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
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
    type ConnectedServiceRegistrySnapshot,
} from '@/sync/domains/connectedServices/connectedServiceRegistry';
import { activateProjectedExternalVoiceProviders } from '@/voice/registry/projectedExternalVoiceProviderActivation';
import {
    getBundledConversationRuntimeGenerationRevision,
    subscribeBundledConversationRuntimeGeneration,
} from '@/voice/registry/bundledConversationRuntimeGeneration';
import { resolveVoiceExecutionMachineIdFromState } from '@/voice/settings/executionMachine';

const APP_SHELL_PLUGIN_PROJECTION_TIMEOUT_MS = 5_000;
const CONNECTED_ACCOUNT_PROJECTION_REFRESH_INTERVAL_MS = 30_000;

export type AppPluginSurfacePlacement = 'app.settingsPage' | 'app.sidePanel' | 'app.bottomPanel';

export type AppShellPluginUiProjectionValue = Readonly<{
    pluginUiProjection: PluginUiProjectionModel | null;
    pluginBrowserProjection: PluginBrowserProjectionModel | null;
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

export function resolveAppShellPluginProjectionTarget(params: Readonly<{
    activeServerId: string | null;
    machines: ReadonlyArray<Machine>;
    nowMs?: number;
}>): Readonly<{ machineId: string; serverId: string | null }> | null {
    const nowMs = params.nowMs ?? Date.now();
    const candidates = params.machines.filter((machine) => (
        typeof machine.id === 'string'
        && machine.id.trim().length > 0
        && isMachineOnline(machine, nowMs)
    ));
    const activeCandidates = candidates.filter((machine) => machine.active === true);
    const pool = activeCandidates.length > 0 ? activeCandidates : candidates;
    const selected = [...pool].sort((left, right) => {
        const leftActiveAt = typeof left.activeAt === 'number' ? left.activeAt : 0;
        const rightActiveAt = typeof right.activeAt === 'number' ? right.activeAt : 0;
        if (leftActiveAt !== rightActiveAt) return rightActiveAt - leftActiveAt;
        return left.id.localeCompare(right.id);
    })[0];
    if (!selected) {
        return null;
    }
    return {
        machineId: selected.id,
        serverId: params.activeServerId && params.activeServerId.trim().length > 0 ? params.activeServerId : null,
    };
}

async function applyAppShellProjectionInvalidation(previous: PluginUiProjectionModel, next: PluginUiProjectionModel): Promise<void> {
    await applyInstalledAppShellPluginUiReactNativeRuntimeProjectionInvalidation(previous, next);
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
            {props.children}
        </AppShellPluginUiProjectionContext.Provider>
    );
}

export function AppShellPluginUiProjectionProvider(props: Readonly<{
    children: React.ReactNode;
}>): React.ReactElement {
    const machines = useAllMachines();
    const activeServer = useActiveServerSnapshot();
    const resolvedTarget = React.useMemo(() => resolveAppShellPluginProjectionTarget({
        activeServerId: activeServer.serverId,
        machines,
    }), [activeServer.serverId, machines]);
    const resolvedTargetMachineId = resolvedTarget?.machineId ?? null;
    const resolvedTargetServerId = resolvedTarget?.serverId ?? null;
    const target = React.useMemo(() => (
        resolvedTargetMachineId
            ? { machineId: resolvedTargetMachineId, serverId: resolvedTargetServerId }
            : null
    ), [resolvedTargetMachineId, resolvedTargetServerId]);
    const projectionCurrentness = usePluginUiProjectionCurrentness({
        machineId: resolvedTargetMachineId,
        serverId: resolvedTargetServerId,
    });
    const {
        interactionEnabled,
        platform,
        pluginBrowserProjection,
        pluginUiProjection,
    } = projectionCurrentness;
    const voiceExecutionMachineId = storage(resolveVoiceExecutionMachineIdFromState);
    const requiresDedicatedVoiceProjection = (
        voiceExecutionMachineId !== resolvedTargetMachineId
    );
    const dedicatedVoiceProjectionCurrentness = usePluginUiProjectionCurrentness({
        machineId: voiceExecutionMachineId,
        serverId: activeServer.serverId,
        enabled: requiresDedicatedVoiceProjection,
    });
    const voiceProjectionCurrentness = requiresDedicatedVoiceProjection
        ? dedicatedVoiceProjectionCurrentness
        : projectionCurrentness;
    const {
        interactionEnabled: voiceInteractionEnabled,
        machineId: voiceMachineId,
        platform: voicePlatform,
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
    const installedConnectedAccountScopeRef = React.useRef<string | null>(null);

    const commitConnectedAccountProjection = React.useCallback((
        resolution: ConnectedAccountDescriptorProjectionResolution,
    ) => {
        const previous = connectedAccountProjectionStateRef.current;
        const next = advanceConnectedAccountDescriptorProjectionState(previous, resolution);
        if (next === previous) return;
        connectedAccountProjectionStateRef.current = next;
        installConnectedAccountDescriptorProjection(next);
        setConnectedAccountProjectionState(next);
        setConnectedAccountProjectionRevision((revision) => revision + 1);
    }, []);

    React.useEffect(() => {
        const previous = connectedAccountProjectionStateRef.current;
        if (installedConnectedAccountScopeRef.current === connectedAccountScopeKey) return;
        const next = previous.scopeKey === connectedAccountScopeKey
            ? previous
            : createConnectedAccountDescriptorProjectionLoadingState(connectedAccountScopeKey);
        installedConnectedAccountScopeRef.current = connectedAccountScopeKey;
        connectedAccountProjectionStateRef.current = next;
        installConnectedAccountDescriptorProjection(next);
        setConnectedAccountProjectionState(next);
        setConnectedAccountProjectionRevision((revision) => revision + 1);
    }, [connectedAccountScopeKey]);

    React.useEffect(() => () => {
        const unmounted = createConnectedAccountDescriptorProjectionLoadingState('unmounted');
        connectedAccountProjectionStateRef.current = unmounted;
        installConnectedAccountDescriptorProjection(unmounted);
    }, []);

    React.useEffect(() => {
        let cancelled = false;
        let refreshInFlight = false;
        const refresh = async (): Promise<void> => {
            if (refreshInFlight) return;
            refreshInFlight = true;
            try {
                const onlineMachines = machines
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
                if (cancelled) return;
                const byMachine = settledByMachine.map((result): ConnectedAccountDescriptorMachineProjection => (
                    result.status === 'fulfilled'
                        ? result.value
                        : { kind: 'error', reason: 'transport' }
                ));
                commitConnectedAccountProjection(mergeConnectedAccountDescriptorProjections(byMachine));
            } finally {
                refreshInFlight = false;
            }
        };
        void refresh();
        const refreshTimer = machines.length > 0
            ? setInterval(() => { void refresh(); }, CONNECTED_ACCOUNT_PROJECTION_REFRESH_INTERVAL_MS)
            : null;
        return () => {
            cancelled = true;
            if (refreshTimer) clearInterval(refreshTimer);
        };
    }, [activeServer.serverId, commitConnectedAccountProjection, machines]);
    const scheduledProjectionRef = React.useRef<PluginUiProjectionModel>(EMPTY_PLUGIN_UI_PROJECTION);
    const appliedProjectionRef = React.useRef<PluginUiProjectionModel>(EMPTY_PLUGIN_UI_PROJECTION);
    const previousVoiceRuntimeGenerationRevisionRef = React.useRef(voiceRuntimeGenerationRevision);
    const pluginRuntimeUpdateTailRef = React.useRef<Promise<void>>(Promise.resolve());

    React.useEffect(() => {
        const previous = scheduledProjectionRef.current;
        const next = pluginUiProjection ?? EMPTY_PLUGIN_UI_PROJECTION;
        const projectionChanged = previous !== next;
        const voiceRuntimeGenerationChanged = (
            previousVoiceRuntimeGenerationRevisionRef.current !== voiceRuntimeGenerationRevision
        );
        if (!voiceInteractionEnabled || !voiceMachineId) {
            // Preserve the last-known visible projection while withdrawing its
            // process-global executable authority immediately. Do not queue
            // this behind activation or plugin-owned teardown.
            void getInstalledPluginUiExecutableModuleHost().replaceAuthority(null).catch(() => {
                // Authority is synchronously fenced before cleanup awaits plugin disposal.
            });
        }
        if (projectionChanged || voiceRuntimeGenerationChanged || voiceInteractionEnabled) {
            scheduledProjectionRef.current = next;
            previousVoiceRuntimeGenerationRevisionRef.current = voiceRuntimeGenerationRevision;
            let cancelled = false;
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
                        if (!voiceInteractionEnabled || !voiceMachineId || !voicePluginUiProjection) return;
                        await activateProjectedExternalVoiceProviders({
                            projection: voicePluginUiProjection,
                            machineId: voiceMachineId,
                            serverId: voiceServerId,
                            hostPlatform: voicePlatform,
                        });
                    },
                });
            });
            pluginRuntimeUpdateTailRef.current = update;
            return () => { cancelled = true; };
        }
        return undefined;
    }, [
        pluginUiProjection,
        voiceInteractionEnabled,
        voiceMachineId,
        voicePlatform,
        voicePluginUiProjection,
        voiceRuntimeGenerationRevision,
        voiceServerId,
    ]);

    React.useEffect(() => () => {
        const previous = appliedProjectionRef.current;
        scheduledProjectionRef.current = EMPTY_PLUGIN_UI_PROJECTION;
        appliedProjectionRef.current = EMPTY_PLUGIN_UI_PROJECTION;
        void applyAppShellProjectionInvalidation(previous, EMPTY_PLUGIN_UI_PROJECTION).catch(() => {
            // Unmount must remain safe if cache invalidation fails.
        });
        // The executable host is process-global while this update tail belongs
        // to one component instance. Fence authority synchronously so pending
        // activation cannot publish during a same-generation remount.
        void getInstalledPluginUiExecutableModuleHost().replaceAuthority(null).catch(() => {
            // Authority is synchronously fenced before cleanup awaits plugin disposal.
        });
    }, []);

    const value = React.useMemo<AppShellPluginUiProjectionValue>(() => ({
        pluginUiProjection,
        pluginBrowserProjection,
        interactionEnabled,
        machineId: target?.machineId ?? null,
        serverId: target?.serverId ?? null,
        platform,
        connectedAccountProjectionRevision,
        connectedAccountProjectionState,
    }), [connectedAccountProjectionRevision, connectedAccountProjectionState, interactionEnabled, platform, pluginBrowserProjection, pluginUiProjection, target?.machineId, target?.serverId]);

    return (
        <AppShellPluginUiProjectionContext.Provider value={value}>
            {props.children}
        </AppShellPluginUiProjectionContext.Provider>
    );
}

export function useAppShellPluginUiProjection(): AppShellPluginUiProjectionValue {
    return React.useContext(AppShellPluginUiProjectionContext);
}

export function useProjectedConnectedServicesRegistry(): ConnectedServiceRegistrySnapshot {
    useAppShellPluginUiProjection().connectedAccountProjectionRevision;
    return getConnectedServiceRegistrySnapshot();
}

export function useAppPluginSurfacePlacements(
    placement: AppPluginSurfacePlacement,
): AppShellPluginUiProjectionValue & Readonly<{ placements: readonly PluginUiSurfacePlacementProjection[] }> {
    const projection = useAppShellPluginUiProjection();
    const placements = React.useMemo(() => (
        projection.pluginUiProjection
            ? selectRenderablePluginSurfacePlacementsForPlacement(projection.pluginUiProjection, placement)
            : []
    ), [placement, projection.pluginUiProjection]);
    return React.useMemo(() => ({
        ...projection,
        placements,
    }), [placements, projection]);
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
        projection.pluginUiProjection
            ? selectRenderablePluginRightSidebarTabPlacements(projection.pluginUiProjection, 'app').length > 0
            : false
    ), [projection.pluginUiProjection]);
}

export function AppPluginSurfacePlacementStack(props: Readonly<{
    placement: AppPluginSurfacePlacement;
    testID?: string;
}>): React.ReactElement | null {
    const projection = useAppPluginSurfacePlacements(props.placement);
    if (!projection.pluginUiProjection || projection.placements.length === 0) {
        return null;
    }
    return (
        <PluginSurfacePlacementStack
            placement={props.placement}
            pluginUiProjection={projection.pluginUiProjection}
            projectionInteractionEnabled={projection.interactionEnabled}
            machineId={projection.machineId}
            serverId={projection.serverId}
            platform={projection.platform}
            targetKind="app"
            testID={props.testID}
        />
    );
}
