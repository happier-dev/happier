import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { installMessageViewCommonModuleMocks } from './messageViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const platformState = vi.hoisted(() => ({
    os: 'ios' as 'ios' | 'android',
}));

vi.mock('@/agents/registry/registryUiBehavior', () => ({
    buildNewSessionOptionsFromUiState: () => ({}),
    buildResumeCapabilityOptionsFromUiState: () => ({}),
    getNewSessionPreflightIssues: () => [],
    getNewSessionRelevantInstallableDepKeys: () => [],
    resolveAgentUiBehavior: () => ({}),
    resolveAgentUiBehaviorFromFlavor: () => ({}),
    supportsDetectedMcpConfigScan: () => false,
    supportsEditableSessionGoals: () => false,
}));

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

describe('MessageView (copy button hitSlop)', () => {
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

            const selectButtons = screen.findAll(
                (node: any) => node.type === 'Pressable' && node.props?.testID === 'transcript-message-select:m1',
            );
            expect(selectButtons).toHaveLength(1);
            expect(selectButtons[0].props.hitSlop).toBe(15);

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
});
