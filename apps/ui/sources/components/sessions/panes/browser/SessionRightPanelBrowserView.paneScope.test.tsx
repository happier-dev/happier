import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import type { PluginUiProjectionCurrentness } from '@/sync/domains/plugins/ui/usePluginUiProjectionCurrentness';

const browserHostInputs = vi.hoisted(() => [] as Record<string, unknown>[]);
const daemonTransportInputs = vi.hoisted(() => [] as Record<string, unknown>[]);
const ambientTarget = vi.hoisted(() => ({
    machineId: 'machine-ambient',
    serverId: 'server-ambient',
}));

vi.mock('@/components/browser/surfaces', () => ({
    BrowserSurfaceHost: (props: Record<string, unknown>) => React.createElement('BrowserSurfaceHostStub', props),
}));

vi.mock('@/components/browser/surfaces/useBrowserSurfaceHostProps', () => ({
    useBrowserSurfaceHostProps: (input: Record<string, unknown>) => {
        browserHostInputs.push(input);
        return {
            browserSessionId: 'browser-session',
            platform: 'web',
            initialBrowserState: {},
            surfaceKey: 'surface-key',
            presentationSlotId: 'slot-id',
            launchpadRows: [],
            launchpadRefreshStatus: 'idle',
            launchpadRefreshError: null,
            localServicePreviewState: null,
            localServicePreviewServerId: null,
            onLifecycleChange: () => {},
        };
    },
}));

vi.mock('@/components/sessions/model/useSessionMachineTarget', () => ({
    useSessionMachineTarget: () => ({ machineId: ambientTarget.machineId, basePath: '/repo' }),
}));

vi.mock('@/sync/runtime/orchestration/serverScopedRpc/usePreferredServerIdForSession', () => ({
    usePreferredServerIdForSession: () => ambientTarget.serverId,
}));

vi.mock('@/sync/domains/browser/control', () => ({
    useBrowserDaemonControlTransport: (input: Record<string, unknown>) => {
        daemonTransportInputs.push(input);
        return undefined;
    },
}));

vi.mock('@/components/sessions/browser/sessionBrowserContextRuntime', () => ({
    useSessionBrowserContextRuntimeContext: () => null,
}));

vi.mock('@/components/sessions/browser/sessionBrowserRecordingRuntime', () => ({
    useSessionBrowserRecordingRuntime: () => null,
}));

vi.mock('@/sync/domains/browser/context', () => ({
    createManagedChromiumBrowserAnnotationCaptureProvider: () => null,
}));

function runtimeScope(input: Readonly<{
    machineId: string | null;
    serverId: string | null;
    phase?: PluginUiProjectionCurrentness['phase'];
    interactionEnabled?: boolean;
}>): PluginUiProjectionCurrentness {
    return {
        pluginUiProjection: null,
        pluginBrowserProjection: null,
        phase: input.phase ?? 'unavailable',
        interactionEnabled: input.interactionEnabled ?? false,
        machineId: input.machineId,
        serverId: input.serverId,
        platform: 'web',
    };
}

describe('SessionRightPanelBrowserView pane scope', () => {
    beforeEach(() => {
        browserHostInputs.length = 0;
        daemonTransportInputs.length = 0;
        ambientTarget.machineId = 'machine-ambient';
        ambientTarget.serverId = 'server-ambient';
    });

    it('uses the admitted pane target rather than ambient Session lookup facts', async () => {
        const { SessionRightPanelBrowserView } = await import('./SessionRightPanelBrowserView');

        await renderScreen(
            <SessionRightPanelBrowserView
                sessionId="session-1"
                pluginProjection={runtimeScope({
                    machineId: 'machine-pane-driver',
                    serverId: 'server-pane-driver',
                })}
            />,
        );

        expect(browserHostInputs.at(-1)).toMatchObject({
            machineId: 'machine-pane-driver',
            serverId: 'server-pane-driver',
        });
        expect(daemonTransportInputs.at(-1)).toEqual({
            machineId: 'machine-pane-driver',
            serverId: 'server-pane-driver',
        });
    });

    it('keeps an explicit unavailable pane target unavailable rather than rebuilding ambient target state', async () => {
        const { SessionRightPanelBrowserView } = await import('./SessionRightPanelBrowserView');

        await renderScreen(
            <SessionRightPanelBrowserView
                sessionId="session-1"
                pluginProjection={runtimeScope({ machineId: null, serverId: null })}
            />,
        );

        expect(browserHostInputs.at(-1)).toMatchObject({ machineId: null, serverId: null });
        expect(daemonTransportInputs.at(-1)).toEqual({ machineId: null, serverId: null });
    });

    it('retains incumbent Session lookup for a direct Browser render without pane facts', async () => {
        const { SessionRightPanelBrowserView } = await import('./SessionRightPanelBrowserView');

        await renderScreen(<SessionRightPanelBrowserView sessionId="session-1" />);

        expect(browserHostInputs.at(-1)).toMatchObject({
            machineId: 'machine-ambient',
            serverId: 'server-ambient',
        });
        expect(daemonTransportInputs.at(-1)).toEqual({
            machineId: 'machine-ambient',
            serverId: 'server-ambient',
        });
    });

    it('keeps a retained Browser projection visible but noninteractive even when a stale boolean remains true', async () => {
        const { SessionRightPanelBrowserView } = await import('./SessionRightPanelBrowserView');

        const screen = await renderScreen(
            <SessionRightPanelBrowserView
                sessionId="session-1"
                pluginProjection={runtimeScope({
                    machineId: 'machine-pane-driver',
                    serverId: 'server-pane-driver',
                    phase: 'retainedOffline',
                    interactionEnabled: true,
                })}
            />,
        );

        expect(screen.root.findByType('BrowserSurfaceHostStub' as never).props
            .pluginUiInteractionEnabled).toBe(false);
    });
});
