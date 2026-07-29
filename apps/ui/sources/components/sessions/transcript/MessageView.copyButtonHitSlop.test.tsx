import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({
    os: 'ios' as 'ios' | 'android',
}));

vi.mock('@/agents/registry/registryUiBehavior', async () => {
    const { createRegistryUiBehaviorModuleMock } = await import('@/dev/testkit/mocks/registryUiBehavior');
    return createRegistryUiBehaviorModuleMock();
});

installMessageViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Platform: {
                get OS() {
                    return platformState.os;
                },
                select: (values: Record<string, unknown>) =>
                    values?.[platformState.os] ?? values?.default,
            },
        });
    },
    storage: async () => {
        const { createStorageModuleStub } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleStub({
            useSetting: (key: string) => key === 'transcriptMessageSelectionEnabled' ? true : null,
            useSession: () => null,
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

vi.mock('@/components/sessions/linkedFiles/LinkedWorkspaceFilesRow', () => ({
    LinkedWorkspaceFilesRow: () => null,
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
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

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.filter(Boolean).map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

function findNearestAncestorStyle(node: { parent?: unknown }): Record<string, unknown> {
    let cursor = node.parent as ({ parent?: unknown; props?: { style?: unknown } } | null | undefined);
    while (cursor) {
        const style = flattenStyle(cursor.props?.style);
        if (Object.keys(style).length > 0) return style;
        cursor = cursor.parent as ({ parent?: unknown; props?: { style?: unknown } } | null | undefined);
    }
    return {};
}

describe('MessageView (native inline action targets)', () => {
    afterEach(() => {
        standardCleanup();
    });

    it.each(['ios', 'android'] as const)(
        'renders inline message actions on %s instead of relying on long-press dropdowns',
        async (platformOS) => {
            platformState.os = platformOS;
            vi.resetModules();
            const { MessageView } = await import('./MessageView');
            const { TranscriptMessageSelectionProvider } = await import('./messageSelection/TranscriptMessageSelectionContext');

            const message: any = {
                kind: 'user-text',
                localId: 'local-1',
                id: 'm1',
                text: 'hello',
            };

            const screen = await renderScreen(
                <TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={['m1']}>
                    <MessageView message={message} metadata={null} sessionId="s1" />
                </TranscriptMessageSelectionProvider>,
            );

            const copyButtons = screen.findAll(
                (node: any) => node.type === 'Pressable' && node.props?.testID === 'transcript-message-copy:m1',
            );
            expect(copyButtons).toHaveLength(1);
            const minimumSize = platformOS === 'android' ? 48 : 44;
            const copyStyle = typeof copyButtons[0].props.style === 'function'
                ? copyButtons[0].props.style({ pressed: false })
                : copyButtons[0].props.style;
            expect(flattenStyle(copyStyle).minWidth).toBeGreaterThanOrEqual(minimumSize);
            expect(flattenStyle(copyStyle).minHeight).toBeGreaterThanOrEqual(minimumSize);
            expect(copyButtons[0].props.hitSlop).toBeUndefined();

            const selectButtons = screen.findAll(
                (node: any) => node.type === 'Pressable' && node.props?.testID === 'transcript-message-select:m1',
            );
            expect(selectButtons).toHaveLength(1);
            const selectStyle = typeof selectButtons[0].props.style === 'function'
                ? selectButtons[0].props.style({ pressed: false })
                : selectButtons[0].props.style;
            expect(flattenStyle(selectStyle).minWidth).toBeGreaterThanOrEqual(minimumSize);
            expect(flattenStyle(selectStyle).minHeight).toBeGreaterThanOrEqual(minimumSize);
            expect(selectButtons[0].props.hitSlop).toBeUndefined();

            await act(async () => {
                selectButtons[0].props.onPress?.({} as never);
            });
            const selectionCheckbox = screen.findByTestId('transcript-message-select-checkbox:m1');
            if (!selectionCheckbox) throw new Error('expected transcript selection checkbox to render');
            const selectionAnchorStyle = findNearestAncestorStyle(selectionCheckbox);
            expect(selectionAnchorStyle).toMatchObject({ position: 'absolute', right: 0 });
            expect(selectionAnchorStyle).not.toHaveProperty('left');
            expect(selectionAnchorStyle).not.toHaveProperty('marginBottom');

            const longPressables = screen.findAll(
                (node: any) => node.type === 'Pressable' && typeof node.props?.onLongPress === 'function',
            );
            expect(longPressables).toHaveLength(0);

            const dropdowns = screen.findAllByType('DropdownMenu');
            expect(dropdowns).toHaveLength(0);
        },
    );

    it.each([
        ['ios', true],
        ['android', true],
    ] as const)(
        'sets transcript markdown selectability on %s to %s',
        async (platformOS, expectedSelectable) => {
            platformState.os = platformOS;
            vi.resetModules();
            const { MessageView } = await import('./MessageView');
            const { TranscriptMessageSelectionProvider } = await import('./messageSelection/TranscriptMessageSelectionContext');

            const message: any = {
                kind: 'user-text',
                localId: 'local-1',
                id: 'm1',
                text: 'hello',
            };

            const screen = await renderScreen(
                <TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={['m1']}>
                    <MessageView message={message} metadata={null} sessionId="s1" />
                </TranscriptMessageSelectionProvider>,
            );

            const markdownView = screen.findByType('MarkdownView' as any);
            expect(markdownView.props.selectable).toBe(expectedSelectable);
            expect(markdownView.props.profile).toBe('transcript');
            expect(markdownView.props.textStyle).toMatchObject({
                fontSize: 16,
                lineHeight: 24,
            });
        },
    );

    it('copies user message options on long press without submitting them', async () => {
        platformState.os = 'ios';
        vi.resetModules();
        const Clipboard = await import('expo-clipboard');
        const { sync } = await import('@/sync/sync');
        const { MessageView } = await import('./MessageView');
        const { TranscriptMessageSelectionProvider } = await import('./messageSelection/TranscriptMessageSelectionContext');

        const message: any = {
            kind: 'user-text',
            localId: 'local-1',
            id: 'm1',
            text: [
                '<options>',
                '<option>Run command</option>',
                '</options>',
            ].join('\n'),
        };

        const screen = await renderScreen(
            <TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={['m1']}>
                <MessageView message={message} metadata={null} sessionId="s1" />
            </TranscriptMessageSelectionProvider>,
        );

        const markdownView = screen.findByType('MarkdownView' as any);
        expect(typeof markdownView.props.onOptionLongPress).toBe('function');

        let copied = false;
        await act(async () => {
            copied = await markdownView.props.onOptionLongPress({ title: 'Run command' });
        });

        expect(copied).toBe(true);
        expect(Clipboard.setStringAsync).toHaveBeenCalledWith('Run command');
        expect(sync.submitMessage).not.toHaveBeenCalled();
    });
});
