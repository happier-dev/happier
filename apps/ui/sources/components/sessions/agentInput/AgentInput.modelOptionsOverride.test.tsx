import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { ReactTestInstance } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { createReducer } from '@/sync/reducer/reducer';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let lastModelPickerOverlayProps: any = null;
let mockSessionModePickerControl: any = null;
const modalShowMock = vi.fn();
const modalPromptMock = vi.fn();
let lastPopoverProps: any = null;
let mockAgentInputActionBarLayout: 'wrap' | 'collapsed' = 'wrap';
const supportsFreeformModelSelectionState = vi.hoisted(() => ({ value: false }));
const storageSettings: Settings = {
    ...settingsDefaults,
    profiles: [],
    agentInputEnterToSend: true,
    agentInputActionBarLayout: 'wrap',
    agentInputChipDensity: 'labels',
    sessionPermissionModeApplyTiming: 'immediate',
};

function findIconNode(
    tree: Awaited<ReturnType<typeof renderScreen>>['tree'] | ReactTestInstance,
    type: 'Ionicons' | 'Octicons',
    name: string,
): ReactTestInstance | undefined {
    const root = 'root' in tree ? tree.root : tree;
    return root.findAll((node: ReactTestInstance) => (
        typeof node.type === 'string' &&
        String(node.type) === type &&
        (node.props as any)?.name === name
    ))[0];
}

function collectTextContent(node: ReactTestInstance | string | number | null | undefined): string {
    if (node == null) return '';
    if (typeof node === 'string' || typeof node === 'number') {
        return String(node);
    }

    return node.children
        .map((child) => collectTextContent(child as ReactTestInstance | string | number | null | undefined))
        .join('');
}

function findPressableByText(
    scope: Pick<Awaited<ReturnType<typeof renderScreen>>['tree'] | ReactTestInstance, 'findAllByType'>,
    text: string,
): ReactTestInstance | undefined {
    return scope.findAllByType('Pressable').find((node) => collectTextContent(node).includes(text));
}

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                                    View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                        React.createElement('View', props, props.children),
                                    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                        React.createElement('Text', props, props.children),
                                    Pressable: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                        React.createElement('Pressable', props, props.children),
                                    ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                                        React.createElement('ScrollView', props, props.children),
                                    ActivityIndicator: (props: Record<string, unknown>) => React.createElement('ActivityIndicator', props, null),
                                    Platform: {
                                    OS: 'ios',
                                    select: (v: any) => v.ios,
                                },
                                    useWindowDimensions: () => ({ width: 800, height: 600 }),
                                    Dimensions: {
                                        get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
                                    },
                                }
    );
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

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({
        translate: (key: string, params?: { name?: string }) => {
            if (key === 'agentInput.mode.badgeA11y') return `Mode: ${params?.name ?? ''}`;
            return key;
        },
    });
});

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const { createStorageModuleMock, createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
    return createStorageModuleMock({
        importOriginal,
        overrides: {
            useSetting: createUseSettingMock({
                fallback: (key) => {
                    if (key === 'agentInputActionBarLayout') return mockAgentInputActionBarLayout;
                    return storageSettings[key];
                },
            }),
            useSettings: () => ({
                ...storageSettings,
                agentInputActionBarLayout: mockAgentInputActionBarLayout,
            }),
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionMessagesById: () => ({}),
            useSessionMessagesVersion: () => 0,
            useSessionMessagesReducerState: () => createReducer(),
        },
    });
});

