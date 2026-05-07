import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createReducer } from '@/sync/reducer/reducer';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const storageSettings: Settings = {
    ...settingsDefaults,
    profiles: [],
    agentInputEnterToSend: true,
    agentInputActionBarLayout: 'wrap',
    agentInputChipDensity: 'labels',
    sessionPermissionModeApplyTiming: 'immediate',
    alwaysShowContextSize: true,
};

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, props.children),
            Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Text', props, props.children),
            Pressable: React.forwardRef((props: Record<string, unknown> & { children?: React.ReactNode }, ref) =>
                React.createElement('Pressable', { ...props, __ref: ref }, props.children)),
            ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('ScrollView', props, props.children),
            ActivityIndicator: (props: Record<string, unknown>) =>
                React.createElement('ActivityIndicator', props, null),
            Platform: {
                OS: 'web',
                select: (v: any) => v.web ?? v.default,
            },
            useWindowDimensions: () => ({ width: 800, height: 600 }),
            Dimensions: {
                get: () => ({ width: 800, height: 600, scale: 1, fontScale: 1 }),
            },
        });
    },
    icons: async () => ({
        Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
        Octicons: (props: Record<string, unknown>) => React.createElement('Octicons', props, null),
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key, params) => {
                if (key === 'agentInput.context.usedDetail') {
                    return `${params?.percent} • ${params?.used}/${params?.total} context used`;
                }
                if (key === 'agentInput.context.windowTitle') return 'Context Window';
                if (key === 'agentInput.context.description') return 'Automatically compacts its context when needed.';
                return key;
            },
        });
    },
    modal: async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock, createUseSettingMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: createUseSettingMock({ values: storageSettings }),
                useSettings: () => storageSettings,
                useSessionMessages: () => ({ messages: [], isLoaded: true }),
                useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
                useSessionMessagesById: () => ({}),
                useSessionMessagesVersion: () => 0,
                useSessionMessagesReducerState: () => createReducer(),
            },
        });
    },
});

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

vi.mock('react-native-svg', () => ({
    Svg: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Svg', props, props.children),
    Circle: (props: Record<string, unknown>) => React.createElement('Circle', props, null),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 800, headerMaxWidth: 800 },
}));

vi.mock('@/sync/domains/state/storageStore', async () => {
    const { createStorageStoreMock } = await import('@/dev/testkit/mocks/storage');
    const store = createStorageStoreMock({ sessionMessages: {} } as any);
    return {
        getStorage: () => store,
    };
});

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex', 'claude', 'opencode', 'gemini'],
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ displayNameKey: 'agents.codex', toolRendering: { hideUnknownToolsByDefault: false } }),
    getAgentBehavior: (agentId: string) => ({
        sessionUsage: {
            supportsExactContextUsageBadge: agentId !== 'codex' && agentId !== 'gemini',
        },
    }),
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

vi.mock('@/components/ui/buttons/PrimaryCircleIconButton', () => ({
    PrimaryCircleIconButton: () => null,
}));

vi.mock('@/components/ui/lists/ActionListSection', () => ({
    ActionListSection: () => null,
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

type CapturedPopoverProps = Record<string, unknown> & {
    open: boolean;
    anchorRef: React.RefObject<any>;
    maxHeightCap?: number;
    maxWidthCap?: number;
};

const captured: { last: CapturedPopoverProps | null } = { last: null };

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: CapturedPopoverProps) => {
        captured.last = props;
        const renderedChildren = typeof (props as any).children === 'function'
            ? (props as any).children({ maxHeight: props.maxHeightCap ?? 360, placement: 'top' })
            : (props as any).children ?? null;
        return React.createElement('Popover', props, props.open ? renderedChildren : null);
    },
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('FloatingOverlay', props, props.children),
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

vi.mock('@/hooks/session/useUserMessageHistory', () => ({
    useUserMessageHistory: () => ({
        navigatePrevious: () => {},
        navigateNext: () => {},
        hasPrevious: false,
        hasNext: false,
    }),
}));

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/sync/acp/sessionModeControl', () => ({
    computeAcpPlanModeControl: () => null,
    computeAcpSessionModePickerControl: () => null,
}));

