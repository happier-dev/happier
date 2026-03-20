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

vi.mock('react-native-unistyles', () => {
    const createFallbackToken = (value: string) => {
        const token: any = new Proxy(
            {},
            {
                get: (_target, prop) => {
                    if (prop === Symbol.toPrimitive) return () => value;
                    if (prop === 'toString') return () => value;
                    if (prop === 'valueOf') return () => value;
                    return token;
                },
            },
        );
        return token;
    };

    const fallback = createFallbackToken('#000');
    const withFallback = <T extends Record<string, any>>(obj: T): T =>
        new Proxy(obj, {
            get: (target, prop) => (prop in target ? (target as any)[prop] : fallback),
        });

    const theme = {
        colors: withFallback({
            input: withFallback({ background: '#111' }),
            text: '#fff',
            textSecondary: '#aaa',
            textTertiary: '#888',
            divider: '#333',
            surface: '#000',
            surfacePressed: '#111',
            overlay: withFallback({ scrim: 'rgba(0,0,0,0.4)', text: '#fff' }),
            radio: withFallback({ active: '#0af', inactive: '#555', dot: '#0af' }),
            button: withFallback({
                secondary: withFallback({ tint: '#0af' }),
                primary: withFallback({ tint: '#0af' }),
            }),
            permission: withFallback({
                acceptEdits: '#0a0',
                bypass: '#f00',
                plan: '#0af',
                readOnly: '#777',
                safeYolo: '#fb0',
                yolo: '#f0f',
            }),
        }),
    };

    const runtime = {
        insets: { top: 0, bottom: 0, left: 0, right: 0 },
    };

    return {
        useUnistyles: () => ({ theme, runtime }),
        StyleSheet: {
            create: (value: any) => (typeof value === 'function' ? value(theme, runtime) : value),
        },
    };
});

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

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: (props: Record<string, unknown>) => React.createElement('TextInput', props, null),
    TextSelectabilityScope: (props: { selectable: boolean; children: React.ReactNode }) =>
        React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
    return {
        ...actual,
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
    useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
    useSessionMessagesById: () => ({}),
    useSessionMessagesVersion: () => 0,
    useSessionMessagesReducerState: () => null,
    };
});

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

vi.mock('@/components/tools/normalization/parse/shellCommand', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/components/tools/normalization/parse/shellCommand')>();
    return {
        ...actual,
        extractShellCommand: () => null,
    };
});

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
    useScrollEdgeFades: () => ({
        canScrollX: false,
        canScrollY: false,
        visibility: { top: false, bottom: false, left: false, right: false },
        onViewportLayout: () => {},
        onContentSizeChange: () => {},
        onScroll: () => {},
        onMomentumScrollEnd: () => {},
    }),
}));

vi.mock('@/sync/domains/profiles/profileCompatibility', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/profiles/profileCompatibility')>();
    return {
        ...actual,
        getProfileEnvironmentVariables: () => [],
    };
});

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
    computeSessionModePickerControl: () => null,
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
    Typography: { default: () => ({}), mono: () => ({}), header: () => ({}) },
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
    shouldShowSecondaryControlRow: () => false,
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

    it('renders permission requests inside a clamped scroll container', async () => {
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
                        { id: 'req2', tool: 'Bash', arguments: { command: 'pwd' }, createdAt: 124 },
                    ],
                }),
            );
        });

        const scrolls = tree!.root.findAll(
            (node) => (node.type as any) === 'ScrollView' && node.props.testID === 'agentInput.permissionRequests.scroll',
        );
        expect(scrolls).toHaveLength(1);
    });
});
