// @vitest-environment jsdom
import * as React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

import { EMPTY_PLUGIN_UI_PROJECTION } from '@/sync/domains/plugins/ui/projection';
import { useHomeWidgetCandidates } from '@/components/hub/layout/useHomeWidgetCandidates';
import { useConnectedServicesAgents } from '@/components/settings/connectedServices/model/useConnectedServicesAgents';
import {
    AppShellPluginUiProjectionValueProvider,
    type AppShellPluginUiProjectionValue,
} from './AppShellPluginUiProjection';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());

/**
 * Always-mounted Home readers (the Home widget inventory and the Get set up block's connected-services
 * agents) consume the AppShell projection's declarations and placement facts only. Client-executable
 * activation is a diagnostic the AppShell republishes several times while plugins load at cold start;
 * it must not redraw these readers (iOS cold start: each such publication redrew Home's whole setup
 * block and widget section, ~600–1,150 components per publication).
 */
it('keeps Home readers quiet through executable-activation-only publications and delivers a declaration change', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const renders = { widgets: 0, agents: 0 };
    const WidgetProbe = React.memo(function WidgetProbe() {
        useHomeWidgetCandidates();
        renders.widgets += 1;
        return null;
    });
    const AgentsProbe = React.memo(function AgentsProbe() {
        useConnectedServicesAgents({ agents: 'cached' });
        renders.agents += 1;
        return null;
    });
    const value: AppShellPluginUiProjectionValue = {
        pluginUiProjection: EMPTY_PLUGIN_UI_PROJECTION, pluginBrowserProjection: null,
        phase: 'current', interactionEnabled: true, machineId: null, serverId: null,
        platform: 'web', accountLifetime: null,
        reloadConnectedAccountProjection: () => {}, clientExecutableActivation: { status: 'establishing' },
        reloadClientExecutables: () => {},
    };
    const render = async (next: AppShellPluginUiProjectionValue) => {
        await act(async () => root.render(
            <AppShellPluginUiProjectionValueProvider value={next}><WidgetProbe /><AgentsProbe /></AppShellPluginUiProjectionValueProvider>,
        ));
    };
    try {
        await render(value);
        renders.widgets = 0;
        renders.agents = 0;
        for (const status of ['establishing', 'ready', 'establishing', 'ready'] as const) {
            await render({ ...value, clientExecutableActivation: { status } });
        }
        expect(renders).toEqual({ widgets: 0, agents: 0 });
        await render({ ...value, pluginUiProjection: { ...EMPTY_PLUGIN_UI_PROJECTION, generation: 2 }, machineId: 'machine-a' });
        expect(renders.widgets).toBe(1);
        expect(renders.agents).toBeGreaterThan(0);
    } finally {
        await act(async () => root.unmount());
        container.remove();
    }
});
