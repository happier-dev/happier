import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import type { BrowserLocalServicePreviewTargetV1 } from '@happier-dev/protocol';

import { flushHookEffects, renderScreen } from '@/dev/testkit';
import {
    applyLocalServicePreviewSnapshot,
    createLocalServicePreviewState,
} from '@/sync/domains/local/services/preview/store';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const endpointConnectivityState = vi.hoisted(() => ({
    status: 'online' as 'online' | 'offline',
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        Platform: { OS: 'web' },
        View: (props: any) => React.createElement('View', props, props.children),
    });
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/domains/state/storage')>(),
    useEndpointStatus: () => endpointConnectivityState.status,
    useMachineCliDetectionTarget: () => ({ daemonStateVersion: 1, isOnline: true }),
}));

const focusedTarget: BrowserLocalServicePreviewTargetV1 = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
};

function createPreviewState() {
    return applyLocalServicePreviewSnapshot(createLocalServicePreviewState(), {
        generatedAt: 100,
        refreshState: 'idle',
        diagnostics: [],
        previews: [{
            previewId: 'preview_1',
            accessUrl: 'https://preview.happier.test/plugin/acme/',
            expiresAt: null,
            diagnostics: [],
            resource: {
                previewId: 'preview_1',
                sessionId: 'session_1',
                machineId: 'machine_1',
                owner: { kind: 'session', id: 'session_1' },
                target: {
                    scheme: 'https',
                    host: 'localhost',
                    port: 5173,
                },
                initialPath: { pathname: '/', search: '' },
                display: {
                    title: 'Preview',
                    addressLabel: 'localhost:5173',
                },
                originMode: 'host',
                browserTarget: focusedTarget,
            },
        }],
    });
}

const browserPanelPlacement = {
    id: 'surfacePlacement:acme.browser:hosted-panel',
    pluginId: 'acme.browser',
    contributionKind: 'surfacePlacement',
    descriptorId: 'hosted-panel',
    placement: 'browser.panel',
    target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
    renderer: { kind: 'hostedWeb', contributionId: 'panel' },
    display: { label: 'Browser panel' },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
    hostActions: [{
        actionId: 'browser.automation.snapshot',
        placement: 'browser.panel',
        scope: {
            kind: 'browserView',
            browserViewIdPath: '/browser/viewId',
            sessionIdPath: '/session/id',
            profileIdPath: '/browser/profileId',
        },
        policyOwner: 'BRW-14',
        effect: 'readOnly',
        requiredFeatureIds: ['browser.automation'],
        requiredPermissionIds: [],
    }],
} as const;

const pluginUiProjection: PluginUiProjectionModel = {
    ...EMPTY_PLUGIN_UI_PROJECTION,
    hostedWebById: {
        'hostedWeb:acme.browser:panel': {
            id: 'hostedWeb:acme.browser:panel',
            pluginId: 'acme.browser',
            contributionKind: 'hostedWeb',
            contributionId: 'panel',
            service: { kind: 'sessionEndpoint', endpointIdPath: '/endpointId' },
            entry: { routeMode: 'hostOrigin', path: '/' },
            bridge: { allowedMessages: ['requestHostAction'] },
            sandbox: { scripts: true },
            security: {},
            runtime: {
                state: 'available',
                diagnostics: [],
                decision: {
                    state: 'render',
                    reason: 'available',
                    diagnostics: [],
                },
            },
        },
    },
    surfacePlacementsById: {
        [browserPanelPlacement.id]: browserPanelPlacement,
    },
    surfacePlacementsByPlacement: {
        'browser.panel': [browserPanelPlacement],
    },
};

type LegacyGrantActionsProbe = Readonly<{
    list: ReturnType<typeof vi.fn>;
    request: ReturnType<typeof vi.fn>;
    grant: ReturnType<typeof vi.fn>;
    revoke: ReturnType<typeof vi.fn>;
    dismissRequest: ReturnType<typeof vi.fn>;
}>;

function createLegacyGrantActionsProbe(): LegacyGrantActionsProbe {
    return {
        list: vi.fn(async () => ({ grants: [], pendingRequests: [] })),
        request: vi.fn(),
        grant: vi.fn(),
        revoke: vi.fn(),
        dismissRequest: vi.fn(),
    };
}

async function dispatchHostActionRequest(params: Readonly<{
    sequence: number;
    nonce: string;
    iframeSource: WindowProxy;
    actionId: string;
}>) {
    await act(async () => {
        const event = new Event('message') as MessageEvent;
        Object.defineProperties(event, {
            origin: { value: 'https://preview.happier.test' },
            data: { value: {
                version: 1,
                pluginId: 'acme.browser',
                contributionId: 'panel',
                surfaceId: 'surfacePlacement:acme.browser:hosted-panel',
                nonce: params.nonce,
                sequence: params.sequence,
                kind: 'requestHostAction',
                payload: {
                    actionId: params.actionId,
                    input: {
                        browserSessionId: 'browser_session_1',
                        viewId: 'browser_view:preview_1',
                    },
                },
            } },
            source: { value: params.iframeSource },
        });
        (globalThis as { window: Window }).window.dispatchEvent(event);
        await Promise.resolve();
    });
}

