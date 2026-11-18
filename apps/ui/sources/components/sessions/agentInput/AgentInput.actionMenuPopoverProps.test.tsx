import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit/render/renderScreen';
import { createHomeGovernanceHarness, installHomeGovernanceBoundaries } from '@/dev/testkit/harness/homeGovernanceHarness';
import type { NavigationPlacement } from '@/sync/domains/settings/navigationPlacement';
import type { AgentInputExtraActionChip } from './agentInputContracts';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/ui/layout/layout', () => ({
    layout: { maxWidth: 800, headerMaxWidth: 800 },
    useLayoutMaxWidth: () => 800,
    useLayoutMaxWidthStyle: () => ({ maxWidth: 800 }),
}));

vi.mock('react-native', async () => {
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
});
vi.mock('@expo/vector-icons', () => ({
        Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
        Octicons: (props: Record<string, unknown>) => React.createElement('Octicons', props, null),
}));
vi.mock('@/text', async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@/modal', async () => {
        const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
        return createModalModuleMock().module;
});
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('react-native-reanimated', async () => (await import('@/dev/testkit/mocks/reanimated')).createReanimatedModuleMock());
vi.mock('react-native-keyboard-controller', () => ({
    useFocusedInputHandler: () => {},
    KeyboardController: { dismiss: () => Promise.resolve() },
}));

const inputFocus = vi.hoisted(() => vi.fn());
const inputSetTextAndSelection = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: React.forwardRef((props: Record<string, unknown>, ref) => {
        React.useImperativeHandle(ref, () => ({ focus: inputFocus, blur: () => {}, setSelection: () => {}, setTextAndSelection: inputSetTextAndSelection }));
        return React.createElement('MultiTextInput', props, null);
    }),
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
const capturedChipPickerPopover: { last: Record<string, unknown> | null } = { last: null };
const capturedSelectionListPopover: {
    last: Record<string, unknown> | null;
    all: Array<Record<string, unknown>>;
} = { last: null, all: [] };
const capturedPermissionPicker: { last: Record<string, unknown> | null } = { last: null };

function findSelectionListPopoverByOpen(open: boolean): Record<string, unknown> | undefined {
    return capturedSelectionListPopover.all.find((props) => props.open === open);
}

/** The presentation the shared Popover reports to its content (a phone sheet in the sheet test). */
const popoverPresentation: { current: 'sheet' | undefined } = { current: undefined };
/** Popover's own push decision (a phone panel), as its render props report it. */
const popoverPushesSubmenus: { current: boolean } = { current: false };

function renderPopoverChildren(
    props: Readonly<{
        children?: React.ReactNode | ((args: { maxHeight: number; presentation?: 'sheet' }) => React.ReactNode);
        maxHeightCap?: number;
    }>,
): React.ReactNode {
    return typeof props.children === 'function'
        ? props.children({ maxHeight: props.maxHeightCap ?? 360, presentation: popoverPresentation.current, ...(popoverPushesSubmenus.current ? { pushesSubmenus: true } : {}) })
        : props.children ?? null;
}

function getCapturedActionMenuActions(): Array<{ id?: string; onPress?: () => void }> {
    const current = capturedActionMenuContent.last;
    return current && Array.isArray(current.actionMenuActions)
        ? current.actionMenuActions
        : [];
}

