import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import { renderScreen } from '@/dev/testkit';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
    onChangeText: vi.fn(),
    onSend: vi.fn(),
    inputBlur: vi.fn(),
    suggestionMoveUp: vi.fn(),
    suggestionMoveDown: vi.fn(),
    activeSuggestions: [] as AutocompleteSuggestion[],
    activeSuggestionIndex: -1,
}));

const settingState = vi.hoisted(() => ({
    webEnterToSend: true,
    nativeEnterToSend: false,
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
    useSessionServerId: () => null,
}));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: Record<string, unknown> & { children?: React.ReactNode }) =>
        React.createElement('Text', props, props.children),
    TextInput: React.forwardRef((props: Record<string, unknown>, ref) => {
        React.useImperativeHandle(ref, () => ({
            blur: mocks.inputBlur,
            focus: () => {},
            setNativeProps: () => {},
        }));
        return React.createElement('TextInput', props, null);
    }),
}));

vi.mock('@/agents/catalog/catalog', () => ({
    AGENT_IDS: ['codex', 'claude', 'opencode', 'gemini'],
    DEFAULT_AGENT_ID: 'codex',
    resolveAgentIdFromFlavor: () => null,
    getAgentCore: () => ({ displayNameKey: 'agents.codex', toolRendering: { hideUnknownToolsByDefault: false } }),
}));

vi.mock('@/sync/domains/models/modelOptions', () => ({
    findModelOptionForEffectiveModelId: (options: any, effectiveModelId: any) =>
        options?.find?.((option: any) => option.value === effectiveModelId)
            ?? options?.find?.((option: any) => option.value === String(effectiveModelId ?? '').replace(/\[[^\]]*\]$/u, ''))
            ?? null,
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
    useActiveSuggestions: () => [mocks.activeSuggestions, mocks.activeSuggestionIndex, mocks.suggestionMoveUp, mocks.suggestionMoveDown],
}));

vi.mock('@/components/autocomplete/applySuggestion', () => ({
    applySuggestion: (text: string) => ({ text, cursorPosition: text.length }),
}));

