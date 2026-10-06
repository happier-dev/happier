import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
    type BrowserLocalServicePreviewTargetV1,
    type ActionExecuteResult,
    PluginProjectionInstalledPackageV2Schema,
} from '@happier-dev/protocol';
import { normalizePluginUiDestinationBindingV1 } from '@happier-dev/protocol/plugins/ui';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { initializeTerminalRouteRuntimeForTests, installTerminalRouteCommonModuleMocks } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { createMachineFixture } from '@/dev/testkit/fixtures/machineFixtures';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { adoptHomeProfile } from '@/sync/domains/server/serverProfiles';
import { storage } from '@/sync/domains/state/storageStore';
import {
    applyLocalServicePreviewSnapshot,
    createLocalServicePreviewState,
} from '@/sync/domains/local/services/preview/store';
import { EMPTY_PLUGIN_UI_PROJECTION, type PluginUiProjectionModel } from '@/sync/domains/plugins/ui/projection';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

installTerminalRouteCommonModuleMocks();
await initializeTerminalRouteRuntimeForTests();

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
    occurrenceId: 'acme-browser-occurrence',
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
        serverId: 'srv_account_one',
        generation: 9,
        phase: 'current',
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
    installedPackagesById: { 'acme.browser': PluginProjectionInstalledPackageV2Schema.parse({
        id: 'acme.browser', displayName: 'Browser panel', version: '1.0.0', enabled: true,
        source: { kind: 'localPath', locator: 'acme.browser' },
        occurrenceId: 'acme-browser-occurrence',
        sourceCustody: { kind: 'development', registeredRootId: 'browser-panel-root' },
        declaresContributionPoints: false,
    }) },
    hostedWebById: {
        'hostedWeb:acme.browser:panel': {
            id: 'hostedWeb:acme.browser:panel',
            pluginId: 'acme.browser',
            occurrenceId: 'acme-browser-occurrence',
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
    runtimeResult: () => ActionExecuteResult,
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
    storage.getState().setEndpointConnectivity({ status: options.endpointStatus ?? 'online',
        reason: null, attempt: 0, nextRetryAt: null, lastConnectedAt: Date.now(),
        lastDisconnectedAt: null, lastErrorMessage: null });
    (globalThis as { window: unknown }).window = new EventTarget();

    try {
        const screen = await renderScreen(
            <BrowserPluginSurfacePlacements
                focusedTarget={focusedTarget}
                platform="desktop"
                pluginUiProjection={options.projection ?? pluginUiProjection}
                localServicePreviewState={createPreviewState()}
                executionMachineId={options.executionMachineId ?? 'machine-admitted'}
                executionServerId={options.executionServerId ?? 'srv_account_one'}
                executionSessionId={executionSessionId}
                executeAction={executeAction}
                isFeatureEnabled={options.isFeatureEnabled ?? (() => true)}
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
        const frame = screen.root.findAllByType('iframe')[0];
        const nonce = new URL(String(frame?.props.src ?? 'https://unused.test/')).searchParams.get('happierBridgeNonce') ?? '';
        await run({ screen, iframeSource, executeAction, nonce, sessionId: executionSessionId });
    } finally {
        await standardCleanup();
        if (previousWindow) {
            (globalThis as { window?: Window }).window = previousWindow;
        } else {
            delete (globalThis as { window?: Window }).window;
        }
    }
}

let account: Awaited<ReturnType<typeof restoreServerAccountForTest>>;
beforeEach(async () => {
    const { invalidateAccountEncryptionModeCache } = await import(
        '@/sync/api/account/apiAccountEncryptionMode'
    );
    invalidateAccountEncryptionModeCache();
    const serverUrl = 'https://browser-placement.example.test';
    await adoptHomeProfile({ descriptor: { v: 1, homeServerIdentityId: 'srv_account_one',
        canonicalServerUrl: serverUrl, revision: 1, endpoints: [{ kind: 'https', url: serverUrl }] },
        source: 'qr', descriptorAuthority: 'current_connection_observation' });
    account = await restoreServerAccountForTest({ serverUrl, accountId: 'account-1', request: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        return new Response('{}', { status: 404 });
    } });
    storage.getState().applyMachines([createMachineFixture({ id: 'machine-admitted', activeAt: Date.now() })], true,
        { sourceServerId: account.home.id });
});
afterEach(async () => { await standardCleanup(); await account?.dispose(); });

describe('BrowserPluginSurfacePlacements', () => {
    it('uses browser host feature context when filtering renderable placements', async () => {
        const gatedProjection: PluginUiProjectionModel = {
            ...pluginUiProjection,
            surfacePlacementsById: {
                [browserPanelPlacement.id]: {
                    ...browserPanelPlacement,
                    availability: { ...browserPanelPlacement.availability,
                        when: { fact: 'host.feature', operator: 'enabled', value: 'plugins.ui.hostedWeb' } },
                },
            },
        };

        await withBrowserPanelHarness(
            () => ({ ok: true, result: { state: 'available' } }),
            async ({ screen }) => {
                expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();
            },
            {
                projection: gatedProjection,
                isFeatureEnabled: (featureId) => featureId === 'plugins.ui.hostedWeb',
            },
        );
        await withBrowserPanelHarness(
            () => ({ ok: true, result: { state: 'available' } }), async ({ screen }) => {
                expect(screen.findByTestId('plugin-hosted-web-frame')).toBeNull();
            }, { projection: gatedProjection, isFeatureEnabled: () => false });
    });

    it('keeps a loaded browser-panel surface non-interactive while the endpoint is offline', async () => {
        await withBrowserPanelHarness(
            () => ({ ok: true, result: { state: 'available' } }),
            async ({ screen, iframeSource, executeAction, nonce, sessionId }) => {
                expect(screen.findByTestId('plugin-hosted-web-frame')).toBeTruthy();
                expect(nonce.length).toBeGreaterThan(0);
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
            () => ({ ok: true, result: { state: 'available', snapshotId: 'snapshot_1' } }),
            async ({ iframeSource, executeAction, nonce, sessionId }) => {
                expect(nonce.length).toBeGreaterThan(0);
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
                executionServerId: 'srv_account_one',
                executionSessionId: 'session-admitted',
            },
        );
    });

});
