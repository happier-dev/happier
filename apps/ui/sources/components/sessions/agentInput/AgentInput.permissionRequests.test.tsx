import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderScreen as renderPanelScreen, wrapWithSessionTranscriptSource } from '@/dev/testkit';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
            useWindowDimensions: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
        });
    },
});
const runtime = installSessionPaneRuntimeTestHarness();
const { storage } = await import('@/sync/domains/state/storageStore');
const { PermissionFooter } = await import('@/components/tools/shell/permissions/PermissionFooter');
beforeEach(() => {
    storage.setState({ settings: { ...storage.getState().settings,
        agentInputEnterToSend: true, agentInputActionBarLayout: 'wrap', agentInputChipDensity: 'labels',
        sessionPermissionModeApplyTiming: 'immediate', permissionPromptSurface: 'composer' } });
});
async function renderScreen(element: React.ReactElement) {
    return renderPanelScreen(wrapWithSessionTranscriptSource(element), { wrapper: runtime.Wrapper });
}

function flattenStyle(style: unknown): Record<string, unknown> {
    const flattened: Record<string, unknown> = {};
    const entries = Array.isArray(style) ? style : [style];
    for (const entry of entries) {
        if (entry && typeof entry === 'object') {
            Object.assign(flattened, entry);
        }
    }
    return flattened;
}

describe('AgentInput (permission requests)', () => {
    it('renders PermissionFooter when pending permission requests are provided', async () => {
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(React.createElement(AgentInput, {
            value: '',
            placeholder: 'Type',
            onChangeText: () => {},
            sessionId: 's1',
            onSend: () => {},
            maxPanelHeight: 80,
            autocompleteKinds: [],
            autocompleteSuggestions: async () => [],
            permissionRequests: [
                { id: 'req1', kind: 'permission', tool: 'Bash', arguments: { command: 'ls' }, createdAt: 123 },
            ],
        }));

        expect(screen.findAllByType(PermissionFooter)).toHaveLength(1);
        expect(screen.findAllByType(PermissionFooter)[0]?.props.permission).toMatchObject({ id: 'req1', status: 'pending' });
    });

    it('does not reserve the maximum permission height before content is measured', async () => {
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(React.createElement(AgentInput, {
            value: '',
            placeholder: 'Type',
            onChangeText: () => {},
            sessionId: 's1',
            onSend: () => {},
            autocompleteKinds: [],
            autocompleteSuggestions: async () => [],
            permissionRequests: [
                { id: 'req1', kind: 'permission', tool: 'Bash', arguments: { command: 'ls' }, createdAt: 123 },
            ],
        }));

        const scroll = screen.findByTestId('agentInput.permissionRequests.scroll');
        expect(scroll).toBeTruthy();
        const style = flattenStyle(scroll?.props.style);
        expect(style.maxHeight).toBeGreaterThan(0);
        expect(style.height).toBeUndefined();
    });

    it('does not clamp permission requests above the visible keyboard-open area', async () => {
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(React.createElement(AgentInput, {
            value: '',
            placeholder: 'Type',
            onChangeText: () => {},
            sessionId: 's1',
            onSend: () => {},
            maxPanelHeight: 80,
            autocompleteKinds: [],
            autocompleteSuggestions: async () => [],
            permissionRequests: [
                { id: 'req1', kind: 'permission', tool: 'Bash', arguments: { command: 'ls' }, createdAt: 123 },
                { id: 'req2', kind: 'permission', tool: 'Bash', arguments: { command: 'pwd' }, createdAt: 124 },
            ],
        }));

        const scroll = screen.findByTestId('agentInput.permissionRequests.scroll');
        const style = flattenStyle(scroll?.props.style);
        expect(style.maxHeight).toBeLessThanOrEqual(80);
    });
});
