import * as React from 'react';
import { useOptionalAppPaneContext } from '@/components/appShell/panes/AppPaneProvider';
import type { PaneDriver, PaneSurfaceScope } from '@/components/appShell/panes/types';
import { useScopedPluginUiProjection } from '@/components/plugins/projection/useScopedPluginUiProjection';
import { useSessionMachineTarget } from '@/components/sessions/model/useSessionMachineTarget';
import { usePreferredServerIdForSession } from '@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession';
import { SessionRightPanel } from './SessionRightPanel';
import { SessionBottomPanel } from './bottom/SessionBottomPanel';
import { SessionDetailsPanel } from './SessionDetailsPanel';

type SessionPaneScopedProps = Readonly<{ sessionId: string; scopeId: string }>;

export async function loadSessionSubagentDetailsModule(): Promise<void> {
    await import('@/components/sessions/agents/details/SessionSubagentDetailsView');
}

export const sessionPaneModulePrefetchLoaders: Array<() => Promise<void>> = [
    loadSessionSubagentDetailsModule,
];

export async function prefetchSessionPaneModules(): Promise<void> {
    await Promise.all(sessionPaneModulePrefetchLoaders.map((loadModule) => loadModule()));
}

export function useRegisterSessionPaneDriver(sessionId: string): string {
    const scopeId = React.useMemo(() => `session:${sessionId}`, [sessionId]);
    const paneCtx = useOptionalAppPaneContext();
    const registerDriver = paneCtx?.registerDriver ?? null;
    const canRegister = Boolean(registerDriver);
    // The registered PaneDriver is the sole target/currentness producer for
    // this scope. AppPane receives these facts; it must not reconstruct a
    // Session target from `scopeId` or issue a competing projection lookup.
    const sessionMachineTarget = useSessionMachineTarget(sessionId);
    const serverId = usePreferredServerIdForSession(sessionId);
    const pluginProjection = useScopedPluginUiProjection({
        machineId: sessionMachineTarget?.machineId ?? null,
        serverId,
    });

    React.useEffect(() => {
        if (!canRegister) return;
        const timer = setTimeout(() => {
            void prefetchSessionPaneModules();
        }, 3000);
        return () => clearTimeout(timer);
    }, [canRegister]);

    React.useEffect(() => {
        if (!registerDriver) return;
        const surfaceScope = {
            targetKind: 'session',
            sessionId,
            machineId: sessionMachineTarget?.machineId ?? null,
            serverId,
            pluginUiProjection: pluginProjection.pluginUiProjection,
            pluginBrowserProjection: pluginProjection.pluginBrowserProjection,
            projectionPhase: pluginProjection.phase,
            interactionEnabled: pluginProjection.interactionEnabled,
            platform: pluginProjection.platform,
        } satisfies Extract<PaneSurfaceScope, Readonly<{ targetKind: 'session' }>>;
        const driver: PaneDriver = {
            scopeId,
            surfaceScope,
            rightPaneBuiltinAdapter: {
                destinationIds: ['git', 'files', 'navigation', 'agents', 'terminal', 'browser', 'services'],
                defaultDestinationId: 'files',
                render: () => React.createElement(SessionRightPanel, {
                    sessionId,
                    scopeId,
                    paneSurfaceScope: surfaceScope,
                }),
            },
            rightSidebarAdapter: {
                render: () => React.createElement(SessionRightPanel, {
                    sessionId,
                    scopeId,
                    paneSurfaceScope: surfaceScope,
                }),
            },
            detailsPaneBuiltinAdapter: {
                destinationIds: ['session-details'],
                defaultDestinationId: 'session-details',
                render: () => React.createElement(SessionDetailsPanel, {
                    sessionId,
                    scopeId,
                    paneSurfaceScope: surfaceScope,
                }),
            },
            bottomPaneBuiltinAdapter: {
                destinationIds: ['terminal'],
                defaultDestinationId: 'terminal',
                render: () => React.createElement(SessionBottomPanel, { sessionId, scopeId }),
            },
        };
        return registerDriver(driver);
    }, [
        pluginProjection.interactionEnabled,
        pluginProjection.phase,
        pluginProjection.platform,
        pluginProjection.pluginBrowserProjection,
        pluginProjection.pluginUiProjection,
        registerDriver,
        scopeId,
        serverId,
        sessionId,
        sessionMachineTarget?.machineId,
    ]);

    return scopeId;
}
