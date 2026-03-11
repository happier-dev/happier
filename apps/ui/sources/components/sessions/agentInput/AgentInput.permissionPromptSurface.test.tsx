import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const permissionPromptSurfaceSetting = vi.hoisted(() => ({ value: 'composer' as any }));

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

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/components/tools/shell/permissions/PermissionPromptCard', () => ({
    PermissionPromptCard: (props: any) => React.createElement('PermissionPromptCard', props),
}));
vi.mock('@/components/tools/shell/userActions/UserActionPromptCard', () => ({
    UserActionPromptCard: (props: any) => React.createElement('UserActionPromptCard', props),
}));

vi.mock('@/text', () => ({
    t: (key: string) => key,
}));

vi.mock('@/sync/domains/state/storage', () => {
    const emptyIds: string[] = [];
    const emptyMessagesById: Record<string, any> = {};

    return {
        useSetting: (key: string) => {
            if (key === 'profiles') return [];
            if (key === 'agentInputEnterToSend') return true;
            if (key === 'agentInputHistoryScope') return 'perSession';
            if (key === 'agentInputActionBarLayout') return 'wrap';
            if (key === 'agentInputChipDensity') return 'labels';
            if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
            if (key === 'permissionPromptSurface') return permissionPromptSurfaceSetting.value;
            return null;
        },
        useSessionTranscriptIds: () => ({ ids: emptyIds, isLoaded: true }),
        useSessionMessagesById: () => emptyMessagesById,
        useSessionMessagesVersion: () => 0,
        useSessionMessagesReducerState: () => null,
    };
});

vi.mock('@/sync/domains/state/storageStore', () => ({
    getStorage: () => (selector: any) => selector({ sessionMessages: {} }),
}));

vi.mock('@/hooks/session/useUserMessageHistory', () => ({
    useUserMessageHistory: () => ({
        moveUp: () => null,
        moveDown: () => null,
        reset: () => {},
    }),
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
    useActiveWord: () => null,
}));

vi.mock('@/components/autocomplete/useActiveSuggestions', () => ({
    useActiveSuggestions: () => [[], -1, () => {}, () => {}],
}));

vi.mock('./components/AgentInputAutocomplete', () => ({
    AgentInputAutocomplete: () => null,
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeFades', () => ({
    ScrollEdgeFades: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/scroll/ScrollEdgeIndicators', () => ({
    ScrollEdgeIndicators: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/buttons/PrimaryCircleIconButton', () => ({
    PrimaryCircleIconButton: () => null,
}));

vi.mock('@/components/ui/lists/ActionListSection', () => ({
    ActionListSection: () => null,
}));

vi.mock('@/components/autocomplete/applySuggestion', () => ({
    applySuggestion: () => ({ text: '', selection: { start: 0, end: 0 } }),
}));

vi.mock('@/components/sessions/sourceControl/status', () => ({
    SourceControlStatusBadge: () => null,
    useHasMeaningfulScmStatus: () => false,
}));

vi.mock('@/components/model/ModelPickerOverlay', () => ({
    ModelPickerOverlay: () => null,
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

vi.mock('@/components/ui/scroll/useScrollEdgeFades', () => ({
    useScrollEdgeFades: () => ({ showTop: false, showBottom: false, onScroll: () => {} }),
}));

vi.mock('./ResumeChip', () => ({
    ResumeChip: () => null,
    formatResumeChipLabel: () => '',
    RESUME_CHIP_ICON_NAME: 'play',
    RESUME_CHIP_ICON_SIZE: 16,
}));

vi.mock('./PathAndResumeRow', () => ({
    PathAndResumeRow: () => null,
}));

vi.mock('./actionBarLogic', () => ({
    getHasAnyAgentInputActions: () => false,
    shouldShowPathAndResumeRow: () => false,
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('./inputMaxHeight', () => ({
    computeAgentInputDefaultMaxHeight: () => 100,
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

vi.mock('@/sync/acp/sessionModeControl', () => ({
    computeSessionModePickerControl: () => null,
}));

vi.mock('@/sync/acp/configOptionsControl', () => ({
    computeAcpConfigOptionControls: () => [],
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('./attachActionBarMouseDragScroll', () => ({
    attachActionBarMouseDragScroll: () => () => {},
}));

describe('AgentInput (permission prompt surface)', () => {
    beforeEach(() => {
        permissionPromptSurfaceSetting.value = 'composer';
    });

    it('hides permission cards when surface is transcript', async () => {
        permissionPromptSurfaceSetting.value = 'transcript';
        const { AgentInput } = await import('./AgentInput');
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <AgentInput
                    placeholder="x"
                    value=""
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                    sessionId="s1"
                    permissionRequests={[{ id: 'p1', tool: 'Bash', arguments: { command: 'ls' }, createdAt: 1 } as any]}
                    connectionStatus={null as any}
                />
            );
        });

        expect(tree.root.findAllByType('PermissionPromptCard' as any)).toHaveLength(0);
        act(() => tree.unmount());
    });

    it('shows permission cards when surface is composer', async () => {
        permissionPromptSurfaceSetting.value = 'composer';
        const { AgentInput } = await import('./AgentInput');
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <AgentInput
                    placeholder="x"
                    value=""
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                    sessionId="s1"
                    permissionRequests={[{ id: 'p1', tool: 'Bash', arguments: { command: 'ls' }, createdAt: 1 } as any]}
                    connectionStatus={null as any}
                />
            );
        });

        expect(tree.root.findAllByType('PermissionPromptCard' as any)).toHaveLength(1);
        act(() => tree.unmount());
    });

    it('shows user action cards when surface is composer', async () => {
        permissionPromptSurfaceSetting.value = 'composer';
        const { AgentInput } = await import('./AgentInput');
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <AgentInput
                    placeholder="x"
                    value=""
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                    sessionId="s1"
                    userActionRequests={[{ id: 'q1', tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions: [{ header: 'Mode', question: 'Create?', options: [{ label: 'Yes', description: 'Create it' }], multiSelect: false }] }, createdAt: 1 } as any]}
                    connectionStatus={null as any}
                />
            );
        });

        expect(tree.root.findAllByType('UserActionPromptCard' as any)).toHaveLength(1);
        act(() => tree.unmount());
    });

    it('shows user action cards for legacy requests without an explicit kind', async () => {
        permissionPromptSurfaceSetting.value = 'composer';
        const { AgentInput } = await import('./AgentInput');
        let tree!: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <AgentInput
                    placeholder="x"
                    value=""
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                    sessionId="s1"
                    userActionRequests={[{ id: 'q1', tool: 'AskUserQuestion', arguments: { questions: [{ header: 'Mode', question: 'Create?', options: [{ label: 'Yes', description: 'Create it' }], multiSelect: false }] }, createdAt: 1 } as any]}
                    connectionStatus={null as any}
                />
            );
        });

        expect(tree.root.findAllByType('UserActionPromptCard' as any)).toHaveLength(1);
        act(() => tree.unmount());
    });
});
