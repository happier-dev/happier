import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                OS: 'ios',
                select: (v: any) => v?.ios ?? v?.default ?? v?.web ?? v?.native ?? v?.android,
            },
        });
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => {
                if (key === 'profiles') return [];
                if (key === 'agentInputEnterToSend') return true;
                if (key === 'agentInputActionBarLayout') return 'wrap';
                if (key === 'agentInputChipDensity') return 'labels';
                if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
                return null;
            },
            useSettings: () => ({
                profiles: [],
                agentInputEnterToSend: true,
                agentInputActionBarLayout: 'wrap',
                agentInputChipDensity: 'labels',
                sessionPermissionModeApplyTiming: 'immediate',
            }),
            useSessionMessagesById: () => ({}),
            useSessionMessagesVersion: () => 0,
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionMessagesReducerState: () => null,
        });
    },
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/hooks/session/useUserMessageHistory', () => ({
    useUserMessageHistory: () => ({ reset: () => {}, moveUp: () => {}, moveDown: () => {}, setText: () => {} }),
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex', 'claude', 'opencode', 'gemini'],
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ displayNameKey: 'agents.codex', toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/sync/domains/models/modelOptions', () => ({
    getModelOptionsForSession: () => [{ value: 'default', label: 'Default' }],
    supportsFreeformModelSelectionForSession: () => false,
}));

vi.mock('@/sync/domains/models/describeEffectiveModelMode', () => ({
    describeEffectiveModelMode: () => ({ effectiveModelId: 'default' }),
}));

vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
    getPermissionModeBadgeLabelForAgentType: () => 'Default',
    getPermissionModeLabelForAgentType: () => 'Default',
    getPermissionModeOptionsForSession: () => [{ value: 'default', label: 'Default' }],
    getPermissionModeTitleForAgentType: () => 'Permissions',
}));

vi.mock('@/sync/domains/permissions/describeEffectivePermissionMode', () => ({
    describeEffectivePermissionMode: () => ({ effectiveMode: 'default' }),
}));

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: (props: Record<string, unknown>) => React.createElement('MultiTextInput', props, null),
}));

vi.mock('@/components/ui/forms/Switch', () => ({
    Switch: (props: Record<string, unknown>) => React.createElement('Switch', props, null),
}));

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: () => {},
    hapticsError: () => {},
}));

vi.mock('@/components/ui/feedback/Shaker', () => ({
    Shaker: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: () => null,
}));

vi.mock('@/components/autocomplete/useActiveWord', () => ({
    useActiveWord: () => ({ word: '', start: 0, end: 0 }),
}));

vi.mock('@/components/autocomplete/useActiveSuggestions', () => ({
    useActiveSuggestions: () => [[], 0, () => {}, () => {}],
}));

vi.mock('@/components/autocomplete/applySuggestion', () => ({
    applySuggestion: (text: string) => ({ text, cursorPosition: text.length }),
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: () => null,
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: () => null,
}));

vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
    useScrollEdgeFades: () => ({
        canScrollX: false,
        visibility: { left: false, right: false },
        onViewportLayout: () => {},
        onContentSizeChange: () => {},
        onScroll: () => {},
        onMomentumScrollEnd: () => {},
    }),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
    ScrollEdgeFades: () => null,
}));

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: () => null,
}));

vi.mock('@/components/sessions/sourceControl/status', () => ({
    SourceControlStatusBadge: () => null,
    useHasMeaningfulScmStatus: () => false,
}));

vi.mock('@/components/sessions/pickers/OptionPickerOverlay', () => ({
    OptionPickerOverlay: () => null,
}));

vi.mock('@/sync/domains/sessionControl/sessionModeControl', () => ({
    computeSessionModePickerControl: () => null,
}));

vi.mock('@/sync/domains/sessionControl/configOptionsControl', () => ({
    computeSessionConfigOptionControls: () => null,
}));

