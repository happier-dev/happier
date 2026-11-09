import React from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';

import {
    MENTION_KIND_V1,
    buildMentionRefForKindV1,
} from '@happier-dev/protocol/runtime/input/mentionRefV1';

import type { AutocompleteSuggestion } from '@/components/autocomplete/autocompleteTypes';
import { renderScreen as renderTestScreen } from '@/dev/testkit';
import { formatInlineReferenceTokenV1 } from '@happier-dev/protocol/runtime/input/inlineReferenceTokenV1';
import { TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT } from '@/components/ui/forms/largeTextInputPolicy';
import { installAgentInputCommonModuleMocks } from './agentInputTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const promptInvocationMock = vi.hoisted(() => ({
    resolve: vi.fn(async (_args: unknown) => ({ handled: false as boolean })),
}));

vi.mock('@/sync/domains/input/slashCommands/promptInvocationSuggestion', () => ({
    resolvePromptInvocationAutocompleteSelection: (args: unknown) => promptInvocationMock.resolve(args as never),
}));

const mocks = vi.hoisted(() => ({
    onChangeText: vi.fn(),
    onSend: vi.fn(),
    inputBlur: vi.fn(),
    inputFocus: vi.fn(),
    suggestionMoveUp: vi.fn(),
    suggestionMoveDown: vi.fn(),
    activeSuggestions: [] as AutocompleteSuggestion[],
    activeSuggestionIndex: -1,
    respectSuggestionQuery: false,
    lastSuggestionQuery: undefined as string | null | undefined,
}));

const settingState = vi.hoisted(() => ({
    webEnterToSend: true,
    nativeEnterToSend: false,
}));

