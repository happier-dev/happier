import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { createReducer } from '@/sync/reducer/reducer';
import { settingsDefaults, type Settings } from '@/sync/domains/settings/settings';
import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 800, headerMaxWidth: 800 },
}));

const storageSettings: Settings = {
    ...settingsDefaults,
    profiles: [],
    agentInputEnterToSend: true,
    agentInputActionBarLayout: 'collapsed',
    agentInputChipDensity: 'labels',
    sessionPermissionModeApplyTiming: 'immediate',
};

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
                OS: 'ios',
                select: (v: any) => v.ios,
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
        return createTextModuleMock({ translate: (key) => key });
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
const capturedChipPickerPopover: { last: Record<string, unknown> | null } = { last: null };

function renderPopoverChildren(
    props: Readonly<{
        children?: React.ReactNode | ((args: { maxHeight: number }) => React.ReactNode);
        maxHeightCap?: number;
    }>,
): React.ReactNode {
    return typeof props.children === 'function'
        ? props.children({ maxHeight: props.maxHeightCap ?? 360 })
        : props.children ?? null;
}

function getCapturedActionMenuActions(): Array<{ id?: string; onPress?: () => void }> {
    const current = capturedActionMenuContent.last;
    return current && Array.isArray(current.actionMenuActions)
        ? current.actionMenuActions
        : [];
}
vi.mock('@/components/ui/popover', () => ({
    Popover: (props: CapturedPopoverProps) => {
        captured.last = props;
        return React.createElement('Popover', props, props.open ? renderPopoverChildren(props) : null);
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

vi.mock('./components/AgentInputChipPickerPopover', () => ({
    AgentInputChipPickerPopover: (props: Record<string, unknown>) => {
        capturedChipPickerPopover.last = props;
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

        await expect(renderScreen(
            <AgentInput
                value="/bro"
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompletePrefixes={['/']}
                autocompleteSuggestions={async () => []}
            />,
        )).resolves.toEqual(expect.objectContaining({ tree: expect.anything() }));
    });

    it('anchors the permission popover to the permission chip and uses the shared popover sizing', async () => {
        vi.resetModules();
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    onPermissionModeChange={() => {}}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const permissionPressable = screen.findByTestId('agent-input-permission-chip');

        expect(permissionPressable).toBeTruthy();
        if (!permissionPressable) {
            return;
        }
        await screen.pressByTestIdAsync('agent-input-permission-chip');

        const popoverProps: CapturedPopoverProps | null = captured.last;
        expect(popoverProps?.open).toBe(true);
        expect(popoverProps?.anchorRef).toStrictEqual(permissionPressable.props.ref);
        expect(popoverProps?.maxHeightCap).toBe(420);
        expect(popoverProps?.maxWidthCap).toBe(420);
        expect(popoverProps?.portal?.matchAnchorWidth).toBe(false);
    });

    it('routes collapsed delivery actions through the shared chip-picker popover anchored to the action menu button', async () => {
        vi.resetModules();
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedSimpleOptionsPopover.last = null;
        capturedChipPickerPopover.last = null;
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
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
                />);

        const settingsButton = screen.findByTestId('agent-input-action-menu-button');
        const machinePressable = screen.findByTestId('agent-input-machine-chip');

        expect(settingsButton).toBeTruthy();
        if (!settingsButton) {
            return;
        }

        await screen.pressByTestIdAsync('agent-input-action-menu-button');

        const actionMenuActions = getCapturedActionMenuActions();
        const deliveryAction = actionMenuActions.find((action: { id?: string }) => action.id === 'delivery');
        expect(deliveryAction).toBeTruthy();

        act(() => {
            deliveryAction?.onPress?.();
        });

        const chipPickerProps = capturedChipPickerPopover.last as (Record<string, unknown> & {
            open?: boolean;
            title?: string;
            selectedOptionId?: string | null;
            anchorRef?: unknown;
            options?: Array<{ id: string }>;
        }) | null;

        expect(chipPickerProps?.open).toBe(true);
        expect(chipPickerProps?.title).toBe('runs.delivery.title');
        expect(chipPickerProps?.selectedOptionId).toBe('interrupt');
        expect(chipPickerProps?.options?.map((option) => option.id)).toEqual([
            'steer_if_supported',
            'interrupt',
        ]);
        expect(chipPickerProps?.anchorRef).toBe(settingsButton.props.ref);
    });

    it('routes collapsed recipient actions through the shared chip-picker popover anchored to the action menu button', async () => {
        vi.resetModules();
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedSimpleOptionsPopover.last = null;
        capturedChipPickerPopover.last = null;
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
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
                />);

        const settingsButton = screen.findByTestId('agent-input-action-menu-button');

        expect(settingsButton).toBeTruthy();
        if (!settingsButton) {
            return;
        }

        await screen.pressByTestIdAsync('agent-input-action-menu-button');

        const actionMenuActions = getCapturedActionMenuActions();
        const recipientAction = actionMenuActions.find((action: { id?: string }) => action.id === 'recipient');
        expect(recipientAction).toBeTruthy();

        act(() => {
            recipientAction?.onPress?.();
        });

        const chipPickerProps = capturedChipPickerPopover.last as (Record<string, unknown> & {
            open?: boolean;
            title?: string;
            selectedOptionId?: string | null;
            anchorRef?: unknown;
            options?: Array<{ id: string }>;
        }) | null;

        expect(chipPickerProps?.open).toBe(true);
        expect(chipPickerProps?.title).toBe('session.participants.sendToTitle');
        expect(chipPickerProps?.selectedOptionId).toBe('run-1');
        expect(chipPickerProps?.options?.map((option) => option.id)).toEqual([
            'lead',
            'run-1',
        ]);
        expect(chipPickerProps?.anchorRef).toBe(settingsButton.props.ref);
    });

    it('routes collapsed content actions through the shared content popover anchored to the action menu button', async () => {
        vi.resetModules();
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedSimpleOptionsPopover.last = null;
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                    agentType={"codex" as any}
                    onAgentClick={() => {}}
                    extraActionChips={[{
                        key: 'new-session-mcp',
                        controlId: 'mcp',
                        collapsedContentPopover: {
                            title: 'newSession.mcpChipLabel',
                            boundaryRef: null,
                            maxHeightCap: 520,
                            maxWidthCap: 480,
                            renderContent: () => React.createElement('View', { testID: 'mcp-content' }),
                        },
                        render: () => React.createElement('View', { testID: 'agent-input-mcp-chip' }),
                    }]}
                    onMachineClick={() => {}}
                    machineName="Builder"
                />);

        const settingsButton = screen.findByTestId('agent-input-action-menu-button');

        expect(settingsButton).toBeTruthy();
        if (!settingsButton) {
            return;
        }

        await screen.pressByTestIdAsync('agent-input-action-menu-button');

        const actionMenuActions = getCapturedActionMenuActions();
        const mcpAction = actionMenuActions.find((action: { id?: string }) => action.id === 'mcp');
        expect(mcpAction).toBeTruthy();

        act(() => {
            mcpAction?.onPress?.();
        });

        const contentPopoverProps = captured.last as (Record<string, unknown> & {
            open?: boolean;
            anchorRef?: unknown;
            maxHeightCap?: number;
            maxWidthCap?: number;
        }) | null;

        expect(contentPopoverProps?.open).toBe(true);
        expect(contentPopoverProps?.anchorRef).toEqual(settingsButton.props.ref);
        expect(contentPopoverProps?.maxHeightCap).toBeGreaterThan(0);
        expect(contentPopoverProps?.maxWidthCap).toBeGreaterThan(0);
        expect(contentPopoverProps?.boundaryRef).toBeNull();
    });

    it('toggles a visible extra-chip content popover closed when the chip is pressed twice', async () => {
        vi.resetModules();
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedSimpleOptionsPopover.last = null;
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                    agentType={"codex" as any}
                    onAgentClick={() => {}}
                    extraActionChips={[{
                        key: 'new-session-mcp',
                        controlId: 'mcp',
                        collapsedContentPopover: {
                            title: 'newSession.mcpChipLabel',
                            maxHeightCap: 520,
                            maxWidthCap: 480,
                            renderContent: () => React.createElement('View', { testID: 'mcp-content' }),
                        },
                        render: ({ toggleCollapsedPopover, chipAnchorRef }: any) => React.createElement(
                            'Pressable',
                            {
                                ref: chipAnchorRef,
                                testID: 'visible-mcp-chip',
                                onPress: () => toggleCollapsedPopover?.('new-session-mcp'),
                            },
                        ),
                    }]}
                    onMachineClick={() => {}}
                    machineName="Builder"
                />);

        const chip = screen.findByTestId('visible-mcp-chip');

        expect(chip).toBeTruthy();
        if (!chip) {
            return;
        }

        await screen.pressByTestIdAsync('visible-mcp-chip');

        expect(screen.findByTestId('mcp-content')).toBeTruthy();
        const visibleChipPopoverProps = captured.last as CapturedPopoverProps | null;
        expect(visibleChipPopoverProps?.open).toBe(true);
        expect(visibleChipPopoverProps?.maxHeightCap).toBe(520);

        await screen.pressByTestIdAsync('visible-mcp-chip');

        expect(screen.findByTestId('mcp-content')).toBeNull();
    });

    it('routes collapsed machine actions through the shared content popover when a machine popover is configured', async () => {
        vi.resetModules();
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedSimpleOptionsPopover.last = null;
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                    agentType={"codex" as any}
                    onAgentClick={() => {}}
                    machinePopover={{
                        renderContent: () => React.createElement('View', { testID: 'machine-content' }),
                    }}
                    machineName="Builder"
                    onMachineClick={() => {}}
                />);

        const settingsButton = screen.findByTestId('agent-input-action-menu-button');
        const machinePressable = screen.findByTestId('agent-input-machine-chip');

        expect(settingsButton).toBeTruthy();
        expect(machinePressable).toBeTruthy();
        if (!settingsButton || !machinePressable) {
            return;
        }

        await screen.pressByTestIdAsync('agent-input-action-menu-button');

        const actionMenuActions = getCapturedActionMenuActions();
        const machineAction = actionMenuActions.find((action: { id?: string }) => action.id === 'machine');
        expect(machineAction).toBeTruthy();

        act(() => {
            machineAction?.onPress?.();
        });

        const contentPopoverProps = captured.last as (Record<string, unknown> & {
            open?: boolean;
            anchorRef?: unknown;
            maxHeightCap?: number;
            maxWidthCap?: number;
        }) | null;

        expect(contentPopoverProps?.open).toBe(true);
        expect(contentPopoverProps?.anchorRef).toStrictEqual(machinePressable.props.ref);
        expect(contentPopoverProps?.maxHeightCap).toBeGreaterThan(0);
        expect(contentPopoverProps?.maxWidthCap).toBeGreaterThan(0);
    });

    it('routes collapsed resume actions through the shared content popover anchored to the action menu button', async () => {
        vi.resetModules();
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedSimpleOptionsPopover.last = null;
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                    resumeSessionId="session-42"
                    resumePopover={{
                        renderContent: () => React.createElement('View', { testID: 'resume-content' }),
                        maxHeightCap: 420,
                        maxWidthCap: 520,
                    }}
                    onMachineClick={() => {}}
                    machineName="Builder"
                />);

        const settingsButton = screen.findByTestId('agent-input-action-menu-button');

        expect(settingsButton).toBeTruthy();
        if (!settingsButton) {
            return;
        }

        await screen.pressByTestIdAsync('agent-input-action-menu-button');

        const actionMenuActions = getCapturedActionMenuActions();
        const resumeAction = actionMenuActions.find((action: { id?: string }) => action.id === 'resume');
        expect(resumeAction).toBeTruthy();

        act(() => {
            resumeAction?.onPress?.();
        });

        const contentPopoverProps = captured.last as (Record<string, unknown> & {
            open?: boolean;
            anchorRef?: unknown;
            maxHeightCap?: number;
            maxWidthCap?: number;
        }) | null;

        expect(contentPopoverProps?.open).toBe(true);
        expect(contentPopoverProps?.anchorRef).toEqual(settingsButton.props.ref);
        expect(contentPopoverProps?.maxHeightCap).toBe(420);
        expect(contentPopoverProps?.maxWidthCap).toBe(520);
    });

    it('routes the target-server chip through the shared content popover rather than a route-only action', async () => {
        vi.resetModules();
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedSimpleOptionsPopover.last = null;
        const { createServerActionChip } = await import('./definitions/createServerActionChip');

        const toggleCollapsedPopover = vi.fn();
        function Probe() {
            const chip = createServerActionChip({
                label: 'Server B',
                popoverContent: () => React.createElement('View', { testID: 'server-selection-content' }),
            } as any);

            const renderedChip = chip.render({
                chipStyle: () => null,
                iconColor: '#000',
                showLabel: true,
                textStyle: null,
                countTextStyle: null,
                chipAnchorRef: { current: null },
                popoverAnchorRef: { current: null },
                toggleCollapsedPopover,
            });

            return React.isValidElement<{ testID?: string }>(renderedChip)
                ? React.cloneElement(renderedChip, { testID: 'new-session-target-server-chip' })
                : renderedChip;
        }

        const screen = await renderScreen(<Probe />);

        await screen.pressByTestIdAsync('new-session-target-server-chip');

        expect(toggleCollapsedPopover).toHaveBeenCalledWith('new-session-target-server');
        expect(captured.last).toBeNull();
    });

    it('routes the checkout/worktree chip through the shared simple-options popover anchored to the chip', async () => {
        vi.resetModules();
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedSimpleOptionsPopover.last = null;
        const { AgentInput } = await import('./AgentInput');
        const { createCheckoutActionChip } = await import('./definitions/createCheckoutActionChip');

        const checkoutChip = createCheckoutActionChip({
            interaction: { kind: 'picker' },
            pickerOpen: false,
            title: 'Checkout',
            selectedLabel: 'No worktree',
            selectedOptionId: 'none',
            pickerOptions: [
                { id: 'none', label: 'No worktree', sectionId: 'linked', sectionLabel: 'Linked' },
                { id: 'create_git_worktree', label: 'New worktree', sectionId: 'actions', sectionLabel: 'Actions' },
            ],
            onApplyOption: () => {},
            onRequestClose: () => {},
            setPickerOpen: () => {},
        });

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                extraActionChips={[checkoutChip]}
            />,
        );

        const chip = screen.findByTestId('new-session-checkout-chip');
        expect(chip).toBeTruthy();
        if (!chip) return;

        await screen.pressByTestIdAsync('new-session-checkout-chip');

        const simpleOptionsPopoverProps = capturedSimpleOptionsPopover.last as (Record<string, unknown> & {
            open?: boolean;
            anchorRef?: unknown;
        }) | null;

        expect(simpleOptionsPopoverProps?.open).toBe(true);
        expect(simpleOptionsPopoverProps?.anchorRef).toStrictEqual(chip.props.ref);
    });

});
