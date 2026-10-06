import React from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReactTestRendererJSON } from 'react-test-renderer';
import { renderScreen as renderPanelScreen } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storageStore';
import { installSessionPaneRuntimeTestHarness } from '@/components/sessions/panes/sessionPaneRuntimeTestHarness';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' });
    },
});
const runtime = installSessionPaneRuntimeTestHarness();
beforeEach(() => {
    storage.setState({ settings: { ...storage.getState().settings,
        agentInputEnterToSend: true, agentInputActionBarLayout: 'wrap', agentInputChipDensity: 'labels',
        sessionPermissionModeApplyTiming: 'immediate' } });
});
async function renderScreen(element: React.ReactElement) {
    return renderPanelScreen(element, { wrapper: runtime.Wrapper });
}
function flattenJson(
    node: ReactTestRendererJSON | ReactTestRendererJSON[] | string | number | null,
    out: ReactTestRendererJSON[] = [],
): ReactTestRendererJSON[] {
    if (node === null || typeof node === 'string' || typeof node === 'number') return out;
    if (Array.isArray(node)) {
        for (const entry of node) flattenJson(entry, out);
    } else {
        out.push(node);
        for (const child of node.children ?? []) flattenJson(child, out);
    }
    return out;
}

describe('AgentInput (chip ordering)', () => {
    it('keeps the engine controls grouped ahead of permission in wrap layout', async () => {
        const { AgentInput } = await import('./AgentInput');

        const tree = (await renderScreen(React.createElement(AgentInput, {
                    value: '',
                    placeholder: 'placeholder',
                    onChangeText: () => {},
                    onSend: () => {},
                    autocompleteKinds: [],
                    autocompleteSuggestions: async () => [],
                    onPermissionClick: () => {},
                    agentType: 'codex',
                    onAgentClick: () => {},
                    onAcpSessionModeChange: () => {},
                    acpSessionModeOptionsOverride: [{ id: 'plan', name: 'Plan' }],
                }))).tree;

        const allNodes = flattenJson(tree.toJSON());
        const pressables = allNodes.filter((n) => n.type === 'Pressable');

        const permissionIndex = pressables.findIndex((n) => n.props?.testID === 'agent-input-permission-chip');
        const agentIndex = pressables.findIndex((n) => n.props?.testID === 'agent-input-agent-chip');
        const modeIndex = pressables.findIndex((n) => n.props?.testID === 'agent-input-session-mode-chip');

        expect(permissionIndex).toBeGreaterThanOrEqual(0);
        expect(agentIndex).toBeGreaterThanOrEqual(0);
        expect(modeIndex).toBeGreaterThanOrEqual(0);
        expect(agentIndex).toBeLessThan(modeIndex);
        expect(modeIndex).toBeLessThan(permissionIndex);
    }, 90_000);

    it('keeps machine on the secondary wrap row before path/resume, with the trailing cluster read last', async () => {
        const { AgentInput } = await import('./AgentInput');

        const tree = (await renderScreen(React.createElement(AgentInput, {
                    value: '',
                    placeholder: 'placeholder',
                    onChangeText: () => {},
                    onSend: () => {},
                    autocompleteKinds: [],
                    autocompleteSuggestions: async () => [],
                    onMachineClick: () => {},
                    machineName: 'Local dev machine',
                    onPathClick: () => {},
                    currentPath: '/workspace/app',
                    onResumeClick: () => {},
                    resumeSessionId: 'session-1',
                }))).tree;

        const allNodes = flattenJson(tree.toJSON());
        const sendIndex = allNodes.findIndex((node) => node.props?.testID === 'new-session-composer-send');
        const wrapRowIndex = allNodes.findIndex((node) => node.props?.testID === 'agentInput-pathResumeRow');
        const machineIndex = allNodes.findIndex((node) => node.props?.testID === 'agent-input-machine-chip');
        const pathIndex = allNodes.findIndex((node) => node.props?.testID === 'agent-input-path-chip');

        // Machine belongs to the wrapped second row, ahead of path and resume.
        expect(wrapRowIndex).toBeGreaterThanOrEqual(0);
        expect(machineIndex).toBeGreaterThan(wrapRowIndex);
        expect(pathIndex).toBeGreaterThan(machineIndex);
        // The trailing cluster is the chip column's sibling and stands beside
        // *both* rows, so it reads after the whole column rather than splitting
        // it — the same order the eye takes: options first, then the action.
        expect(sendIndex).toBeGreaterThan(pathIndex);
    }, 90_000);

    it('keeps recipient ahead of delivery in the primary wrap row', async () => {
        const { AgentInput } = await import('./AgentInput');

        const tree = (await renderScreen(React.createElement(AgentInput, {
                    value: '',
                    placeholder: 'placeholder',
                    onChangeText: () => {},
                    onSend: () => {},
                    autocompleteKinds: [],
                    autocompleteSuggestions: async () => [],
                    onPermissionClick: () => {},
                    extraActionChips: [
                        {
                            key: 'participants-recipient',
                            controlId: 'recipient',
                            collapsedOptionsPopover: {
                                title: 'session.participants.sendToTitle',
                                options: [{ id: 'lead', label: 'Lead' }],
                                selectedOptionId: 'lead',
                                onSelect: () => {},
                            },
                            render: () => React.createElement('Pressable', { testID: 'agent-input-recipient-chip' }),
                        },
                        {
                            key: 'execution-run-delivery',
                            controlId: 'delivery',
                            collapsedOptionsPopover: {
                                title: 'runs.delivery.title',
                                options: [{ id: 'interrupt', label: 'Interrupt' }],
                                selectedOptionId: 'interrupt',
                                onSelect: () => {},
                            },
                            render: () => React.createElement('Pressable', { testID: 'agent-input-delivery-chip' }),
                        },
                    ],
                }))).tree;

        const allNodes = flattenJson(tree.toJSON());
        const permissionIndex = allNodes.findIndex((node) => node.props?.testID === 'agent-input-permission-chip');
        const recipientIndex = allNodes.findIndex((node) => node.props?.testID === 'agent-input-recipient-chip');
        const deliveryIndex = allNodes.findIndex((node) => node.props?.testID === 'agent-input-delivery-chip');

        expect(permissionIndex).toBeGreaterThanOrEqual(0);
        expect(recipientIndex).toBeGreaterThan(permissionIndex);
        expect(deliveryIndex).toBeGreaterThan(recipientIndex);
    }, 90_000);

});