vi.mock('@/components/ui/popover', () => ({
    MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS: {
        web: true,
        native: true,
        matchAnchorWidth: false,
        anchorAlign: 'start',
    },
    Popover: (props: CapturedPopoverProps) => {
        captured.last = props;
        return React.createElement('Popover', props, props.open ? renderPopoverChildren(props) : null);
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

vi.mock('@/hooks/ui/useKeyboardHeight', () => ({
    useKeyboardHeight: () => 0,
}));

vi.mock('./components/PermissionModePicker', () => ({
    PermissionModePicker: (props: Record<string, unknown>) => {
        capturedPermissionPicker.last = props;
        return null;
    },
}));

vi.mock('./components/AgentInputActionMenuPopoverContent', () => ({
    AgentInputActionMenuPopoverContent: (props: CapturedActionMenuContentProps & { children?: React.ReactNode }) => {
        capturedActionMenuContent.last = props;
        // A row's picker renders inside the menu.
        return props.children ?? null;
    },
}));

vi.mock('./components/AgentInputChipPickerPopover', () => ({
    AgentInputChipPickerPopover: (props: Record<string, unknown>) => {
        capturedChipPickerPopover.last = props;
        return null;
    },
}));

vi.mock('./components/AgentInputSelectionListPopover', () => ({
    AgentInputSelectionListPopover: (props: Record<string, unknown>) => {
        capturedSelectionListPopover.last = props;
        capturedSelectionListPopover.all.push(props);
        return null;
    },
}));

const home = createHomeGovernanceHarness();
installHomeGovernanceBoundaries(home);
const { getStorage } = await import('@/sync/domains/state/storageStore');
const initialStorageState = getStorage().getState();
function setComposerPlacements(placements: Readonly<Record<string, NavigationPlacement>>) {
    getStorage().setState((state) => ({
        localSettings: {
            ...state.localSettings,
            navigationSurfacePlacementsV1: {
                ...state.localSettings.navigationSurfacePlacementsV1,
                composer: { orderedIds: [], placements },
            },
        },
    }));
}
beforeEach(() => {
    getStorage().setState({ settings: {
        ...initialStorageState.settings,
        agentInputEnterToSend: true,
        agentInputActionBarLayout: 'wrap',
        agentInputChipDensity: 'labels',
        sessionPermissionModeApplyTiming: 'immediate',
    } });
    setComposerPlacements({});
});
afterEach(async () => {
    getStorage().setState(initialStorageState, true);
    await home.reset();
});

await import('./AgentInput');

describe('AgentInput (action menu popover props)', () => {
    it('anchors autocomplete suggestions to the composer input container', async () => {
        captured.last = null;
        const { AgentInput } = await import('./AgentInput');
        const { CommandMenu } = await import('@/components/ui/commandMenu');

        const screen = await renderScreen(<AgentInput
                    value="/m"
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={['slashCommand']}
                    autocompleteSuggestions={async () => [{
                        kind: 'slashCommand', key: 'slash-command', text: '/mcp', label: '/mcp', description: 'MCP',
                    }]}
                />);

        const composerInput = screen.findByType('MultiTextInput');
        await act(async () => { composerInput.props.onFocus?.(); });
        const autocompletePopoverProps = screen.findByType(CommandMenu).props;
        expect(autocompletePopoverProps.open).toBe(true);
        expect(autocompletePopoverProps.anchor.kind).toBe('view');
        let composerInputContainer = composerInput?.parent ?? null;
        while (composerInputContainer && String(composerInputContainer.type) !== 'View') {
            composerInputContainer = composerInputContainer.parent;
        }
        expect(composerInputContainer?.props.ref).toBe(autocompletePopoverProps.anchor.ref);
    });

    it('renders incomplete slash suggestions using their text fallback without crashing', async () => {
        const { AgentInput } = await import('./AgentInput');
        const { CommandMenu } = await import('@/components/ui/commandMenu');

        const screen = await renderScreen(
            <AgentInput
                value="/bro"
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={['slashCommand']}
                autocompleteSuggestions={async () => [{ kind: 'slashCommand', key: 'broken', text: '/broken', component: undefined }]}
            />,
        );
        await act(async () => { screen.findByType('MultiTextInput').props.onFocus?.(); });
        const menu = screen.findByType(CommandMenu).props;
        expect(menu.open).toBe(true);
        expect(menu.items.find((item: { id: string }) => item.id === 'slashCommand:broken')).toMatchObject({
            label: '/broken', renderRow: undefined,
        });
    });

    it('anchors the permission popover to the permission chip and uses the shared popover sizing', async () => {
        capturedPermissionPicker.last = null;
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    onPermissionModeChange={() => {}}
                    autocompleteKinds={[]}
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

    it('closes the permission popover after selecting a mode', async () => {
        captured.last = null;
        capturedPermissionPicker.last = null;
        const { AgentInput } = await import('./AgentInput');

        const onPermissionModeChange = vi.fn();
        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    onPermissionModeChange={onPermissionModeChange}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                />);

        const basePopoverCount = screen.findAllByType('Popover').length;
        const permissionPressable = screen.findByTestId('agent-input-permission-chip');

        await screen.pressByTestIdAsync('agent-input-permission-chip');

        expect(screen.findAllByType('Popover')).toHaveLength(basePopoverCount + 1);
        expect(typeof (capturedPermissionPicker.last as any)?.onSelect).toBe('function');

        act(() => {
            (capturedPermissionPicker.last as any).onSelect('default');
        });

        expect(onPermissionModeChange).toHaveBeenCalledWith('default');
        expect(screen.findAllByType('Popover')).toHaveLength(basePopoverCount);
        expect(
            screen.findAllByType('Popover').some((node) => (node.props as any).anchorRef === (permissionPressable as any).props.ref),
        ).toBe(false);
    });

    it("routes the pending delivery row through the SelectionList popover and per-option onSelect dispatches the mutation", async () => {
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedChipPickerPopover.last = null;
        capturedSelectionListPopover.last = null;
        capturedSelectionListPopover.all = [];
        const { AgentInput } = await import('./AgentInput');
        const { createExecutionRunRequestedActionChip } = await import(
            './routing/createExecutionRunRequestedActionChip'
        );

        const onRequestedActionChange = vi.fn();
        const deliveryChip = createExecutionRunRequestedActionChip({
            recipient: { kind: 'execution_run', runId: 'A1' },
            requestedAction: { v: 1, kind: 'send_now' },
            onRequestedActionChange,
        });

        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    agentType={"codex" as any}
                    onAgentClick={() => {}}
                    extraActionChips={[deliveryChip]}
                    onMachineClick={() => {}}
                    machineName="Builder"
                />);

        const deliveryPressable = screen.findByTestId('agent-input-delivery-chip');
        expect(deliveryPressable).toBeTruthy();
        let deliveryContainer = deliveryPressable?.parent ?? null;
        while (deliveryContainer && String(deliveryContainer.type) !== 'View') {
            deliveryContainer = deliveryContainer.parent;
        }
        await screen.pressByTestIdAsync('agent-input-delivery-chip');

        const selectionListProps = findSelectionListPopoverByOpen(true) as (Record<string, unknown> & {
            open?: boolean;
            anchorRef?: unknown;
            rootStep?: { sections?: Array<{ kind: string; options?: Array<{ id: string; onSelect?: () => void }> }> };
            selectedOptionId?: string | null;
        }) | undefined;
        expect(capturedChipPickerPopover.last).toBeNull();
        expect(selectionListProps).toBeTruthy();
        expect(selectionListProps?.anchorRef).toBe(deliveryContainer?.props.ref);
        expect(selectionListProps?.selectedOptionId).toBe('send_now');

        const section = selectionListProps?.rootStep?.sections?.[0];
        expect(section?.kind).toBe('static');
        const steerOption = section?.options?.find((option) => option.id === 'steer_if_active');
        expect(typeof steerOption?.onSelect).toBe('function');

        act(() => steerOption?.onSelect?.());

        expect(onRequestedActionChange).toHaveBeenCalledWith({ v: 1, kind: 'steer_if_active' });
    });

    it("routes the migrated recipient factory through the SelectionList popover and per-option onSelect dispatches the mutation", async () => {
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedChipPickerPopover.last = null;
        capturedSelectionListPopover.last = null;
        capturedSelectionListPopover.all = [];
        const { AgentInput } = await import('./AgentInput');
        const { createRecipientActionChip } = await import('./definitions/createRecipientActionChip');

        const onRecipientChange = vi.fn();
        const recipientChip = createRecipientActionChip({
            isReadOnly: false,
            participantTargets: [
                {
                    key: 'run-A1',
                    displayLabel: 'Run A1',
                    recipient: { kind: 'execution_run', runId: 'A1' },
                },
            ],
            recipient: null,
            onRecipientChange,
        })!;

        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    agentType={"codex" as any}
                    onAgentClick={() => {}}
                    extraActionChips={[recipientChip]}
                    onMachineClick={() => {}}
                    machineName="Builder"
                />);

        const settingsButton = screen.findByTestId('agent-input-action-menu-button');

        expect(settingsButton).toBeTruthy();
        if (!settingsButton) return;

        await screen.pressByTestIdAsync('agent-input-action-menu-button');

        const recipientAction = getCapturedActionMenuActions().find(
            (action: { id?: string }) => action.id === recipientChip.key,
        );
        expect(recipientAction).toBeTruthy();
        act(() => recipientAction?.onPress?.());

        const selectionListProps = findSelectionListPopoverByOpen(true) as (Record<string, unknown> & {
            open?: boolean;
            anchorRef?: unknown;
            rootStep?: { sections?: Array<{ kind: string; options?: Array<{ id: string; onSelect?: () => void }> }> };
            selectedOptionId?: string | null;
        }) | undefined;
        expect(capturedChipPickerPopover.last).toBeNull();
        expect(selectionListProps).toBeTruthy();
        expect(selectionListProps?.anchorRef).toBe(settingsButton.props.ref);
        expect(selectionListProps?.selectedOptionId).toBe('lead');

        const section = selectionListProps?.rootStep?.sections?.[0];
        const runOption = section?.options?.find((option) => option.id === 'run-A1');
        expect(typeof runOption?.onSelect).toBe('function');

        act(() => runOption?.onSelect?.());

        expect(onRecipientChange).toHaveBeenCalledWith({
            kind: 'execution_run',
            runId: 'A1',
        });
    });

    it('routes the migrated storage factory through the SelectionList popover and per-option onSelect dispatches the mutation', async () => {
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedChipPickerPopover.last = null;
        capturedSelectionListPopover.last = null;
        capturedSelectionListPopover.all = [];
        const { AgentInput } = await import('./AgentInput');
        const { createTranscriptStorageActionChip } = await import('./definitions/createTranscriptStorageActionChip');

        const onStorageChange = vi.fn();
        const storageChip = createTranscriptStorageActionChip({
            transcriptStorage: 'persisted',
            onStorageChange,
        });

        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    agentType={"codex" as any}
                    onAgentClick={() => {}}
                    extraActionChips={[storageChip]}
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
        const storageAction = actionMenuActions.find((action: { id?: string }) => action.id === storageChip.key);
        expect(storageAction).toBeTruthy();

        act(() => {
            storageAction?.onPress?.();
        });

        const selectionListProps = findSelectionListPopoverByOpen(true) as (Record<string, unknown> & {
            open?: boolean;
            rootStep?: {
                id?: string;
                sections?: Array<{ kind: string; options?: Array<{ id: string; onSelect?: () => void }> }>;
            };
            selectedOptionId?: string | null;
            anchorRef?: unknown;
        }) | undefined;

        expect(selectionListProps).toBeTruthy();
        expect(selectionListProps?.rootStep?.id).toBe('transcript-storage-root');
        expect(selectionListProps?.selectedOptionId).toBe('persisted');
        expect(selectionListProps?.anchorRef).toBe(settingsButton.props.ref);
        expect(capturedChipPickerPopover.last).toBeNull();

        const directOption = selectionListProps?.rootStep?.sections?.[0]?.options?.find(
            (option) => option.id === 'direct',
        );
        expect(typeof directOption?.onSelect).toBe('function');
        act(() => directOption?.onSelect?.());
        expect(onStorageChange).toHaveBeenCalledWith('direct');
    });

    it('routes overflow content actions through the shared content popover beside their + menu row', async () => {
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedSelectionListPopover.last = null;
        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    agentType={"codex" as any}
                    onAgentClick={() => {}}
                    extraActionChips={[{
                        key: 'new-session-mcp',
                        controlId: 'capabilities',
                        placement: { id: 'capabilities', title: 'newSession.mcpChipLabel', defaultPlacement: 'overflow' },
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
        const mcpAction = actionMenuActions.find((action: { id?: string }) => action.id === 'new-session-mcp');
        expect(mcpAction).toBeTruthy();

        const mcpRow = { focus: vi.fn() };
        act(() => {
            (mcpAction as { rowRef?: (element: unknown) => void } | undefined)?.rowRef?.(mcpRow);
            mcpAction?.onPress?.();
        });

        const contentPopoverProps = captured.last as (Record<string, unknown> & {
            open?: boolean;
            anchorRef?: unknown;
            maxHeightCap?: number;
            maxWidthCap?: number;
        }) | null;

        expect(contentPopoverProps?.open).toBe(true);
        expect((contentPopoverProps?.anchorRef as React.RefObject<unknown> | undefined)?.current).toBe(mcpRow);
        expect(contentPopoverProps?.maxHeightCap).toBeGreaterThan(0);
        expect(contentPopoverProps?.maxWidthCap).toBeGreaterThan(0);
        expect(contentPopoverProps?.boundaryRef).toBeNull();
    });

    it('opens an overflowed chip when another surface asks for it, instead of closing it at once', async () => {
        captured.last = null;
        const { AgentInput } = await import('./AgentInput');
        const chip = {
            key: 'session-account',
            controlId: 'capabilities',
            placement: { id: 'capabilities', title: 'newSession.mcpChipLabel', defaultPlacement: 'overflow' as const },
            collapsedContentPopover: {
                title: 'newSession.mcpChipLabel', maxHeightCap: 520, maxWidthCap: 480,
                renderContent: () => React.createElement('View', { testID: 'account-chooser' }),
            },
            render: () => React.createElement('View', { testID: 'session-account-chip' }),
        } satisfies AgentInputExtraActionChip;
        const props = { value: '', placeholder: 'Type', onChangeText: () => {}, onSend: () => {}, autocompleteKinds: [],
            autocompleteSuggestions: async () => [], agentType: 'codex' as any, onAgentClick: () => {},
            extraActionChips: [chip], onMachineClick: () => {}, machineName: 'Builder' };
        const screen = await renderScreen(<AgentInput {...props} />);
        await screen.update(<AgentInput {...props} openActionChipRequest={{ chipKey: 'session-account', key: '1' }} />);
        expect(screen.findByTestId('account-chooser')).toBeTruthy();
        expect((captured.last as CapturedPopoverProps | null)?.open).toBe(true);
    });

    it('toggles a visible extra-chip content popover closed when the chip is pressed twice', async () => {
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedSelectionListPopover.last = null;
        const { AgentInput } = await import('./AgentInput');
        setComposerPlacements({ capabilities: 'pinned' });

        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    agentType={"codex" as any}
                    onAgentClick={() => {}}
                    extraActionChips={[{
                        key: 'new-session-mcp',
                        controlId: 'capabilities',
                        placement: { id: 'capabilities', title: 'newSession.mcpChipLabel', defaultPlacement: 'overflow' },
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

    // Insert (owner 2026-11-15): a visible entry to the '@' list. Opening it writes nothing, so a draft or
    // workflow is not changed until a value is chosen (WF-ACCEPT-1118B D12).
    it('opens the @ list at the caret for Insert without writing into the field', async () => {
        const { AgentInput } = await import('./AgentInput');
        inputSetTextAndSelection.mockClear();
        inputFocus.mockClear();
        const { CommandMenu } = await import('@/components/ui/commandMenu');
        const onChangeText = vi.fn();
        const suggest = vi.fn(async () => [{ kind: 'file' as const, key: 'file:src/a.ts', text: '@src/a.ts', label: 'src/a.ts' }]);
        let requestControl: ((intent: 'insertMention') => void) | null = null;
        const screen = await renderScreen(<AgentInput value="Fix it" placeholder="Type" onChangeText={onChangeText}
            autocompleteKinds={['file']} autocompleteSuggestions={suggest}
            onComposerControlRequestChange={(request) => { requestControl = request; }} />);
        await act(async () => { screen.findByType('MultiTextInput').props.onStateChange?.({ text: 'Fix it', selection: { start: 6, end: 6 } }); });
        await act(async () => requestControl?.('insertMention'));
        await act(async () => { screen.findByType('MultiTextInput').props.onFocus?.(); });
        expect(inputFocus).toHaveBeenCalled();
        await vi.waitFor(() => expect(suggest).toHaveBeenCalledWith('@', expect.anything(), expect.anything()));
        // The list is shown (live 20:5xZ: it resolved suggestions but never opened, since no word was typed).
        await vi.waitFor(() => expect(screen.findByType(CommandMenu).props.open).toBe(true));
        expect(inputSetTextAndSelection).not.toHaveBeenCalled();
        expect(onChangeText).not.toHaveBeenCalled();
        // A chosen value lands at the caret, after the existing text.
        const menu = screen.findByType(CommandMenu).props;
        await act(async () => menu.onSelect(menu.items[0], 0));
        const [text] = inputSetTextAndSelection.mock.calls.at(-1) ?? [];
        expect(text).toMatch(/^Fix it.*src\/a\.ts/u);
    });

    it('opens a visible extra-chip content popover for the initiating chip intent a picture hands over', async () => {
        captured.last = null;
        const { AgentInput } = await import('./AgentInput');
        setComposerPlacements({ capabilities: 'pinned' });
        let requestControl: ((intent: { chipPopover: string }) => void) | null = null;

        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    agentType={"codex" as any}
                    onAgentClick={() => {}}
                    onComposerControlRequestChange={(request) => { requestControl = request; }}
                    extraActionChips={[{
                        key: 'new-session-mcp',
                        controlId: 'capabilities',
                        placement: { id: 'capabilities', title: 'newSession.mcpChipLabel', defaultPlacement: 'overflow' },
                        collapsedContentPopover: {
                            title: 'newSession.mcpChipLabel',
                            maxHeightCap: 520,
                            maxWidthCap: 480,
                            renderContent: () => React.createElement('View', { testID: 'mcp-content' }),
                        },
                        render: ({ chipAnchorRef }: any) => React.createElement('Pressable', { ref: chipAnchorRef, testID: 'visible-mcp-chip' }),
                    }]}
                    onMachineClick={() => {}}
                    machineName="Builder"
                />);

        expect(screen.findByTestId('mcp-content')).toBeNull();
        await act(async () => requestControl?.({ chipPopover: 'new-session-mcp' }));
        expect(screen.findByTestId('mcp-content')).toBeTruthy();
        expect((captured.last as CapturedPopoverProps | null)?.open).toBe(true);
    });

    it('closes a chip detail and returns input focus when its placement moves out of the row', async () => {
        const { AgentInput } = await import('./AgentInput');
        setComposerPlacements({ capabilities: 'pinned' });
        const screen = await renderScreen(<AgentInput
            value="Draft stays here"
            placeholder="Type"
            onChangeText={() => {}}
            onSend={() => {}}
            autocompleteKinds={[]}
            autocompleteSuggestions={async () => []}
            extraActionChips={[{
                key: 'placement-detail',
                controlId: 'capabilities',
                placement: { id: 'capabilities', title: 'Capabilities', defaultPlacement: 'overflow' },
                collapsedContentPopover: {
                    title: 'Capabilities',
                    renderContent: () => React.createElement('View', { testID: 'placement-detail-content' }),
                },
                render: ({ toggleCollapsedPopover, chipAnchorRef }) => React.createElement('Pressable', {
                    ref: chipAnchorRef,
                    testID: 'placement-detail-chip',
                    onPress: () => toggleCollapsedPopover?.('placement-detail'),
                }),
            }]}
        />);

        for (const placement of ['overflow', 'hidden'] as const) {
            await act(async () => setComposerPlacements({ capabilities: 'pinned' }));
            await screen.pressByTestIdAsync('placement-detail-chip');
            expect(screen.findByTestId('placement-detail-content')).toBeTruthy();
            inputFocus.mockClear();

            await act(async () => setComposerPlacements({ capabilities: placement }));

            expect(screen.findByTestId('placement-detail-chip')).toBeNull();
            expect(screen.findByTestId('placement-detail-content')).toBeNull();
            expect(inputFocus).toHaveBeenCalled();
            expect(screen.findByType('MultiTextInput').props.value).toBe('Draft stays here');
        }
    });

    it('opens an overflow machine as a submenu beside its + menu row, keeping the menu open', async () => {
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedSelectionListPopover.last = null;
        const { AgentInput } = await import('./AgentInput');
        setComposerPlacements({ machine: 'overflow' });
        const requestCloses: Array<() => void> = [];

        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
                    autocompleteSuggestions={async () => []}
                    agentType={"codex" as any}
                    onAgentClick={() => {}}
                    machinePopover={{
                        renderContent: ({ requestClose }: { requestClose: () => void }) => {
                            requestCloses.push(requestClose);
                            return React.createElement('View', { testID: 'machine-content' });
                        },
                    }}
                    machineName="Builder"
                    onMachineClick={() => {}}
                />);

        expect(screen.findByTestId('agent-input-machine-chip')).toBeNull();
        await screen.pressByTestIdAsync('agent-input-action-menu-button');
        const menuExpanded = () => screen.findByTestId('agent-input-action-menu-button')?.props.accessibilityState?.expanded;
        expect(menuExpanded()).toBe(true);

        const machineAction = getCapturedActionMenuActions().find((action: { id?: string }) => action.id === 'machine') as
            ({ onPress?: () => void; rowRef?: (element: unknown) => void } | undefined);
        const row = { focus: vi.fn() };
        act(() => machineAction?.rowRef?.(row));
        act(() => machineAction?.onPress?.());

        const picker = captured.last as (Record<string, unknown> & {
            open?: boolean; anchorRef?: React.RefObject<unknown>; placement?: string; onRequestClose?: () => void;
        }) | null;
        // The machine picker hangs beside the row that opened it, and the + menu stays open.
        expect(picker?.open).toBe(true);
        expect(picker?.anchorRef?.current).toBe(row);
        expect(picker?.placement).toBe('auto-horizontal');
        expect(menuExpanded()).toBe(true);

        // A dismissal (Escape, an outside press) returns to the + menu.
        act(() => picker?.onRequestClose?.());
        expect(screen.findByTestId('machine-content')).toBeNull();
        expect(menuExpanded()).toBe(true);

        // Reopened, a choice made in the picker closes both.
        act(() => machineAction?.onPress?.());
        expect(screen.findByTestId('machine-content')).toBeTruthy();
        act(() => requestCloses[requestCloses.length - 1]?.());
        expect(screen.findByTestId('machine-content')).toBeNull();
        expect(menuExpanded()).toBe(false);
    });

    it('gives a + menu presented as a sheet no hover intent: its rows open by press only', async () => {
        popoverPresentation.current = 'sheet';
        try {
            capturedActionMenuContent.last = null;
            const { AgentInput } = await import('./AgentInput');
            setComposerPlacements({ machine: 'overflow' });
            const screen = await renderScreen(<AgentInput value="" placeholder="Type" onChangeText={() => {}} onSend={() => {}}
                autocompleteKinds={[]} autocompleteSuggestions={async () => []}
                machinePopover={{ renderContent: () => React.createElement('View', { testID: 'machine-content' }) }}
                machineName="Builder" onMachineClick={() => {}} />);
            await screen.pressByTestIdAsync('agent-input-action-menu-button');
            const machineRow = getCapturedActionMenuActions().find((action: { id?: string }) => action.id === 'machine') as
                ({ onHover?: () => void; onPress?: () => void } | undefined);
            expect(machineRow?.onHover).toBeUndefined();
            expect((capturedActionMenuContent.last as { onPointerLeave?: unknown } | null)?.onPointerLeave).toBeUndefined();
            act(() => machineRow?.onPress?.());
            expect(screen.findByTestId('machine-content')).toBeTruthy();
        } finally {
            popoverPresentation.current = undefined;
        }
    });

    // PATTERNS-1110: at web 390 the + menu is a phone panel that pushes its row pickers; hover intent there closed a
    // pushed picker as soon as the mouse "left" the hidden menu.
    it('gives a + menu that pushes its pickers (a phone panel) no hover intent: its rows open by press only', async () => {
        popoverPushesSubmenus.current = true;
        try {
            capturedActionMenuContent.last = null;
            const { AgentInput } = await import('./AgentInput');
            setComposerPlacements({ machine: 'overflow' });
            const screen = await renderScreen(<AgentInput value="" placeholder="Type" onChangeText={() => {}} onSend={() => {}}
                autocompleteKinds={[]} autocompleteSuggestions={async () => []}
                machinePopover={{ renderContent: () => React.createElement('View', { testID: 'machine-content' }) }}
                machineName="Builder" onMachineClick={() => {}} />);
            await screen.pressByTestIdAsync('agent-input-action-menu-button');
            const machineRow = getCapturedActionMenuActions().find((action: { id?: string }) => action.id === 'machine') as
                ({ onHover?: () => void; onPress?: () => void } | undefined);
            expect(machineRow?.onHover).toBeUndefined();
            expect((capturedActionMenuContent.last as { onPointerLeave?: unknown } | null)?.onPointerLeave).toBeUndefined();
            act(() => machineRow?.onPress?.());
            expect(screen.findByTestId('machine-content')).toBeTruthy();
        } finally {
            popoverPushesSubmenus.current = false;
        }
    });

    it('opens a + menu row picker with Right and on hover intent', async () => {
        vi.useFakeTimers();
        try {
            capturedActionMenuContent.last = null;
            const { AgentInput } = await import('./AgentInput');
            setComposerPlacements({ machine: 'overflow' });
            const screen = await renderScreen(<AgentInput
                        value=""
                        placeholder="Type"
                        onChangeText={() => {}}
                        onSend={() => {}}
                        autocompleteKinds={[]}
                        autocompleteSuggestions={async () => []}
                        machinePopover={{ renderContent: () => React.createElement('View', { testID: 'machine-content' }) }}
                        machineName="Builder"
                        onMachineClick={() => {}}
                    />);
            await screen.pressByTestIdAsync('agent-input-action-menu-button');
            const machineRow = () => getCapturedActionMenuActions().find((action: { id?: string }) => action.id === 'machine') as
                ({ onHover?: () => void; onKeyDown?: (event: unknown) => void } | undefined);

            act(() => machineRow()?.onKeyDown?.({ nativeEvent: { key: 'ArrowRight' }, preventDefault: () => {} }));
            expect(screen.findByTestId('machine-content')).toBeTruthy();

            const picker = captured.last as ({ onRequestClose?: () => void } | null);
            act(() => picker?.onRequestClose?.());
            expect(screen.findByTestId('machine-content')).toBeNull();

            // Hover opens it only after the shared submenu dwell.
            act(() => machineRow()?.onHover?.());
            expect(screen.findByTestId('machine-content')).toBeNull();
            act(() => { vi.advanceTimersByTime(200); });
            expect(screen.findByTestId('machine-content')).toBeTruthy();
        } finally {
            vi.useRealTimers();
        }
    });

    it('routes an overflow resume through the shared content popover beside its + menu row', async () => {
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedSelectionListPopover.last = null;
        const { AgentInput } = await import('./AgentInput');
        setComposerPlacements({ resume: 'overflow' });

        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={[]}
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

        const resumeRow = { focus: vi.fn() };
        act(() => {
            (resumeAction as { rowRef?: (element: unknown) => void } | undefined)?.rowRef?.(resumeRow);
            resumeAction?.onPress?.();
        });

        const contentPopoverProps = captured.last as (Record<string, unknown> & {
            open?: boolean;
            anchorRef?: unknown;
            maxHeightCap?: number;
            maxWidthCap?: number;
        }) | null;

        expect(contentPopoverProps?.open).toBe(true);
        expect((contentPopoverProps?.anchorRef as React.RefObject<unknown> | undefined)?.current).toBe(resumeRow);
        expect(contentPopoverProps?.maxHeightCap).toBe(420);
        expect(contentPopoverProps?.maxWidthCap).toBe(520);
    });

    it('routes the target-server chip through the shared content popover rather than a route-only action', async () => {
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedSelectionListPopover.last = null;
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

    it('routes a list-presentation checkout/worktree chip through the SelectionList popover anchored to the chip', async () => {
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedChipPickerPopover.last = null;
        capturedSelectionListPopover.last = null;
        capturedSelectionListPopover.all = [];
        const { AgentInput } = await import('./AgentInput');

        const checkoutRootStep = {
            id: 'worktree-root',
            sections: [
                {
                    kind: 'static' as const,
                    id: 'worktree:quick-actions',
                    options: [
                        { id: 'current_path', label: 'No worktree' },
                        { id: 'create_git_worktree', label: 'New worktree' },
                    ],
                },
            ],
        };

        const checkoutChip = {
            key: 'new-session-checkout',
            controlId: 'checkout' as const,
            placement: { id: 'checkout', title: 'Checkout' },
            collapsedOptionsPopover: {
                presentation: 'list' as const,
                title: 'Checkout',
                label: 'No worktree',
                icon: () => null,
                rootStep: checkoutRootStep,
                selectedOptionId: 'current_path',
                onSelect: () => {},
                maxHeightCap: 480,
                maxWidthCap: 720,
                heightBehavior: 'fixedToMaxHeight' as const,
            },
            render: (ctx: any) => React.createElement('Pressable', {
                ref: ctx.chipAnchorRef,
                testID: 'new-session-checkout-chip',
                onPress: () => ctx.toggleCollapsedPopover?.('new-session-checkout'),
            }, null),
        };

        const screen = await renderScreen(
            <AgentInput
                value=""
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                extraActionChips={[checkoutChip]}
            />,
        );

        const chip = screen.findByTestId('new-session-checkout-chip');
        expect(chip).toBeTruthy();
        if (!chip) return;

        await screen.pressByTestIdAsync('new-session-checkout-chip');

        const selectionListProps = capturedSelectionListPopover.last as (Record<string, unknown> & {
            open?: boolean;
            anchorRef?: unknown;
            rootStep?: { id?: string };
            heightBehavior?: string;
        }) | null;

        expect(selectionListProps?.open).toBe(true);
        expect(selectionListProps?.anchorRef).toStrictEqual(chip.props.ref);
        expect(selectionListProps?.rootStep?.id).toBe('worktree-root');
        expect(selectionListProps?.heightBehavior).toBe('fixedToMaxHeight');
        expect(capturedChipPickerPopover.last).toBeNull();
    });

});
