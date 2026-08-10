import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderScreen } from '@/dev/testkit';
import { TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT } from '@/components/ui/forms/largeTextInputPolicy';
import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
    onChangeText: vi.fn(),
    onSend: vi.fn(),
    inputFocus: vi.fn(),
    inputBlur: vi.fn(),
    suggestionMoveUp: vi.fn(),
    suggestionMoveDown: vi.fn(),
    activeSuggestions: [] as AutocompleteSuggestion[],
    activeSuggestionIndex: -1,
    respectSuggestionQuery: false,
    lastSuggestionQuery: undefined as string | null | undefined,
}));

const promptInvocationMock = vi.hoisted(() => ({
    resolve: vi.fn(async (_args: unknown) => ({ handled: false as boolean })),
}));

vi.mock('@/sync/domains/input/slashCommands/promptInvocationSuggestion', () => ({
    resolvePromptInvocationAutocompleteSelection: (args: unknown) => promptInvocationMock.resolve(args as never),
}));

const settingState = vi.hoisted(() => ({
    webEnterToSend: true,
    nativeEnterToSend: true,
}));

const hardwareShiftEnterState = vi.hoisted(() => ({
    listener: null as null | (() => void),
    remove: vi.fn(),
}));

const keyboardShortcutState = vi.hoisted(() => ({
    useHandlers: vi.fn(),
}));

type CommandMenuMockProps = {
    open?: boolean;
    query?: string;
    items?: readonly { id: string; label: string }[];
};

type CommandMenuKeyboardMockInput = {
    open?: boolean;
    onMoveUp: () => void;
    onMoveDown: () => void;
    onSelect: () => void;
    onClose: () => void;
};

const commandMenuState = vi.hoisted(() => ({
    lastProps: null as null | CommandMenuMockProps,
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

vi.mock('@/keyboard/KeyboardShortcutProvider', () => ({
    useKeyboardShortcutHandlers: (handlers: unknown) => keyboardShortcutState.useHandlers(handlers),
}));

vi.mock('@/components/ui/commandMenu', () => ({
    CommandMenu: (props: CommandMenuMockProps) => {
        commandMenuState.lastProps = props;
        return props.open ? React.createElement('CommandMenu', props, null) : null;
    },
    useCommandMenuKeyboard: (input: CommandMenuKeyboardMockInput) => ({
        handleKey: (event: { key: string; shiftKey?: boolean }) => {
            if (!input.open) return false;
            if (event.key === 'ArrowUp') {
                input.onMoveUp();
                return true;
            }
            if (event.key === 'ArrowDown') {
                input.onMoveDown();
                return true;
            }
            if (event.key === 'Enter' || (event.key === 'Tab' && !event.shiftKey)) {
                input.onSelect();
                return true;
            }
            if (event.key === 'Escape') {
                input.onClose();
                return true;
            }
            return false;
        },
    }),
}));

vi.mock('expo-image', () => ({
    Image: (props: Record<string, unknown>) => React.createElement('Image', props, null),
}));

vi.mock('@/components/tools/shell/permissions/PermissionFooter', () => ({
    PermissionFooter: () => null,
}));

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
    describeEffectivePermissionMode: () => ({ effectiveMode: 'default', notes: [] }),
}));

