import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastModelPickerOverlayProps: any = null;
let mockSessionModePickerControl: any = null;
const modalShowMock = vi.fn();
let lastPopoverProps: any = null;
let mockAgentInputActionBarLayout: 'wrap' | 'collapsed' = 'wrap';

function nodeContainsExactText(node: renderer.ReactTestInstance, value: string): boolean {
    return node.children.some((child) => {
        if (typeof child === 'string') return child === value;
        return child && typeof child === 'object' && 'children' in child
            ? nodeContainsExactText(child as any, value)
            : false;
    });
}

function findTextNode(tree: renderer.ReactTestRenderer, value: string): renderer.ReactTestInstance | undefined {
    return tree.root.findAll((node) => (
        typeof node.type === 'string' &&
        String(node.type) === 'Text' &&
        nodeContainsExactText(node, value)
    ))[0];
}

function findPressableByLabel(tree: renderer.ReactTestRenderer, label: string): renderer.ReactTestInstance | undefined {
    return tree.root.findAll((node) => (
        typeof node.type === 'string' &&
        String(node.type) === 'Pressable' &&
        nodeContainsExactText(node, label)
    ))[0];
}

function findPressableByAccessibilityLabel(tree: renderer.ReactTestRenderer, label: string): renderer.ReactTestInstance | undefined {
    return tree.root.findAll((node) => (
        typeof node.type === 'string' &&
        String(node.type) === 'Pressable' &&
        typeof (node.props as any)?.accessibilityLabel === 'string' &&
        (node.props as any).accessibilityLabel === label
    ))[0];
}

function findIconNode(
    tree: renderer.ReactTestRenderer | renderer.ReactTestInstance,
    type: 'Ionicons' | 'Octicons',
    name: string,
): renderer.ReactTestInstance | undefined {
    const root = 'root' in tree ? tree.root : tree;
    return root.findAll((node: renderer.ReactTestInstance) => (
        typeof node.type === 'string' &&
        String(node.type) === type &&
        (node.props as any)?.name === name
    ))[0];
}

function findSettingsPressable(tree: renderer.ReactTestRenderer): renderer.ReactTestInstance | null {
    const gearIcons = tree.root.findAll(
        (node) => String(node.type) === 'Octicons' && (node.props as any)?.name === 'gear',
    );
    const gearIcon = gearIcons[0] ?? null;
    if (!gearIcon) return null;
    let current: any = gearIcon;
    while (current && String(current.type) !== 'Pressable') {
        current = current.parent;
    }
    return current ?? null;
}

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

vi.mock('@/text', () => ({
    t: (key: string, params?: { name?: string }) => {
        if (key === 'agentInput.mode.badgeA11y') return `Mode: ${params?.name ?? ''}`;
        return key;
    },
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
    return {
        ...actual,
    useSetting: (key: string) => {
        if (key === 'profiles') return [];
        if (key === 'agentInputEnterToSend') return true;
        if (key === 'agentInputActionBarLayout') return mockAgentInputActionBarLayout;
        if (key === 'agentInputChipDensity') return 'labels';
        if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
        return null;
    },
    useSettings: () => ({
        profiles: [],
        agentInputEnterToSend: true,
        agentInputActionBarLayout: mockAgentInputActionBarLayout,
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
    getStorage: () => (selector: any) => selector({ sessionMessages: {}, localSettings: { uiFontScale: 1 } }),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex', 'claude', 'opencode', 'gemini'],
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({
        displayNameKey: 'agents.codex',
        toolRendering: { hideUnknownToolsByDefault: false },
        connectedService: { id: 'codex', name: 'Codex' },
        flavorAliases: [],
        availability: { experimental: false },
        model: {
            supportsSelection: true,
            supportsFreeform: false,
            allowedModes: [],
            defaultMode: 'default',
            nonAcpApplyScope: 'spawn_only',
            acpApplyBehavior: 'none',
        },
    }),
}));

vi.mock('@/sync/domains/models/modelOptions', () => ({
    getModelOptionsForSession: (_agentId: string, metadata: any) => {
        const state = metadata?.sessionModelsV1 ?? metadata?.acpSessionModelsV1 ?? null;
        const hasDynamic =
            state &&
            state.provider === 'codex' &&
            Array.isArray(state.availableModels) &&
            state.availableModels.length > 0;
        if (!hasDynamic) {
            return [{ value: 'default', label: 'Default (from session)', description: '' }];
        }
        return [
            { value: 'default', label: 'Default (from session)', description: '' },
            { value: 'session-model', label: 'Session Model', description: '' },
        ];
    },
    supportsFreeformModelSelectionForSession: () => false,
}));

vi.mock('@/sync/domains/models/describeEffectiveModelMode', () => ({
    describeEffectiveModelMode: () => ({ effectiveModelId: 'default', applyScope: 'spawn_only', notes: [] }),
}));

vi.mock('@/sync/domains/permissions/permissionModeOptions', () => ({
    getPermissionModeBadgeLabelForAgentType: () => 'Default',
    getPermissionModeLabelForAgentType: () => 'Default',
    getPermissionModeOptionsForSession: () => [{ value: 'default', label: 'Default' }],
    getPermissionModeTitleForAgentType: () => 'Permissions',
}));

vi.mock('@/sync/domains/permissions/describeEffectivePermissionMode', () => ({
    describeEffectivePermissionMode: () => ({ effectiveMode: 'default', notes: [] }),
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
    Popover: (props: any) => {
        lastPopoverProps = props;
        if (!props.open) return null;
        return typeof props.children === 'function'
            ? props.children({ maxHeight: 600 })
            : props.children ?? null;
    },
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: any) => React.createElement('FloatingOverlay', props, props.children ?? null),
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
    ModelPickerOverlay: (props: any) => {
        lastModelPickerOverlayProps = props;
        return React.createElement('ModelPickerOverlay', props, null);
    },
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn(), prompt: vi.fn(), show: (...args: any[]) => modalShowMock(...args) },
}));

vi.mock('@/sync/acp/sessionModeControl', () => ({
    computeSessionModePickerControl: () => mockSessionModePickerControl,
}));

vi.mock('@/sync/acp/configOptionsControl', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/acp/configOptionsControl')>();
    return {
        ...actual,
        computeAcpConfigOptionControls: () => null,
    };
});

