import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const permissionPromptSurfaceSetting = vi.hoisted(() => ({ value: 'composer' as any }));
const layoutMockState = vi.hoisted(() => ({
    platform: 'ios' as 'ios' | 'web',
}));
const transcriptMockState = vi.hoisted(() => ({
    emptyIds: [] as string[],
    emptyMessagesById: {} as Record<string, unknown>,
}));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, props.children),
            Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Text', props, props.children),
            Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Pressable', props, props.children),
            ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('ScrollView', props, props.children),
            ActivityIndicator: (props: Record<string, unknown>) =>
                React.createElement('ActivityIndicator', props, null),
            Platform: {
                get OS() {
                    return layoutMockState.platform;
                },
                select: (v: any) => v?.[layoutMockState.platform] ?? v?.default ?? v?.ios,
            },
            useWindowDimensions: () => ({ width: 800, height: 600 }),
            Dimensions: {
                get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
            },
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    },
    icons: () => ({
        Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
        Octicons: (props: Record<string, unknown>) => React.createElement('Octicons', props, null),
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
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
            useSessionTranscriptIds: () => ({ ids: transcriptMockState.emptyIds, isLoaded: true }),
            useSessionMessagesById: () => transcriptMockState.emptyMessagesById,
            useSessionMessagesVersion: () => 0,
            useSessionMessagesReducerState: () => null,
        });
    },
});

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/components/tools/shell/permissions/PermissionPromptCard', () => ({
    PermissionPromptCard: (props: any) => React.createElement('PermissionPromptCard', props),
}));
vi.mock('@/components/tools/shell/approvals/ApprovalPromptCard', () => ({
    ApprovalPromptCard: (props: any) => React.createElement('ApprovalPromptCard', props),
}));
vi.mock('@/components/tools/shell/userActions/UserActionPromptCard', () => ({
    UserActionPromptCard: (props: any) => React.createElement('UserActionPromptCard', props),
}));

vi.mock('@/sync/domains/state/storageStore', () => ({
    getStorage: () => {
        const state = {
            sessionMessages: {},
            localSettings: { uiBackdropBlurEnabled: false, uiContentWidthMode: 'standard' },
        };
        return Object.assign(
            (selector: any) => selector(state),
            { getState: () => state },
        );
    },
}));