vi.mock('@/sync/acp/configOptionsControl', () => ({
    computeAcpConfigOptionControls: () => null,
}));

describe('AgentInput (context usage badge)', () => {
    it('does not render a context usage badge for codex sessions even when telemetry is present', async () => {
        captured.last = null;
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                agentType={"codex" as any}
                onAgentClick={() => {}}
                usageData={{
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheCreation: 0,
                    cacheRead: 0,
                    contextSize: 16_000,
                }}
                alwaysShowContextSize={true}
                connectionStatus={{
                    text: 'Connected',
                    color: '#00aa00',
                    dotColor: '#00aa00',
                }}
                metadata={{
                    sessionModelsV1: {
                        v: 1,
                        provider: 'codex',
                        updatedAt: 1,
                        currentModelId: 'gpt-5.4',
                        availableModels: [
                            {
                                id: 'gpt-5.4',
                                name: 'GPT 5.4',
                                contextWindowTokens: 258_000,
                            },
                        ],
                    },
                } as any}
            />,
        );

        expect(screen.findByTestId('agent-input-status-trailing')).toBeTruthy();
        expect(screen.findByTestId('agent-input-context-usage-badge')).toBeNull();

        act(() => screen.tree.unmount());
    });

    it('does not render a zero-state context usage badge for codex when always-show is enabled', async () => {
        captured.last = null;
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                agentType={"codex" as any}
                onAgentClick={() => {}}
                alwaysShowContextSize={true}
                metadata={{
                    sessionModelsV1: {
                        v: 1,
                        provider: 'codex',
                        updatedAt: 1,
                        currentModelId: 'gpt-5.4',
                        availableModels: [
                            {
                                id: 'gpt-5.4',
                                name: 'GPT 5.4',
                                contextWindowTokens: 258_000,
                            },
                        ],
                    },
                } as any}
            />,
        );

        expect(screen.findByTestId('agent-input-context-usage-badge')).toBeNull();

        act(() => screen.tree.unmount());
    });

    it('does not render a codex context usage badge from live telemetry when metadata is missing', async () => {
        captured.last = null;
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                agentType={"codex" as any}
                onAgentClick={() => {}}
                usageData={{
                    inputTokens: 700,
                    outputTokens: 250,
                    cacheCreation: 0,
                    cacheRead: 200,
                    contextSize: 1_200,
                    contextWindowTokens: 258_400,
                } as any}
                alwaysShowContextSize={true}
            />,
        );

        expect(screen.findByTestId('agent-input-context-usage-badge')).toBeNull();

        act(() => screen.tree.unmount());
    });

    it('still renders the context usage badge for providers that support exact context telemetry', async () => {
        captured.last = null;
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                agentType={"claude" as any}
                onAgentClick={() => {}}
                usageData={{
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheCreation: 0,
                    cacheRead: 0,
                    contextSize: 38_691,
                }}
                alwaysShowContextSize={true}
            />,
        );

        expect(screen.findByTestId('agent-input-context-usage-badge')).toBeTruthy();
        expect(screen.findByTestId('agent-input-context-usage-value')?.props.children).toBe('19');

        act(() => screen.tree.unmount());
    });

    it('does not render a context usage badge for providers without context support', async () => {
        captured.last = null;
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                agentType={"gemini" as any}
                onAgentClick={() => {}}
                usageData={{
                    inputTokens: 120,
                    outputTokens: 40,
                    cacheCreation: 0,
                    cacheRead: 0,
                    contextSize: 120,
                }}
                alwaysShowContextSize={true}
            />,
        );

        expect(screen.findByTestId('agent-input-context-usage-badge')).toBeNull();

        act(() => screen.tree.unmount());
    });
});
