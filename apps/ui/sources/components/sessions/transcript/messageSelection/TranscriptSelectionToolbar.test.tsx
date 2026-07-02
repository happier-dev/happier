import * as React from 'react';
import { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

import { TranscriptMessageSelectionProvider, useTranscriptSelectionActions } from './TranscriptMessageSelectionContext';
import { TranscriptSelectionToolbar } from './TranscriptSelectionToolbar';

const keyboardShortcutHandlersMock = vi.hoisted(() => vi.fn());
const setClipboardStringSafeMock = vi.fn(async (_value: string) => true);

vi.mock('@/keyboard/KeyboardShortcutProvider', () => ({
    useKeyboardShortcutHandlers: (handlers: Record<string, () => void>) => {
        keyboardShortcutHandlersMock(handlers);
        return true;
    },
}));

vi.mock('@/utils/ui/clipboard', () => ({
    setClipboardStringSafe: (value: string) => setClipboardStringSafeMock(value),
}));

vi.mock('@/modal', () => ({
    Modal: { alert: vi.fn() },
}));

function ToolbarHarness(props: { sendEnabled?: boolean; onSend?: () => void; maxWidth?: number }) {
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
                maxWidth={props.maxWidth}
            />
        </>
    );
}

function ProbeButton(props: { testID: string; onPress: () => void }) {
    return React.createElement('ProbeButton', props);
}

function findPressableByTestId(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    return screen.find((node) => (node.type as unknown) === 'Pressable' && node.props?.testID === testID && typeof node.props?.onPress === 'function');
}

function findAllPressablesByTestId(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string) {
    return screen.findAll((node) => (node.type as unknown) === 'Pressable' && node.props?.testID === testID && typeof node.props?.onPress === 'function');
}

async function pressByTestId(screen: Awaited<ReturnType<typeof renderScreen>>, testID: string): Promise<void> {
    const target = screen.find((node) => node.props?.testID === testID && typeof node.props?.onPress === 'function');
    await act(async () => {
        await target.props.onPress();
    });
}

async function renderToolbar(props: { sendEnabled?: boolean; onSend?: () => void; maxWidth?: number } = {}) {
    keyboardShortcutHandlersMock.mockClear();
    setClipboardStringSafeMock.mockClear();
    return renderScreen(
        <TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={['a', 'b']}>
            <ToolbarHarness {...props} />
        </TranscriptMessageSelectionProvider>,
    );
}

describe('TranscriptSelectionToolbar', () => {
    it('is hidden when selection mode is inactive', async () => {
        const screen = await renderToolbar();

        expect(screen.findAllByTestId('transcript-selection-toolbar')).toHaveLength(0);
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

    it('constrains itself to the transcript content width when a max width is provided', async () => {
        const screen = await renderToolbar({ maxWidth: 640 });

        await pressByTestId(screen, 'enter-a');

        const toolbar = screen.findByTestId('transcript-selection-toolbar');
        expect(toolbar?.props.style).toContainEqual({ width: '100%', maxWidth: 640, alignSelf: 'center' });
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
        expect(screen.findAllByTestId('transcript-selection-toolbar')).toHaveLength(0);
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
});
