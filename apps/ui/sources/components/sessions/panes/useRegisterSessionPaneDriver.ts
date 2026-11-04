import * as React from 'react';
import { useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import type { PaneDriver } from '@/components/appShell/panes/types';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { RIGHT_SIDEBAR_BUILTIN_TABS } from '@/components/appShell/rightSidebar/rightSidebarBuiltinTabs';
import { createSessionPaneSurfaceScope } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { SessionRightPanel, SessionActionRail } from './SessionRightPanel';
import { SessionBottomPanel } from './bottom/SessionBottomPanel';
import { SessionDetailsPanel } from './SessionDetailsPanelHost';
import { createSessionPaneScopeId } from './sessionPaneScopeId';
import type { SessionBoardPrimaryMountResolver } from '@/sync/domains/session/board';
import type { SessionPluginRuntimeState } from '@/components/sessions/plugins/useSessionPluginRuntime';
import { useDestinationInstanceKey } from '@/components/appShell/workspace/DestinationInstanceHost';
import { useSessionCockpitChromeRegistration } from '@/components/workspaceCockpit/session/SessionCockpitChromeRegistry';
import { areServerProfileIdentifiersEquivalent } from '@/sync/domains/server/serverProfiles';
import { resolveSessionTerminalDockLocation } from '@/components/sessions/terminal/useSessionTerminalAvailability';
import { useDeviceType } from '@/utils/platform/responsive';
import { usePanePresentation } from '@/components/appShell/panes/panePresentation';
import { useOptionalDetailsTabOpener } from '@/components/appShell/panes/hooks/useAppPaneScope';
import { createSessionPaneDetailsTab } from './url/sessionPaneUrlState';
import { fileChangesComparisonOfScope } from '@/components/workspaces/files/file/changes/fileChangesScope';
import { readCurrentAppShellPluginUiProjection } from '@/components/appShell/plugins/committedPluginUiProjection';
import { selectPluginSurfacePlacementsByDestination } from '@/sync/domains/plugins/ui/surfacePlacementSelectors';
import { resolveRightSidebarPluginTabs } from '@/components/appShell/rightSidebar/rightSidebarPluginTabs';
import { resolveRightSidebarTabSelection } from '@/components/appShell/rightSidebar/rightSidebarTabRegistry';
import { resolveSelectedPaneDestination } from '@/components/appShell/panes/model/resolveSelectedPaneDestination';
import { readPluginUiContributionOrigin } from '@/sync/domains/plugins/ui/projectionUnion';
import { resolvePluginUiRuntimeFormFactor } from '@/components/appShell/panes/layout/resolveMultiPaneDeviceType';
import { getActiveServerAccountScope } from '@/sync/domains/scope/activeServerAccountScope';
import { areServerAccountScopesEqual } from '@/sync/domains/scope/serverAccountScope';

type SessionPaneScopedProps = Readonly<{ sessionId: string; scopeId: string }>;

const sessionBuiltinDestinationIds = RIGHT_SIDEBAR_BUILTIN_TABS
    .filter((tab) => tab.scopes.includes('session'))
    .map((tab) => tab.id);

export async function loadSessionSubagentDetailsModule(): Promise<void> {
    await import('@/components/sessions/agents/details/SessionSubagentDetailsView');
}

export const sessionPaneModulePrefetchLoaders: Array<() => Promise<void>> = [
    loadSessionSubagentDetailsModule,
];

export async function prefetchSessionPaneModules(): Promise<void> {
    await Promise.all(sessionPaneModulePrefetchLoaders.map(async (loadModule) => {
        try {
            await loadModule();
        } catch (error) {
            // Speculative loading failures must not become unhandled rejections.
            // Demand loading owns its own import and can retry a failed chunk fetch.
            console.warn('Failed to prefetch session pane module', error);
        }
    }));
}

export function useRegisterSessionPaneDriver(
    sessionId: string,
    explicitServerId?: string | null,
    resolveBoardPrimaryHost?: SessionBoardPrimaryMountResolver,
    suppliedPluginRuntime?: SessionPluginRuntimeState,
    options?: Readonly<{
        /**
         * `false` for a Session presented inside another surface (the embedded arm): the scope is
         * keyed by Session, so registering would replace the route Session's own driver.
         */
        registerDriver?: boolean;
        /** A selected pane recipient retains the source layout's exact scope identity. */
        scopeId?: string;
    }>,
): string {
    const instanceKey = useDestinationInstanceKey();
    const paneCtx = useOptionalAppPaneContext(value => ({ registerDriver: value.registerDriver }));
    const cockpitChrome = useSessionCockpitChromeRegistration();
    // The bottom pane exists only where the terminal docks there. A phone shows it as the Terminal
    // page, yet every cockpit scene mounts this scope's pane host, so a bottom pane a wider layout
    // left open would otherwise duplicate the terminal under Chat.
    const deviceType = useDeviceType();
    const bottomPaneAvailable = resolveSessionTerminalDockLocation(deviceType) === 'bottom';
    const presentPane = usePanePresentation();
    // The phone cockpit presents sidebar destinations as its own retained
    // scenes. Its Session chrome must not mount another copy as an overlay.
    const rightPaneAvailable = bottomPaneAvailable || presentPane === null;
    // Its Details are the cockpit's own File scene too: a Session screen raised beside it (the phone Ask sheet)
    // must not open them again as an overlay over Chat.
    const detailsPaneEnabled = presentPane === null;
    const registerDriver = options?.registerDriver === false ? null : paneCtx?.registerDriver ?? null;
    const canRegister = Boolean(registerDriver);
    // The registered PaneDriver is the sole target/currentness producer for
    // this scope. AppPane receives these facts; it must not reconstruct a
    // Session target from `scopeId` or issue a competing projection lookup.
    const sessionMachineTarget = useSessionMachineTarget(
        suppliedPluginRuntime ? null : sessionId,
        suppliedPluginRuntime ? null : explicitServerId,
    );
    const inferredServerId = usePreferredServerIdForSession({ serverId: explicitServerId, sessionId });
    const serverId = String(suppliedPluginRuntime?.serverId ?? explicitServerId ?? '').trim() || inferredServerId;
    const scopeId = React.useMemo(
        () => options?.scopeId ?? createSessionPaneScopeId(sessionId, serverId, instanceKey),
        [instanceKey, options?.scopeId, serverId, sessionId],
    );
    const openDetailsTab = useOptionalDetailsTabOpener(scopeId);
    const openResource = React.useCallback<NonNullable<PaneDriver['openResource']>>((resource, openOptions) => {
        if (resource.kind !== 'file' || !openDetailsTab) return false;
        const { kind, changesScope, ...file } = resource;
        const constructed = createSessionPaneDetailsTab({ kind, ...file,
            ...(changesScope ? { changes: fileChangesComparisonOfScope(changesScope) } : {}),
        });
        if (!constructed) return false;
        const { isPinned: _pinned, isPreview: _preview, ...tab } = constructed;
        openDetailsTab(tab, { intent: openOptions?.intent ?? 'preview', present: openOptions?.present });
        return true;
    }, [openDetailsTab]);
    const pluginProjection = useScopedPluginUiProjection({
        machineId: suppliedPluginRuntime ? null : sessionMachineTarget?.machineId ?? null,
        serverId: suppliedPluginRuntime ? null : serverId,
        enabled: suppliedPluginRuntime === undefined && options?.registerDriver !== false,
    });
    const pluginRuntime = suppliedPluginRuntime ?? {
        pluginUiProjection: pluginProjection.pluginUiProjection,
        pluginBrowserProjection: pluginProjection.pluginBrowserProjection,
        accountLifetime: pluginProjection.accountLifetime,
        phase: pluginProjection.phase,
        interactionEnabled: pluginProjection.interactionEnabled,
        machineId: sessionMachineTarget?.machineId ?? null,
        serverId,
        platform: pluginProjection.platform,
    } satisfies SessionPluginRuntimeState;

    React.useEffect(() => {
        if (!canRegister) return;
        const timer = setTimeout(() => {
            void prefetchSessionPaneModules();
        }, 3000);
        return () => clearTimeout(timer);
    }, [canRegister]);

    React.useEffect(() => {
        if (!registerDriver) return;
        const surfaceScope = createSessionPaneSurfaceScope(sessionId, pluginRuntime);
        const driver: PaneDriver = {
            scopeId,
            surfaceScope,
            openResource,
            onTerminalWorkspaceReveal: () => {
                const matchingHome = serverId
                    ? areServerProfileIdentifiersEquivalent(cockpitChrome?.serverId, serverId)
                    : !cockpitChrome?.serverId;
                if (cockpitChrome?.sessionId === sessionId && matchingHome && cockpitChrome.terminalTabAvailable) {
                    cockpitChrome.switchSurface('terminal');
                }
            },
            rightPaneBuiltinAdapter: {
                destinationIds: sessionBuiltinDestinationIds,
                defaultDestinationId: 'files',
                render: () => rightPaneAvailable ? React.createElement(SessionRightPanel, {
                    sessionId,
                    scopeId,
                    paneSurfaceScope: surfaceScope,
                    resolveBoardPrimaryHost,
                }) : null,
            },
            rightSidebarAdapter: {
                readContinuingDestination: selection => {
                    const lifetime = pluginRuntime.accountLifetime;
                    if (!rightPaneAvailable || selection.kind !== 'plugin' || !lifetime?.isCurrent()
                        || !areServerAccountScopesEqual(lifetime.scope, getActiveServerAccountScope())) return null;
                    // Re-admit the selected identity from the one committed App catalog only on
                    // an eligible navigation. Always-mounted drivers subscribe to no detail here.
                    const projection = readCurrentAppShellPluginUiProjection({ scope: lifetime.scope, declarationsOnly: true });
                    if (!projection) return null;
                    const placements = selectPluginSurfacePlacementsByDestination(projection, selection.destination);
                    const runtimeAdmission = { platform: pluginRuntime.platform,
                        formFactor: resolvePluginUiRuntimeFormFactor({ deviceType }) };
                    const tabs = resolveRightSidebarPluginTabs({ scope: 'app', placements,
                        runtimeAdmission });
                    const projectionPhase = readCurrentAppShellPluginUiProjection() === projection ? 'current' : 'establishing';
                    const admitted = resolveRightSidebarTabSelection({ activeTabId: null, selectedDestination: selection,
                        tabs, scope: 'app', projectionPhase });
                    if (admitted.kind !== 'available' || admitted.tab.owner !== 'plugin') return null;
                    const paneSelection = resolveSelectedPaneDestination({ container: 'rightSidebarTab', targetKind: 'app',
                        projection, selectedDestination: selection, runtimeAdmission,
                        projectionPhase: readPluginUiContributionOrigin(admitted.tab.placement)?.phase ?? projectionPhase });
                    return paneSelection.kind === 'available' && paneSelection.placement === admitted.tab.placement
                        ? paneSelection.placement.binding : null;
                },
                renderActionRail: () => React.createElement(SessionActionRail),
                render: () => rightPaneAvailable ? React.createElement(SessionRightPanel, {
                    sessionId,
                    scopeId,
                    paneSurfaceScope: surfaceScope,
                    resolveBoardPrimaryHost,
                }) : null,
            },
            detailsPaneBuiltinAdapter: {
                destinationIds: ['session-details'],
                defaultDestinationId: 'session-details',
                render: () => React.createElement(SessionDetailsPanel, {
                    sessionId,
                    scopeId,
                    paneSurfaceScope: surfaceScope,
                    resolveBoardPrimaryHost,
                }),
            },
            detailsPaneEnabled,
            ...(bottomPaneAvailable ? {
                bottomPaneBuiltinAdapter: {
                    destinationIds: ['terminal'],
                    defaultDestinationId: 'terminal',
                    render: () => React.createElement(SessionBottomPanel, { sessionId, scopeId }),
                },
            } : null),
        };
        return registerDriver(driver);
    }, [
        bottomPaneAvailable,
        detailsPaneEnabled,
        deviceType,
        rightPaneAvailable,
        cockpitChrome,
        pluginRuntime.accountLifetime,
        pluginRuntime.interactionEnabled,
        pluginRuntime.phase,
        pluginRuntime.platform,
        pluginRuntime.pluginBrowserProjection,
        pluginRuntime.pluginUiProjection,
        pluginRuntime.machineId,
        pluginRuntime.serverId,
        registerDriver,
        openResource,
        resolveBoardPrimaryHost,
        scopeId,
        sessionId,
        serverId,
    ]);

    return scopeId;
}
