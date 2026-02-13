import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function collectText(node: any, out: string[] = []): string[] {
    if (node === null || node === undefined) return out;
    if (typeof node === 'string' || typeof node === 'number') {
        out.push(String(node));
        return out;
    }
    if (Array.isArray(node)) {
        for (const item of node) collectText(item, out);
        return out;
    }
    if (typeof node === 'object') {
        if (node.children) collectText(node.children, out);
        return out;
    }
    return out;
}

vi.mock('react-native', () => ({
    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('View', props, props.children),
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Pressable', props, props.children),
    ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ScrollView', props, props.children),
    ActivityIndicator: (props: Record<string, unknown>) => React.createElement('ActivityIndicator', props, null),
    Platform: { OS: 'ios', select: (v: any) => v.ios },
    useWindowDimensions: () => ({ width: 800, height: 600 }),
    Dimensions: {
        get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
    },
}));

vi.mock('react-native-unistyles', () => ({
    StyleSheet: {
        create: (styles: any) => {
            const theme = {
                colors: {
                    input: { background: '#fff' },
                    button: {
                        primary: { background: '#000', tint: '#fff' },
                        secondary: { tint: '#000', surface: '#fff' },
                    },
                    radio: { active: '#000', inactive: '#ddd' },
                    text: '#000',
                    textSecondary: '#666',
                    divider: '#ddd',
                    success: '#0a0',
                    textDestructive: '#a00',
                },
            };
            return typeof styles === 'function' ? styles(theme) : styles;
        },
    },
    useUnistyles: () => ({
        theme: {
            colors: {
                input: { background: '#fff' },
                button: {
                    primary: { background: '#000', tint: '#fff' },
                    secondary: { tint: '#000', surface: '#fff' },
                },
                radio: { active: '#000', inactive: '#ddd' },
                text: '#000',
                textSecondary: '#666',
                divider: '#ddd',
                success: '#0a0',
                textDestructive: '#a00',
            },
        },
    }),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
    Octicons: (props: Record<string, unknown>) => React.createElement('Octicons', props, null),
}));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
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

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

vi.mock('@/sync/acp/sessionModeControl', () => ({
    computeAcpPlanModeControl: () => null,
    computeAcpSessionModePickerControl: () => null,
}));

vi.mock('@/sync/acp/configOptionsControl', () => ({
    computeAcpConfigOptionControls: () => null,
}));

describe('AgentInput (machine chip)', () => {
    it('renders a select-machine label when machine is not yet selected', async () => {
        const { AgentInput } = await import('./AgentInput');

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(AgentInput, {
                    value: 'hello',
                    placeholder: 'placeholder',
                    onChangeText: () => {},
                    onSend: () => {},
                    autocompletePrefixes: [],
                    autocompleteSuggestions: async () => [],
                    onMachineClick: () => {},
                    currentPath: '/tmp',
                    onPathClick: () => {},
                }),
            );
        });

        const text = collectText(tree?.toJSON());
        expect(text.join(' ')).toContain('newSession.selectMachineTitle');
    });

    it('renders a select-path label when path is not yet selected (new-session bootstrap)', async () => {
        const { AgentInput } = await import('./AgentInput');

        let tree: renderer.ReactTestRenderer | undefined;
        await act(async () => {
            tree = renderer.create(
                React.createElement(AgentInput, {
                    value: 'hello',
                    placeholder: 'placeholder',
                    onChangeText: () => {},
                    onSend: () => {},
                    autocompletePrefixes: [],
                    autocompleteSuggestions: async () => [],
                    onMachineClick: () => {},
                    currentPath: '',
                    onPathClick: () => {},
                }),
            );
        });

        const text = collectText(tree?.toJSON());
        expect(text.join(' ')).toContain('newSession.selectPathTitle');
    });
});