const hardwareShiftEnterState = vi.hoisted(() => ({
    listener: null as null | (() => void),
    remove: vi.fn(),
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
        const { createReactNativeNativeMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeNativeMock({ platformOS: 'ios' }, {
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

const historyMock = vi.hoisted(() => ({
    moveUp: vi.fn((): string | null => null),
    moveDown: vi.fn((): string | null => null),
    browsing: false,
}));

vi.mock('@/hooks/session/useUserMessageHistory', () => ({
    useUserMessageHistory: () => ({
        moveUp: historyMock.moveUp,
        moveDown: historyMock.moveDown,
        pause: () => {},
        reset: () => {},
        warmup: () => {},
        isBrowsing: () => historyMock.browsing,
        hasRetainedSession: () => historyMock.browsing,
        readPosition: () => null,
    }),
}));

vi.mock('@/sync/store/hooks', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/store/hooks')>(),
    useSessionServerId: () => null,
}));

vi.mock('@/components/ui/commandMenu', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/components/ui/commandMenu')>(),
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

vi.mock('@/components/ui/text/Text', async () => {
    const { createUiTextModuleMock } = await import('@/dev/testkit/mocks/uiText');
    return createUiTextModuleMock();
});

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

const { AgentInput } = await import('./AgentInput');

function renderScreen(element: React.ReactElement) {
    return renderTestScreen(element, {
        createNodeMock: node => node.type === 'HappierComposerInput' ? {
            focus: mocks.inputFocus, blur: mocks.inputBlur,
            setTextAndSelection: () => {}, setSelection: () => {},
        } : null,
    });
}

function findNativeTextInput(screen: Awaited<ReturnType<typeof renderScreen>>) {
    const nodes = screen.tree.findAllByType('HappierComposerInput');
    expect(nodes.length).toBe(1);
    return nodes[0]!;
}

// Module transform is paid once, outside any single case's time budget.
beforeAll(async () => {
    await import('./AgentInput');
}, 900_000);

describe('AgentInput (enter to send on native)', () => {
    it.each([
        { armedContinuationTarget: { agentId: 'claude', label: 'Claude' } },
        { armedRouteContinuation: { modelLabel: 'Other model' } },
    ])('submits a blank armed continuation with the native submit action (%j)', async (arm) => {
        settingState.nativeEnterToSend = true;
        const screen = await renderScreen(<AgentInput
            sessionId="session-1" value="" placeholder="p" {...arm}
            onChangeText={mocks.onChangeText} onSend={mocks.onSend}
            autocompleteKinds={[]} autocompleteSuggestions={async () => []}
        />);
        await act(async () => { findNativeTextInput(screen).props.onComposerSubmitEditing?.(); });
        expect(mocks.onSend).toHaveBeenCalled();
        await screen.unmount();
    });

    afterEach(() => {
        settingState.webEnterToSend = true;
        settingState.nativeEnterToSend = false;
        hardwareShiftEnterState.listener = null;
        mocks.activeSuggestions = [];
        mocks.activeSuggestionIndex = -1;
        mocks.respectSuggestionQuery = false;
        mocks.lastSuggestionQuery = undefined;
        commandMenuState.lastProps = null;
        vi.clearAllMocks();
    });

    describe('message history flicks', () => {
        const renderComposer = (AgentInput: typeof import('./AgentInput').AgentInput, value: string, onChangeText = mocks.onChangeText) => (
            <AgentInput
                sessionId="session-1"
                value={value}
                onChangeText={onChangeText}
                placeholder="p"
                onSend={mocks.onSend}
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                isSendDisabled={false}
                disabled={false}
                showAbortButton={false}
            />
        );
        // Like the real navigator: once a message is recalled, the history is being browsed.
        const recall = (fn: typeof historyMock.moveUp, ...messages: string[]) => {
            fn.mockReset();
            for (const message of messages) fn.mockImplementationOnce(() => { historyMock.browsing = true; return message; });
            fn.mockImplementation(() => null);
        };
        beforeEach(() => {
            historyMock.browsing = false;
            recall(historyMock.moveUp);
            recall(historyMock.moveDown);
        });
        const swipeArea = (screen: Awaited<ReturnType<typeof renderScreen>>) =>
            screen.root.findByProps({ testID: 'composer-history-swipe-area' });
        /** Replays one finger's touch stream: [pageX, pageY, timestamp ms] samples, first = down, last = up. */
        const touch = async (screen: Awaited<ReturnType<typeof renderScreen>>, samples: ReadonlyArray<readonly [number, number, number]>) => {
            const event = ([pageX, pageY, timestamp]: readonly [number, number, number], touches: number) =>
                ({ nativeEvent: { pageX, pageY, timestamp, touches: Array.from({ length: touches }, () => ({})) } });
            await act(async () => {
                const area = swipeArea(screen);
                area.props.onTouchStart(event(samples[0]!, 1));
                for (const sample of samples.slice(1, -1)) area.props.onTouchMove(event(sample, 1));
                area.props.onTouchEnd(event(samples[samples.length - 1]!, 0));
            });
        };
        const flickUp = (screen: Awaited<ReturnType<typeof renderScreen>>) => touch(screen, [[100, 300, 0], [100, 260, 60], [100, 220, 120]]);

        it('steps on a quick flick but leaves a slow drag, a held finger or a sideways swipe to the text field', async () => {
            recall(historyMock.moveUp, 'previous message');
            recall(historyMock.moveDown, '');
            const { AgentInput } = await import('./AgentInput');
            const screen = await renderScreen(renderComposer(AgentInput, ''));
            await touch(screen, [[100, 300, 0], [100, 250, 400], [100, 200, 800]]);
            await touch(screen, [[100, 300, 0], [100, 300, 600], [100, 220, 700]]);
            await touch(screen, [[100, 300, 0], [180, 280, 80], [260, 260, 120]]);
            expect(historyMock.moveUp).not.toHaveBeenCalled();
            await flickUp(screen);
            expect(historyMock.moveUp).toHaveBeenCalledTimes(1);
            expect(mocks.onChangeText).toHaveBeenLastCalledWith('previous message');
            await touch(screen, [[100, 220, 0], [100, 260, 60], [100, 300, 120]]);
            expect(historyMock.moveDown).toHaveBeenCalledTimes(1);
            await screen.unmount();
        });

        it('cycles with repeated flicks from an empty composer', async () => {
            recall(historyMock.moveUp, 'previous message', 'older message');
            const { AgentInput } = await import('./AgentInput');
            const screen = await renderScreen(renderComposer(AgentInput, ''));
            await flickUp(screen);
            await flickUp(screen);
            expect(historyMock.moveUp).toHaveBeenCalledTimes(2);
            expect(mocks.onChangeText).toHaveBeenLastCalledWith('older message');
            await screen.unmount();
        });

        it.each(['focus', 'caret move'] as const)('stops cycling once the person reaches into the recalled message (%s)', async (reach) => {
            recall(historyMock.moveUp, 'previous message', 'older message');
            const { AgentInput } = await import('./AgentInput');
            const screen = await renderScreen(renderComposer(AgentInput, ''));
            await flickUp(screen);
            const input = findNativeTextInput(screen);
            await act(async () => {
                if (reach === 'focus') input.props.onComposerFocus?.({ nativeEvent: {} });
                else input.props.onComposerSelection?.({ nativeEvent: { selection: { start: 3, end: 3 } } });
            });
            await screen.update(renderComposer(AgentInput, 'previous message'));
            await flickUp(screen);
            expect(historyMock.moveUp).toHaveBeenCalledTimes(1);
            await screen.unmount();
        });

        it('leaves text the person typed alone, and cycles again once the field is emptied', async () => {
            recall(historyMock.moveUp, 'previous message', 'older message');
            const { AgentInput } = await import('./AgentInput');
            const screen = await renderScreen(renderComposer(AgentInput, 'typed draft'));
            await flickUp(screen);
            expect(historyMock.moveUp).not.toHaveBeenCalled();
            await act(async () => {
                findNativeTextInput(screen).props.onComposerChange?.({
                    nativeEvent: { text: '', selection: { start: 0, end: 0 }, eventCount: 1, references: [] },
                });
            });
            await screen.update(renderComposer(AgentInput, ''));
            await flickUp(screen);
            expect(historyMock.moveUp).toHaveBeenCalledTimes(1);
            await screen.unmount();
        });
    });

    it('uses a 16 point input text base for existing sessions and new sessions', async () => {
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
            />,
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
            />,
        );

        expect(findNativeTextInput(existingSessionScreen).props.typography.fontSize).toBe(16);
        expect(findNativeTextInput(newSessionScreen).props.typography.fontSize).toBe(16);
    });

    it('keeps slash autocomplete active when focusing a large native input with an active trigger', async () => {
        mocks.activeSuggestions = [{ kind: 'slashCommand', key: 'cmd-run', text: '/run', label: '/run' }] as any;
        mocks.activeSuggestionIndex = 0;
        mocks.respectSuggestionQuery = true;
        const largePrompt = `${'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1)} /r`;
        const screen = await renderScreen(
            <AgentInput
                sessionId="session-1"
                value={largePrompt}
                onChangeText={mocks.onChangeText}
                placeholder="p"
                onSend={mocks.onSend}
                autocompleteKinds={['slashCommand']}
                autocompleteSuggestions={async (query) => { mocks.lastSuggestionQuery = query; return mocks.activeSuggestions; }}
                isSendDisabled={false}
                disabled={false}
                showAbortButton={false}
            />
        );

        const input = findNativeTextInput(screen);
        await act(async () => {
            input.props.onComposerFocus?.();
        });

        expect(mocks.lastSuggestionQuery).toBe('/r');
        expect(commandMenuState.lastProps).toEqual(expect.objectContaining({
            open: true,
            query: '/r',
            items: [
                expect.objectContaining({ label: '/run' }),
                expect.objectContaining({ id: 'prompt-picker', label: 'agentInput.promptPicker.menu' }),
            ],
        }));
    });

    it('reports real input focus changes and exposes the incumbent focus request without changing native input behavior', async () => {
        const focusChanges = vi.fn();
        const focusRequestCapture = { current: null as (() => void) | null };
        mocks.inputFocus.mockClear();
        const screen = await renderScreen(
            <AgentInput
                sessionId="session-1"
                value="draft"
                onChangeText={mocks.onChangeText}
                onSend={mocks.onSend}
                placeholder="p"
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                onComposerFocusChange={focusChanges}
                onComposerFocusRequestChange={(request) => {
                    focusRequestCapture.current = request;
                }}
            />,
        );

        const input = findNativeTextInput(screen);
        await act(async () => {
            input.props.onComposerFocus?.();
            input.props.onComposerBlur?.();
        });

        expect(focusChanges).toHaveBeenNthCalledWith(1, true);
        expect(focusChanges).toHaveBeenNthCalledWith(2, false);
        const focusRequest = focusRequestCapture.current;
        expect(focusRequest).toEqual(expect.any(Function));
        if (!focusRequest) throw new Error('expected composer focus request');
        focusRequest();
        expect(mocks.inputFocus).toHaveBeenCalledTimes(1);
    });

    it('keeps slash autocomplete active after a large native value is restored into an empty composer', async () => {
        mocks.activeSuggestions = [{ kind: 'slashCommand', key: 'cmd-run', text: '/run', label: '/run' }] as any;
        mocks.activeSuggestionIndex = 0;
        mocks.respectSuggestionQuery = true;
        const largePrompt = `${'x'.repeat(TEXT_INPUT_LARGE_TEXT_VALUE_LENGTH_LIMIT + 1)} /r`;
        const render = (value: string) => (
            <AgentInput
                sessionId="session-1"
                value={value}
                onChangeText={mocks.onChangeText}
                placeholder="p"
                onSend={mocks.onSend}
                autocompleteKinds={['slashCommand']}
                autocompleteSuggestions={async (query) => { mocks.lastSuggestionQuery = query; return mocks.activeSuggestions; }}
                isSendDisabled={false}
                disabled={false}
                showAbortButton={false}
            />
        );
        const screen = await renderScreen(render(''));

        await act(async () => {
            screen.tree.update(render(largePrompt));
        });
        const input = findNativeTextInput(screen);
        await act(async () => {
            input.props.onComposerFocus?.();
        });

        expect(mocks.lastSuggestionQuery).toBe('/r');
        expect(commandMenuState.lastProps).toEqual(expect.objectContaining({
            open: true,
            query: '/r',
            items: [
                expect.objectContaining({ label: '/run' }),
                expect.objectContaining({ id: 'prompt-picker', label: 'agentInput.promptPicker.menu' }),
            ],
        }));
    });

    it('lets the suggestion kind rewrite the whole input instead of inserting the token', async () => {
        // D-20: a prompt-template slash command replaces the entire composer input, which a
        // token string cannot express. The kind owns that rewrite; it is no longer a host prop.
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
        }] as any;
        mocks.activeSuggestionIndex = 0;
        promptInvocationMock.resolve.mockResolvedValueOnce({
            handled: true,
            text: 'Expanded QA prompt',
            cursorPosition: 'Expanded QA prompt'.length,
        } as never);
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

        const input = findNativeTextInput(screen);
        await act(async () => { input.props.onComposerFocus?.(); });

        await act(async () => {
            input.props.onComposerKeyPress?.({
                nativeEvent: { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false },
                preventDefault: vi.fn(),
            });
        });

        expect(promptInvocationMock.resolve).toHaveBeenCalledWith(expect.objectContaining({
            suggestion: expect.objectContaining({ key: 'cmd-qa', text: '/qa' }),
            input: '/qa',
            selection: { start: 3, end: 3 },
        }));
        expect(mocks.onChangeText).toHaveBeenCalledWith('Expanded QA prompt');
        expect(mocks.onSend).not.toHaveBeenCalled();
    });

    it('does not let a late slash-template resolution overwrite a draft after edit and revert', async () => {
        // A selection can need asynchronous artifact resolution. Any edit retires
        // that selection, even when the user later restores the same visible text.
        let resolveSelection!: (result: {
            handled: true;
            text: string;
            cursorPosition: number;
        }) => void;
        const pendingSelection = new Promise<{
            handled: true;
            text: string;
            cursorPosition: number;
        }>((resolve) => {
            resolveSelection = resolve;
        });

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
        }] as any;
        mocks.activeSuggestionIndex = 0;
        promptInvocationMock.resolve.mockImplementationOnce(() => pendingSelection as never);

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
        const screen = await renderScreen(render('/qa'));
        const input = findNativeTextInput(screen);
        await act(async () => { input.props.onComposerFocus?.(); });

        await act(async () => {
            input.props.onComposerKeyPress?.({
                nativeEvent: { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false },
                preventDefault: vi.fn(),
            });
        });
        await act(async () => {
            screen.tree.update(render('/qa — temporary edit'));
            await Promise.resolve();
        });
        await act(async () => {
            screen.tree.update(render('/qa'));
            await Promise.resolve();
        });
        await act(async () => {
            resolveSelection({
                handled: true,
                text: 'Expanded QA prompt',
                cursorPosition: 'Expanded QA prompt'.length,
            });
            await Promise.resolve();
        });

        expect(mocks.onChangeText).not.toHaveBeenCalledWith('Expanded QA prompt');
        expect(mocks.onSend).not.toHaveBeenCalled();
    });

    it('falls back to token insertion when the slash command has no prompt invocation', async () => {
        // No `promptInvocation` means the kind declines before it ever reaches the resolver.
        mocks.activeSuggestions = [{ kind: 'slashCommand', key: 'cmd-qa', text: '/qa', label: '/qa' }] as any;
        mocks.activeSuggestionIndex = 0;
        promptInvocationMock.resolve.mockClear();
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

        const input = findNativeTextInput(screen);
        await act(async () => { input.props.onComposerFocus?.(); });

        await act(async () => {
            input.props.onComposerKeyPress?.({
                nativeEvent: { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false },
                preventDefault: vi.fn(),
            });
        });

        expect(promptInvocationMock.resolve).not.toHaveBeenCalled();
        expect(mocks.onChangeText).toHaveBeenCalledWith('/qa');
        expect(mocks.onSend).not.toHaveBeenCalled();
    });

    it('sends selected structured input mentions as message metadata overrides', async () => {
        settingState.webEnterToSend = false;
        settingState.nativeEnterToSend = true;
        mocks.activeSuggestions = [{
            kind: 'vendorPlugin',
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
        const screen = await renderScreen(
            <AgentInput
                sessionId="session-1"
                value="@github"
                onChangeText={mocks.onChangeText}
                placeholder="p"
                onSend={mocks.onSend}
                autocompleteKinds={['file', 'vendorPlugin']}
                autocompleteSuggestions={async (query) => { mocks.lastSuggestionQuery = query; return mocks.activeSuggestions; }}
                isSendDisabled={false}
                disabled={false}
                showAbortButton={false}
            />
        );

        const input = findNativeTextInput(screen);
        await act(async () => { input.props.onComposerFocus?.(); });

        await act(async () => {
            input.props.onComposerKeyPress?.({
                nativeEvent: { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false },
                preventDefault: vi.fn(),
            });
        });
        mocks.activeSuggestions = [];
        mocks.activeSuggestionIndex = -1;
        const insertedText = formatInlineReferenceTokenV1({ label: 'GitHub', ref: buildMentionRefForKindV1(MENTION_KIND_V1.vendorPlugin, 'github') }) + ' ';
        await screen.update(<AgentInput sessionId="session-1" value={insertedText} onChangeText={mocks.onChangeText}
            placeholder="p" onSend={mocks.onSend} autocompleteKinds={['file', 'vendorPlugin']}
            autocompleteSuggestions={async (query) => { mocks.lastSuggestionQuery = query; return mocks.activeSuggestions; }} />);
        await act(async () => {
            findNativeTextInput(screen).props.onComposerSubmitEditing?.();
        });

        expect(mocks.onSend).toHaveBeenCalledWith({
            structuredInputMetaOverrides: {
                happierStructuredInputV1: {
                    v: 1,
                    mentions: [{
                        kind: MENTION_KIND_V1.vendorPlugin,
                        ref: buildMentionRefForKindV1(MENTION_KIND_V1.vendorPlugin, 'github'),
                        token: formatInlineReferenceTokenV1({ label: 'GitHub', ref: buildMentionRefForKindV1(MENTION_KIND_V1.vendorPlugin, 'github') }),
                        label: 'GitHub',
                    }],
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
            />,
        );

        const input = findNativeTextInput(screen);

        expect(input.props.submitBehavior).toBe('newline');

        await act(async () => {
            input.props.onComposerSubmitEditing?.();
        });

        expect(mocks.onSend).not.toHaveBeenCalled();
    });

    it('submits from the native composer when the native enter-to-send setting is enabled', async () => {
        settingState.webEnterToSend = false;
        settingState.nativeEnterToSend = true;

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
            />,
        );

        const input = findNativeTextInput(screen);

        expect(input.props.submitBehavior).toBe('submit');

        await act(async () => {
            input.props.onComposerSubmitEditing?.();
        });

        expect(mocks.onSend).toHaveBeenCalledTimes(1);
    });

    it('handles one physical Enter as one submit intent through the native key and submit sequence', async () => {
        settingState.nativeEnterToSend = true;
        const screen = await renderScreen(<AgentInput value="hello" onChangeText={mocks.onChangeText}
            placeholder="p" onSend={mocks.onSend} autocompleteKinds={[]} autocompleteSuggestions={async () => []} />);
        const input = findNativeTextInput(screen);
        await act(async () => {
            input.props.onComposerKeyPress({ nativeEvent: { key: 'Enter', submitting: true } });
            input.props.onComposerSubmitEditing({ nativeEvent: { key: 'Enter' } });
        });
        expect(mocks.onSend).toHaveBeenCalledTimes(1);
    });

    it('consumes picker Enter without a newline or send when native Enter-to-send is disabled', async () => {
        mocks.activeSuggestions = [{ kind: 'slashCommand', key: 'cmd-qa', text: '/qa', label: '/qa' }];
        mocks.activeSuggestionIndex = 0;
        const screen = await renderScreen(<AgentInput value="/qa" onChangeText={mocks.onChangeText}
            placeholder="p" onSend={mocks.onSend} autocompleteKinds={['slashCommand']}
            autocompleteSuggestions={async (query) => { mocks.lastSuggestionQuery = query; return mocks.activeSuggestions; }} />);
        const input = findNativeTextInput(screen);
        await act(async () => { input.props.onComposerFocus?.(); });
        expect(input.props.submitBehavior).toBe('submit');
        await act(async () => {
            input.props.onComposerKeyPress({ nativeEvent: { key: 'Enter', submitting: true } });
            input.props.onComposerSubmitEditing({ nativeEvent: { key: 'Enter' } });
        });
        expect(mocks.onChangeText).toHaveBeenCalledWith('/qa');
        expect(mocks.onChangeText).not.toHaveBeenCalledWith('/qa\n');
        expect(mocks.onSend).not.toHaveBeenCalled();
    });

    it('blurs the existing-session composer when native Enter sends', async () => {
        settingState.webEnterToSend = false;
        settingState.nativeEnterToSend = true;

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
            />,
        );

        const input = findNativeTextInput(screen);

        await act(async () => {
            input.props.onComposerSubmitEditing?.();
        });

        expect(mocks.onSend).toHaveBeenCalledTimes(1);
        expect(mocks.inputBlur).toHaveBeenCalledTimes(1);
    });

    it('inserts a newline for focused hardware Shift+Enter when the native enter-to-send setting is enabled', async () => {
        settingState.webEnterToSend = false;
        settingState.nativeEnterToSend = true;

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
            />,
        );

        const input = findNativeTextInput(screen);

        await act(async () => {
            input.props.onComposerSelection?.({
                nativeEvent: {
                    selection: { start: 5, end: 5 },
                },
            });
            input.props.onComposerFocus?.({
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

    it('is authoring-only without onSend: Enter inserts a newline, no submit path or send affordance exists', async () => {
        settingState.webEnterToSend = true;
        settingState.nativeEnterToSend = true;

        const { AgentInput } = await import('./AgentInput');
        const screen = await renderScreen(
            <AgentInput
                value="hello"
                onChangeText={mocks.onChangeText}
                placeholder="p"
                autocompleteKinds={[]}
                autocompleteSuggestions={async () => []}
                isSendDisabled={false}
                disabled={false}
                showAbortButton={false}
            />,
        );

        const input = findNativeTextInput(screen);
        // The Session Enter-to-send preference never turns an authoring field into a submitter.
        expect(input.props.submitBehavior).toBe('newline');

        await act(async () => {
            input.props.onComposerSelection?.({ nativeEvent: { selection: { start: 5, end: 5 } } });
            input.props.onComposerFocus?.({ nativeEvent: {} });
        });
        // No hardware Shift+Enter interception: Enter is already a newline.
        expect(hardwareShiftEnterState.listener).toBeNull();

        const modEnterPreventDefault = vi.fn();
        let modEnterHandled: unknown;
        await act(async () => {
            input.props.onComposerSubmitEditing?.();
            modEnterHandled = input.props.onComposerKeyPress?.({
                nativeEvent: { key: 'Enter', shiftKey: false, metaKey: true, ctrlKey: false },
                preventDefault: modEnterPreventDefault,
            });
        });
        // Mod+Enter is left to the page (its Run command), never consumed as a send.
        expect(modEnterPreventDefault).not.toHaveBeenCalled();
        expect(modEnterHandled).not.toBe(true);
        expect(mocks.inputBlur).not.toHaveBeenCalled();
        expect(screen.findAll((node) => node.props?.testID === 'new-session-composer-send')).toHaveLength(0);
    });

    it('keeps typed identity after a programmatic prefix edit through the real host reconciliation', async () => {
        settingState.nativeEnterToSend = true;
        const token = formatInlineReferenceTokenV1({ label: 'GitHub', ref: buildMentionRefForKindV1(MENTION_KIND_V1.vendorPlugin, 'github') });
        const mention = { kind: 'vendorPlugin', vendorPluginRef: 'github', label: 'GitHub',
            backendId: 'codex-app-server', agentId: 'codex', tokenText: token, start: 0, end: token.length } as const;
        const changedMentions = vi.fn();
        const screen = await renderScreen(<AgentInput value={token} onChangeText={mocks.onChangeText}
            onSend={mocks.onSend} placeholder="p" autocompleteKinds={[]} autocompleteSuggestions={async () => []}
            structuredInputMentions={[mention]} onStructuredInputMentionsChange={changedMentions} />);
        const input = findNativeTextInput(screen);
        await act(async () => {
            input.props.onComposerSelection({ nativeEvent: { selection: { start: 0, end: 0 } } });
            input.props.onComposerFocus({ nativeEvent: {} });
        });
        expect(hardwareShiftEnterState.listener).toBeTypeOf('function');
        await act(async () => hardwareShiftEnterState.listener?.());
        expect(mocks.onChangeText).toHaveBeenCalledWith(`\n${token}`);
        expect(changedMentions).toHaveBeenLastCalledWith([{ ...mention, start: 1, end: token.length + 1 }]);
    });

    it('uses platform-correct immediate-send bypass for native hardware Mod+Enter', async () => {
        settingState.webEnterToSend = false;
        settingState.nativeEnterToSend = false;

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
            />,
        );

        const input = findNativeTextInput(screen);

        await act(async () => {
            input.props.onComposerKeyPress?.({
                nativeEvent: { key: 'Enter', shiftKey: false, metaKey: true, ctrlKey: false },
                preventDefault: vi.fn(),
            });
        });
        await act(async () => {
            input.props.onComposerKeyPress?.({
                nativeEvent: { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: true },
                preventDefault: vi.fn(),
            });
        });
        await act(async () => {
            input.props.onComposerKeyPress?.({
                nativeEvent: { key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: true, platformOS: 'android' },
                preventDefault: vi.fn(),
            });
        });

        expect(mocks.onSend).toHaveBeenCalledTimes(2);
        expect(mocks.onSend).toHaveBeenNthCalledWith(1, { deliveryIntent: 'agent_queue' });
        expect(mocks.onSend).toHaveBeenNthCalledWith(2, { deliveryIntent: 'agent_queue' });
    });
});
