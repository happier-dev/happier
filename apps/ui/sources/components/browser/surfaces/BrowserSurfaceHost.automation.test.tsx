import * as React from 'react';
import type {
    BrowserAdapterCapabilitiesV1} from '@happier-dev/protocol/browser/adapters/v1';
import type {
    BrowserEventV1} from '@happier-dev/protocol/browser/events/v1';
import type {
    BrowserViewTargetV1,
} from '@happier-dev/protocol/browser/target/v1';
import { AccountProfileSchema } from '@happier-dev/protocol/account/profile';
import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { flushHookEffects, renderScreen, standardCleanup } from '@/dev/testkit';
import { createPlainAccountEncryptionCurrentnessFixture } from '@/dev/testkit/fixtures/accountEncryptionCurrentness';
import { createRootLayoutFeaturesResponse } from '@/dev/testkit/fixtures/featureFixtures';
import { initializeAuthRouteRuntimeForTests } from '@/dev/testkit/harness/authRouteRuntimeHarness';
import { restoreServerAccountForTest } from '@/dev/testkit/harness/serverAccountConnectionHarness';
import { buildBrowserAdapterCapabilities } from '@/sync/domains/browser/adapters/capabilities';
import {
    applyBrowserControlEvent,
    createBrowserControlState,
    type BrowserControlState,
} from '@/sync/domains/browser/control';
import { clearBrowserRuntimeControlRegistryForTests } from '@/sync/domains/browser/actions/runtimeControlRegistry';
import type { BrowserAutomationControlService } from '@/sync/domains/browser/automation';
import { createDefaultRuntimeActionExecutor } from '@/sync/ops/actions/defaultRuntimeActionExecutor';
import { BrowserSurfaceHost } from './BrowserSurfaceHost';
import { apiSocket } from '@/sync/api/session/apiSocket';
import { uiBrowserAutomationDispatchMethod } from '@happier-dev/protocol/browser/automation/reverseDispatchV1';

// Static browser imports reach Socket consumers; retain the canonical network boundary.
vi.mock('socket.io-client', async (importOriginal) =>
    (await import('@/dev/testkit/harness/serverAccountConnectionHarness')).createSocketIoClientBoundary(importOriginal));

await initializeAuthRouteRuntimeForTests();

let connection: Awaited<ReturnType<typeof restoreServerAccountForTest>> | undefined;
beforeEach(async () => {
    connection = await restoreServerAccountForTest({
        serverUrl: 'https://browser-automation-home.example.test',
        serverIdentityId: 'srv_browser_automation',
        request: async (input) => {
            const path = new URL(String(input)).pathname;
            if (path === '/v1/account/encryption') return Response.json({ mode: 'plain', updatedAt: 1 });
            if (path === '/v1/account/encryption/currentness') return Response.json(createPlainAccountEncryptionCurrentnessFixture());
            // Mounted Browser dispatch is fenced by the hydrated Account content lifetime.
            if (path === '/v1/account/profile') return Response.json({ profile: AccountProfileSchema.parse({ id: 'account-a' }) });
            if (path === '/v1/features') return Response.json(createRootLayoutFeaturesResponse({
                features: { browser: { enabled: true, internal: { enabled: true }, automation: { enabled: true }, viewTargets: { enabled: true } } },
            }));
            return null;
        },
    });
});

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
    capabilities: BrowserAdapterCapabilitiesV1;
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
        target,
        platform: 'web',
        currentUrl: 'https://preview.happier.test/',
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

const browserSessionId = 'browser_session_automation';
const viewId = 'view_automation';

function renderHost(automationEnabled: boolean, machineId?: string) {
    return renderScreen(
        <BrowserSurfaceHost
            browserSessionId={browserSessionId}
            platform="web"
            pluginBrowserActionContext={machineId ? { machineId, sessionId: 'session_1' } : undefined}
            initialBrowserState={openViewState({
                browserSessionId,
                viewId,
                capabilities: buildBrowserAdapterCapabilities({
                    adapterKind: 'localPreview',
                    supportedTargetKinds: ['localServicePreview'],
                    supportedRenderEngines: ['webIframe'],
                }),
            })}
            policy={{
                browserEnabled: true,
                viewTargetsEnabled: true,
                diagnosticsEnabled: false,
                contextEnabled: false,
                automationEnabled,
                recordingEnabled: false,
            }}
            testID="browser-surface"
        />,
    );
}

describe('BrowserSurfaceHost in-app automation control service wiring', () => {
    afterEach(async () => {
        await standardCleanup();
        await connection?.dispose();
        clearBrowserRuntimeControlRegistryForTests();
        vi.restoreAllMocks();
    });

    it('mounts the exact machine reverse room and executes through the mounted controller until unmount', async () => {
        // Machine RPC registration is the network boundary; the installer/handler/controller stay real.
        const registration = vi.spyOn(apiSocket, 'registerMachineScopedRpcHandler');
        const screen = await renderHost(true, 'machine_1');
        await flushHookEffects();
        const call = registration.mock.calls.find(([, method]) => method === uiBrowserAutomationDispatchMethod({ browserSessionId, viewId }));
        expect(call).toBeTruthy();
        const handler = call![2];
        const request = { v: 1, actionId: 'browser.automation.cancelActive', input: { browserSessionId, viewId }, authority: 'present_user', sessionId: 'session_1' };
        expect(await handler(request)).toMatchObject({ outcome: 'no_active', canceledCount: 0 });
        expect(await handler({ ...request, sessionId: 'another-session' })).toMatchObject({ ok: false });
        await screen.unmount();
        expect(await handler(request)).toMatchObject({ errorCode: 'runtime_action_disabled' });
    });

    it('constructs an in-app control service and threads it into the shell when browser.automation is enabled', async () => {
        const screen = await renderHost(true);
        await flushHookEffects();

        const shell = screen.findByTestId('browser-surface');
        const automation = shell?.props.browserAutomation as
            | Readonly<{ controlService?: BrowserAutomationControlService }>
            | null
            | undefined;
        expect(automation).toBeTruthy();
        expect(typeof automation?.controlService?.executeAction).toBe('function');
        expect(typeof automation?.controlService?.registerOwner).toBe('function');
    });

    it('does not construct or thread a control service when browser.automation is disabled (fail-closed)', async () => {
        const screen = await renderHost(false);
        await flushHookEffects();

        const shell = screen.findByTestId('browser-surface');
        expect(shell?.props.browserAutomation ?? null).toBeNull();
    });

    it('exposes the in-app control service to the agent action path when enabled', async () => {
        await renderHost(true);
        await flushHookEffects();

        const execute = createDefaultRuntimeActionExecutor();
        let result: unknown;
        await act(async () => {
            result = await execute({
                actionId: 'browser.automation.cancelActive',
                input: { browserSessionId, viewId },
                context: { authority: 'present_user' },
            });
        });
        await flushHookEffects();

        expect(result).toMatchObject({
            v: 1,
            outcome: 'no_active',
            canceledCount: 0,
        });
    });

    it('fails the agent automation action closed when browser.automation is disabled', async () => {
        await renderHost(false);
        await flushHookEffects();

        const execute = createDefaultRuntimeActionExecutor();
        let result: unknown;
        await act(async () => {
            result = await execute({
                actionId: 'browser.automation.cancelActive',
                input: { browserSessionId, viewId },
                context: { authority: 'present_user' },
            });
        });
        await flushHookEffects();

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'runtime_action_disabled',
        });
    });
});
