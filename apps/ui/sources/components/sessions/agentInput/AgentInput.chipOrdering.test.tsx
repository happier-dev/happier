import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const rn = await import('@/dev/reactNativeStub');
    return {
        ...rn,
        Platform: {
            ...rn.Platform,
            OS: 'ios',
            select: (v: any) => v?.ios ?? v?.default ?? rn.Platform.select(v),
        },
    };
});

vi.mock('expo-image', () => ({
    Image: 'Image',
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/domains/state/storage', () => ({
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

vi.mock('@/components/model/ModelPickerOverlay', () => ({
    ModelPickerOverlay: () => null,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

vi.mock('@/sync/acp/sessionModeControl', () => ({
    computeSessionModePickerControl: () => null,
}));

vi.mock('@/sync/acp/configOptionsControl', () => ({
    computeAcpConfigOptionControls: () => null,
}));

describe('AgentInput (chip ordering)', () => {
    it('renders permissions, then backend, then mode', async () => {
        const { AgentInput } = await import('./AgentInput');

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(AgentInput, {
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
                }),
            );
        });

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

        const permissionIndex = pressables.findIndex((n) => pressableContainsIcon(n, 'Octicons', 'gear'));
        const agentIndex = pressables.findIndex((n) => pressableContainsIcon(n, 'Octicons', 'cpu'));
        const modeIndex = pressables.findIndex((n) => (n.props as any)?.accessibilityLabel === 'agentInput.mode.badgeA11y');

        expect(permissionIndex).toBeGreaterThanOrEqual(0);
        expect(agentIndex).toBeGreaterThanOrEqual(0);
        expect(modeIndex).toBeGreaterThanOrEqual(0);
        expect(permissionIndex).toBeLessThan(agentIndex);
        expect(agentIndex).toBeLessThan(modeIndex);
    });
});
