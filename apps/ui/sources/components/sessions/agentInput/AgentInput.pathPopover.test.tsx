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
};

installAgentInputCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock(
            {
                View: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                    React.createElement('View', props, props.children),
                Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
                    React.createElement('Text', props, props.children),
                Pressable: React.forwardRef((props: Record<string, unknown> & { children?: React.ReactNode }, ref) =>
                    React.createElement('Pressable', { ...props, __ref: ref }, props.children)),
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
            },
        );
    },
    icons: () => ({
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
};

const captured: { last: CapturedPopoverProps | null } = { last: null };
const capturedOverlay: { last: Record<string, unknown> | null } = { last: null };

vi.mock('@/components/ui/popover', () => ({
    Popover: (props: CapturedPopoverProps) => {
        captured.last = props;
        const renderedChildren = typeof (props as any).children === 'function'
            ? (props as any).children({ maxHeight: props.maxHeightCap ?? 360 })
            : (props as any).children ?? null;
        return React.createElement('Popover', props, renderedChildren);
    },
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: (props: Record<string, unknown> & { children?: React.ReactNode }) => {
        capturedOverlay.last = props;
        return React.createElement('FloatingOverlay', props, props.children);
    },
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

describe('AgentInput (path popover)', () => {
    it('opens the shared content popover from the path chip when a path popover is provided', async () => {
        captured.last = null;
        capturedOverlay.last = null;
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
                    pathPopover={{
                        renderContent: () => React.createElement('View', { testID: 'path-popover-content' }),
                        boundaryRef: null,
                        maxHeightCap: 540,
                        maxWidthCap: 520,
                    } as any}
                    onMachineClick={() => {}}
                    machineName="Builder"
                    currentPath="/Users/leeroy/Documents/Development/happier/dev"
                />);

        expect(screen.findByTestId('agent-input-path-chip')).toBeTruthy();

        act(() => {
            screen.pressByTestId('agent-input-path-chip');
        });

        const contentPopoverProps = captured.last as CapturedPopoverProps | null;
        expect(contentPopoverProps?.open).toBe(true);
        expect(contentPopoverProps).toEqual(expect.objectContaining({
            anchorRef: expect.objectContaining({ current: null }),
        }));
        expect(contentPopoverProps?.boundaryRef).toBeNull();
        expect(contentPopoverProps?.maxHeightCap).toBe(540);
        expect(contentPopoverProps?.maxWidthCap).toBe(520);
        // Content popovers should provide their own scroll container by default so list-like content
        // can size reliably inside maxHeight constraints on native.
        const overlayProps = capturedOverlay.last as { scrollEnabled?: boolean } | null;
        expect(overlayProps?.scrollEnabled).toBe(true);

        act(() => screen.tree.unmount());
    });

    it('opens the shared content popover from the machine chip when a machine popover is provided', async () => {
        captured.last = null;
        const { AgentInput } = await import('./AgentInput');

        const onMachineClick = vi.fn();
        const screen = await renderScreen(<AgentInput
                    value=""
                    placeholder="Type"
                    onChangeText={() => {}}
                    onSend={() => {}}
                    autocompletePrefixes={[]}
                    autocompleteSuggestions={async () => []}
                    agentType={"codex" as any}
                    onAgentClick={() => {}}
                    onMachineClick={onMachineClick}
                    machinePopover={{
                        renderContent: () => React.createElement('View', { testID: 'machine-popover-content' }),
                        maxHeightCap: 500,
                        maxWidthCap: 480,
                    } as any}
                    machineName="Builder"
                />);

        expect(screen.findByTestId('agent-input-machine-chip')).toBeTruthy();

        act(() => {
            screen.pressByTestId('agent-input-machine-chip');
        });

        expect(onMachineClick).not.toHaveBeenCalled();
        const machinePopoverProps = captured.last as CapturedPopoverProps | null;
        expect(machinePopoverProps?.open).toBe(true);
        expect(machinePopoverProps).toEqual(expect.objectContaining({
            anchorRef: expect.objectContaining({ current: null }),
        }));
        expect(machinePopoverProps?.maxHeightCap).toBe(500);
        expect(machinePopoverProps?.maxWidthCap).toBe(480);

        act(() => screen.tree.unmount());
    });

    it('opens the shared content popover from the resume chip when a resume popover is provided', async () => {
        captured.last = null;
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
                    resumePopover={{
                        renderContent: () => React.createElement('View', { testID: 'resume-popover-content' }),
                        maxHeightCap: 460,
                        maxWidthCap: 420,
                    } as any}
                    resumeSessionId={null}
                />);

        expect(screen.findByTestId('agent-input-resume-chip')).toBeTruthy();

        act(() => {
            screen.pressByTestId('agent-input-resume-chip');
        });

        const resumePopoverProps = captured.last as CapturedPopoverProps | null;
        expect(resumePopoverProps?.open).toBe(true);
        expect(resumePopoverProps).toEqual(expect.objectContaining({
            anchorRef: expect.objectContaining({ current: null }),
        }));
        expect(resumePopoverProps?.maxHeightCap).toBe(460);
        expect(resumePopoverProps?.maxWidthCap).toBe(420);

        act(() => screen.tree.unmount());
    });
});
