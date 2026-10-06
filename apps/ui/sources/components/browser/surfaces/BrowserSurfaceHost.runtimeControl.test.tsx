import * as React from 'react';
import {
    BrowserEventV1Schema,
    type BrowserAdapterCapabilitiesV1,
    type BrowserCommandV1,
    type BrowserEventV1,
    type BrowserViewTargetV1,
} from '@happier-dev/protocol';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDeferred, flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { initializeTerminalRouteRuntimeForTests, installTerminalRouteCommonModuleMocks } from '@/__tests__/routes/(app)/terminal/terminalRouteTestHelpers';
import type { BrowserDaemonControlCommandSender } from '@/sync/domains/browser/control/machineRpc';
import { BrowserShell } from '@/components/browser/BrowserShell';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import {
    applyBrowserControlEvent,
    createBrowserControlState,
    type BrowserControlState,
} from '@/sync/domains/browser/control';
import { clearBrowserRuntimeControlRegistryForTests } from '@/sync/domains/browser/actions/runtimeControlRegistry';
import { createDefaultRuntimeActionExecutor } from '@/sync/ops/actions/defaultRuntimeActionExecutor';
import { BrowserSurfaceHost } from './BrowserSurfaceHost';

installTerminalRouteCommonModuleMocks();
await initializeTerminalRouteRuntimeForTests();

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
beforeEach(async () => {
    connection = await restoreServerAccountForTest({ serverUrl: 'https://browser-control-home.example.test', request: async (input) => {
        const path = new URL(String(input)).pathname;
        if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
        if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
        if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({ features: { browser: { enabled: true, viewTargets: { enabled: true } } } }));
        return new Response('{}', { status: 404 });
    } });
});

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
    afterEach(async () => {
        await standardCleanup();
        await connection?.dispose();
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
            commandId: 'command_surface_navigate',
            status: 'dispatched',
            adapterKind: 'localPreview',
            events: [],
        });
        const shell = screen.findByType(BrowserShell);
        expect(shell?.props.state.viewsById[viewId]?.pendingUrl).toBe('https://preview.happier.test/surface');
        expect(screen.findByType('iframe').props.src).toBe('https://preview.happier.test/surface');
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

        const daemonReply = createDeferred<void>();
        const sendDaemonCommand = vi.fn<BrowserDaemonControlCommandSender>(async (command, onEvents) => {
            // The real sender awaits its daemon RPC before publishing response
            // events; hold that external reply until local dispatch has settled.
            await daemonReply.promise;
            const events = [BrowserEventV1Schema.parse({ kind: 'navigationCommitted', eventId: 'event_committed',
                browserSessionId, viewId, currentUrl: command.kind === 'navigate' ? command.url : '', occurredAt: 1_003 })];
            onEvents?.(events);
            return { ok: true, result: { v: 1, commandId: command.commandId, status: 'dispatched', adapterKind: 'chromiumSidecar', events } };
        });
        const screen = await renderScreen(
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

        expect(result).toMatchObject({
            v: 1,
            commandId: 'command_sidecar_navigate',
            status: 'dispatched',
            adapterKind: 'chromiumSidecar',
            events: [],
        });
        expect(result).not.toMatchObject({ error: 'runtime_action_disabled:browser:browser_control_route_unavailable' });
        expect(sendDaemonCommand).toHaveBeenCalledWith(command, expect.any(Function));
        expect(screen.findByType(BrowserShell).props.state.viewsById[viewId]?.currentUrl).toBe('https://browser.example.test/start');
        await act(async () => {
            daemonReply.resolve();
            await sendDaemonCommand.mock.results[0]?.value;
        });
        await flushHookEffects();
        expect(screen.findByType(BrowserShell).props.state.viewsById[viewId]).toMatchObject({
            currentUrl: 'https://browser.example.test/next', pendingUrl: null,
        });
        expect(screen.findByTestId('browser-surface-address')?.props.value).toBe('browser.example.test/next');
    });
});