vi.mock('@/sync/domains/state/storageStore', async () => {
    const { createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const store = createStorageStoreMock({ sessionMessages: {}, localSettings: { uiFontScale: 1 } } as any);
    return {
        getStorage: () => store,
    };
});

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
    supportsFreeformModelSelectionForSession: () => supportsFreeformModelSelectionState.value,
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

vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    const modalMock = createModalModuleMock();
    modalMock.spies.show.mockImplementation((...args) => modalShowMock(...args));
    modalMock.spies.prompt.mockImplementation((...args) => modalPromptMock(...args));
    return modalMock.module;
});

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
    beforeEach(() => {
        supportsFreeformModelSelectionState.value = false;
        modalPromptMock.mockReset();
        modalShowMock.mockReset();
        mockAgentInputActionBarLayout = 'wrap';
    });

    it('prefers modelOptionsOverride over getModelOptionsForSession()', async () => {
        const { AgentInput } = await import('./AgentInput');

        lastModelPickerOverlayProps = null;

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                }));
        expect(screen.findByTestId('agent-input-action-menu-button')).toBeNull();
        await screen.pressByTestIdAsync('agent-input-agent-chip');

        expect(lastModelPickerOverlayProps).not.toBeNull();
        expect((lastModelPickerOverlayProps.options ?? []).map((o: any) => o.value)).toEqual(['default', 'override-model']);
    });

    it('passes probe state through to ModelPickerOverlay when provided', async () => {
        const { AgentInput } = await import('./AgentInput');

        lastModelPickerOverlayProps = null;
        const onRefresh = vi.fn();

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));
        expect(screen.findByTestId('agent-input-action-menu-button')).toBeNull();
        await screen.pressByTestIdAsync('agent-input-agent-chip');

        expect(lastModelPickerOverlayProps?.probe?.phase).toBe('loading');
        expect(lastModelPickerOverlayProps?.probe?.onRefresh).toBe(onRefresh);
    });

    it('submits inline custom models through ModelPickerOverlay without opening a modal prompt', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onModelModeChange = vi.fn();
        supportsFreeformModelSelectionState.value = true;
        lastModelPickerOverlayProps = null;

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                    modelOptionsOverride: [
                        { value: 'default', label: 'Default (override)', description: '' },
                    ],
                }));

        await screen.pressByTestIdAsync('agent-input-agent-chip');

        expect(typeof lastModelPickerOverlayProps?.onSubmitCustomModel).toBe('function');

        await act(async () => {
            lastModelPickerOverlayProps.onSubmitCustomModel('custom-model');
        });

        expect(onModelModeChange).toHaveBeenCalledWith('custom-model');
        expect(modalPromptMock).not.toHaveBeenCalled();
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

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));
        expect(screen.findByTestId('agent-input-action-menu-button')).toBeNull();
        await screen.pressByTestIdAsync('agent-input-agent-chip');

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

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));
        expect(screen.findByTestId('agent-input-action-menu-button')).toBeNull();
        await screen.pressByTestIdAsync('agent-input-agent-chip');

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

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));
        expect(screen.findByTestId('agent-input-action-menu-button')).toBeNull();
        await screen.pressByTestIdAsync('agent-input-agent-chip');

        expect(lastModelPickerOverlayProps?.probe?.phase).toBe('loading');

        await act(async () => {
            screen.tree.update(
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

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));
        expect(screen.findByTestId('agent-input-action-menu-button')).toBeNull();
        await screen.pressByTestIdAsync('agent-input-agent-chip');

        expect((lastModelPickerOverlayProps?.options ?? []).map((o: any) => o.value)).toEqual(['default', 'session-model']);
        expect(lastModelPickerOverlayProps?.probe).toBeUndefined();

        await act(async () => {
            screen.tree.update(
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

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));
        expect(screen.findByTestId('agent-input-action-menu-button')).toBeNull();
        await screen.pressByTestIdAsync('agent-input-agent-chip');

        expect(screen.findByTestId('agent-input-chip-picker-popover')).toBeTruthy();
        expect(screen.getTextContent()).toContain('agentInput.mode.sectionTitle');
        expect(screen.findByTestId('agent-input-session-mode-option:plan')).toBeTruthy();
        expect(screen.findByTestId('agent-input-session-mode-option:build')).toBeTruthy();
    });

    it('calls onAcpSessionModeChange when selecting a preflight ACP mode', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onAcpSessionModeChange = vi.fn();

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));
        expect(screen.findByTestId('agent-input-action-menu-button')).toBeNull();
        await screen.pressByTestIdAsync('agent-input-agent-chip');

        await screen.pressByTestIdAsync('agent-input-session-mode-option:plan');

        expect(onAcpSessionModeChange).toHaveBeenCalledWith('plan');
    });

    it('cycles the ACP mode chip directly when only simple build-plan options are available', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onAcpSessionModeChange = vi.fn();
        modalShowMock.mockReset();

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                        { id: 'build', name: 'Build' },
                        { id: 'plan', name: 'Plan' },
                    ],
                    acpSessionModeSelectedIdOverride: 'build',
                    onAcpSessionModeChange,
                } as any));

        const modeChip = screen.findByTestId('agent-input-session-mode-chip');
        expect(modeChip).toBeTruthy();
        expect(modeChip?.props.accessibilityLabel).toContain('Build');
        expect(findIconNode(modeChip!, 'Octicons', 'rocket')).toBeTruthy();
        expect(findIconNode(modeChip!, 'Ionicons', 'list-outline')).toBeUndefined();

        await screen.pressByTestIdAsync('agent-input-session-mode-chip');

        expect(onAcpSessionModeChange).toHaveBeenCalledWith('plan');
        expect(modalShowMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('agent-input-simple-options-popover')).toBeNull();
    });

    it('keeps the existing list icon and bare mode label when the selected ACP mode is Plan', async () => {
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));
        const modeChip = screen.findByTestId('agent-input-session-mode-chip');
        expect(modeChip).toBeTruthy();
        expect(modeChip?.props.accessibilityLabel).toContain('Plan');
        expect(findIconNode(modeChip!, 'Ionicons', 'list-outline')).toBeTruthy();
        expect(findIconNode(modeChip!, 'Octicons', 'rocket')).toBeUndefined();
    });

    it('opens ACP mode picker popover instead of cycling when selectable options exceed threshold', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onAcpSessionModeChange = vi.fn();
        modalShowMock.mockReset();

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));
        const modeChip = screen.findByTestId('agent-input-session-mode-chip');
        expect(modeChip).toBeTruthy();

        await screen.pressByTestIdAsync('agent-input-session-mode-chip');

        expect(onAcpSessionModeChange).not.toHaveBeenCalled();
        expect(modalShowMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('agent-input-simple-options-popover')).toBeTruthy();
        expect(screen.findByTestId('agent-input-simple-option:review')).toBeTruthy();
        await screen.pressByTestIdAsync('agent-input-simple-option:build');
        expect(onAcpSessionModeChange).toHaveBeenCalledWith('build');
    });

    it('opens env chip popover content instead of invoking the legacy env click callback when custom content exists', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onEnvVarsClick = vi.fn();

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));
        const envVarsChip = screen.findByTestId('agent-input-env-vars-chip');
        expect(envVarsChip).toBeTruthy();

        await screen.pressByTestIdAsync('agent-input-env-vars-chip');

        expect(onEnvVarsClick).not.toHaveBeenCalled();
        expect(screen.findByTestId('agent-input-content-popover')).toBeTruthy();
        expect(screen.findByTestId('env-vars-close-button')).toBeTruthy();
        await screen.pressByTestIdAsync('env-vars-close-button');
        expect(screen.findByTestId('agent-input-content-popover')).toBeNull();
    });

    it('opens profile chip popover content instead of invoking the legacy profile click callback when custom content exists', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onProfileClick = vi.fn();

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));
        const profileChip = screen.findByTestId('agent-input-profile-chip');
        expect(profileChip).toBeTruthy();

        await screen.pressByTestIdAsync('agent-input-profile-chip');

        expect(onProfileClick).not.toHaveBeenCalled();
        expect(screen.findByTestId('agent-input-content-popover')).toBeTruthy();
        expect(screen.findByTestId('profile-close-button')).toBeTruthy();
        await screen.pressByTestIdAsync('profile-close-button');
        expect(screen.findByTestId('agent-input-content-popover')).toBeNull();
    });

    it('opens the permission chip with the shared popover instead of invoking the legacy permission click callback', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onPermissionClick = vi.fn();

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));

        await screen.pressByTestIdAsync('agent-input-permission-chip');

        expect(onPermissionClick).not.toHaveBeenCalled();
        expect(screen.findByTestId('agent-input-content-popover')).toBeTruthy();
    });

    it('closes the collapsed action menu when opening the permission chip popover', async () => {
        const { AgentInput } = await import('./AgentInput');
        mockAgentInputActionBarLayout = 'collapsed';

        try {
            const screen = await renderScreen(React.createElement(AgentInput, {
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
                    } as any));
            expect(screen.findByTestId('agent-input-action-menu-button')).toBeTruthy();
            await screen.pressByTestIdAsync('agent-input-action-menu-button');

            expect(screen.findByTestId('agent-input-action-menu-overlay')).toBeTruthy();
            await screen.pressByTestIdAsync('agent-input-permission-chip');
            expect(screen.findByTestId('agent-input-action-menu-overlay')).toBeNull();
            expect(screen.findByTestId('agent-input-content-popover')).toBeTruthy();
        } finally {
            mockAgentInputActionBarLayout = 'wrap';
        }
    });

    it('reopens collapsed settings through the shared content popover transport after closing the permission chip popover', async () => {
        const { AgentInput } = await import('./AgentInput');
        mockAgentInputActionBarLayout = 'collapsed';

        try {
            const screen = await renderScreen(React.createElement(AgentInput, {
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
                    } as any));
            await screen.pressByTestIdAsync('agent-input-permission-chip');
            expect(screen.findByTestId('agent-input-content-popover')).toBeTruthy();

            expect(screen.findByTestId('agent-input-action-menu-button')).toBeTruthy();
            await screen.pressByTestIdAsync('agent-input-action-menu-button');

            expect(screen.findByTestId('agent-input-content-popover')).toBeTruthy();
            expect(screen.findByTestId('agent-input-action-menu-overlay')).toBeTruthy();
        } finally {
            mockAgentInputActionBarLayout = 'wrap';
        }
    });

    it('opens the agent chip with the shared chip popover when engine picker props are provided', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onAgentPickerSelect = vi.fn();
        modalShowMock.mockReset();

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));

        await screen.pressByTestIdAsync('agent-input-agent-chip');

        expect(modalShowMock).not.toHaveBeenCalled();
        expect(screen.findByTestId('agent-input-chip-picker-popover')).toBeTruthy();
        await screen.pressByTestIdAsync('agent-input-chip-picker.option:agent:codex');

        expect(onAgentPickerSelect).toHaveBeenCalledWith('agent:codex');
    });

    it('closes the permission popover before showing the shared engine picker in wrap layout', async () => {
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));
        expect(screen.findByTestId('agent-input-action-menu-button')).toBeNull();

        await screen.pressByTestIdAsync('agent-input-permission-chip');
        expect(screen.findByTestId('agent-input-content-popover')).toBeTruthy();

        await screen.pressByTestIdAsync('agent-input-agent-chip');

        expect(screen.findByTestId('agent-input-content-popover')).toBeNull();
        expect(screen.findByTestId('agent-input-chip-picker-popover')).toBeTruthy();
    });

    it('prefers the shared live engine picker over the legacy agent click callback when live model access exists', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onAgentClick = vi.fn();
        lastModelPickerOverlayProps = null;

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));

        await screen.pressByTestIdAsync('agent-input-agent-chip');

        expect(onAgentClick).not.toHaveBeenCalled();
        expect(screen.findByTestId('agent-input-chip-picker-popover')).toBeTruthy();
        expect((lastModelPickerOverlayProps?.options ?? []).map((o: any) => o.value)).toEqual(['default', 'session-model']);
    });

    it('opens the agent chip with a live engine detail picker when model selection is available', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onModelModeChange = vi.fn();
        lastModelPickerOverlayProps = null;
        lastPopoverProps = null;

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));

        const agentChip = screen.findByTestId('agent-input-agent-chip');
        expect(agentChip).toBeTruthy();
        if (!agentChip) {
            throw new Error('Expected agent chip');
        }

        await screen.pressByTestIdAsync('agent-input-agent-chip');

        expect(screen.findByTestId('agent-input-chip-picker-popover')).toBeTruthy();
        expect(screen.findByTestId('agent-input-chip-picker.option:engine:codex')).toBeNull();
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
            const screen = await renderScreen(React.createElement(AgentInput, {
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
                    } as any));
            expect(screen.findByTestId('agent-input-action-menu-button')).toBeTruthy();
            await screen.pressByTestIdAsync('agent-input-action-menu-button');

            expect(screen.findByTestId('agent-input-action-menu-overlay')).toBeTruthy();
            expect(lastModelPickerOverlayProps).toBeNull();

            const engineAction = findPressableByText(screen.tree, 'agents.codex');
            expect(engineAction).toBeTruthy();

            await act(async () => {
                engineAction!.props.onPress();
            });

            expect(screen.findByTestId('agent-input-action-menu-overlay')).toBeNull();
            expect(screen.findByTestId('agent-input-chip-picker-popover')).toBeTruthy();
            expect(lastPopoverProps?.anchorRef).toBe(screen.findByTestId('agent-input-action-menu-button')!.props.ref);
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
            const screen = await renderScreen(React.createElement(AgentInput, {
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
                    } as any));
            expect(screen.findByTestId('agent-input-action-menu-button')).toBeTruthy();
            await screen.pressByTestIdAsync('agent-input-action-menu-button');

            expect(screen.findByTestId('agent-input-action-menu-overlay')).toBeTruthy();
            expect(screen.getTextContent()).not.toContain('agentInput.mode.sectionTitle');

            const modeAction = findPressableByText(screen.tree, 'Build');
            expect(modeAction).toBeTruthy();

            await act(async () => {
                modeAction!.props.onPress();
            });

            expect(screen.findByTestId('agent-input-action-menu-overlay')).toBeNull();
            expect(screen.findByTestId('agent-input-simple-options-popover')).toBeNull();
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

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));
        expect(screen.findByTestId('agent-input-action-menu-button')).toBeNull();
        await screen.pressByTestIdAsync('agent-input-agent-chip');

        expect(screen.getTextContent()).toContain('agentInput.mode.sectionTitle');
        expect(screen.findByTestId('agent-input-session-mode-refresh')).toBeTruthy();

        mockSessionModePickerControl = null;
    });

    it('calls refresh handler for preflight ACP mode lists when provided', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onRefresh = vi.fn();

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));
        expect(screen.findByTestId('agent-input-action-menu-button')).toBeNull();
        await screen.pressByTestIdAsync('agent-input-agent-chip');

        const refresh = screen.findByTestId('agent-input-session-mode-refresh');
        expect(refresh).toBeTruthy();
        await screen.pressByTestIdAsync('agent-input-session-mode-refresh');

        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it('renders preflight ACP config options in the agent picker and applies local overrides', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onAcpConfigOptionChange = vi.fn();

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));
        expect(screen.findByTestId('agent-input-action-menu-button')).toBeNull();
        await screen.pressByTestIdAsync('agent-input-agent-chip');

        expect(screen.findByTestId('agent-input-config-option:speed')).toBeTruthy();
        expect(screen.getTextContent()).toContain('agentInput.acp.optionsSectionTitle');
        expect(screen.getTextContent()).toContain('Speed');
        expect(screen.getTextContent()).toContain('agentInput.acp.pendingValue');

        await screen.pressByTestIdAsync('agent-input-config-option-option:speed:fast');

        expect(onAcpConfigOptionChange).toHaveBeenCalledWith('speed', 'fast');
    });

    it('renders a config-options loading affordance when ACP config preflight is still loading', async () => {
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));
        expect(screen.findByTestId('agent-input-action-menu-button')).toBeNull();
        await screen.pressByTestIdAsync('agent-input-agent-chip');

        expect(screen.getTextContent()).toContain('agentInput.acp.optionsSectionTitle');
        expect(screen.findByTestId('agent-input-config-options-refresh')).toBeTruthy();
    });

    it('calls refresh handler for preflight ACP config options when no options are loaded yet', async () => {
        const { AgentInput } = await import('./AgentInput');
        const onRefresh = vi.fn();

        const screen = await renderScreen(React.createElement(AgentInput, {
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
                } as any));
        expect(screen.findByTestId('agent-input-action-menu-button')).toBeNull();
        await screen.pressByTestIdAsync('agent-input-agent-chip');

        const refresh = screen.findByTestId('agent-input-config-options-refresh');
        expect(refresh).toBeTruthy();
        if (!refresh) {
            throw new Error('Expected ACP config refresh action');
        }
        expect(typeof refresh.props.onPress).toBe('function');
        await screen.pressByTestIdAsync('agent-input-config-options-refresh');

        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

});