vi.mock('./components/PermissionModePicker', () => ({
    PermissionModePicker: () => null,
}));

describe('AgentInput (modelOptionsOverride)', () => {
    it('prefers modelOptionsOverride over getModelOptionsForSession()', async () => {
        const { AgentInput } = await import('./AgentInput');

        lastModelPickerOverlayProps = null;

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
                    agentType: 'codex',
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                    modelOptionsOverride: [
                        { value: 'default', label: 'Default (override)', description: '' },
                        { value: 'override-model', label: 'Override Model', description: '' },
                    ],
                }),
            );
        });

        expect(findSettingsPressable(tree!)).toBeNull();
        const agentChip = tree!.root.findByProps({ testID: 'agent-input-agent-chip' });

        await act(async () => {
            agentChip.props.onPress();
        });

        expect(lastModelPickerOverlayProps).not.toBeNull();
        expect((lastModelPickerOverlayProps.options ?? []).map((o: any) => o.value)).toEqual(['default', 'override-model']);
    });

    it('passes probe state through to ModelPickerOverlay when provided', async () => {
        const { AgentInput } = await import('./AgentInput');

        lastModelPickerOverlayProps = null;
        const onRefresh = vi.fn();

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
                    agentType: 'codex',
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                    modelOptionsOverride: [
                        { value: 'default', label: 'Default (override)', description: '' },
                    ],
                    modelOptionsOverrideProbe: { phase: 'loading', onRefresh },
                } as any),
            );
        });

        expect(findSettingsPressable(tree!)).toBeNull();
        const agentChip = tree!.root.findByProps({ testID: 'agent-input-agent-chip' });

        await act(async () => {
            agentChip.props.onPress();
        });

        expect(lastModelPickerOverlayProps?.probe?.phase).toBe('loading');
        expect(lastModelPickerOverlayProps?.probe?.onRefresh).toBe(onRefresh);
    });

    it('shows a loading probe when session models are expected but not yet available', async () => {
        const { AgentInput } = await import('./AgentInput');

        lastModelPickerOverlayProps = null;

        const metadata = {
            flavor: null,
            acpSessionModelsV1: {
                v: 1,
                provider: 'codex',
                updatedAt: 1,
                currentModelId: 'default',
                availableModels: [],
            },
        } as any;

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
                    agentType: 'codex',
                    metadata,
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                } as any),
            );
        });

        expect(findSettingsPressable(tree!)).toBeNull();
        const agentChip = tree!.root.findByProps({ testID: 'agent-input-agent-chip' });

        await act(async () => {
            agentChip.props.onPress();
        });

        expect(lastModelPickerOverlayProps?.probe?.phase).toBe('loading');
        expect((lastModelPickerOverlayProps?.options ?? []).map((o: any) => o.value)).toEqual(['default']);
    });

    it('shows a loading probe when generic session-control model metadata is present but empty', async () => {
        const { AgentInput } = await import('./AgentInput');

        lastModelPickerOverlayProps = null;

        const metadata = {
            flavor: null,
            sessionModelsV1: {
                v: 1,
                provider: 'codex',
                updatedAt: 1,
                currentModelId: 'default',
                availableModels: [],
            },
        } as any;

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
                    agentType: 'codex',
                    metadata,
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                } as any),
            );
        });

        expect(findSettingsPressable(tree!)).toBeNull();
        const agentChip = tree!.root.findByProps({ testID: 'agent-input-agent-chip' });

        await act(async () => {
            agentChip.props.onPress();
        });

        expect(lastModelPickerOverlayProps?.probe?.phase).toBe('loading');
        expect((lastModelPickerOverlayProps?.options ?? []).map((o: any) => o.value)).toEqual(['default']);
    });

    it('clears the loading probe once session models are available', async () => {
        const { AgentInput } = await import('./AgentInput');

        lastModelPickerOverlayProps = null;

        const metadataLoading = {
            flavor: null,
            acpSessionModelsV1: {
                v: 1,
                provider: 'codex',
                updatedAt: 1,
                currentModelId: 'default',
                availableModels: [],
            },
        } as any;

        const metadataLoaded = {
            ...metadataLoading,
            acpSessionModelsV1: {
                ...metadataLoading.acpSessionModelsV1,
                updatedAt: 2,
                availableModels: [{ id: 'session-model', name: 'Session Model' }],
            },
        } as any;

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
                    agentType: 'codex',
                    metadata: metadataLoading,
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                } as any),
            );
        });

        expect(findSettingsPressable(tree!)).toBeNull();
        const agentChip = tree!.root.findByProps({ testID: 'agent-input-agent-chip' });

        await act(async () => {
            agentChip.props.onPress();
        });

        expect(lastModelPickerOverlayProps?.probe?.phase).toBe('loading');

        await act(async () => {
            tree!.update(
                React.createElement(AgentInput, {
                    value: 'hello',
                    placeholder: 'placeholder',
                    onChangeText: () => {},
                    onSend: () => {},
                    autocompletePrefixes: [],
                    autocompleteSuggestions: async () => [],
                    agentType: 'codex',
                    metadata: metadataLoaded,
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                } as any),
            );
        });

        expect(lastModelPickerOverlayProps?.probe).toBeUndefined();
        expect((lastModelPickerOverlayProps?.options ?? []).map((o: any) => o.value)).toEqual(['default', 'session-model']);
    });

    it('keeps the previous model list visible while refreshing if the session list temporarily clears', async () => {
        const { AgentInput } = await import('./AgentInput');

        lastModelPickerOverlayProps = null;

        const metadataLoaded = {
            flavor: null,
            acpSessionModelsV1: {
                v: 1,
                provider: 'codex',
                updatedAt: 1,
                currentModelId: 'default',
                availableModels: [{ id: 'session-model', name: 'Session Model' }],
            },
        } as any;

        const metadataRefreshing = {
            ...metadataLoaded,
            acpSessionModelsV1: {
                ...metadataLoaded.acpSessionModelsV1,
                updatedAt: 2,
                availableModels: [],
            },
        } as any;

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
                    agentType: 'codex',
                    metadata: metadataLoaded,
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                } as any),
            );
        });

        expect(findSettingsPressable(tree!)).toBeNull();
        const agentChip = tree!.root.findByProps({ testID: 'agent-input-agent-chip' });

        await act(async () => {
            agentChip.props.onPress();
        });

        expect((lastModelPickerOverlayProps?.options ?? []).map((o: any) => o.value)).toEqual(['default', 'session-model']);
        expect(lastModelPickerOverlayProps?.probe).toBeUndefined();

        await act(async () => {
            tree!.update(
                React.createElement(AgentInput, {
                    value: 'hello',
                    placeholder: 'placeholder',
                    onChangeText: () => {},
                    onSend: () => {},
                    autocompletePrefixes: [],
                    autocompleteSuggestions: async () => [],
                    agentType: 'codex',
                    metadata: metadataRefreshing,
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                } as any),
            );
        });

        expect(lastModelPickerOverlayProps?.probe?.phase).toBe('refreshing');
        expect((lastModelPickerOverlayProps?.options ?? []).map((o: any) => o.value)).toEqual(['default', 'session-model']);
    });

    it('renders an ACP session mode picker from preflight override options when provided', async () => {
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
                    agentType: 'opencode',
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                    acpSessionModeOptionsOverride: [
                        { id: 'default', name: 'Default' },
                        { id: 'plan', name: 'Plan' },
                        { id: 'build', name: 'Build' },
                    ],
                    acpSessionModeSelectedIdOverride: null,
                    onAcpSessionModeChange: () => {},
                } as any),
            );
        });

        expect(findSettingsPressable(tree!)).toBeNull();
        const agentChip = tree!.root.findByProps({ testID: 'agent-input-agent-chip' });

        await act(async () => {
            agentChip.props.onPress();
        });

        expect(() => tree!.root.findByProps({ testID: 'agent-input-chip-picker-popover' })).not.toThrow();
        expect(findTextNode(tree!, 'agentInput.mode.sectionTitle')).toBeTruthy();
        expect(findPressableByLabel(tree!, 'Plan')).toBeTruthy();
        expect(findPressableByLabel(tree!, 'Build')).toBeTruthy();
        expect(() => tree!.root.findByProps({ testID: 'agent-input-session-mode-option:plan' })).not.toThrow();
        expect(() => tree!.root.findByProps({ testID: 'agent-input-session-mode-option:build' })).not.toThrow();
    });

    it('calls onAcpSessionModeChange when selecting a preflight ACP mode', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onAcpSessionModeChange = vi.fn();

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
                    agentType: 'opencode',
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                    acpSessionModeOptionsOverride: [
                        { id: 'default', name: 'Default' },
                        { id: 'plan', name: 'Plan' },
                    ],
                    acpSessionModeSelectedIdOverride: null,
                    onAcpSessionModeChange,
                } as any),
            );
        });

        expect(findSettingsPressable(tree!)).toBeNull();
        const agentChip = tree!.root.findByProps({ testID: 'agent-input-agent-chip' });

        await act(async () => {
            agentChip.props.onPress();
        });

        const plan = findPressableByLabel(tree!, 'Plan');
        expect(plan).toBeTruthy();

        await act(async () => {
            plan!.props.onPress();
        });

        expect(onAcpSessionModeChange).toHaveBeenCalledWith('plan');
    });

    it('opens the ACP mode picker in the shared chip popover even when selectable options are within the former cycle threshold', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onAcpSessionModeChange = vi.fn();
        modalShowMock.mockReset();

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
                    agentType: 'opencode',
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                    acpSessionModeOptionsOverride: [
                        { id: 'default', name: 'Default' },
                        { id: 'plan', name: 'Plan' },
                        { id: 'build', name: 'Build' },
                    ],
                    acpSessionModeSelectedIdOverride: 'build',
                    onAcpSessionModeChange,
                } as any),
            );
        });

        const modeChip = findPressableByAccessibilityLabel(tree!, 'Build');
        expect(modeChip).toBeTruthy();
        expect(nodeContainsExactText(modeChip!, 'Build')).toBe(true);
        expect(findIconNode(modeChip!, 'Octicons', 'rocket')).toBeTruthy();
        expect(findIconNode(modeChip!, 'Ionicons', 'list-outline')).toBeUndefined();

        await act(async () => {
            modeChip!.props.onPress();
        });

        expect(onAcpSessionModeChange).not.toHaveBeenCalled();
        expect(modalShowMock).not.toHaveBeenCalled();
        expect(() => tree!.root.findByProps({ testID: 'agent-input-simple-options-popover' })).not.toThrow();
        expect(() => tree!.root.findByProps({ testID: 'agent-input-simple-option:plan' })).not.toThrow();
        expect(() => tree!.root.findByProps({ testID: 'agent-input-simple-option:build' })).not.toThrow();

        await act(async () => {
            tree!.root.findByProps({ testID: 'agent-input-simple-option:plan' }).props.onPress();
        });

        expect(onAcpSessionModeChange).toHaveBeenCalledWith('plan');
    });

    it('keeps the existing list icon and bare mode label when the selected ACP mode is Plan', async () => {
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
                    agentType: 'opencode',
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                    acpSessionModeOptionsOverride: [
                        { id: 'default', name: 'Build' },
                        { id: 'plan', name: 'Plan' },
                    ],
                    acpSessionModeSelectedIdOverride: 'plan',
                    onAcpSessionModeChange: () => {},
                } as any),
            );
        });

        const modeChip = findPressableByAccessibilityLabel(tree!, 'Plan');
        expect(modeChip).toBeTruthy();
        expect(nodeContainsExactText(modeChip!, 'Plan')).toBe(true);
        expect(findIconNode(modeChip!, 'Ionicons', 'list-outline')).toBeTruthy();
        expect(findIconNode(modeChip!, 'Octicons', 'rocket')).toBeUndefined();
    });

    it('opens ACP mode picker popover instead of cycling when selectable options exceed threshold', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onAcpSessionModeChange = vi.fn();
        modalShowMock.mockReset();

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
                    agentType: 'opencode',
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                    acpSessionModeOptionsOverride: [
                        { id: 'default', name: 'Default' },
                        { id: 'plan', name: 'Plan' },
                        { id: 'build', name: 'Build' },
                        { id: 'review', name: 'Review' },
                    ],
                    acpSessionModeSelectedIdOverride: null,
                    onAcpSessionModeChange,
                } as any),
            );
        });

        const modeChip = findPressableByAccessibilityLabel(tree!, 'Default');
        expect(modeChip).toBeTruthy();

        await act(async () => {
            modeChip!.props.onPress();
        });

        expect(onAcpSessionModeChange).not.toHaveBeenCalled();
        expect(modalShowMock).not.toHaveBeenCalled();
        expect(() => tree!.root.findByProps({ testID: 'agent-input-simple-options-popover' })).not.toThrow();
        expect(() => tree!.root.findByProps({ testID: 'agent-input-simple-option:review' })).not.toThrow();

        await act(async () => {
            tree!.root.findByProps({ testID: 'agent-input-simple-option:build' }).props.onPress();
        });
        expect(onAcpSessionModeChange).toHaveBeenCalledWith('build');
    });

    it('opens env chip popover content instead of invoking the legacy env click callback when custom content exists', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onEnvVarsClick = vi.fn();

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
                    agentType: 'codex',
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                    envVarsCount: 2,
                    onEnvVarsClick,
                    envVarsPopover: {
                        renderContent: ({ requestClose }: { requestClose: () => void }) => React.createElement(
                            'Pressable',
                            { testID: 'env-vars-close-button', onPress: requestClose },
                            null,
                        ),
                    },
                } as any),
            );
        });

        const envVarsChip = findPressableByLabel(tree!, 'agentInput.envVars.title');
        expect(envVarsChip).toBeTruthy();

        await act(async () => {
            envVarsChip!.props.onPress();
        });

        expect(onEnvVarsClick).not.toHaveBeenCalled();
        expect(() => tree!.root.findByProps({ testID: 'agent-input-content-popover' })).not.toThrow();
        expect(() => tree!.root.findByProps({ testID: 'env-vars-close-button' })).not.toThrow();

        await act(async () => {
            tree!.root.findByProps({ testID: 'env-vars-close-button' }).props.onPress();
        });

        expect(() => tree!.root.findByProps({ testID: 'agent-input-content-popover' })).toThrow();
    });

    it('opens profile chip popover content instead of invoking the legacy profile click callback when custom content exists', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onProfileClick = vi.fn();

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
                    agentType: 'codex',
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                    onProfileClick,
                    profilePopover: {
                        renderContent: ({ requestClose }: { requestClose: () => void }) => React.createElement(
                            'Pressable',
                            { testID: 'profile-close-button', onPress: requestClose },
                            null,
                        ),
                    },
                } as any),
            );
        });

        const profileChip = findPressableByLabel(tree!, 'profiles.noProfile');
        expect(profileChip).toBeTruthy();

        await act(async () => {
            profileChip!.props.onPress();
        });

        expect(onProfileClick).not.toHaveBeenCalled();
        expect(() => tree!.root.findByProps({ testID: 'agent-input-content-popover' })).not.toThrow();
        expect(() => tree!.root.findByProps({ testID: 'profile-close-button' })).not.toThrow();

        await act(async () => {
            tree!.root.findByProps({ testID: 'profile-close-button' }).props.onPress();
        });

        expect(() => tree!.root.findByProps({ testID: 'agent-input-content-popover' })).toThrow();
    });

    it('opens the permission chip with the shared popover instead of invoking the legacy permission click callback', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onPermissionClick = vi.fn();

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
                    agentType: 'codex',
                    permissionMode: 'default',
                    onPermissionClick,
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                } as any),
            );
        });

        const permissionChip = tree!.root.findByProps({ testID: 'agent-input-permission-chip' });

        await act(async () => {
            permissionChip.props.onPress();
        });

        expect(onPermissionClick).not.toHaveBeenCalled();
        expect(() => tree!.root.findByProps({ testID: 'agent-input-content-popover' })).not.toThrow();
    });

    it('closes the collapsed action menu when opening the permission chip popover', async () => {
        const { AgentInput } = await import('./AgentInput');
        mockAgentInputActionBarLayout = 'collapsed';

        try {
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
                        agentType: 'codex',
                        permissionMode: 'default',
                        onPermissionModeChange: () => {},
                        modelMode: 'default',
                        onModelModeChange: () => {},
                    } as any),
                );
            });

            const settings = findSettingsPressable(tree!);
            expect(settings).toBeTruthy();

            await act(async () => {
                settings!.props.onPress();
            });

            expect(() => tree!.root.findByProps({ testID: 'agent-input-action-menu-overlay' })).not.toThrow();

            const permissionChip = tree!.root.findByProps({ testID: 'agent-input-permission-chip' });
            await act(async () => {
                permissionChip.props.onPress();
            });

            expect(() => tree!.root.findByProps({ testID: 'agent-input-action-menu-overlay' })).toThrow();
            expect(() => tree!.root.findByProps({ testID: 'agent-input-content-popover' })).not.toThrow();
        } finally {
            mockAgentInputActionBarLayout = 'wrap';
        }
    });

    it('reopens collapsed settings through the shared content popover transport after closing the permission chip popover', async () => {
        const { AgentInput } = await import('./AgentInput');
        mockAgentInputActionBarLayout = 'collapsed';

        try {
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
                        agentType: 'codex',
                        permissionMode: 'default',
                        onPermissionModeChange: () => {},
                        modelMode: 'default',
                        onModelModeChange: () => {},
                    } as any),
                );
            });

            const permissionChip = tree!.root.findByProps({ testID: 'agent-input-permission-chip' });
            await act(async () => {
                permissionChip.props.onPress();
            });

            expect(() => tree!.root.findByProps({ testID: 'agent-input-content-popover' })).not.toThrow();

            const settings = findSettingsPressable(tree!);
            expect(settings).toBeTruthy();

            await act(async () => {
                settings!.props.onPress();
            });

            expect(() => tree!.root.findByProps({ testID: 'agent-input-content-popover' })).not.toThrow();
            expect(() => tree!.root.findByProps({ testID: 'agent-input-action-menu-overlay' })).not.toThrow();
        } finally {
            mockAgentInputActionBarLayout = 'wrap';
        }
    });

    it('opens the agent chip with the shared chip popover when engine picker props are provided', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onAgentPickerSelect = vi.fn();
        modalShowMock.mockReset();

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
                    agentType: 'claude',
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                    agentPickerTitle: 'Select engine',
                    agentPickerOptions: [
                        { id: 'agent:claude', label: 'Claude' },
                        { id: 'agent:codex', label: 'Codex' },
                    ],
                    agentPickerSelectedOptionId: 'agent:claude',
                    onAgentPickerSelect,
                    onAgentClick: () => {
                        throw new Error('fallback agent click should not run when picker props exist');
                    },
                } as any),
            );
        });

        const agentChip = tree!.root.findByProps({ testID: 'agent-input-agent-chip' });
        await act(async () => {
            agentChip.props.onPress();
        });

        expect(modalShowMock).not.toHaveBeenCalled();
        expect(() => tree!.root.findByProps({ testID: 'agent-input-chip-picker-popover' })).not.toThrow();

        await act(async () => {
            tree!.root.findByProps({ testID: 'agent-input-chip-picker.option:agent:codex' }).props.onPress();
        });

        expect(onAgentPickerSelect).toHaveBeenCalledWith('agent:codex');
    });

    it('closes the permission popover before showing the shared engine picker in wrap layout', async () => {
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
                    agentType: 'claude',
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                    agentPickerTitle: 'Select engine',
                    agentPickerOptions: [
                        { id: 'agent:claude', label: 'Claude' },
                        { id: 'agent:codex', label: 'Codex' },
                    ],
                    agentPickerSelectedOptionId: 'agent:claude',
                    onAgentPickerSelect: () => {},
                } as any),
            );
        });

        expect(findSettingsPressable(tree!)).toBeNull();

        const agentChip = tree!.root.findByProps({ testID: 'agent-input-agent-chip' });

        const permissionChip = tree!.root.findByProps({ testID: 'agent-input-permission-chip' });
        await act(async () => {
            permissionChip.props.onPress();
        });

        expect(() => tree!.root.findByProps({ testID: 'agent-input-content-popover' })).not.toThrow();

        await act(async () => {
            agentChip.props.onPress();
        });

        expect(() => tree!.root.findByProps({ testID: 'agent-input-content-popover' })).toThrow();
        expect(() => tree!.root.findByProps({ testID: 'agent-input-chip-picker-popover' })).not.toThrow();
    });

    it('prefers the shared live engine picker over the legacy agent click callback when live model access exists', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onAgentClick = vi.fn();
        lastModelPickerOverlayProps = null;

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
                    agentType: 'codex',
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                    onAgentClick,
                    metadata: {
                        sessionModelsV1: {
                            provider: 'codex',
                            availableModels: [
                                { id: 'session-model', name: 'Session Model' },
                            ],
                        },
                    },
                } as any),
            );
        });

        const agentChip = tree!.root.findByProps({ testID: 'agent-input-agent-chip' });
        await act(async () => {
            agentChip.props.onPress();
        });

        expect(onAgentClick).not.toHaveBeenCalled();
        expect(() => tree!.root.findByProps({ testID: 'agent-input-chip-picker-popover' })).not.toThrow();
        expect((lastModelPickerOverlayProps?.options ?? []).map((o: any) => o.value)).toEqual(['default', 'session-model']);
    });

    it('opens the agent chip with a live engine detail picker when model selection is available', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onModelModeChange = vi.fn();
        lastModelPickerOverlayProps = null;
        lastPopoverProps = null;

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
                    agentType: 'codex',
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange,
                    metadata: {
                        sessionModelsV1: {
                            provider: 'codex',
                            availableModels: [
                                { id: 'session-model', name: 'Session Model' },
                            ],
                        },
                    },
                } as any),
            );
        });

        const agentChip = tree!.root.findByProps({ testID: 'agent-input-agent-chip' });
        expect(agentChip).toBeTruthy();

        await act(async () => {
            agentChip.props.onPress();
        });

        expect(() => tree!.root.findByProps({ testID: 'agent-input-chip-picker-popover' })).not.toThrow();
        expect(lastPopoverProps?.anchorRef).toBe(agentChip.props.ref);
        expect((lastModelPickerOverlayProps?.options ?? []).map((o: any) => o.value)).toEqual(['default', 'session-model']);

        await act(async () => {
            lastModelPickerOverlayProps.onSelect('session-model');
        });

        expect(onModelModeChange).toHaveBeenCalledWith('session-model');
    });

    it('uses the collapsed settings action as a launcher for the shared engine picker when agent picker options exist', async () => {
        const { AgentInput } = await import('./AgentInput');
        mockAgentInputActionBarLayout = 'collapsed';
        lastModelPickerOverlayProps = null;
        lastPopoverProps = null;

        try {
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
                        agentType: 'codex',
                        permissionMode: 'default',
                        onPermissionModeChange: () => {},
                        modelMode: 'default',
                        onModelModeChange: () => {},
                        metadata: {
                            sessionModelsV1: {
                                provider: 'codex',
                                availableModels: [
                                    { id: 'session-model', name: 'Session Model' },
                                ],
                            },
                        },
                    } as any),
                );
            });

            const settings = findSettingsPressable(tree!);
            expect(settings).toBeTruthy();

            await act(async () => {
                settings!.props.onPress();
            });

            expect(() => tree!.root.findByProps({ testID: 'agent-input-action-menu-overlay' })).not.toThrow();
            expect(lastModelPickerOverlayProps).toBeNull();

            const engineAction = findPressableByLabel(tree!, 'agents.codex');
            expect(engineAction).toBeTruthy();

            await act(async () => {
                engineAction!.props.onPress();
            });

            expect(() => tree!.root.findByProps({ testID: 'agent-input-action-menu-overlay' })).toThrow();
            expect(() => tree!.root.findByProps({ testID: 'agent-input-chip-picker-popover' })).not.toThrow();
            expect(lastPopoverProps?.anchorRef).toBe(settings!.props.ref);
            expect((lastModelPickerOverlayProps?.options ?? []).map((o: any) => o.value)).toEqual(['default', 'session-model']);
        } finally {
            mockAgentInputActionBarLayout = 'wrap';
        }
    });

    it('uses the collapsed settings action as a launcher for the shared session mode popover', async () => {
        const { AgentInput } = await import('./AgentInput');
        mockAgentInputActionBarLayout = 'collapsed';
        lastPopoverProps = null;
        mockSessionModePickerControl = {
            options: [
                { id: 'build', name: 'Build', description: 'Default behavior' },
                { id: 'plan', name: 'Plan', description: 'Think first' },
            ],
            currentModeId: 'build',
            currentModeName: 'Build',
            requestedModeId: null,
            requestedModeName: null,
            effectiveModeId: 'build',
            effectiveModeName: 'Build',
            isPending: false,
            label: 'Build',
            selectedId: 'build',
        };
        const onAcpSessionModeChange = vi.fn();

        try {
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
                        agentType: 'codex',
                        permissionMode: 'default',
                        onPermissionModeChange: () => {},
                        onAcpSessionModeChange,
                    } as any),
                );
            });

            const settings = findSettingsPressable(tree!);
            expect(settings).toBeTruthy();

            await act(async () => {
                settings!.props.onPress();
            });

            expect(() => tree!.root.findByProps({ testID: 'agent-input-action-menu-overlay' })).not.toThrow();
            expect(findTextNode(tree!, 'agentInput.mode.sectionTitle')).toBeUndefined();

            const modeAction = findPressableByLabel(tree!, 'Build');
            expect(modeAction).toBeTruthy();

            await act(async () => {
                modeAction!.props.onPress();
            });

            expect(() => tree!.root.findByProps({ testID: 'agent-input-action-menu-overlay' })).toThrow();
            expect(() => tree!.root.findByProps({ testID: 'agent-input-simple-options-popover' })).not.toThrow();
            expect(lastPopoverProps?.anchorRef).toBe(settings!.props.ref);

            await act(async () => {
                tree!.root.findByProps({ testID: 'agent-input-simple-option:plan' }).props.onPress();
            });

            expect(onAcpSessionModeChange).toHaveBeenCalledWith('plan');
        } finally {
            mockSessionModePickerControl = null;
            mockAgentInputActionBarLayout = 'wrap';
        }
    });

    it('renders preflight session mode controls for Claude even when static session modes exist', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onRefresh = vi.fn();
        mockSessionModePickerControl = {
            options: [
                { id: 'default', name: 'Build', description: 'Default behavior' },
                { id: 'plan', name: 'Plan', description: 'Think first' },
            ],
            currentModeId: 'default',
            currentModeName: 'Build',
            requestedModeId: null,
            requestedModeName: null,
            effectiveModeId: 'default',
            effectiveModeName: 'Build',
            isPending: false,
        };

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
                    agentType: 'claude',
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                    acpSessionModeOptionsOverride: [
                        { id: 'default', name: 'Build' },
                        { id: 'plan', name: 'Plan' },
                    ],
                    acpSessionModeSelectedIdOverride: 'plan',
                    acpSessionModeOptionsOverrideProbe: { phase: 'idle', onRefresh },
                    onAcpSessionModeChange: () => {},
                } as any),
            );
        });

        expect(findSettingsPressable(tree!)).toBeNull();
        const agentChip = tree!.root.findByProps({ testID: 'agent-input-agent-chip' });

        await act(async () => {
            agentChip.props.onPress();
        });

        expect(findTextNode(tree!, 'agentInput.mode.sectionTitle')).toBeTruthy();
        expect(findPressableByAccessibilityLabel(tree!, 'agentInput.mode.refreshModesA11y')).toBeTruthy();

        mockSessionModePickerControl = null;
    });

    it('calls refresh handler for preflight ACP mode lists when provided', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onRefresh = vi.fn();

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
                    agentType: 'opencode',
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                    acpSessionModeOptionsOverride: [
                        { id: 'default', name: 'Default' },
                        { id: 'plan', name: 'Plan' },
                    ],
                    acpSessionModeSelectedIdOverride: null,
                    acpSessionModeOptionsOverrideProbe: { phase: 'idle', onRefresh },
                    onAcpSessionModeChange: () => {},
                } as any),
            );
        });

        expect(findSettingsPressable(tree!)).toBeNull();
        const agentChip = tree!.root.findByProps({ testID: 'agent-input-agent-chip' });

        await act(async () => {
            agentChip.props.onPress();
        });

        const refresh = findPressableByAccessibilityLabel(tree!, 'agentInput.mode.refreshModesA11y');
        expect(refresh).toBeTruthy();
        expect(refresh?.props?.testID).toBe('agent-input-session-mode-refresh');

        await act(async () => {
            refresh!.props.onPress();
        });

        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('renders preflight ACP config options in the agent picker and applies local overrides', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onAcpConfigOptionChange = vi.fn();

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
                    agentType: 'codex',
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                    acpConfigOptionsOverride: [
                        {
                            id: 'speed',
                            name: 'Speed',
                            type: 'select',
                            currentValue: 'standard',
                            options: [
                                { value: 'standard', name: 'Standard' },
                                { value: 'fast', name: 'Fast' },
                            ],
                        },
                    ],
                    acpConfigOptionOverridesOverride: {
                        v: 1,
                        updatedAt: 123,
                        overrides: {
                            speed: { updatedAt: 123, value: 'fast' },
                        },
                    },
                    onAcpConfigOptionChange,
                } as any),
            );
        });

        expect(findSettingsPressable(tree!)).toBeNull();
        const agentChip = tree!.root.findByProps({ testID: 'agent-input-agent-chip' });

        await act(async () => {
            agentChip.props.onPress();
        });

        expect(() => tree!.root.findByProps({ testID: 'agent-input-config-option:speed' })).not.toThrow();
        expect(findTextNode(tree!, 'agentInput.acp.optionsSectionTitle')).toBeTruthy();
        expect(findTextNode(tree!, 'Speed')).toBeTruthy();
        expect(findTextNode(tree!, 'agentInput.acp.pendingValue')).toBeTruthy();

        const fast = tree!.root.findByProps({ testID: 'agent-input-config-option-option:speed:fast' });
        await act(async () => {
            fast.props.onPress();
        });

        expect(onAcpConfigOptionChange).toHaveBeenCalledWith('speed', 'fast');
    });

    it('renders a config-options loading affordance when ACP config preflight is still loading', async () => {
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
                    agentType: 'codex',
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                    acpConfigOptionsOverrideProbe: { phase: 'loading', onRefresh: () => {} },
                    onAcpConfigOptionChange: () => {},
                } as any),
            );
        });

        expect(findSettingsPressable(tree!)).toBeNull();
        const agentChip = tree!.root.findByProps({ testID: 'agent-input-agent-chip' });

        await act(async () => {
            agentChip.props.onPress();
        });

        expect(findTextNode(tree!, 'agentInput.acp.optionsSectionTitle')).toBeTruthy();
        expect(() => tree!.root.findByProps({ testID: 'agent-input-config-options-refresh' })).not.toThrow();
    });

    it('calls refresh handler for preflight ACP config options when no options are loaded yet', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onRefresh = vi.fn();

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
                    agentType: 'codex',
                    permissionMode: 'default',
                    onPermissionModeChange: () => {},
                    modelMode: 'default',
                    onModelModeChange: () => {},
                    acpConfigOptionsOverrideProbe: { phase: 'idle', onRefresh },
                    onAcpConfigOptionChange: () => {},
                } as any),
            );
        });

        expect(findSettingsPressable(tree!)).toBeNull();
        const agentChip = tree!.root.findByProps({ testID: 'agent-input-agent-chip' });

        await act(async () => {
            agentChip.props.onPress();
        });

        const refresh = tree!.root.findByProps({ testID: 'agent-input-config-options-refresh' });
        expect(typeof refresh.props.onPress).toBe('function');

        await act(async () => {
            refresh.props.onPress();
        });

        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

});
