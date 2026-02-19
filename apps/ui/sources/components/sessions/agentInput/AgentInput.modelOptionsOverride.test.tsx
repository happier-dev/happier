import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import renderer, { act } from 'react-test-renderer';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastModelPickerOverlayProps: any = null;

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
        node.type === 'Text' &&
        nodeContainsExactText(node, value)
    ))[0];
}

function findPressableByLabel(tree: renderer.ReactTestRenderer, label: string): renderer.ReactTestInstance | undefined {
    return tree.root.findAll((node) => (
        typeof node.type === 'string' &&
        node.type === 'Pressable' &&
        nodeContainsExactText(node, label)
    ))[0];
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

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
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
        const state = metadata?.acpSessionModelsV1 ?? null;
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
    Modal: { alert: vi.fn(), prompt: vi.fn() },
}));

vi.mock('@/sync/acp/sessionModeControl', () => ({
    computeAcpPlanModeControl: () => null,
    computeAcpSessionModePickerControl: () => null,
}));

vi.mock('@/sync/acp/configOptionsControl', () => ({
    computeAcpConfigOptionControls: () => null,
}));

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

        const pressables = tree!.root.findAllByType('Pressable');
        const settings = pressables.find((p) => {
            const octicons = p.findAllByType('Octicons');
            return octicons.some((o) => (o.props as any).name === 'gear');
        });
        expect(settings).toBeTruthy();

        await act(async () => {
            settings!.props.onPress();
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

        const pressables = tree!.root.findAllByType('Pressable');
        const settings = pressables.find((p) => {
            const octicons = p.findAllByType('Octicons');
            return octicons.some((o) => (o.props as any).name === 'gear');
        });
        expect(settings).toBeTruthy();

        await act(async () => {
            settings!.props.onPress();
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

        const pressables = tree!.root.findAllByType('Pressable');
        const settings = pressables.find((p) => {
            const octicons = p.findAllByType('Octicons');
            return octicons.some((o) => (o.props as any).name === 'gear');
        });
        expect(settings).toBeTruthy();

        await act(async () => {
            settings!.props.onPress();
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

        const pressables = tree!.root.findAllByType('Pressable');
        const settings = pressables.find((p) => {
            const octicons = p.findAllByType('Octicons');
            return octicons.some((o) => (o.props as any).name === 'gear');
        });
        expect(settings).toBeTruthy();

        await act(async () => {
            settings!.props.onPress();
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

        const pressables = tree!.root.findAllByType('Pressable');
        const settings = pressables.find((p) => {
            const octicons = p.findAllByType('Octicons');
            return octicons.some((o) => (o.props as any).name === 'gear');
        });
        expect(settings).toBeTruthy();

        await act(async () => {
            settings!.props.onPress();
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

        const pressables = tree!.root.findAllByType('Pressable');
        const settings = pressables.find((p) => {
            const octicons = p.findAllByType('Octicons');
            return octicons.some((o) => (o.props as any).name === 'gear');
        });
        expect(settings).toBeTruthy();

        await act(async () => {
            settings!.props.onPress();
        });

        expect(findTextNode(tree!, 'Mode')).toBeTruthy();
        expect(findPressableByLabel(tree!, 'Plan')).toBeTruthy();
        expect(findPressableByLabel(tree!, 'Build')).toBeTruthy();
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

        const pressables = tree!.root.findAllByType('Pressable');
        const settings = pressables.find((p) => {
            const octicons = p.findAllByType('Octicons');
            return octicons.some((o) => (o.props as any).name === 'gear');
        });
        expect(settings).toBeTruthy();

        await act(async () => {
            settings!.props.onPress();
        });

        const plan = findPressableByLabel(tree!, 'Plan');
        expect(plan).toBeTruthy();

        await act(async () => {
            plan!.props.onPress();
        });

        expect(onAcpSessionModeChange).toHaveBeenCalledWith('plan');
    });
});
