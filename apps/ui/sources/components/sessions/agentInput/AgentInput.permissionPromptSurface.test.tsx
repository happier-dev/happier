import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let permissionPromptSurfaceSetting: any = 'composer';

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
        if (key === 'permissionPromptSurface') return permissionPromptSurfaceSetting;
        return null;
    },
    useSettings: () => ({
        profiles: [],
        agentInputEnterToSend: true,
        agentInputActionBarLayout: 'wrap',
        agentInputChipDensity: 'labels',
        sessionPermissionModeApplyTiming: 'immediate',
        permissionPromptSurface: permissionPromptSurfaceSetting,
	    }),
	    useSessionMessages: () => ({ messages: [], isLoaded: true }),
	    useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
	    useSessionMessagesById: () => ({}),
	    useSessionMessagesVersion: () => 0,
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

vi.mock('@/sync/domains/settings/settings', () => ({
    getProfileEnvironmentVariables: () => [],
}));

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
        permissionPromptSurfaceSetting = 'composer';
    });

    it('hides permission cards when surface is transcript', async () => {
        permissionPromptSurfaceSetting = 'transcript';
        const { AgentInput } = await import('./AgentInput');
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
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

        expect(tree!.root.findAllByType('PermissionPromptCard' as any)).toHaveLength(0);
    });

    it('shows permission cards when surface is composer', async () => {
        permissionPromptSurfaceSetting = 'composer';
        const { AgentInput } = await import('./AgentInput');
        let tree: renderer.ReactTestRenderer | null = null;
        await act(async () => {
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

        expect(tree!.root.findAllByType('PermissionPromptCard' as any)).toHaveLength(1);
    });
});