async function withBrowserPanelHarness(
    legacyGrantActions: LegacyGrantActionsProbe,
    runtimeResult: () => unknown,
    run: (ctx: Readonly<{
        screen: Awaited<ReturnType<typeof renderScreen>>;
        iframeSource: WindowProxy;
        runtimeActionExecute: ReturnType<typeof vi.fn>;
        nonce: string;
    }>) => Promise<void>,
    options: Readonly<{
        projection?: PluginUiProjectionModel;
        isFeatureEnabled?: (featureId: string) => boolean;
        endpointStatus?: 'online' | 'offline';
    }> = {},
): Promise<void> {
    const { BrowserPluginSurfacePlacements } = await import('./BrowserPluginSurfacePlacements');
    const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
    const previousWindow = (globalThis as { window?: Window }).window;
    const runtimeActionExecute = vi.fn(async () => runtimeResult());
    endpointConnectivityState.status = options.endpointStatus ?? 'online';
    (globalThis as { window: unknown }).window = new EventTarget();

    try {
        const screen = await renderScreen(
            <BrowserPluginSurfacePlacements
                focusedTarget={focusedTarget}
                platform="desktop"
                pluginUiProjection={options.projection ?? pluginUiProjection}
                localServicePreviewState={createPreviewState()}
                localServicePreviewServerId="server_1"
                runtimeActionExecute={runtimeActionExecute as never}
                isFeatureEnabled={options.isFeatureEnabled ?? (() => true)}
                {...({ grantActions: legacyGrantActions } as Record<string, unknown>)}
            />,
            {
                createNodeMock: (element) => (
                    (element as { type?: string }).type === 'iframe'
                        ? { contentWindow: iframeSource }
                        : null
                ),
            },
        );
        // Allow hosted-frame bridge effects to settle before dispatching.
        await flushHookEffects({ cycles: 3 });
        const frame = screen.root.findByType('iframe');
        const nonce = new URL(String(frame?.props.src ?? 'https://unused.test/')).searchParams.get('happierBridgeNonce') ?? '';
        await run({ screen, iframeSource, runtimeActionExecute, nonce });
    } finally {
        endpointConnectivityState.status = 'online';
        if (previousWindow) {
            (globalThis as { window?: Window }).window = previousWindow;
        } else {
            delete (globalThis as { window?: Window }).window;
        }
    }
}

describe('BrowserPluginSurfacePlacements', () => {
    it('uses browser host feature context when filtering renderable placements', async () => {
        const gatedProjection: PluginUiProjectionModel = {
            ...pluginUiProjection,
            surfacePlacementsById: {
                [browserPanelPlacement.id]: {
                    ...browserPanelPlacement,
                    featureGate: 'plugins.ui.hostedWeb',
                },
            },
            surfacePlacementsByPlacement: {
                'browser.panel': [{
                    ...browserPanelPlacement,
                    featureGate: 'plugins.ui.hostedWeb',
                }],
            },
        };

        await withBrowserPanelHarness(
            createLegacyGrantActionsProbe(),
            () => ({ state: 'available' }),
            async ({ screen }) => {
                expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();
            },
            {
                projection: gatedProjection,
                isFeatureEnabled: (featureId) => featureId === 'plugins.ui.hostedWeb',
            },
        );
    });

    it('keeps a loaded browser-panel surface non-interactive while the endpoint is offline', async () => {
        await withBrowserPanelHarness(
            createLegacyGrantActionsProbe(),
            () => ({ state: 'available' }),
            async ({ screen, iframeSource, runtimeActionExecute, nonce }) => {
                expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();
                expect(
                    screen.findByTestId(
                        'plugin-surface-interaction-boundary:surfacePlacement:acme.browser:hosted-panel',
                    )?.props,
                ).toMatchObject({
                    inert: true,
                    'aria-hidden': true,
                });

                await dispatchHostActionRequest({
                    sequence: 2,
                    nonce,
                    iframeSource,
                    actionId: 'browser.automation.snapshot',
                });
                expect(runtimeActionExecute).not.toHaveBeenCalled();
                expect(iframeSource.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
                    kind: 'error',
                    requestSequence: 2,
                    payload: expect.objectContaining({ code: 'unavailable' }),
                }), 'https://preview.happier.test');
            },
            { endpointStatus: 'offline' },
        );
    });

    it('does not consult legacy project grants and routes declared actions through the front door', async () => {
        const legacyGrantActions = createLegacyGrantActionsProbe();
        await withBrowserPanelHarness(
            legacyGrantActions,
            () => ({ state: 'available', snapshotId: 'snapshot_1' }),
            async ({ iframeSource, runtimeActionExecute, nonce }) => {
                expect(legacyGrantActions.list).not.toHaveBeenCalled();

                await dispatchHostActionRequest({
                    sequence: 2,
                    nonce,
                    iframeSource,
                    actionId: 'browser.automation.snapshot',
                });

                // Declared action reaches the front-door executor (no direct bypass).
                expect(runtimeActionExecute).toHaveBeenCalledTimes(1);
                expect(runtimeActionExecute).toHaveBeenCalledWith(expect.objectContaining({
                    actionId: 'browser.automation.snapshot',
                    input: {
                        browserSessionId: 'browser_session_1',
                        viewId: 'browser_view:preview_1',
                    },
                    context: expect.objectContaining({ surface: 'ui', serverId: 'server_1' }),
                }));
                expect(iframeSource.postMessage).toHaveBeenCalledWith(expect.objectContaining({
                    kind: 'result',
                    requestSequence: 2,
                    payload: { state: 'available', snapshotId: 'snapshot_1' },
                }), 'https://preview.happier.test');

                await dispatchHostActionRequest({
                    sequence: 3,
                    nonce,
                    iframeSource,
                    actionId: 'browser.automation.click',
                });

                // Undeclared action never reaches the executor; fail-closed at the host-action seam.
                expect(runtimeActionExecute).toHaveBeenCalledTimes(1);
                expect(iframeSource.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
                    kind: 'result',
                    requestSequence: 3,
                    payload: expect.objectContaining({
                        state: 'unavailable',
                        reason: 'browser_panel_host_action_not_declared',
                        diagnostics: ['browser_panel_host_action_not_declared'],
                    }),
                }), 'https://preview.happier.test');
            },
        );
    });

});
