import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
    onChangeText: vi.fn(),
    onSend: vi.fn(),
    inputBlur: vi.fn(),
    suggestionMoveUp: vi.fn(),
    suggestionMoveDown: vi.fn(),
}));

const settingState = vi.hoisted(() => ({
    webEnterToSend: true,
    nativeEnterToSend: true,
}));

const hardwareShiftEnterState = vi.hoisted(() => ({
    listener: null as null | (() => void),
    remove: vi.fn(),
}));

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
            ActivityIndicator: (props: Record<string, unknown>) => React.createElement('ActivityIndicator', props, null),
            Platform: {
                OS: 'ios',
                select: (v: any) => v.ios ?? v.default ?? null,
            },
            useWindowDimensions: () => ({ width: 900, height: 600 }),
            Dimensions: {
                get: () => ({ width: 900, height: 600, scale: 1, fontScale: 1 }),
            },
        });
    },
    icons: () => ({
        Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props, null),
        Octicons: (props: Record<string, unknown>) => React.createElement('Octicons', props, null),
    }),
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({ translate: (key) => key });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => {
                if (key === 'profiles') return [];
                if (key === 'agentInputEnterToSend') return settingState.webEnterToSend;
                if (key === 'agentInputEnterToSendNative') return settingState.nativeEnterToSend;
                if (key === 'agentInputActionBarLayout') return 'wrap';
                if (key === 'agentInputChipDensity') return 'labels';
                if (key === 'sessionPermissionModeApplyTiming') return 'immediate';
                return null;
            },
            useSettings: () => ({
                profiles: [],
                agentInputEnterToSend: settingState.webEnterToSend,
                agentInputEnterToSendNative: settingState.nativeEnterToSend,
                agentInputActionBarLayout: 'wrap',
                agentInputChipDensity: 'labels',
                sessionPermissionModeApplyTiming: 'immediate',
            }),
            useSessionMessages: () => ({ messages: [], isLoaded: true }),
            useSessionTranscriptIds: () => ({ ids: [], isLoaded: true }),
            useSessionMessagesById: () => ({}),
            useSessionMessagesVersion: () => 0,
            useSessionMessagesReducerState: () => null,
        });
    },
});

vi.mock('@/sync/store/hooks', () => ({
    useLocalSetting: () => 1,
}));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

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
    describeEffectivePermissionMode: () => ({ effectiveMode: 'default', notes: [] }),
}));

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: React.forwardRef((props: any, ref: any) => {
        React.useImperativeHandle(ref, () => ({
            setTextAndSelection: (text: string, selection: { start: number; end: number }) => {
                props.onChangeText?.(text);
                props.onStateChange?.({ text, selection });
            },
            focus: () => {},
            blur: mocks.inputBlur,
        }));
        return React.createElement('MultiTextInput', props, null);
    }),
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
    useActiveSuggestions: () => [[], -1, mocks.suggestionMoveUp, mocks.suggestionMoveDown],
}));

vi.mock('@/components/autocomplete/applySuggestion', () => ({
    applySuggestion: (text: string) => ({ text, cursorPosition: text.length }),
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: () => null,
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
}));

vi.mock('@/components/ui/overlays/FloatingOverlay', () => ({
    FloatingOverlay: () => null,
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

vi.mock('./subscribeToIosHardwareShiftEnter', () => ({
    subscribeToIosHardwareShiftEnter: (listener: () => void) => {
        hardwareShiftEnterState.listener = listener;
        return {
            remove: hardwareShiftEnterState.remove,
        };
    },
}));

function findMultiTextInput(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const nodes = screen.findAll((node) => (node.type as any) === 'MultiTextInput');
    expect(nodes.length).toBe(1);
    return nodes[0]!;
}

describe('AgentInput (enter to send on native)', () => {
    afterEach(() => {
        settingState.webEnterToSend = true;
        settingState.nativeEnterToSend = true;
        hardwareShiftEnterState.listener = null;
        vi.clearAllMocks();
    });

    it('sends and blurs on Enter for existing sessions when native enter-to-send is enabled', async () => {
        const { AgentInput } = await import('./AgentInput');
        const screen = await renderScreen(
            <AgentInput
                sessionId="session-1"
                value="hello"
                onChangeText={mocks.onChangeText}
                placeholder="p"
                onSend={mocks.onSend}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                isSendDisabled={false}
                disabled={false}
                showAbortButton={false}
            />
        );

        const input = findMultiTextInput(screen);

        expect(input.props.submitBehavior).toBe('submit');

        await act(async () => {
            input.props.onSubmitEditing?.();
        });

        expect(mocks.onSend).toHaveBeenCalledTimes(1);
        expect(mocks.inputBlur).toHaveBeenCalledTimes(1);
    });

    it('inserts a newline for focused hardware Shift+Enter when native enter-to-send is enabled', async () => {
        settingState.webEnterToSend = false;
        settingState.nativeEnterToSend = true;

        const { AgentInput } = await import('./AgentInput');
        const screen = await renderScreen(
            <AgentInput
                value="hello"
                onChangeText={mocks.onChangeText}
                placeholder="p"
                onSend={mocks.onSend}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                isSendDisabled={false}
                disabled={false}
                showAbortButton={false}
            />
        );

        const input = findMultiTextInput(screen);

        await act(async () => {
            input.props.onStateChange?.({
                text: 'hello',
                selection: { start: 5, end: 5 },
            });
            input.props.onFocus?.();
        });

        expect(hardwareShiftEnterState.listener).toBeTypeOf('function');

        await act(async () => {
            hardwareShiftEnterState.listener?.();
        });

        expect(mocks.onChangeText).toHaveBeenCalledWith('hello\n');
        expect(mocks.onSend).not.toHaveBeenCalled();
    });
});
