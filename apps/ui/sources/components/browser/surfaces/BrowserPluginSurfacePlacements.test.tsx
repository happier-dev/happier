import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    type BrowserLocalServicePreviewTargetV1,
} from '@happier-dev/protocol';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

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

const pluginSurfaceAccountLifetime = vi.hoisted(() => Object.freeze({
    scope: Object.freeze({ serverId: 'server-1', accountId: 'account-1' }),
    isCurrent: () => true,
    onRetire: () => Object.freeze({ dispose: () => {} }),
}));

const accountEncryptionModeCredentials = vi.hoisted(() => ({
    value: { token: 'browser-placement-account-mode-test-token' } as Readonly<{ token: string }> | null,
}));
const accountEncryptionModeFetch = vi.hoisted(() => vi.fn<
    typeof import('@/sync/api/account/apiAccountEncryptionMode').fetchAccountEncryptionMode
>());

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

vi.mock('@/sync/domains/scope/activeServerAccountScope', () => ({
    captureActiveServerAccountScopeLifetime: () => pluginSurfaceAccountLifetime,
}));

vi.mock('@/sync/api/account/apiAccountEncryptionMode', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/api/account/apiAccountEncryptionMode')>();
    return {
        ...original,
        fetchAccountEncryptionMode: (...args: Parameters<typeof original.fetchAccountEncryptionMode>) => (
            accountEncryptionModeFetch(...args)
        ),
    };
});

vi.mock('@/sync/sync', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/sync')>();
    return {
        ...original,
        sync: new Proxy(original.sync, {
            get(target, property) {
                if (property === 'getCredentials') {
                    return () => accountEncryptionModeCredentials.value;
                }
                const value = Reflect.get(target, property, target);
                return typeof value === 'function' ? value.bind(target) : value;
            },
        }),
    };
});

const focusedTarget: BrowserLocalServicePreviewTargetV1 = {
    kind: 'localServicePreview',
    targetId: 'preview_1',
    sessionId: 'session_1',
    machineId: 'machine_1',
};

const browserPanelBinding = normalizePluginUiDestinationBindingV1({
    pluginId: 'acme.browser',
    destinationId: 'hosted-panel',
    rendererId: 'panel',
    container: 'browserPanel',
    target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
});
if (!browserPanelBinding) throw new Error('Browser panel binding fixture is required');

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
    binding: browserPanelBinding,
    target: { kind: 'browser', browserViewIdPath: '/browser/viewId' },
    renderer: { kind: 'hostedWeb', contributionId: 'panel' },
    display: { label: 'Browser panel' },
    availability: { state: 'available', reason: 'available', diagnostics: [] },
    headerActions: [],
    // The Browser target is `machine_1`, but effects must use this exact
    // producer materialization. The controller rejects a plugin caller without
    // it rather than downgrading to a host presentation action.
    hostOrigin: {
        machineId: 'machine-admitted',
        serverId: 'server-admitted',
        generation: 9,
        interactionEnabled: true,
        executionOrigin: {
            serverIdentityId: 'srv_account_one',
            materializationRef: {
                pluginId: 'acme.browser',
                machineId: 'machine-admitted',
                materializationId: 'browser-panel-install-a',
            },
        },
    },
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
            bridge: { allowedMessages: ['hostApi'] },
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

/**
 * Post the predecessor outer host-method envelope. The direct cut admits Host
 * API traffic only inside `kind: 'hostApi'`, so this raw form must not reach
 * the mounted action dispatcher.
 */
