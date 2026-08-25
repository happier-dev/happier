import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
                useSessionTranscriptIds: () => ({ ids: [], isLoaded: true, hasRetainedContent: false }),
                useSessionMessagesById: () => ({}),
                useSessionMessagesVersion: () => 0,
                useSessionMessagesReducerState: () => createReducer(),
            },
        });
    },
});

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
    getAgentCore: () => ({
        displayNameKey: 'agents.codex',
        toolRendering: { hideUnknownToolsByDefault: false },
        ui: { agentPickerIconName: 'sparkles-outline' },
    }),
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

const activeSuggestionsState = vi.hoisted(() => ({ value: [] as Array<Record<string, unknown>> }));
vi.mock('@/components/autocomplete/useActiveSuggestions', () => ({
    useActiveSuggestions: () => [activeSuggestionsState.value, 0, () => {}, () => {}],
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
const capturedChipPickerPopover: { last: Record<string, unknown> | null } = { last: null };
const capturedSelectionListPopover: {
    last: Record<string, unknown> | null;
    all: Array<Record<string, unknown>>;
} = { last: null, all: [] };

function findSelectionListPopoverByOpen(open: boolean): Record<string, unknown> | undefined {
    // Multiple `AgentInputSelectionListPopover` instances may render in the
    // tree (the inline chip render keeps one mounted at open=false; the
    // overlay layer mounts another). Filter by `open` so the assertion does
    // not depend on render order.
    return capturedSelectionListPopover.all.find((props) => props.open === open);
}
const capturedPermissionPicker: { last: Record<string, unknown> | null } = { last: null };

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

function getCapturedPopoverProps(): CapturedPopoverProps | null {
    return captured.last;
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

vi.mock('@/sync/domains/sessionControl/sessionModeControl', () => ({
    computeAcpPlanModeControl: () => null,
    computeAcpSessionModePickerControl: () => null,
}));

vi.mock('@/sync/domains/sessionControl/configOptionsControl', () => ({
    computeSessionConfigOptionControls: () => null,
}));

vi.mock('./components/PermissionModePicker', () => ({
    PermissionModePicker: (props: Record<string, unknown>) => {
        capturedPermissionPicker.last = props;
        return null;
    },
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

vi.mock('./components/AgentInputSelectionListPopover', () => ({
    AgentInputSelectionListPopover: (props: Record<string, unknown>) => {
        capturedSelectionListPopover.last = props;
        capturedSelectionListPopover.all.push(props);
        return null;
    },
}));

describe('AgentInput (action menu popover props)', () => {
    beforeEach(() => {
        activeSuggestionsState.value = [];
    });

    it('anchors autocomplete suggestions to the composer input container', async () => {
        captured.last = null;
        activeSuggestionsState.value = [{
            // `kind` is the registry lookup the row mapper resolves its section
            // header and icon from; every suggestion carries one.
            kind: 'slashCommand',
            key: 'slash-command',
            text: '/mcp',
            label: '/mcp',
            description: 'MCP',
        }];

        const { AgentInput } = await import('./AgentInput');

        const screen = await renderScreen(<AgentInput
                    value="/m"
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompleteKinds={['slashCommand']}
                    autocompleteSuggestions={async () => []}
                />);

        const autocompletePopoverProps = getCapturedPopoverProps();
        expect(autocompletePopoverProps?.open).toBe(true);

        const composerInput = screen.findByType('MultiTextInput');
        let composerInputContainer = composerInput?.parent ?? null;
        while (composerInputContainer && String(composerInputContainer.type) !== 'View') {
            composerInputContainer = composerInputContainer.parent;
        }
        expect(composerInputContainer?.props.ref).toBe(autocompletePopoverProps?.anchorRef);
    });

    it('ignores autocomplete suggestions whose component is missing instead of crashing', async () => {
        activeSuggestionsState.value = [{ kind: 'slashCommand', key: 'broken', text: '/broken', component: undefined }];

        const { AgentInput } = await import('./AgentInput');

        await expect(renderScreen(
            <AgentInput
                value="/bro"
                placeholder="Type"
                onChangeText={() => {}}
                onSend={() => {}}
                autocompleteKinds={['slashCommand']}
                autocompleteSuggestions={async () => []}
            />,
        )).resolves.toEqual(expect.objectContaining({ tree: expect.anything() }));
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

    it("routes the migrated delivery factory through the SelectionList popover and per-option onSelect dispatches the mutation (RV-1 F1)", async () => {
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedChipPickerPopover.last = null;
        capturedSelectionListPopover.last = null;
        capturedSelectionListPopover.all = [];
        const { AgentInput } = await import('./AgentInput');
        const { createExecutionRunDeliveryActionChip } = await import(
            './routing/createExecutionRunDeliveryActionChip'
        );

        const onDeliveryChange = vi.fn();
        const deliveryChip = createExecutionRunDeliveryActionChip({
            recipient: { kind: 'execution_run', runId: 'A1' },
            delivery: 'interrupt',
            onDeliveryChange,
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

        const settingsButton = screen.findByTestId('agent-input-action-menu-button');
        expect(settingsButton).toBeTruthy();
        if (!settingsButton) return;

        await screen.pressByTestIdAsync('agent-input-action-menu-button');

        const deliveryAction = getCapturedActionMenuActions().find(
            (action: { id?: string }) => action.id === 'delivery',
        );
        expect(deliveryAction).toBeTruthy();
        act(() => deliveryAction?.onPress?.());

        // Migrated factory uses `presentation: 'list'` → SelectionList popover,
        // not the legacy chip-picker. The inline chip render keeps a popover
        // mounted at open=false; the overlay layer mounts another at open=true
        // when the action menu is invoked. Filter by `open` so the assertion
        // is order-independent.
        const selectionListProps = findSelectionListPopoverByOpen(true) as (Record<string, unknown> & {
            open?: boolean;
            anchorRef?: unknown;
            rootStep?: { sections?: Array<{ kind: string; options?: Array<{ id: string; onSelect?: () => void }> }> };
            selectedOptionId?: string | null;
        }) | undefined;
        expect(capturedChipPickerPopover.last).toBeNull();
        expect(selectionListProps).toBeTruthy();
        expect(selectionListProps?.anchorRef).toBe(settingsButton.props.ref);
        expect(selectionListProps?.selectedOptionId).toBe('interrupt');

        // The action-menu route activates rows via per-option SelectionListOption.onSelect
        // (the descriptor-level onSelect is a documented no-op for list-mode chips).
        const section = selectionListProps?.rootStep?.sections?.[0];
        expect(section?.kind).toBe('static');
        const steerOption = section?.options?.find((option) => option.id === 'steer_if_supported');
        expect(typeof steerOption?.onSelect).toBe('function');

        act(() => steerOption?.onSelect?.());

        expect(onDeliveryChange).toHaveBeenCalledWith('steer_if_supported');
    });

    it("routes the migrated recipient factory through the SelectionList popover and per-option onSelect dispatches the mutation (RV-1 F1)", async () => {
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedChipPickerPopover.last = null;
        capturedSelectionListPopover.last = null;
        capturedSelectionListPopover.all = [];
        const { AgentInput } = await import('./AgentInput');
        const { createRecipientActionChip } = await import(
            './definitions/createRecipientActionChip'
        );

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
            (action: { id?: string }) => action.id === 'recipient',
        );
        expect(recipientAction).toBeTruthy();
        act(() => recipientAction?.onPress?.());

        // Migrated factory uses `presentation: 'list'` → SelectionList popover.
        // Filter by open=true to skip the inline chip's idle popover mount.
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

        // Per-option onSelect MUST dispatch the recipient mutation when invoked
        // (this is the contract the action-menu overlay route depends on).
        const section = selectionListProps?.rootStep?.sections?.[0];
        const runOption = section?.options?.find((option) => option.id === 'run-A1');
        expect(typeof runOption?.onSelect).toBe('function');

        act(() => runOption?.onSelect?.());

        expect(onRecipientChange).toHaveBeenCalledWith({
            kind: 'execution_run',
            runId: 'A1',
        });
    });

    it('routes the migrated storage factory through the SelectionList popover and per-option onSelect dispatches the mutation (RV-1 F1)', async () => {
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedChipPickerPopover.last = null;
        capturedSelectionListPopover.last = null;
        capturedSelectionListPopover.all = [];
        const { AgentInput } = await import('./AgentInput');
        const { createTranscriptStorageActionChip } = await import(
            './definitions/createTranscriptStorageActionChip'
        );

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
        const storageAction = actionMenuActions.find((action: { id?: string }) => action.id === 'storage');
        expect(storageAction).toBeTruthy();

        act(() => {
            storageAction?.onPress?.();
        });

        // Filter by open=true to skip the inline chip's idle popover mount.
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

        // Per-option onSelect MUST dispatch the storage mutation.
        const directOption = selectionListProps?.rootStep?.sections?.[0]?.options?.find(
            (option) => option.id === 'direct',
        );
        expect(typeof directOption?.onSelect).toBe('function');
        act(() => directOption?.onSelect?.());
        expect(onStorageChange).toHaveBeenCalledWith('direct');
    });

    it('routes the migrated Windows-mode factory through the SelectionList popover and per-option onSelect dispatches the mutation (RV-1 F1)', async () => {
        captured.last = null;
        capturedActionMenuContent.last = null;
        capturedChipPickerPopover.last = null;
        capturedSelectionListPopover.last = null;
        capturedSelectionListPopover.all = [];
        const { AgentInput } = await import('./AgentInput');
        const { createWindowsRemoteSessionLaunchModeActionChip } = await import(
            './definitions/createWindowsRemoteSessionLaunchModeActionChip'
        );

        const onModeChange = vi.fn();
        const windowsChip = createWindowsRemoteSessionLaunchModeActionChip({
            mode: 'console',
            windowsTerminalAvailable: true,
            onModeChange,
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
                    extraActionChips={[windowsChip]}
                    onMachineClick={() => {}}
                    machineName="Builder"
                />);

        const settingsButton = screen.findByTestId('agent-input-action-menu-button');
        expect(settingsButton).toBeTruthy();
        if (!settingsButton) return;

        await screen.pressByTestIdAsync('agent-input-action-menu-button');

        const windowsAction = getCapturedActionMenuActions().find(
            (action: { id?: string }) => action.id === 'windowsRemoteSessionMode',
        );
        expect(windowsAction).toBeTruthy();
        act(() => windowsAction?.onPress?.());

        const selectionListProps = findSelectionListPopoverByOpen(true) as (Record<string, unknown> & {
            open?: boolean;
            anchorRef?: unknown;
            rootStep?: { sections?: Array<{ kind: string; options?: Array<{ id: string; onSelect?: () => void }> }> };
            selectedOptionId?: string | null;
        }) | undefined;

        expect(capturedChipPickerPopover.last).toBeNull();
        expect(selectionListProps).toBeTruthy();
        expect(selectionListProps?.anchorRef).toBe(settingsButton.props.ref);
        expect(selectionListProps?.selectedOptionId).toBe('console');

        const hiddenOption = selectionListProps?.rootStep?.sections?.[0]?.options?.find(
            (option) => option.id === 'hidden',
        );
        expect(typeof hiddenOption?.onSelect).toBe('function');
        act(() => hiddenOption?.onSelect?.());
        expect(onModeChange).toHaveBeenCalledWith('hidden');
    });

    it('routes collapsed content actions through the shared content popover anchored to the action menu button', async () => {
        captured.last = null;
        capturedActionMenuContent.last = null;
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
        captured.last = null;
        capturedActionMenuContent.last = null;
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
        captured.last = null;
        capturedActionMenuContent.last = null;
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
        captured.last = null;
        capturedActionMenuContent.last = null;
        const { AgentInput } = await import('./AgentInput');

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
        captured.last = null;
        capturedActionMenuContent.last = null;
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

    it('routes the checkout/worktree chip through the SelectionList popover anchored to the chip', async () => {
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
        }) | null;

        expect(selectionListProps?.open).toBe(true);
        expect(selectionListProps?.anchorRef).toStrictEqual(chip.props.ref);
        expect(selectionListProps?.rootStep?.id).toBe('worktree-root');
        // The legacy chip-picker route MUST NOT fire for the worktree popover.
        expect(capturedChipPickerPopover.last).toBeNull();
    });

});