vi.mock('@/components/ui/popover', () => ({
    Popover: () => null,
    PopoverScope: ({ children }: any) => React.createElement(React.Fragment, null, children),
    MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS: { web: { target: 'body' }, native: true },
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

function findNativeTextInput(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const nodes = screen.findAll((node) => (node.type as any) === 'TextInput');
    expect(nodes.length).toBe(1);
    return nodes[0]!;
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        return style.reduce<Record<string, unknown>>((merged, entry) => ({
            ...merged,
            ...flattenStyle(entry),
        }), {});
    }
    if (typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

describe('AgentInput (enter to send on native)', () => {
    afterEach(() => {
        settingState.webEnterToSend = true;
        settingState.nativeEnterToSend = false;
        hardwareShiftEnterState.listener = null;
        mocks.activeSuggestions = [];
        mocks.activeSuggestionIndex = -1;
        vi.clearAllMocks();
    });

    it('uses a 16 point input text base for existing sessions and new sessions', async () => {
        const { AgentInput } = await import('./AgentInput');
        const existingSessionScreen = await renderScreen(
            <AgentInput
                sessionId="session-1"
                value=""
                onChangeText={mocks.onChangeText}
                placeholder="p"
                onSend={mocks.onSend}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                isSendDisabled={false}
                disabled={false}
                showAbortButton={false}
            />,
        );
        const newSessionScreen = await renderScreen(
            <AgentInput
                value=""
                onChangeText={mocks.onChangeText}
                placeholder="p"
                onSend={mocks.onSend}
                autocompletePrefixes={[]}
                autocompleteSuggestions={async () => []}
                isSendDisabled={false}
                disabled={false}
                showAbortButton={false}
            />,
        );

        expect(flattenStyle(findNativeTextInput(existingSessionScreen).props.style).fontSize).toBe(16);
        expect(flattenStyle(findNativeTextInput(newSessionScreen).props.style).fontSize).toBe(16);
    });

    it('lets owners handle autocomplete suggestion selection before default insertion', async () => {
        mocks.activeSuggestions = [{ key: 'cmd-qa', text: '/qa', label: '/qa' }];
        mocks.activeSuggestionIndex = 0;
        const onAutocompleteSuggestionSelect = vi.fn(async () => ({
            handled: true,
            text: 'Expanded QA prompt',
            cursorPosition: 'Expanded QA prompt'.length,
        }));
        const { AgentInput } = await import('./AgentInput');
        const screen = await renderScreen(
            <AgentInput
                sessionId="session-1"
                value="/qa"
                onChangeText={mocks.onChangeText}
                placeholder="p"
                onSend={mocks.onSend}
                autocompletePrefixes={['/']}
                autocompleteSuggestions={async () => mocks.activeSuggestions as any}
                isSendDisabled={false}
                disabled={false}
                showAbortButton={false}
                onAutocompleteSuggestionSelect={onAutocompleteSuggestionSelect as any}
            />
        );

        const input = findNativeTextInput(screen);

        await act(async () => {
            input.props.onKeyPress?.({
                nativeEvent: { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false },
                preventDefault: vi.fn(),
            });
        });

        expect(onAutocompleteSuggestionSelect).toHaveBeenCalledWith(expect.objectContaining({
            suggestion: expect.objectContaining({ key: 'cmd-qa', text: '/qa' }),
            input: '/qa',
            selection: { start: 3, end: 3 },
        }));
        expect(mocks.onChangeText).toHaveBeenCalledWith('Expanded QA prompt');
        expect(mocks.onSend).not.toHaveBeenCalled();
    });

    it('falls back to default insertion when owner autocomplete selection declines handling', async () => {
        mocks.activeSuggestions = [{ key: 'cmd-qa', text: '/qa', label: '/qa' }];
        mocks.activeSuggestionIndex = 0;
        const onAutocompleteSuggestionSelect = vi.fn(async () => ({ handled: false }));
        const { AgentInput } = await import('./AgentInput');
        const screen = await renderScreen(
            <AgentInput
                sessionId="session-1"
                value="/qa"
                onChangeText={mocks.onChangeText}
                placeholder="p"
                onSend={mocks.onSend}
                autocompletePrefixes={['/']}
                autocompleteSuggestions={async () => mocks.activeSuggestions}
                isSendDisabled={false}
                disabled={false}
                showAbortButton={false}
                onAutocompleteSuggestionSelect={onAutocompleteSuggestionSelect}
            />
        );

        const input = findNativeTextInput(screen);

        await act(async () => {
            input.props.onKeyPress?.({
                nativeEvent: { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false },
                preventDefault: vi.fn(),
            });
        });

        expect(onAutocompleteSuggestionSelect).toHaveBeenCalledOnce();
        expect(mocks.onChangeText).toHaveBeenCalledWith('/qa');
        expect(mocks.onSend).not.toHaveBeenCalled();
    });

    it('sends selected structured input mentions as message metadata overrides', async () => {
        settingState.webEnterToSend = false;
        settingState.nativeEnterToSend = true;
        mocks.activeSuggestions = [{
            key: 'vendor-plugin-github',
            text: '@github',
            label: 'GitHub',
            component: () => React.createElement('View', null),
            structuredInput: {
                kind: 'vendorPlugin',
                vendorPluginRef: 'github',
                label: 'GitHub',
                backendId: 'codex-app-server',
                agentId: 'codex',
            },
        }];
        mocks.activeSuggestionIndex = 0;
        const { AgentInput } = await import('./AgentInput');
        const screen = await renderScreen(
            <AgentInput
                sessionId="session-1"
                value="@github"
                onChangeText={mocks.onChangeText}
                placeholder="p"
                onSend={mocks.onSend}
                autocompletePrefixes={['@']}
                autocompleteSuggestions={async () => mocks.activeSuggestions}
                isSendDisabled={false}
                disabled={false}
                showAbortButton={false}
            />
        );

        const input = findNativeTextInput(screen);

        await act(async () => {
            input.props.onKeyPress?.({
                nativeEvent: { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false },
                preventDefault: vi.fn(),
            });
        });
        mocks.activeSuggestions = [];
        mocks.activeSuggestionIndex = -1;
        await act(async () => {
            input.props.onSubmitEditing?.();
        });

        expect(mocks.onSend).toHaveBeenCalledWith({
            structuredInputMetaOverrides: {
                happierStructuredInputV1: {
                    v: 1,
                    vendorPluginMentions: [{
                        vendorPluginRef: 'github',
                        label: 'GitHub',
                        backendId: 'codex-app-server',
                        agentId: 'codex',
                    }],
                },
            },
        });
    });

    it('does not submit from the native composer when only the web enter-to-send setting is enabled', async () => {
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
            />,
        );

        const input = findNativeTextInput(screen);

        expect(input.props.submitBehavior).toBe('newline');

        await act(async () => {
            input.props.onSubmitEditing?.();
        });

        expect(mocks.onSend).not.toHaveBeenCalled();
    });

    it('submits from the native composer when the native enter-to-send setting is enabled', async () => {
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
            />,
        );

        const input = findNativeTextInput(screen);

        expect(input.props.submitBehavior).toBe('submit');

        await act(async () => {
            input.props.onSubmitEditing?.();
        });

        expect(mocks.onSend).toHaveBeenCalledTimes(1);
    });

    it('blurs the existing-session composer when native Enter sends', async () => {
        settingState.webEnterToSend = false;
        settingState.nativeEnterToSend = true;

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
            />,
        );

        const input = findNativeTextInput(screen);

        await act(async () => {
            input.props.onSubmitEditing?.();
        });

        expect(mocks.onSend).toHaveBeenCalledTimes(1);
        expect(mocks.inputBlur).toHaveBeenCalledTimes(1);
    });

    it('inserts a newline for focused hardware Shift+Enter when the native enter-to-send setting is enabled', async () => {
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
            />,
        );

        const input = findNativeTextInput(screen);

        await act(async () => {
            input.props.onSelectionChange?.({
                nativeEvent: {
                    selection: { start: 5, end: 5 },
                },
            });
            input.props.onFocus?.({
                nativeEvent: {},
            });
        });

        expect(hardwareShiftEnterState.listener).toBeTypeOf('function');

        await act(async () => {
            hardwareShiftEnterState.listener?.();
        });

        expect(mocks.onChangeText).toHaveBeenCalledWith('hello\n');
        expect(mocks.onSend).not.toHaveBeenCalled();
    });

    it('uses platform-correct immediate-send bypass for native hardware Mod+Enter', async () => {
        settingState.webEnterToSend = false;
        settingState.nativeEnterToSend = false;

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
            />,
        );

        const input = findNativeTextInput(screen);

        await act(async () => {
            input.props.onKeyPress?.({
                nativeEvent: { key: 'Enter', shiftKey: false, metaKey: true, ctrlKey: false },
                preventDefault: vi.fn(),
            });
        });
        await act(async () => {
            input.props.onKeyPress?.({
                nativeEvent: { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: true },
                preventDefault: vi.fn(),
            });
        });
        await act(async () => {
            input.props.onKeyPress?.({
                nativeEvent: { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: true, platformOS: 'android' },
                preventDefault: vi.fn(),
            });
        });

        expect(mocks.onSend).toHaveBeenCalledTimes(2);
        expect(mocks.onSend).toHaveBeenNthCalledWith(1, { forceImmediate: true });
        expect(mocks.onSend).toHaveBeenNthCalledWith(2, { forceImmediate: true });
    });
});
