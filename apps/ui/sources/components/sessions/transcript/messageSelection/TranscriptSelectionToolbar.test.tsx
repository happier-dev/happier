import * as React from 'react';
import { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { installBrowserClipboardBoundary, renderScreen } from '@/dev/testkit';

import { TranscriptMessageSelectionProvider, useTranscriptSelectionActions } from './TranscriptMessageSelectionContext';
import { TranscriptSelectionToolbar } from './TranscriptSelectionToolbar';
import { TranscriptSelectionToolbarController } from './TranscriptSelectionToolbarController';
import { createReadOnlySessionTranscriptSource } from '../source/readOnlySessionTranscriptSource';
import { SessionTranscriptSourceProvider } from '../source/SessionTranscriptSourceContext';

const keyboardShortcutHandlersMock = vi.hoisted(() => vi.fn());
const setClipboardStringSafeMock = vi.fn(async (_value: string) => true);
beforeEach(() => installBrowserClipboardBoundary(async text => { await setClipboardStringSafeMock(text); }));

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());

vi.mock('@/keyboard/KeyboardShortcutProvider', () => ({
    useKeyboardShortcutHandlers: (handlers: Record<string, () => void>) => {
        keyboardShortcutHandlersMock(handlers);
        return true;
    },
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: (value: string) => setClipboardStringSafeMock(value),
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

function ToolbarHarness(props: {
    sendEnabled?: boolean;
    onSend?: () => void;
    maxWidth?: number;
    formatSelection?: (messages: ReadonlyArray<{ id: string }>) => string | null;
    selectionUnavailableText?: string;
    additionalActions?: React.ComponentProps<typeof TranscriptSelectionToolbar>['additionalActions'];
}) {
    const actions = useTranscriptSelectionActions();
    return (
        <>
            <ProbeButton testID="enter-a" onPress={() => actions.enter('a')} />
            <ProbeButton testID="toggle-b" onPress={() => actions.toggle('b')} />
            <TranscriptSelectionToolbar
                selectableMessagesInOrder={[
                    { id: 'a', role: 'user', text: 'Hello' },
                    { id: 'b', role: 'assistant', text: 'Hi there' },
                ]}
                bulkCopyFormat="markdown_labeled"
                roleLabels={{ user: 'You', assistant: 'Assistant' }}
                sendToSessionEnabled={props.sendEnabled === true}
                onSendToSession={props.onSend}
                formatSelection={props.formatSelection}
                selectionUnavailableText={props.selectionUnavailableText}
                additionalActions={props.additionalActions}
                maxWidth={props.maxWidth}
            />
        </>
    );
}

function ProbeButton(props: { testID: string; onPress: () => void }) {
    return React.createElement('ProbeButton', props);
}

function findPressableByTestId(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    return findAllPressablesByTestId(screen, testID)[0]!;
}

/** The innermost pressable host carrying this id (the shared bar's controls are `HappierPressable`s). */
function findAllPressablesByTestId(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    return screen.findAll((node) => typeof node.type === 'string' && node.props?.testID === testID && typeof node.props?.onPress === 'function');
}

function isDisabled(node: { props: Record<string, unknown> }): boolean {
    const state = node.props.accessibilityState as { disabled?: boolean } | undefined;
    return node.props.disabled === true || state?.disabled === true || node.props['aria-disabled'] === true;
}

async function pressByTestId(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string): Promise<void> {
    const target = screen.find((node) => node.props?.testID === testID && typeof node.props?.onPress === 'function');
    await act(async () => {
        await target.props.onPress();
    });
}

async function renderToolbar(props: React.ComponentProps<typeof ToolbarHarness> = {}) {
    keyboardShortcutHandlersMock.mockClear();
    setClipboardStringSafeMock.mockClear();
    return renderScreen(
        <TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={['a', 'b']}>
            <ToolbarHarness {...props} />
        </TranscriptMessageSelectionProvider>,
    );
}

describe('TranscriptSelectionToolbar', () => {
    it('copies the presentation source dataset when no app-store transcript exists for its Session id', async () => {
        setClipboardStringSafeMock.mockClear();
        const source = createReadOnlySessionTranscriptSource({
            sessionId: 'readonly-selection-source', reducerState: null, metadata: null, agentState: null,
            messages: [{ id: 'readonly-message', kind: 'user-text', localId: null, createdAt: 1, text: 'Source transcript text' }],
        });
        function LocalSelection() {
            const actions = useTranscriptSelectionActions();
            return <>
                <ProbeButton testID="enter-source" onPress={() => actions.enter('readonly-message')} />
                <TranscriptSelectionToolbarController bulkCopyFormat="markdown_labeled" roleLabels={{ user: 'You', assistant: 'Assistant' }} sendToSessionEnabled={false} />
            </>;
        }
        const screen = await renderScreen(<SessionTranscriptSourceProvider source={source}>
            <TranscriptMessageSelectionProvider sessionId={source.sessionId} eligibleMessageIdsInOrder={['readonly-message']}>
                <LocalSelection />
            </TranscriptMessageSelectionProvider>
        </SessionTranscriptSourceProvider>);
        await pressByTestId(screen, 'enter-source');
        await pressByTestId(screen, 'transcript-selection-copy');
        expect(setClipboardStringSafeMock).toHaveBeenCalledWith(expect.stringContaining('Source transcript text'));
        await screen.unmount();
    });
    it('is hidden when selection mode is inactive', async () => {
        const screen = await renderToolbar();

        expect(screen.findAll((node) => typeof node.type === 'string' && node.props?.testID === 'transcript-selection-toolbar')).toHaveLength(0);
    });

    it('shows count, copy, select all, and cancel actions in selection mode', async () => {
        const screen = await renderToolbar();

        await pressByTestId(screen, 'enter-a');

        const countNode = screen.findByTestId('transcript-selection-toolbar-count');
        expect(countNode).not.toBeNull();
        expect(countNode!.props.children).toBe('1 message selected');
        expect(findAllPressablesByTestId(screen, 'transcript-selection-copy')).toHaveLength(1);
        expect(findAllPressablesByTestId(screen, 'transcript-selection-select-all')).toHaveLength(1);
        expect(findAllPressablesByTestId(screen, 'transcript-selection-cancel')).toHaveLength(1);
    });

    it('draws the one shared selection bar: count, Copy · Ask Agent (primary) · Select all, ⋯ holding Send, then ✕', async () => {
        const screen = await renderToolbar({
            maxWidth: 320,
            sendEnabled: true,
            onSend: vi.fn(),
            additionalActions: [{
                testID: 'discussion-selection-ask-agent',
                label: 'Ask Agent',
                primary: true,
                onPress: vi.fn(),
            }],
        });

        await pressByTestId(screen, 'enter-a');

        for (const testID of [
            'transcript-selection-copy',
            'discussion-selection-ask-agent',
            'transcript-selection-select-all',
            'transcript-selection-cancel',
        ]) {
            expect(findAllPressablesByTestId(screen, testID)).toHaveLength(1);
        }
        // With a caller's primary, the bar keeps one primary: Send to session waits under ⋯ (CR5).
        expect(findAllPressablesByTestId(screen, 'transcript-selection-send')).toHaveLength(0);
        expect(screen.findAll((node) => node.props?.hasPopup === 'menu' && typeof node.props.onPress === 'function').length)
            .toBeGreaterThan(0);
        // The ✕ is named for assistive technology rather than printed.
        expect(findPressableByTestId(screen, 'transcript-selection-cancel').props.accessibilityLabel).toBe('Exit selection mode');
    });

    it('hides Send when send-to-session is disabled and shows it when enabled', async () => {
        const disabled = await renderToolbar({ sendEnabled: false });
        await pressByTestId(disabled, 'enter-a');
        expect(findAllPressablesByTestId(disabled, 'transcript-selection-send')).toHaveLength(0);

        const enabled = await renderToolbar({ sendEnabled: true, onSend: vi.fn() });
        await pressByTestId(enabled, 'enter-a');
        expect(findAllPressablesByTestId(enabled, 'transcript-selection-send')).toHaveLength(1);
    });

    it('copies selected messages in canonical order and exits only when canceled', async () => {
        const screen = await renderToolbar();

        await pressByTestId(screen, 'enter-a');
        await pressByTestId(screen, 'toggle-b');
        await pressByTestId(screen, 'transcript-selection-copy');

        expect(setClipboardStringSafeMock).toHaveBeenCalledWith('**You:**\n\nHello\n\n**Assistant:**\n\nHi there');
        const feedbackNode = screen.findByTestId('transcript-selection-copy-feedback');
        expect(feedbackNode).not.toBeNull();
        expect(feedbackNode!.props.children).toBe('Copied');
        const countNode = screen.findByTestId('transcript-selection-toolbar-count');
        expect(countNode).not.toBeNull();
        expect(countNode!.props.children).toBe('2 messages selected');

        await pressByTestId(screen, 'transcript-selection-cancel');
        expect(screen.findAll((node) => typeof node.type === 'string' && node.props?.testID === 'transcript-selection-toolbar')).toHaveLength(0);
    });

    it('registers central keyboard shortcuts for active selection actions', async () => {
        const screen = await renderToolbar();

        await pressByTestId(screen, 'enter-a');
        const handlers = keyboardShortcutHandlersMock.mock.calls.at(-1)?.[0] as Record<string, () => void> | undefined;

        expect(Object.keys(handlers ?? {}).sort()).toEqual([
            'transcript.selection.cancel',
            'transcript.selection.copy',
            'transcript.selection.selectAll',
        ]);

        await act(async () => {
            await handlers?.['transcript.selection.copy']?.();
        });
        expect(setClipboardStringSafeMock).toHaveBeenCalledWith('**You:**\n\nHello');
    });

    it('invokes Send when enabled and selection is non-empty', async () => {
        const onSend = vi.fn();
        const screen = await renderToolbar({ sendEnabled: true, onSend });

        await pressByTestId(screen, 'enter-a');
        await pressByTestId(screen, 'transcript-selection-send');

        expect(onSend).toHaveBeenCalledTimes(1);
    });

    it('uses one caller-supplied canonical selection formatter for Copy', async () => {
        const formatSelection = vi.fn(() => '**Alice:**\n\nSelected discussion row');
        const screen = await renderToolbar({ formatSelection });

        await pressByTestId(screen, 'enter-a');
        await pressByTestId(screen, 'transcript-selection-copy');

        expect(formatSelection).toHaveBeenCalledWith([expect.objectContaining({ id: 'a' })]);
        expect(setClipboardStringSafeMock).toHaveBeenCalledWith('**Alice:**\n\nSelected discussion row');
    });

    it('mounts one canonical additional selection action with the selected rows', async () => {
        const onPress = vi.fn();
        const screen = await renderToolbar({
            additionalActions: [{
                testID: 'discussion-selection-ask-agent',
                label: 'Ask Agent',
                primary: true,
                onPress,
            }],
        });

        await pressByTestId(screen, 'enter-a');
        await pressByTestId(screen, 'discussion-selection-ask-agent');

        expect(onPress).toHaveBeenCalledWith([expect.objectContaining({ id: 'a' })]);
    });

    it('keeps selection visible but disables outward actions when canonical formatting is unavailable', async () => {
        const onPress = vi.fn();
        const screen = await renderToolbar({
            formatSelection: () => null,
            selectionUnavailableText: 'Selected message identity unavailable',
            sendEnabled: true,
            onSend: vi.fn(),
            additionalActions: [{ testID: 'discussion-selection-ask-agent', label: 'Ask Agent', primary: true, onPress }],
        });

        await pressByTestId(screen, 'enter-a');

        expect(screen.findByTestId('transcript-selection-unavailable')?.props.children)
            .toBe('Selected message identity unavailable');
        expect(isDisabled(findPressableByTestId(screen, 'transcript-selection-copy'))).toBe(true);
        expect(isDisabled(findPressableByTestId(screen, 'discussion-selection-ask-agent'))).toBe(true);
    });
});