vi.mock('@/components/ui/forms/MultiTextInput', () => ({
    MultiTextInput: React.forwardRef((props: any, ref: any) => {
        React.useImperativeHandle(ref, () => ({
            setTextAndSelection: (text: string, selection: { start: number; end: number }) => {
                props.onChangeText?.(text);
                props.onStateChange?.({ text, selection });
            },
            setSelection: (selection: { start: number; end: number }) => {
                const text = typeof props.value === 'string' ? props.value : '';
                props.onStateChange?.({ text, selection });
                props.onSelectionChange?.(selection);
            },
            focus: mocks.inputFocus,
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

vi.mock('@/components/autocomplete/useActiveSuggestions', () => ({
    useActiveSuggestions: (query: string | null) => {
        mocks.lastSuggestionQuery = query;
        const suggestions = mocks.respectSuggestionQuery && query === null
            ? []
            : mocks.activeSuggestions;
        const selected = suggestions.length > 0 ? mocks.activeSuggestionIndex : -1;
        return [suggestions, selected, mocks.suggestionMoveUp, mocks.suggestionMoveDown];
    },
}));

vi.mock('@/components/autocomplete/applySuggestion', () => ({
    applySuggestion: (text: string) => ({ text, cursorPosition: text.length }),
}));

vi.mock('@/components/ui/popover', () => ({
    MODAL_AWARE_FLOATING_POPOVER_PORTAL_OPTIONS: {
        web: true,
        native: true,
        matchAnchorWidth: false,
        anchorAlign: 'start',
    },
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
        mocks.activeSuggestions = [];
        mocks.activeSuggestionIndex = -1;
        mocks.respectSuggestionQuery = false;
        mocks.lastSuggestionQuery = undefined;
        commandMenuState.lastProps = null;
        vi.clearAllMocks();
    });

    it('registers composer focus shortcuts through the central keyboard provider', async () => {
        const onAbort = vi.fn();
        const { AgentInput } = await import('./AgentInput');
        await renderScreen(
            <AgentInput
                sessionId="session-1"
                value="hello"
                onChangeText={mocks.onChangeText}
                placeholder="p"
                onSend={mocks.onSend}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                isSendDisabled={false}
                disabled={false}
                showAbortButton={true}
                onAbort={onAbort}
            />,
        );

        const registeredHandlers = keyboardShortcutState.useHandlers.mock.calls.at(-1)?.[0] as Record<string, () => void>;

        expect(registeredHandlers['composer.focus']).toEqual(expect.any(Function));
        expect(registeredHandlers['composer.abortConfirm']).toEqual(expect.any(Function));

        await act(async () => {
            registeredHandlers['composer.focus']();
        });

        expect(mocks.inputFocus).toHaveBeenCalledTimes(1);
    });

    it('lets the suggestion kind rewrite the whole input instead of inserting the token', async () => {
        // D-20: a prompt-template slash command replaces the entire composer input,
        // which a token string cannot express. The kind owns that rewrite.
        mocks.activeSuggestions = [{
            kind: 'slashCommand',
            key: 'cmd-qa',
            text: '/qa',
            label: '/qa',
            promptInvocation: {
                invocationId: 'tmpl_1',
                token: '/qa',
                targetArtifactId: 'artifact_prompt_1',
                behavior: 'insert',
                allowArgs: false,
            },
        }];
        mocks.activeSuggestionIndex = 0;
        promptInvocationMock.resolve.mockResolvedValueOnce({
            handled: true,
            text: 'Expanded QA prompt',
            cursorPosition: 'Expanded QA prompt'.length,
        } as never);
        const { AgentInput } = await import('./AgentInput');
        const screen = await renderScreen(
            <AgentInput
                sessionId="session-1"
                value="/qa"
                onChangeText={mocks.onChangeText}
                placeholder="p"
                onSend={mocks.onSend}
                autocompleteKinds={['slashCommand']}
                autocompleteSuggestions={async () => mocks.activeSuggestions}
                isSendDisabled={false}
                disabled={false}
                showAbortButton={false}
            />
        );

        const input = findMultiTextInput(screen);

        await act(async () => {
            input.props.onKeyPress?.({ key: 'Enter' });
        });

        expect(promptInvocationMock.resolve).toHaveBeenCalledWith(expect.objectContaining({
            promptInvocation: expect.objectContaining({ targetArtifactId: 'artifact_prompt_1' }),
            inputText: '/qa',
            selection: { start: 3, end: 3 },
        }));
        expect(mocks.onChangeText).toHaveBeenCalledWith('Expanded QA prompt');
        expect(mocks.onSend).not.toHaveBeenCalled();
    });

    it('falls back to token insertion when the slash command has no prompt invocation', async () => {
        mocks.activeSuggestions = [{ kind: 'slashCommand', key: 'cmd-run', text: '/run', label: '/run' }];
        mocks.activeSuggestionIndex = 0;
        promptInvocationMock.resolve.mockClear();
        const { AgentInput } = await import('./AgentInput');
        const screen = await renderScreen(
            <AgentInput
                sessionId="session-1"
                value="/ru"
                onChangeText={mocks.onChangeText}
                placeholder="p"
                onSend={mocks.onSend}
                autocompleteKinds={['slashCommand']}
                autocompleteSuggestions={async () => mocks.activeSuggestions}
                isSendDisabled={false}
                disabled={false}
                showAbortButton={false}
            />
        );

        const input = findMultiTextInput(screen);

        await act(async () => {
            input.props.onKeyPress?.({ key: 'Enter' });
        });

        expect(promptInvocationMock.resolve).not.toHaveBeenCalled();
        expect(mocks.onSend).not.toHaveBeenCalled();
    });

    it('keeps slash autocomplete active when focusing a large native input with an active trigger', async () => {
        mocks.activeSuggestions = [{ kind: 'slashCommand', key: 'cmd-run', text: '/run', label: '/run' }];
        mocks.activeSuggestionIndex = 0;
        mocks.respectSuggestionQuery = true;
        const largePrompt = `${'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1)} /r`;
        const { AgentInput } = await import('./AgentInput');
        const screen = await renderScreen(
            <AgentInput
                sessionId="session-1"
                value={largePrompt}
                onChangeText={mocks.onChangeText}
                placeholder="p"
                onSend={mocks.onSend}
                autocompleteKinds={['slashCommand']}
                autocompleteSuggestions={async () => mocks.activeSuggestions}
                isSendDisabled={false}
                disabled={false}
                showAbortButton={false}
            />
        );

        const input = findMultiTextInput(screen);
        await act(async () => {
            input.props.onFocus?.();
        });

        expect(mocks.lastSuggestionQuery).toBe('/r');
        expect(commandMenuState.lastProps).toEqual(expect.objectContaining({
            open: true,
            query: '/r',
            items: [expect.objectContaining({ label: '/run' })],
        }));
    });

    it('keeps slash autocomplete active after a large native value is restored into an empty composer', async () => {
        mocks.activeSuggestions = [{ kind: 'slashCommand', key: 'cmd-run', text: '/run', label: '/run' }];
        mocks.activeSuggestionIndex = 0;
        mocks.respectSuggestionQuery = true;
        const largePrompt = `${'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1)} /r`;
        const { AgentInput } = await import('./AgentInput');
        const render = (value: string) => (
            <AgentInput
                sessionId="session-1"
                value={value}
                onChangeText={mocks.onChangeText}
                placeholder="p"
                onSend={mocks.onSend}
                autocompleteKinds={['slashCommand']}
                autocompleteSuggestions={async () => mocks.activeSuggestions}
                isSendDisabled={false}
                disabled={false}
                showAbortButton={false}
            />
        );
        const screen = await renderScreen(render(''));

        await act(async () => {
            screen.tree.update(render(largePrompt));
        });
        const input = findMultiTextInput(screen);
        await act(async () => {
            input.props.onFocus?.();
        });

        expect(mocks.lastSuggestionQuery).toBe('/r');
        expect(commandMenuState.lastProps).toEqual(expect.objectContaining({
            open: true,
            query: '/r',
            items: [expect.objectContaining({ label: '/run' })],
        }));
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
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                isSendDisabled={false}
                disabled={false}
                showAbortButton={false}
            />
        );
        const newSessionScreen = await renderScreen(
            <AgentInput
                value=""
                onChangeText={mocks.onChangeText}
                placeholder="p"
                onSend={mocks.onSend}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                isSendDisabled={false}
                disabled={false}
                showAbortButton={false}
            />
        );

        expect(findMultiTextInput(existingSessionScreen).props.textStyle).toMatchObject({ fontSize: 16 });
        expect(findMultiTextInput(newSessionScreen).props.textStyle).toMatchObject({ fontSize: 16 });
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
                autocompleteKinds={[]}
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
                autocompleteKinds={[]}
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
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                isSendDisabled={false}
                disabled={false}
                showAbortButton={false}
            />
        );

        const input = findMultiTextInput(screen);

        await act(async () => {
            input.props.onKeyPress?.({ key: 'Enter', shiftKey: false, metaKey: true });
        });
        await act(async () => {
            input.props.onKeyPress?.({ key: 'Enter', shiftKey: false, ctrlKey: true });
        });
        await act(async () => {
            input.props.onKeyPress?.({ key: 'Enter', shiftKey: false, ctrlKey: true, platformOS: 'android' });
        });

        expect(mocks.onSend).toHaveBeenCalledTimes(2);
        expect(mocks.onSend).toHaveBeenNthCalledWith(1, { forceImmediate: true });
        expect(mocks.onSend).toHaveBeenNthCalledWith(2, { forceImmediate: true });
    });
});
