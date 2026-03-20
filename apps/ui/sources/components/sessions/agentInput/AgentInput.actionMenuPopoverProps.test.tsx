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
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 800, headerMaxWidth: 800 },
}));

vi.mock('@/sync/domains/state/storage', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@/sync/domains/state/storage')>();
    return {
        ...actual,
        useSetting: (key: string) => {
            if (key === 'profiles') return [];
            if (key === 'agentInputEnterToSend') return true;
            if (key === 'agentInputActionBarLayout') return 'collapsed';
            if (key === 'agentInputChipDensity') return 'labels';
            if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
            return null;
        },
        useSettings: () => ({
            profiles: [],
            agentInputEnterToSend: true,
            agentInputActionBarLayout: 'collapsed',
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
    boundaryRef?: React.RefObject<any> | null;
    portal?: { matchAnchorWidth?: boolean };
};

const captured: { last: CapturedPopoverProps | null } = { last: null };
type CapturedActionMenuContentProps = Readonly<{
    actionMenuActions?: Array<{ id?: string; onPress?: () => void }>;
}>;
const capturedActionMenuContent: { last: CapturedActionMenuContentProps | null } = { last: null };
const capturedSimpleOptionsPopover: { last: Record<string, unknown> | null } = { last: null };

function getCapturedActionMenuActions(): Array<{ id?: string; onPress?: () => void }> {
    const current = capturedActionMenuContent.last;
    return current && Array.isArray(current.actionMenuActions)
        ? current.actionMenuActions
        : [];
}
vi.mock('@/components/ui/popover', () => ({
    Popover: (props: CapturedPopoverProps) => {
        captured.last = props;
        const renderedChildren = typeof (props as any).children === 'function'
            ? (props as any).children({ maxHeight: props.maxHeightCap ?? 360 })
            : (props as any).children ?? null;
        return React.createElement('Popover', props, renderedChildren);
    },
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

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
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

vi.mock('./components/AgentInputActionMenuPopoverContent', () => ({
    AgentInputActionMenuPopoverContent: (props: CapturedActionMenuContentProps) => {
        capturedActionMenuContent.last = props;
        return null;
    },
}));

vi.mock('./components/AgentInputSimpleOptionsPopover', () => ({
    AgentInputSimpleOptionsPopover: (props: Record<string, unknown>) => {
        capturedSimpleOptionsPopover.last = props;
        return null;
    },
}));

describe('AgentInput (action menu popover props)', () => {
    it('ignores autocomplete suggestions whose component is missing instead of crashing', async () => {
        vi.resetModules();
        vi.doMock('@/components/autocomplete/useActiveSuggestions', () => ({
            useActiveSuggestions: () => [[{ key: 'broken', text: '/broken', component: undefined }], 0, () => {}, () => {}],
        }));

        const { AgentInput } = await import('./AgentInput');

        expect(() => {
            act(() => {
                renderer.create(
                    <AgentInput
                        value="/bro"
                        placeholder="Type"
                        onChangeText={() => {}}
                        onSend={() => {}}
                        autocompletePrefixes={['/']}
                        autocompleteSuggestions={async () => []}
                    />,
                );
            });
        }).not.toThrow();
    });

    it('anchors the permission popover to the permission chip and uses the shared popover sizing', async () => {
        vi.resetModules();
        const { AgentInput } = await import('./AgentInput');

        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    onPermissionModeChange={() => {}}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />
            );
        });

        const permissionPressable = tree!.root.findByProps({ testID: 'agent-input-permission-chip' });

        expect(permissionPressable).toBeTruthy();
        expect(typeof permissionPressable.props.onPress).toBe('function');

        act(() => {
            permissionPressable.props.onPress();
        });

        const popoverProps: CapturedPopoverProps | null = captured.last;
        expect(popoverProps?.open).toBe(true);
        expect(popoverProps?.anchorRef).toBe(permissionPressable.props.ref);
        expect(popoverProps?.boundaryRef).toBe(null);
        expect(popoverProps?.maxHeightCap).toBe(420);
        expect(popoverProps?.maxWidthCap).toBe(420);
        expect(popoverProps?.portal?.matchAnchorWidth).toBe(false);

        act(() => tree!.unmount());
    });

    it('routes collapsed delivery actions through the shared simple-options popover anchored to the action menu button', async () => {
        vi.resetModules();
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedSimpleOptionsPopover.last = null;
        const { AgentInput } = await import('./AgentInput');

        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                    agentType={"codex" as any}
                    onAgentClick={() => {}}
                    extraActionChips={[{
                        key: 'execution-run-delivery',
                        controlId: 'delivery',
                        collapsedOptionsPopover: {
                            title: 'runs.delivery.title',
                            label: 'Delivery',
                            options: [
                                { id: 'steer_if_supported', label: 'Steer' },
                                { id: 'interrupt', label: 'Interrupt' },
                            ],
                            selectedOptionId: 'interrupt',
                            onSelect: () => {},
                        },
                        render: () => React.createElement('View', { testID: 'agent-input-delivery-chip' }),
                    }]}
                    onMachineClick={() => {}}
                    machineName="Builder"
                />
            );
        });

        const settingsButton = tree!.root.findByProps({ testID: 'agent-input-action-menu-button' });

        act(() => {
            settingsButton.props.onPress();
        });

        const actionMenuActions = getCapturedActionMenuActions();
        const deliveryAction = actionMenuActions.find((action: { id?: string }) => action.id === 'delivery');
        expect(deliveryAction).toBeTruthy();

        act(() => {
            deliveryAction?.onPress?.();
        });

        const simpleOptionsProps = capturedSimpleOptionsPopover.last as (Record<string, unknown> & {
            open?: boolean;
            title?: string;
            selectedOptionId?: string | null;
            anchorRef?: unknown;
            options?: Array<{ id: string }>;
        }) | null;

        expect(simpleOptionsProps?.open).toBe(true);
        expect(simpleOptionsProps?.title).toBe('runs.delivery.title');
        expect(simpleOptionsProps?.selectedOptionId).toBe('interrupt');
        expect(simpleOptionsProps?.options?.map((option) => option.id)).toEqual([
            'steer_if_supported',
            'interrupt',
        ]);
        expect(simpleOptionsProps?.anchorRef).toBe(settingsButton.props.ref);

        act(() => tree!.unmount());
    });

    it('routes collapsed recipient actions through the shared simple-options popover anchored to the action menu button', async () => {
        vi.resetModules();
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedSimpleOptionsPopover.last = null;
        const { AgentInput } = await import('./AgentInput');

        let tree: renderer.ReactTestRenderer;
        act(() => {
            tree = renderer.create(
                <AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                    agentType={"codex" as any}
                    onAgentClick={() => {}}
                    extraActionChips={[{
                        key: 'participants-recipient',
                        controlId: 'recipient',
                        collapsedOptionsPopover: {
                            title: 'session.participants.sendToTitle',
                            label: 'Recipient',
                            options: [
                                { id: 'lead', label: 'Lead' },
                                { id: 'run-1', label: 'Run 1' },
                            ],
                            selectedOptionId: 'run-1',
                            onSelect: () => {},
                        },
                        render: () => React.createElement('View', { testID: 'agent-input-recipient-chip' }),
                    }]}
                    onMachineClick={() => {}}
                    machineName="Builder"
                />
            );
        });

        const settingsButton = tree!.root.findByProps({ testID: 'agent-input-action-menu-button' });

        act(() => {
            settingsButton.props.onPress();
        });

        const actionMenuActions = getCapturedActionMenuActions();
        const recipientAction = actionMenuActions.find((action: { id?: string }) => action.id === 'recipient');
        expect(recipientAction).toBeTruthy();

        act(() => {
            recipientAction?.onPress?.();
        });

        const simpleOptionsProps = capturedSimpleOptionsPopover.last as (Record<string, unknown> & {
            open?: boolean;
            title?: string;
            selectedOptionId?: string | null;
            anchorRef?: unknown;
            options?: Array<{ id: string }>;
        }) | null;

        expect(simpleOptionsProps?.open).toBe(true);
        expect(simpleOptionsProps?.title).toBe('session.participants.sendToTitle');
        expect(simpleOptionsProps?.selectedOptionId).toBe('run-1');
        expect(simpleOptionsProps?.options?.map((option) => option.id)).toEqual([
            'lead',
            'run-1',
        ]);
        expect(simpleOptionsProps?.anchorRef).toBe(settingsButton.props.ref);

        act(() => tree!.unmount());
    });
});
