import * as React from 'react';
import type {
    BrowserAdapterCapabilitiesV1,
    BrowserCommandV1,
    BrowserEventV1,
    BrowserViewTargetV1,
} from '@happier-dev/protocol';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import {
    applyBrowserControlEvent,
    createBrowserControlState,
    type BrowserControlState,
} from '@/sync/domains/browser/control';
import { clearBrowserRuntimeControlRegistryForTests } from '@/sync/domains/browser/actions/runtimeControlRegistry';
import { createDefaultRuntimeActionExecutor } from '@/sync/ops/actions/defaultRuntimeActionExecutor';
import { BrowserSurfaceHost } from './BrowserSurfaceHost';

vi.mock('@/hooks/server/useFeatureDecision', () => ({
    useFeatureDecision: () => ({ state: 'enabled' }),
}));

vi.mock('@/components/browser/BrowserShell', async () => {
    const ReactModule = await import('react');
    return {
        BrowserShell: (props: Record<string, unknown>) => ReactModule.createElement('BrowserShellMock', {
            ...props,
            testID: props.testID ?? 'browser-shell',
        }),
    };
});

vi.mock('./BrowserPluginSurfacePlacements', () => ({
    BrowserPluginSurfacePlacements: () => null,
}));

const target = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
    display: {
        title: 'Preview',
        addressLabel: 'localhost:5173',
    },
} satisfies BrowserViewTargetV1;

function stateFromEvents(events: readonly BrowserEventV1[]): BrowserControlState {
    return events.reduce(
        (nextState, event) => applyBrowserControlEvent(nextState, event),
        createBrowserControlState(),
    );
}

function openViewState(input: Readonly<{
    browserSessionId: string;
    viewId: string;
    target: BrowserViewTargetV1;
    capabilities: BrowserAdapterCapabilitiesV1;
    currentUrl: string;
}>): BrowserControlState {
    return stateFromEvents([{
        kind: 'sessionCreated',
        eventId: 'event_session',
        browserSessionId: input.browserSessionId,
        profileId: 'profile_1',
        occurredAt: 1_000,
    }, {
        kind: 'viewOpened',
        eventId: 'event_view',
        browserSessionId: input.browserSessionId,
        viewId: input.viewId,
        target: input.target,
        platform: 'web',
        currentUrl: input.currentUrl,
        adapterKind: 'localPreview',
        engineKind: 'webIframe',
        adapterCapabilities: input.capabilities,
        occurredAt: 1_001,
    }, {
        kind: 'viewFocused',
        eventId: 'event_focus',
        browserSessionId: input.browserSessionId,
        viewId: input.viewId,
        occurredAt: 1_002,
    }]);
}

describe('BrowserSurfaceHost runtime control registration', () => {
    afterEach(() => {
        clearBrowserRuntimeControlRegistryForTests();
    });

    it('registers its control adapter so browser.navigate can execute through the default runtime bridge', async () => {
        const browserSessionId = 'browser_session_surface';
        const viewId = 'view_surface';
        const initialBrowserState = openViewState({
            browserSessionId,
            viewId,
            target,
            currentUrl: 'https://preview.happier.test/',
            capabilities: {
                ...buildBrowserAdapterCapabilities({
                    adapterKind: 'localPreview',
                    supportedTargetKinds: ['localServicePreview'],
                    supportedRenderEngines: ['webIframe'],
                }),
                navigation: {
                    canNavigate: true,
                    canGoBack: false,
                    canGoForward: false,
                    canReload: true,
                    canStop: true,
                },
            },
        });
        const screen = await renderScreen(
            <BrowserSurfaceHost
                browserSessionId={browserSessionId}
                platform="web"
                initialBrowserState={initialBrowserState}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                    automationEnabled: false,
                    recordingEnabled: false,
                }}
                testID="browser-surface"
            />,
        );
        await flushHookEffects();

        const execute = createDefaultRuntimeActionExecutor();
        let result: unknown;
        const command = {
            kind: 'navigate',
            commandId: 'command_surface_navigate',
            browserSessionId,
            viewId,
            url: 'https://preview.happier.test/surface',
        } satisfies BrowserCommandV1;
        await act(async () => {
            result = await execute({
                actionId: 'browser.navigate',
                input: command,
                context: {},
            });
        });
        await flushHookEffects();

        expect(result).toMatchObject({
            v: 1,
            actionId: 'browser.navigate',
            status: 'accepted',
        });
        const shell = screen.findByTestId('browser-surface');
        expect(shell?.props.state.viewsById[viewId]?.pendingUrl).toBe('https://preview.happier.test/surface');
    });

    it('A3: routes a daemon-authoritative navigate through the supplied sendDaemonCommand seam (no route_unavailable)', async () => {
        const browserSessionId = 'browser_session_sidecar';
        const viewId = 'view_sidecar';
        const externalTarget = {
            kind: 'externalUrl',
            targetId: 'external_1',
            url: 'https://browser.example.test/start',
            display: { title: 'Browser', addressLabel: 'browser.example.test' },
        } satisfies BrowserViewTargetV1;
        const sidecarCapabilities = {
            ...buildBrowserAdapterCapabilities({
                adapterKind: 'chromiumSidecar',
                supportedTargetKinds: ['externalUrl'],
                supportedRenderEngines: ['desktopWebView'],
            }),
            navigation: {
                canNavigate: true,
                canGoBack: true,
                canGoForward: true,
                canReload: true,
                canStop: true,
            },
        } satisfies BrowserAdapterCapabilitiesV1;
        const initialBrowserState = stateFromEvents([{
            kind: 'sessionCreated',
            eventId: 'event_session',
            browserSessionId,
            profileId: 'profile_1',
            occurredAt: 1_000,
        }, {
            kind: 'viewOpened',
            eventId: 'event_view',
            browserSessionId,
            viewId,
            target: externalTarget,
            platform: 'desktop',
            currentUrl: 'https://browser.example.test/start',
            adapterKind: 'chromiumSidecar',
            engineKind: 'desktopWebView',
            adapterCapabilities: sidecarCapabilities,
            occurredAt: 1_001,
        }, {
            kind: 'viewFocused',
            eventId: 'event_focus',
            browserSessionId,
            viewId,
            occurredAt: 1_002,
        }]);

        const sendDaemonCommand = vi.fn();
        await renderScreen(
            <BrowserSurfaceHost
                browserSessionId={browserSessionId}
                platform="desktop"
                initialBrowserState={initialBrowserState}
                sendDaemonCommand={sendDaemonCommand}
                policy={{
                    browserEnabled: true,
                    viewTargetsEnabled: true,
                    diagnosticsEnabled: false,
                    contextEnabled: false,
                    automationEnabled: false,
                    recordingEnabled: false,
                }}
                testID="browser-surface"
            />,
        );
        await flushHookEffects();

        const execute = createDefaultRuntimeActionExecutor();
        const command = {
            kind: 'navigate',
            commandId: 'command_sidecar_navigate',
            browserSessionId,
            viewId,
            url: 'https://browser.example.test/next',
        } satisfies BrowserCommandV1;
        let result: unknown;
        await act(async () => {
            result = await execute({ actionId: 'browser.navigate', input: command, context: {} });
        });
        await flushHookEffects();

        expect(result).toMatchObject({ v: 1, actionId: 'browser.navigate', status: 'accepted' });
        expect(result).not.toMatchObject({ error: 'runtime_action_disabled:browser:browser_control_route_unavailable' });
        expect(sendDaemonCommand).toHaveBeenCalledWith(command);
    });
});
