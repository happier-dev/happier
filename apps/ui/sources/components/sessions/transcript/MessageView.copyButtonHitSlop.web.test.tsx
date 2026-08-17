import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';
import { createUseSettingMock } from '@/dev/testkit/mocks/storage';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installMessageViewCommonModuleMocks({
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: createUseSettingMock({ fallback: (key) => key === 'transcriptMessageSelectionEnabled' ? true : null }),
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

function findAncestor(instance: any, predicate: (node: any) => boolean) {
    let current = instance?.parent ?? null;
    while (current) {
        if (predicate(current)) return current;
        current = current.parent ?? null;
    }
    return null;
}

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

function readRevealOpacity(style: unknown): number | undefined {
    const opacity = flattenStyle(style).opacity;
    if (typeof opacity === 'number') return opacity;
    const animated = opacity as { __getValue?: () => number } | undefined;
    return typeof animated?.__getValue === 'function' ? animated.__getValue() : undefined;
}

describe('MessageView (copy button target, web)', () => {
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
        // Selection mode reveals every eligible row's actions, not just the hovered one.
        expect(readRevealOpacity(screen.findByTestId('transcript-message-actions:m2')?.props.style)).toBe(1);
    });

    it('does not use hitSlop on web (avoids overlapping hit targets for sibling actions)', async () => {
        const { MessageView } = await import('./MessageView');

        const message: any = {
            kind: 'user-text',
            localId: 'local-1',
            text: 'hello',
        };

        const screen = await renderScreen(
            <MessageView message={message} metadata={null} sessionId="s1" />,
        );

        const copyButton = screen.findByTestId('transcript-message-copy:local-1');
        expect(copyButton).toBeTruthy();

        const copyPressables = screen.findAll(
            (node: any) => node.type === 'Pressable' && node.props.accessibilityLabel === 'common.copy',
        );
        expect(copyPressables).toHaveLength(1);
        const copyStyle = typeof copyPressables[0].props.style === 'function'
            ? copyPressables[0].props.style({ pressed: false })
            : copyPressables[0].props.style;
        expect(flattenStyle(copyStyle).minWidth).toBeGreaterThanOrEqual(44);
        expect(flattenStyle(copyStyle).minHeight).toBeGreaterThanOrEqual(44);
        expect(copyPressables[0].props.hitSlop).toBeUndefined();
    });
});
