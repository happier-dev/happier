import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const rn = await import('@/dev/reactNativeStub');
    return {
    ...rn,
    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('View', props, props.children),
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Pressable', props, props.children),
    ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('ScrollView', props, props.children),
    ActivityIndicator: (props: Record<string, unknown>) => React.createElement('ActivityIndicator', props, null),
    Platform: { ...rn.Platform, OS: 'ios', select: (v: any) => v.ios },
    useWindowDimensions: () => ({ width: 800, height: 600 }),
    Dimensions: {
        get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
    },
    };
});

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
                    surfacePressed: '#eee',
                    permission: {
                        acceptEdits: '#0a0',
                        bypass: '#0a0',
                        plan: '#0a0',
                        readOnly: '#0a0',
                        safeYolo: '#0a0',
                        yolo: '#0a0',
                    },
                    surfaceHighest: '#fafafa',
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
                surfacePressed: '#eee',
                permission: {
                    acceptEdits: '#0a0',
                    bypass: '#0a0',
                    plan: '#0a0',
                    readOnly: '#0a0',
                    safeYolo: '#0a0',
                    yolo: '#0a0',
                },
                surfaceHighest: '#fafafa',
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
    useSettings: () => ({
        profiles: [],
        agentInputEnterToSend: true,
        agentInputActionBarLayout: 'wrap',
        agentInputChipDensity: 'labels',
        sessionPermissionModeApplyTiming: 'immediate',
    }),
    useSessionMessages: () => ({ messages: [], isLoaded: true }),
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    getStorage: () => (selector: any) => selector({ sessionMessages: {} }),
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

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: (props: Record<string, unknown>) => React.createElement('PermissionFooter', props, null),
}));

vi.mock('@/components/tools/normalization/policy/permissionSummary', () => ({
    formatPermissionRequestSummary: () => 'Permission required',
}));

vi.mock('@/components/tools/normalization/parse/shellCommand', () => ({
    extractShellCommand: () => null,
}));

vi.mock('@/components/tools/normalization/parse/parseParenIdentifier', () => ({
    parseParenIdentifier: () => null,
}));

vi.mock('@/hooks/session/useUserMessageHistory', () => ({
    useUserMessageHistory: () => ({
        getPrevious: () => null,
        getNext: () => null,
        push: () => {},
        resetNavigation: () => {},
    }),
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/components/sessions/sourceControl/status', () => ({
    SourceControlStatusBadge: () => null,
    useHasMeaningfulScmStatus: () => false,
}));

vi.mock('@/components/autocomplete/useActiveWord', () => ({
    useActiveWord: () => ({ activeWord: null, setActiveWord: () => {} }),
}));

vi.mock('@/components/autocomplete/useActiveSuggestions', () => ({
    useActiveSuggestions: () => [[], null, () => {}, () => {}],
}));

vi.mock('./components/AgentInputAutocomplete', () => ({
    AgentInputAutocomplete: () => null,
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: ({ children }: { children?: React.ReactNode }) => React.createElement('FloatingOverlay', null, children),
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: ({ children }: { children?: React.ReactNode }) => React.createElement('Popover', null, children),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
    ScrollEdgeFades: ({ children }: { children?: React.ReactNode }) => React.createElement('ScrollEdgeFades', null, children),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: () => null,
}));

vi.mock('@/components/ui/buttons/PrimaryCircleIconButton', () => ({
    PrimaryCircleIconButton: () => null,
}));

vi.mock('@/components/ui/lists/ActionListSection', () => ({
    ActionListSection: () => null,
}));

vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
    useScrollEdgeFades: () => ({ scrollEdgeFadesProps: {}, onScroll: () => {}, onLayout: () => {} }),
}));

vi.mock('@/sync/domains/settings/settings', () => ({
    getProfileEnvironmentVariables: () => ({}),
}));

vi.mock('@/sync/domains/profiles/profileUtils', () => ({
    resolveProfileById: () => null,
}));

vi.mock('@/components/profiles/profileDisplay', () => ({
    getProfileDisplayName: () => 'Profile',
}));

vi.mock('@/components/model/ModelPickerOverlay', () => ({
    ModelPickerOverlay: () => null,
}));

vi.mock('@/sync/acp/sessionModeControl', () => ({
    computeAcpPlanModeControl: () => null,
    computeAcpSessionModePickerControl: () => null,
}));

vi.mock('@/sync/acp/configOptionsControl', () => ({
    computeAcpConfigOptionControls: () => [],
}));

vi.mock('@/components/ui/theme/haptics', () => ({
    hapticsLight: () => {},
    hapticsError: () => {},
}));

vi.mock('@/modal', () => ({
    Modal: { alert: () => {} },
}));

vi.mock('@/components/ui/status/StatusDot', () => ({
    StatusDot: () => null,
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 920 },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}), mono: () => ({}) },
}));

vi.mock('./ResumeChip', () => ({
    ResumeChip: () => null,
    formatResumeChipLabel: () => '',
    RESUME_CHIP_ICON_NAME: 'play',
    RESUME_CHIP_ICON_SIZE: 12,
}));

vi.mock('./PathAndResumeRow', () => ({
    PathAndResumeRow: () => null,
}));

vi.mock('./actionBarLogic', () => ({
    getHasAnyAgentInputActions: () => false,
    shouldShowPathAndResumeRow: () => false,
}));

vi.mock('./inputMaxHeight', () => ({
    computeAgentInputDefaultMaxHeight: () => 200,
}));

vi.mock('./contextWarning', () => ({
    getContextWarning: () => null,
}));

vi.mock('./permissionChipVisibility', () => ({
    shouldRenderPermissionChip: () => false,
}));

vi.mock('./actionMenuActions', () => ({
    buildAgentInputActionMenuActions: () => [],
}));

vi.mock('./components/PermissionModePicker', () => ({
    PermissionModePicker: () => null,
}));

describe('AgentInput (permission requests)', () => {
    it('renders PermissionFooter when pending permission requests are provided', async () => {
        const { AgentInput } = await import('./AgentInput');

        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
            tree = renderer.create(
                React.createElement(AgentInput as any, {
                    value: '',
                    placeholder: 'Type',
                    onChangeText: () => {},
                    sessionId: 's1',
                    onSend: () => {},
                    autocompletePrefixes: [],
                    autocompleteSuggestions: async () => [],
                    permissionRequests: [
                        { id: 'req1', tool: 'Bash', arguments: { command: 'ls' }, createdAt: 123 },
                    ],
                }),
            );
        });

        expect(tree!.root.findAllByType('PermissionFooter' as any)).toHaveLength(1);
    });
});