async function dispatchPredecessorExecuteActionEnvelope(params: Readonly<{
    sequence: number;
    nonce: string;
    iframeSource: WindowProxy;
    action: string;
    sessionId?: string | null;
}>) {
    await act(async () => {
        const event = new Event('message') as MessageEvent;
        Object.defineProperties(event, {
            origin: { value: 'https://preview.happier.test' },
            data: { value: {
                version: 1,
                pluginId: 'acme.browser',
                // The guest echoes the identity the host wrote into the frame
                // query: the bound controller's surface context, whose
                // `contributionId` is the DECLARING placement, not the renderer.
                contributionId: 'hosted-panel',
                surfaceId: 'surfacePlacement:acme.browser:hosted-panel',
                ...(params.sessionId ? { sessionId: params.sessionId } : {}),
                nonce: params.nonce,
                sequence: params.sequence,
                kind: 'executeAction',
                payload: {
                    action: params.action,
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
        executeAction: ReturnType<typeof vi.fn>;
        nonce: string;
        sessionId: string;
    }>) => Promise<void>,
    options: Readonly<{
        projection?: PluginUiProjectionModel;
        isFeatureEnabled?: (featureId: string) => boolean;
        endpointStatus?: 'online' | 'offline';
        executionMachineId?: string | null;
        executionServerId?: string | null;
        executionSessionId?: string | null;
    }> = {},
): Promise<void> {
    const { BrowserPluginSurfacePlacements } = await import('./BrowserPluginSurfacePlacements');
    const iframeSource = { postMessage: vi.fn() } as unknown as WindowProxy;
    const previousWindow = (globalThis as { window?: Window }).window;
    const executeAction = vi.fn(async () => runtimeResult());
    const executionSessionId = options.executionSessionId ?? 'session_1';
    endpointConnectivityState.status = options.endpointStatus ?? 'online';
    (globalThis as { window: unknown }).window = new EventTarget();

    try {
        const screen = await renderScreen(
            <BrowserPluginSurfacePlacements
                focusedTarget={focusedTarget}
                platform="desktop"
                pluginUiProjection={options.projection ?? pluginUiProjection}
                localServicePreviewState={createPreviewState()}
                executionMachineId={options.executionMachineId ?? 'machine_1'}
                executionServerId={options.executionServerId ?? 'server_1'}
                executionSessionId={executionSessionId}
                executeAction={executeAction as never}
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
        await run({ screen, iframeSource, executeAction, nonce, sessionId: executionSessionId });
    } finally {
        endpointConnectivityState.status = 'online';
        if (previousWindow) {
            (globalThis as { window?: Window }).window = previousWindow;
        } else {
            delete (globalThis as { window?: Window }).window;
        }
    }
}

beforeEach(async () => {
    endpointConnectivityState.status = 'online';
    accountEncryptionModeCredentials.value = { token: 'browser-placement-account-mode-test-token' };
    accountEncryptionModeFetch.mockReset();
    accountEncryptionModeFetch.mockResolvedValue({ mode: 'plain', updatedAt: 1 });
    const { invalidateAccountEncryptionModeCache } = await import(
        '@/sync/api/account/apiAccountEncryptionMode'
    );
    invalidateAccountEncryptionModeCache();
});

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
            async ({ screen, iframeSource, executeAction, nonce, sessionId }) => {
                expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();
                // `inert`/`aria-hidden` are owned by the snapshot node inside the
                // boundary, not by the boundary wrapper itself.
                expect(
                    screen.findByTestId(
                        'plugin-surface-snapshot:surfacePlacement:acme.browser:hosted-panel',
                    )?.props,
                ).toMatchObject({
                    inert: true,
                    'aria-hidden': true,
                });

                await dispatchPredecessorExecuteActionEnvelope({
                    sequence: 2,
                    nonce,
                    iframeSource,
                    action: 'browser.navigate',
                    sessionId,
                });
                expect(executeAction).not.toHaveBeenCalled();
                expect(iframeSource.postMessage).not.toHaveBeenCalled();
            },
            { endpointStatus: 'offline' },
        );
    });

    it('rejects a predecessor direct browser-panel action envelope', async () => {
        await withBrowserPanelHarness(
            createLegacyGrantActionsProbe(),
            () => ({ ok: true, result: { state: 'available', snapshotId: 'snapshot_1' } }),
            async ({ iframeSource, executeAction, nonce, sessionId }) => {
                await dispatchPredecessorExecuteActionEnvelope({
                    sequence: 2,
                    nonce,
                    iframeSource,
                    action: 'browser.navigate',
                    sessionId,
                });
                expect(executeAction).not.toHaveBeenCalled();
                expect(iframeSource.postMessage).not.toHaveBeenCalled();
            },
            {
                executionMachineId: 'machine-admitted',
                executionServerId: 'server-admitted',
                executionSessionId: 'session-admitted',
            },
        );
    });

});
