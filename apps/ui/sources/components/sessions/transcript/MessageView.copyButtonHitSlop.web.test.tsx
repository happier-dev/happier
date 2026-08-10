import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function findAncestor(instance: any, predicate: (node: any) => boolean) {
    let current = instance?.parent ?? null;
    while (current) {
        if (predicate(current)) return current;
        current = current.parent ?? null;
    }
    return null;
}

installMessageViewCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => key === 'transcriptMessageSelectionEnabled' ? true : null,
                useSession: () => null,
            },
        });
    },
});

vi.mock('@/components/markdown/MarkdownView', () => ({
    MarkdownView: (props: any) => React.createElement('MarkdownView', props),
}));

vi.mock('@/components/tools/shell/views/ToolView', () => ({
    ToolView: (props: any) => React.createElement('ToolView', props),
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: (props: any) => React.createElement('ToolTimelineRow', props),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
    TextInput: (props: any) => React.createElement('TextInput', props, props.children),
}));

vi.mock('@/components/sessions/linkedFiles/extractWorkspaceFileMentions', () => ({
    extractWorkspaceFileMentions: () => [],
}));

vi.mock('@/components/sessions/transcript/references/StructuredReferencesRow', () => ({
    StructuredReferencesRow: () => null,
}));

vi.mock('@/utils/sessions/discardedCommittedMessages', () => ({
    isCommittedMessageDiscarded: () => false,
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(),
}));

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/sync/sync', () => ({
    sync: { submitMessage: vi.fn(), sendMessage: vi.fn() },
}));

describe('MessageView (copy button hitSlop, web)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('keeps selectable message actions visible across rows while selection mode is active on web', async () => {
        const { MessageView } = await import('./MessageView');
        const { TranscriptMessageSelectionProvider } = await import('./messageSelection/TranscriptMessageSelectionContext');

        const firstMessage: any = {
            kind: 'user-text',
            localId: 'local-1',
            id: 'm1',
            text: 'hello',
        };
        const secondMessage: any = {
            kind: 'user-text',
            localId: 'local-2',
            id: 'm2',
            text: 'second',
        };

        const screen = await renderScreen(
            <TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={['m1', 'm2']}>
                <MessageView message={firstMessage} metadata={null} sessionId="s1" />
                <MessageView message={secondMessage} metadata={null} sessionId="s1" />
            </TranscriptMessageSelectionProvider>,
        );

        const firstActions = screen.findByTestId('transcript-message-actions:m1');
        const firstHoverableRow = findAncestor(
            firstActions,
            (node: any) => node.type === 'Pressable' && typeof node.props.onHoverIn === 'function',
        );
        expect(firstHoverableRow).not.toBeNull();
        await act(async () => {
            firstHoverableRow!.props.onHoverIn();
        });
        await act(async () => {
            screen.findByTestId('transcript-message-select:m1')!.props.onPress();
        });

        const secondSelect = screen.findByTestId('transcript-message-select:m2');
        expect(secondSelect).not.toBeNull();
        expect(secondSelect!.props.accessibilityRole).toBe('checkbox');
        expect(secondSelect!.props.accessibilityState).toEqual({ checked: false });
        const secondActionsOpacity = (screen.findByTestId('transcript-message-actions:m2')?.props.style as unknown[])
            .flat(Infinity)
            .map((entry) => (entry as { opacity?: { __getValue?: () => number } } | null)?.opacity)
            .find((opacity) => typeof opacity?.__getValue === 'function');
        expect(secondActionsOpacity?.__getValue?.()).toBe(1);
    });

    it('does not use hitSlop on web (avoids overlapping hit targets for sibling actions)', async () => {
        const { MessageView } = await import('./MessageView');
        const { TranscriptMessageSelectionProvider } = await import('./messageSelection/TranscriptMessageSelectionContext');

        const message: any = {
            kind: 'user-text',
            localId: 'local-1',
            text: 'hello',
        };

        const screen = await renderScreen(
            <TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={['local-1']}>
                <MessageView message={message} metadata={null} sessionId="s1" />
            </TranscriptMessageSelectionProvider>,
        );

        const copyButton = screen.findByTestId('transcript-message-copy:local-1');
        expect(copyButton).toBeTruthy();

        const copyPressables = screen.findAll(
            (node: any) => node.type === 'Pressable' && node.props.accessibilityLabel === 'common.copy',
        );
        expect(copyPressables).toHaveLength(1);
        expect(copyPressables[0].props.hitSlop).toBeUndefined();

        const selectButton = screen.findByTestId('transcript-message-select:local-1');
        expect(selectButton).not.toBeNull();
        expect(selectButton!.props.hitSlop).toBeUndefined();
    });
});