describe('AgentInput (chip ordering)', () => {
    it('keeps the engine controls grouped ahead of permission in wrap layout', async () => {
        const { AgentInput } = await import('./AgentInput');

        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderScreen(React.createElement(AgentInput, {
                    value: '',
                    placeholder: 'placeholder',
                    onChangeText: () => {},
                    onSend: () => {},
                    autocompletePrefixes: [],
                    autocompleteSuggestions: async () => [],
                    onPermissionClick: () => {},
                    agentType: 'codex',
                    onAgentClick: () => {},
                    onAcpSessionModeChange: () => {},
                    acpSessionModeOptionsOverride: [{ id: 'plan', name: 'Plan' }],
                }))).tree;

        type JsonNode =
            | renderer.ReactTestRendererJSON
            | renderer.ReactTestRendererJSON[]
            | string
            | number
            | null;

        function flattenJson(node: JsonNode, out: renderer.ReactTestRendererJSON[] = []): renderer.ReactTestRendererJSON[] {
            if (!node) return out;
            if (typeof node === 'string' || typeof node === 'number') return out;
            if (Array.isArray(node)) {
                for (const entry of node) flattenJson(entry, out);
                return out;
            }
            out.push(node);
            if (node.children) flattenJson(node.children as JsonNode, out);
            return out;
        }

        function pressableContainsIcon(
            node: renderer.ReactTestRendererJSON,
            iconType: string,
            iconName: string,
        ): boolean {
            const stack = [...(node.children ?? [])] as unknown as JsonNode[];
            while (stack.length > 0) {
                const current = stack.shift();
                if (!current) continue;
                if (typeof current === 'string' || typeof current === 'number') continue;
                if (Array.isArray(current)) {
                    stack.unshift(...current);
                    continue;
                }
                if (current.type === iconType && (current.props as any)?.name === iconName) return true;
                if (current.children) stack.unshift(current.children as any);
            }
            return false;
        }

        const allNodes = flattenJson(tree!.toJSON() as JsonNode);
        const pressables = allNodes.filter((n) => n.type === 'Pressable');

        const permissionIndex = pressables.findIndex((n) => (n.props as any)?.testID === 'agent-input-permission-chip');
        const agentIndex = pressables.findIndex((n) => pressableContainsIcon(n, 'Octicons', 'cpu'));
        const modeIndex = pressables.findIndex((n) => (n.props as any)?.testID === 'agent-input-session-mode-chip');

        expect(permissionIndex).toBeGreaterThanOrEqual(0);
        expect(agentIndex).toBeGreaterThanOrEqual(0);
        expect(modeIndex).toBeGreaterThanOrEqual(0);
        expect(agentIndex).toBeLessThan(modeIndex);
        expect(modeIndex).toBeLessThan(permissionIndex);
    }, 90_000);

    it('keeps machine on the secondary wrap row after the send button and before path/resume', async () => {
        const { AgentInput } = await import('./AgentInput');

        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderScreen(React.createElement(AgentInput, {
                    value: '',
                    placeholder: 'placeholder',
                    onChangeText: () => {},
                    onSend: () => {},
                    autocompletePrefixes: [],
                    autocompleteSuggestions: async () => [],
                    onMachineClick: () => {},
                    machineName: 'Local dev machine',
                    onPathClick: () => {},
                    currentPath: '/workspace/app',
                    onResumeClick: () => {},
                    resumeSessionId: 'session-1',
                }))).tree;

        type JsonNode =
            | renderer.ReactTestRendererJSON
            | renderer.ReactTestRendererJSON[]
            | string
            | number
            | null;

        function flattenJson(node: JsonNode, out: renderer.ReactTestRendererJSON[] = []): renderer.ReactTestRendererJSON[] {
            if (!node) return out;
            if (typeof node === 'string' || typeof node === 'number') return out;
            if (Array.isArray(node)) {
                for (const entry of node) flattenJson(entry, out);
                return out;
            }
            out.push(node);
            if (node.children) flattenJson(node.children as JsonNode, out);
            return out;
        }

        const allNodes = flattenJson(tree!.toJSON() as JsonNode);
        const sendIndex = allNodes.findIndex((node) => node.props?.testID === 'new-session-composer-send');
        const machineIndex = allNodes.findIndex((node) => node.props?.testID === 'agent-input-machine-chip');
        const pathIndex = allNodes.findIndex((node) => node.props?.testID === 'agent-input-path-chip');

        expect(sendIndex).toBeGreaterThanOrEqual(0);
        expect(machineIndex).toBeGreaterThan(sendIndex);
        expect(pathIndex).toBeGreaterThan(machineIndex);
    }, 90_000);

    it('keeps recipient ahead of delivery in the primary wrap row', async () => {
        const { AgentInput } = await import('./AgentInput');

        let tree: renderer.ReactTestRenderer | undefined;
        tree = (await renderScreen(React.createElement(AgentInput, {
                    value: '',
                    placeholder: 'placeholder',
                    onChangeText: () => {},
                    onSend: () => {},
                    autocompletePrefixes: [],
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

        type JsonNode =
            | renderer.ReactTestRendererJSON
            | renderer.ReactTestRendererJSON[]
            | string
            | number
            | null;

        function flattenJson(node: JsonNode, out: renderer.ReactTestRendererJSON[] = []): renderer.ReactTestRendererJSON[] {
            if (!node) return out;
            if (typeof node === 'string' || typeof node === 'number') return out;
            if (Array.isArray(node)) {
                for (const entry of node) flattenJson(entry, out);
                return out;
            }
            out.push(node);
            if (node.children) flattenJson(node.children as JsonNode, out);
            return out;
        }

        const allNodes = flattenJson(tree!.toJSON() as JsonNode);
        const permissionIndex = allNodes.findIndex((node) => node.props?.testID === 'agent-input-permission-chip');
        const recipientIndex = allNodes.findIndex((node) => node.props?.testID === 'agent-input-recipient-chip');
        const deliveryIndex = allNodes.findIndex((node) => node.props?.testID === 'agent-input-delivery-chip');

        expect(permissionIndex).toBeGreaterThanOrEqual(0);
        expect(recipientIndex).toBeGreaterThan(permissionIndex);
        expect(deliveryIndex).toBeGreaterThan(recipientIndex);
    }, 90_000);

});
