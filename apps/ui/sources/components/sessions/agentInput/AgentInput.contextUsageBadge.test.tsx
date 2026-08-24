import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createReducer } from '@/sync/reducer/reducer';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import type { ConnectedServiceQuotaGaugeViewModel } from '@/sync/domains/connectedServices/connectedServiceQuotaGauge';
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

const windowDimensionsState = {
    width: 800,
    height: 600,
};

type TestPressableProps = Record<string, unknown> & {
    children?: React.ReactNode | ((state: { pressed: boolean; hovered: boolean; focused: boolean }) => React.ReactNode);
};

function renderPressableChildren(children: TestPressableProps['children']): React.ReactNode {
    return typeof children === 'function'
        ? children({ pressed: false, hovered: false, focused: false })
        : children ?? null;
}

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('View', props, props.children),
            Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('Text', props, props.children),
            Pressable: React.forwardRef((props: TestPressableProps, ref) =>
                React.createElement('Pressable', { ...props, __ref: ref }, renderPressableChildren(props.children))),
            ScrollView: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                React.createElement('ScrollView', props, props.children),
            ActivityIndicator: (props: Record<string, unknown>) =>
                React.createElement('ActivityIndicator', props, null),
            Platform: {
                OS: 'web',
                select: (v: any) => v.web ?? v.default,
            },
            useWindowDimensions: () => ({ width: windowDimensionsState.width, height: windowDimensionsState.height }),
            Dimensions: {
                get: () => ({ width: windowDimensionsState.width, height: windowDimensionsState.height, scale: 1, fontScale: 1 }),
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
                if (key === 'agentInput.providerUsage.titleForProvider') return `${params?.provider} usage`;
                if (key === 'agentInput.providerUsage.activeAccount') return `Account: ${params?.account}`;
                if (key === 'connectedServices.quota.recoveryCreditTitle') return `${params?.count} reset available`;
                if (key === 'connectedServices.quota.recoveryCreditSubtitle') return 'Use a reset to restore usage immediately.';
                if (key === 'session.usageLimitRecovery.consumeResetCreditAction') return 'Use reset';
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
                useSessionTranscriptIds: () => ({ ids: [], isLoaded: true, hasRetainedContent: false }),
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
    const { localSettingsDefaults } = await import('@/sync/domains/settings/localSettings');
    const store = createStorageStoreMock({ sessionMessages: {}, localSettings: localSettingsDefaults } as any);
    return {
        getStorage: () => store,
    };
});