vi.mock('@/hooks/session/useUserMessageHistory', () => ({
    useUserMessageHistory: () => ({
        moveUp: () => null,
        moveDown: () => null,
        reset: () => {},
    }),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentIconSvgXml: () => null,
    getAgentIconSource: () => null,
    getAgentIconTintColor: () => undefined,
    AGENT_IDS: ['codex', 'claude', 'opencode', 'gemini'],
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: () => null,
    resolveAgentIdFromSessionMetadata: () => null,
    getAgentCore: () => ({ displayNameKey: 'agents.codex', toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/sync/domains/models/modelOptions', () => ({
    findModelOptionForEffectiveModelId: (options: any, effectiveModelId: any) =>
        options?.find?.((option: any) => option.value === effectiveModelId)
            ?? options?.find?.((option: any) => option.value === String(effectiveModelId ?? '').replace(/\[[^\]]*\]$/u, ''))
            ?? null,
    getModelOptionsForSession: () => [{ value: 'default', label: 'Default' }],
    supportsFreeformModelSelectionForSession: () => false,
}));

vi.mock('@/sync/domains/models/describeEffectiveModelMode', () => ({
    describeEffectiveModelMode: () => ({ selectedModelId: 'default', appliedModelId: null, effectiveModelId: 'default' }),
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

vi.mock('@/components/autocomplete/useActiveSuggestions', () => ({
    useActiveSuggestions: () => [[], -1, () => {}, () => {}],
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: any) => React.createElement(React.Fragment, null, props.children),
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: any) => React.createElement(React.Fragment, null, props.children),
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
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

vi.mock('@/components/sessions/pickers/OptionPickerOverlay', () => ({
    OptionPickerOverlay: () => null,
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
    shouldShowSecondaryControlRow: () => false,
    shouldShowPathAndResumeRow: () => false,
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/hooks/server/useFeatureEnabled', () => ({
    useFeatureEnabled: () => false,
}));

vi.mock('./inputMaxHeight', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./inputMaxHeight')>();
    return {
        ...actual,
        computeAgentInputDefaultMaxHeight: () => 100,
        computeMeasuredPanelInputMaxHeight: () => 100,
    };
});

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

vi.mock('@/sync/domains/sessionControl/sessionModeControl', () => ({
    computeSessionModePickerControl: () => null,
}));

vi.mock('@/sync/domains/sessionControl/configOptionsControl', () => ({
    computeSessionConfigOptionControls: () => [],
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('./attachActionBarMouseDragScroll', () => ({
    attachActionBarMouseDragScroll: () => () => {},
}));

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((merged, entry) => ({
            ...merged,
            ...flattenStyle(entry),
        }), {});
    }
    if (typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

function hasAncestor(node: { parent?: unknown } | null | undefined, ancestor: unknown): boolean {
    let current = node?.parent;
    while (current) {
        if (current === ancestor) return true;
        current = (current as { parent?: unknown }).parent;
    }
    return false;
}

describe('AgentInput (permission prompt surface)', () => {
    beforeEach(() => {
        layoutMockState.platform = 'ios';
        permissionPromptSurfaceSetting.value = 'composer';
    });

    it('hides permission cards when surface is transcript', async () => {
        permissionPromptSurfaceSetting.value = 'transcript';
        const { AgentInput } = await import('./AgentInput');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AgentInput
                    placeholder="x"
                    value=""
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    sessionId="s1"
                    permissionRequests={[{ id: 'p1', tool: 'Bash', arguments: { command: 'ls' }, createdAt: 1 } as any]}
                    connectionStatus={null as any}
                />)).tree;

        expect(tree.findAllByType('PermissionPromptCard' as any)).toHaveLength(0);
        act(() => tree.unmount());
    });

    it('shows permission cards when surface is composer', async () => {
        permissionPromptSurfaceSetting.value = 'composer';
        const { AgentInput } = await import('./AgentInput');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AgentInput
                    placeholder="x"
                    value=""
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    sessionId="s1"
                    permissionRequests={[{ id: 'p1', tool: 'Bash', arguments: { command: 'ls' }, createdAt: 1 } as any]}
                    connectionStatus={null as any}
                />)).tree;

        expect(tree.findAllByType('PermissionPromptCard' as any)).toHaveLength(1);
        act(() => tree.unmount());
    });

    it('keeps composer permission chrome fixed above the web input scroll area', async () => {
        layoutMockState.platform = 'web';
        permissionPromptSurfaceSetting.value = 'composer';
        const { AgentInput } = await import('./AgentInput');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AgentInput
                    placeholder="x"
                    value=""
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    sessionId="s1"
                    permissionRequests={[{ id: 'p1', tool: 'Bash', arguments: { command: 'ls' }, createdAt: 1 } as any]}
                    connectionStatus={null as any}
                />)).tree;

        const scrollViews = tree.root.findAll((node: any) => node.type === 'ScrollView');
        const composerVariableScroll = scrollViews.find((node: any) => (
            node.props.testID !== 'agentInput.permissionRequests.scroll'
            && flattenStyle(node.props.style).marginHorizontal === -8
        ));
        expect(composerVariableScroll).toBeTruthy();
        expect(flattenStyle(composerVariableScroll?.props.contentContainerStyle).paddingHorizontal).toBe(8);

        const permissionChrome = tree.root.findByProps({ testID: 'agentInput.permissionRequests.chrome' });
        expect(hasAncestor(permissionChrome, composerVariableScroll)).toBe(false);
        expect(flattenStyle(permissionChrome.parent?.props.style).marginHorizontal).toBe(-8);
        act(() => tree.unmount());
    });

    it('shows approval cards when surface is composer', async () => {
        permissionPromptSurfaceSetting.value = 'composer';
        const { AgentInput } = await import('./AgentInput');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AgentInput
                    placeholder="x"
                    value=""
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    sessionId="s1"
                    approvalRequests={[{
                        artifact: {
                            id: 'approval-1',
                            header: { v: 1, kind: 'approval_request.v1', title: 'Approve', approvalStatus: 'open', sessionId: 's1' },
                            title: 'Approve',
                            headerVersion: 1,
                            seq: 1,
                            createdAt: 1,
                            updatedAt: 1,
                            isDecrypted: true,
                        },
                        approval: {
                            v: 1,
                            status: 'open',
                            createdAtMs: 1,
                            updatedAtMs: 1,
                            createdBy: { surface: 'agent', sessionId: 's1' },
                            requestedSurface: 'agent',
                            actionId: 'session.list',
                            actionArgs: {},
                            summary: 'List sessions',
                        },
                    }]}
                    connectionStatus={null as any}
                />)).tree;

        expect(tree.findAllByType('ApprovalPromptCard' as any)).toHaveLength(1);
        act(() => tree.unmount());
    });

    it('does not show user action cards in the composer when surface is composer', async () => {
        permissionPromptSurfaceSetting.value = 'composer';
        const { AgentInput } = await import('./AgentInput');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AgentInput
                    placeholder="x"
                    value=""
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    sessionId="s1"
                    {...({ userActionRequests: [{ id: 'q1', tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions: [{ header: 'Mode', question: 'Create?', options: [{ label: 'Yes', description: 'Create it' }], multiSelect: false }] }, createdAt: 1 }] } as any)}
                    connectionStatus={null as any}
                />)).tree;

        expect(tree.findAllByType('UserActionPromptCard' as any)).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'agentInput.permissionRequests.chrome' })).toHaveLength(0);
        act(() => tree.unmount());
    });

    it('does not show user action cards in the composer when surface is transcript', async () => {
        permissionPromptSurfaceSetting.value = 'transcript';
        const { AgentInput } = await import('./AgentInput');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AgentInput
                    placeholder="x"
                    value=""
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    sessionId="s1"
                    {...({ userActionRequests: [{ id: 'q1', tool: 'AskUserQuestion', kind: 'user_action', arguments: { questions: [{ header: 'Mode', question: 'Create?', options: [{ label: 'Yes', description: 'Create it' }], multiSelect: false }] }, createdAt: 1 }] } as any)}
                    connectionStatus={null as any}
                />)).tree;

        expect(tree.findAllByType('UserActionPromptCard' as any)).toHaveLength(0);
        expect(tree.root.findAllByProps({ testID: 'agentInput.permissionRequests.chrome' })).toHaveLength(0);
        act(() => tree.unmount());
    });

    it('does not show user action cards for legacy requests without an explicit kind', async () => {
        permissionPromptSurfaceSetting.value = 'composer';
        const { AgentInput } = await import('./AgentInput');
        let tree!: renderer.ReactTestRenderer;
        tree = (await renderScreen(<AgentInput
                    placeholder="x"
                    value=""
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    sessionId="s1"
                    {...({ userActionRequests: [{ id: 'q1', tool: 'AskUserQuestion', arguments: { questions: [{ header: 'Mode', question: 'Create?', options: [{ label: 'Yes', description: 'Create it' }], multiSelect: false }] }, createdAt: 1 }] } as any)}
                    connectionStatus={null as any}
                />)).tree;

        expect(tree.findAllByType('UserActionPromptCard' as any)).toHaveLength(0);
        act(() => tree.unmount());
    });
});
