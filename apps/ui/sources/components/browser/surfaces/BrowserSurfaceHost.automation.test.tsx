import * as React from 'react';
import type {
    BrowserAdapterCapabilitiesV1,
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
import type { BrowserAutomationControlService } from '@/sync/domains/browser/automation';
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

function renderHost(automationEnabled: boolean) {
    return renderScreen(
        <BrowserSurfaceHost
            browserSessionId={browserSessionId}
            platform="web"
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
    afterEach(() => {
        clearBrowserRuntimeControlRegistryForTests();
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
                context: {},
            });
        });
        await flushHookEffects();

        expect(result).toMatchObject({
            v: 1,
            actionId: 'browser.automation.cancelActive',
            status: 'accepted',
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
                context: {},
            });
        });
        await flushHookEffects();

        expect(result).toMatchObject({
            ok: false,
            errorCode: 'runtime_action_disabled',
        });
    });
});