vi.mock('@/agents/catalog/catalog', () => ({
    getAgentIconSvgXml: () => null,
    getAgentIconSource: () => null,
    getAgentIconTintColor: () => undefined,
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
    findModelOptionForEffectiveModelId: (options: readonly any[], id: string) =>
        (options ?? []).find((o: any) => o.value === id) ?? (options ?? []).find((o: any) => o.extendedContextModelId === id) ?? null,
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
    MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS: {
        web: true,
        native: true,
        matchAnchorWidth: false,
        anchorAlign: 'start',
    },
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

vi.mock('@/sync/domains/sessionControl/sessionModeControl', () => ({
    computeAcpPlanModeControl: () => null,
    computeAcpSessionModePickerControl: () => null,
}));

vi.mock('@/sync/domains/sessionControl/configOptionsControl', () => ({
    computeSessionConfigOptionControls: () => null,
}));

describe('AgentInput (context usage badge)', () => {
    it('renders host-provided trailing status actions even without another status item', async () => {
        const { AgentInput } = await import('./AgentInput');
        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                statusTrailingActions={React.createElement('View', { testID: 'host-status-action' })}
            />,
        );

        expect(screen.findByTestId('agent-input-status-trailing')).toBeTruthy();
        expect(screen.findByTestId('host-status-action')).toBeTruthy();
        act(() => screen.tree.unmount());
    });

    it('allows a host with an editable permission chip to omit the repeated status label', async () => {
        const { AgentInput } = await import('./AgentInput');
        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                statusTrailingActions={React.createElement('View', { testID: 'host-status-action' })}
                showStatusPermissionMode={false}
            />,
        );

        expect(screen.findByTestId('host-status-action')).toBeTruthy();
        expect(screen.getTextContent()).not.toContain('Default');
        act(() => screen.tree.unmount());
    });

    beforeEach(() => {
        captured.last = null;
        windowDimensionsState.width = 800;
        windowDimensionsState.height = 600;
    });

    it('does not render a context usage badge for codex sessions even when telemetry is present', async () => {
        captured.last = null;
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
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
                autocompleteKinds={[]}
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
                autocompleteKinds={[]}
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
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                agentType={"claude" as any}
                onAgentClick={() => {}}
                usageData={{
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheCreation: 0,
                    cacheRead: 0,
                    contextSize: 38_691,
                    contextWindowTokens: 200_000,
                }}
                alwaysShowContextSize={true}
            />,
        );

        const badge = screen.findByTestId('agent-input-context-usage-badge');
        expect(badge).toBeTruthy();
        expect(screen.findByTestId('agent-input-context-usage-ring')).toBeTruthy();
        expect(screen.findByTestId('agent-input-context-usage-value')?.props.children).toBe('19');
        expect(String(badge?.props.accessibilityLabel ?? '')).toContain('38.7k/200k');

        act(() => screen.tree.unmount());
    });

    it('renders status badges next to the connection status without moving trailing usage', async () => {
        captured.last = null;
        const { AgentInput } = await import('./AgentInput');
        const onPress = vi.fn();

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                connectionStatus={{
                    text: 'online',
                    color: 'green',
                    dotColor: 'green',
                }}
                agentType={"claude" as any}
                statusBadges={[
                    {
                        key: 'work-state',
                        label: 'Goal: migrate plugin support',
                        testID: 'session-work-state-status-badge',
                        accessibilityLabel: 'Session work state',
                        onPress,
                    },
                ] as any}
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

        const badge = screen.findByTestId('session-work-state-status-badge');
        expect(badge).toBeTruthy();
        expect(screen.findByTestId('agent-input-status-trailing')).toBeTruthy();
        expect(screen.findByTestId('agent-input-context-usage-badge')).toBeTruthy();

        act(() => {
            badge?.props.onPress?.({} as never);
        });
        expect(onPress).toHaveBeenCalledTimes(1);

        act(() => screen.tree.unmount());
    });

    it('renders the provider quota gauge beside the context gauge when reliable usage exists', async () => {
        captured.last = null;
        const { AgentInput } = await import('./AgentInput');

        const providerUsageGauge: ConnectedServiceQuotaGaugeViewModel = {
            serviceId: 'claude-subscription',
            providerDisplayName: 'Claude',
            activeAccountDisplayLabel: 'Work account',
            remainingPct: 18,
            usedPct: 82,
            valueLabel: '18% left',
            ringValueLabel: '18',
            badgeLabel: 'w. 18% left',
            scopePrefix: 'w.',
            primaryValueSemantics: 'remaining',
            detailRightLabel: '18% left · resets in 2h',
            usedLimitLabel: '82/100 used',
            resetLabel: '2h',
            tone: 'warning',
            isStale: false,
            recoveryCreditSummary: {
                availableCount: 1,
                nextExpiresAtMs: null,
                providerCreditId: null,
            },
            effectiveMeter: {
                meterId: 'weekly',
                label: 'Weekly',
                used: 82,
                limit: 100,
                unit: 'count',
                utilizationPct: null,
                resetsAt: 0,
                status: 'ok',
                details: {},
            },
            allMeterRows: [
                {
                    meterId: 'weekly',
                    label: 'Weekly',
                    remainingPct: 18,
                    usedPct: 82,
                    detailRightSemantics: 'remaining',
                    detailRightLabel: '18% left · resets in 2h',
                    usedLimitSemantics: 'used',
                    usedLimitLabel: '82/100 used',
                    resetLabel: '2h',
                    tone: 'warning',
                },
            ],
        };
        const onProviderUsageRecoveryCreditPress = vi.fn();

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                agentType={"claude" as any}
                usageData={{
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheCreation: 0,
                    cacheRead: 0,
                    contextSize: 38_691,
                }}
                alwaysShowContextSize={true}
                {...{ providerUsageGauge }}
                onProviderUsageRecoveryCreditPress={onProviderUsageRecoveryCreditPress}
            />,
        );

        expect(screen.findByTestId('agent-input-context-usage-badge')).toBeTruthy();
        expect(screen.findByTestId('agent-input-provider-usage-badge')).toBeTruthy();
        expect(screen.findByTestId('agent-input-provider-quota-badge')).toBeTruthy();
        expect(screen.findByTestId('agent-input-provider-usage-value')?.props.children).toBe('18');

        act(() => {
            screen.findByTestId('agent-input-provider-usage-badge')?.props.onPress();
        });

        expect(screen.findByTestId('agent-input-provider-usage-popover')).toBeTruthy();
        expect(screen.findByTestId('agent-input-provider-usage-meter:weekly')).toBeTruthy();
        const providerUsageOverlay = screen.findByType('FloatingOverlay');
        expect(providerUsageOverlay?.props.scrollEnabled).toBe(false);
        expect(screen.getTextContent()).toContain('Claude usage');
        expect(screen.getTextContent()).toContain('Work account');
        expect(screen.getTextContent()).toContain('18% left · resets in 2h');
        expect(screen.getTextContent()).toContain('82/100 used');
        expect(screen.getTextContent()).toContain('1 reset available');
        expect(screen.getTextContent()).toContain('Use a reset to restore usage immediately.');

        act(() => {
            screen.findByTestId('agent-input-provider-usage-recovery-credit-action')?.props.onPress?.();
        });
        expect(onProviderUsageRecoveryCreditPress).toHaveBeenCalledTimes(1);

        act(() => screen.tree.unmount());
    });

    it('keeps the hidden gauge reachable through overflow on very narrow screens', async () => {
        windowDimensionsState.width = 360;
        const { AgentInput } = await import('./AgentInput');

        const providerUsageGauge: ConnectedServiceQuotaGaugeViewModel = {
            serviceId: 'claude-subscription',
            providerDisplayName: 'Claude',
            activeAccountDisplayLabel: null,
            remainingPct: 18,
            usedPct: 82,
            primaryValueSemantics: 'remaining',
            valueLabel: '18% left',
            ringValueLabel: '18',
            badgeLabel: '18% left',
            scopePrefix: null,
            detailRightLabel: '18% left · resets in 2h',
            usedLimitLabel: '82/100 used',
            resetLabel: '2h',
            tone: 'warning',
            isStale: false,
            recoveryCreditSummary: null,
            effectiveMeter: {
                meterId: 'weekly',
                label: 'Weekly',
                used: 82,
                limit: 100,
                unit: 'count',
                utilizationPct: null,
                resetsAt: 0,
                status: 'ok',
                details: {},
            },
            allMeterRows: [
                {
                    meterId: 'weekly',
                    label: 'Weekly',
                    remainingPct: 18,
                    usedPct: 82,
                    detailRightSemantics: 'remaining',
                    detailRightLabel: '18% left · resets in 2h',
                    usedLimitSemantics: 'used',
                    usedLimitLabel: '82/100 used',
                    resetLabel: '2h',
                    tone: 'warning',
                },
            ],
        };

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                agentType={"claude" as any}
                usageData={{
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheCreation: 0,
                    cacheRead: 0,
                    contextSize: 38_691,
                }}
                alwaysShowContextSize={true}
                {...{ providerUsageGauge }}
            />,
        );

        expect(screen.findByTestId('agent-input-context-usage-badge')).toBeNull();
        expect(screen.findByTestId('agent-input-provider-usage-badge')).toBeTruthy();
        const overflow = screen.findByTestId('agent-input-hidden-usage-overflow');
        expect(overflow).toBeTruthy();

        act(() => {
            overflow?.props.onPress?.();
        });

        expect(screen.findByTestId('agent-input-hidden-usage-overflow-popover')).toBeTruthy();
        expect(screen.getTextContent()).toContain('38.7k/200k context used');

        act(() => screen.tree.unmount());
    });

    it('opens a click-persistent status badge popover from the badge press', async () => {
        captured.last = null;
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                connectionStatus={{
                    text: 'online',
                    color: 'green',
                    dotColor: 'green',
                }}
                agentType={"claude" as any}
                statusBadges={[
                    {
                        key: 'work-state',
                        label: 'Goal: migrate plugin support',
                        testID: 'session-work-state-status-badge',
                        accessibilityLabel: 'Session work state',
                        renderPopover: (ctx: Readonly<{
                            open: boolean;
                            onRequestClose: () => void;
                        }>) => ctx.open
                            ? React.createElement('WorkStatePopover', {
                                testID: 'session-work-state-popover',
                                onRequestClose: ctx.onRequestClose,
                            })
                            : null,
                    },
                ] as any}
            />,
        );

        expect(screen.findByTestId('session-work-state-popover')).toBeNull();

        const badge = screen.findByTestId('session-work-state-status-badge');
        act(() => {
            badge?.props.onPress?.({} as never);
        });

        const popover = screen.findByTestId('session-work-state-popover');
        expect(popover).toBeTruthy();

        act(() => {
            popover?.props.onRequestClose();
        });
        expect(screen.findByTestId('session-work-state-popover')).toBeNull();

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
                autocompleteKinds={[]}
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
