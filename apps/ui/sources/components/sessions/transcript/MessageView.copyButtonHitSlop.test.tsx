import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { standardCleanup } from '@/dev/testkit';
import { layoutHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE } from '@happier-dev/plugin-ui/environment';
import { findGestureByKind, type TestGestureChain } from '@/dev/testkit/mocks/gestureHandler';
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

vi.mock('@/components/sessions/transcript/references/StructuredReferencesRow', () => ({
    StructuredReferencesRow: () => null,
}));

vi.mock('@/components/ui/forms/dropdown/DropdownMenu', () => ({
    DropdownMenu: (props: any) => React.createElement('DropdownMenu', props),
}));

vi.mock('@/utils/sessions/discardedCommittedMessages', () => ({
    isCommittedMessageDiscarded: () => false,
}));

vi.mock('expo-clipboard', () => ({
    setStringAsync: vi.fn(async () => true),
}));
vi.mock('react-native-gesture-handler', async () =>
    (await import('@/dev/testkit/mocks/gestureHandler')).createGestureHandlerMock());

vi.mock('@expo/vector-icons', () => ({
    Ionicons: 'Ionicons',
    Octicons: 'Octicons',
}));

vi.mock('@/sync/sync', () => ({
    sync: { submitMessage: vi.fn(), sendMessage: vi.fn() },
}));

// Compile the real transcript graph during collection, after its boundaries are installed, so a cold
// import is not charged to the first test's deadline.
await import('./MessageView');
await import('@/dev/testkit/sessionTranscriptSource');
await import('./messageSelection/TranscriptMessageSelectionContext');
await import('@/components/ui/forms/dropdown/ContextMenu');

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
            const { MessageView } = await import('./MessageView');
            const { renderWithSessionTranscriptSource: renderScreen } = await import('@/dev/testkit/sessionTranscriptSource');
            const { TranscriptMessageSelectionProvider } = await import('./messageSelection/TranscriptMessageSelectionContext');

            const message: any = {
                kind: 'user-text',
                localId: 'local-1',
                id: 'm1',
                text: 'hello',
            };

            const { HappierUiPlatformProvider } = await import('@happier-dev/plugin-ui/environment');
            const screen = await renderScreen(
                <HappierUiPlatformProvider platform={{ platform: platformOS, colorScheme: 'light' }}>
                    <TranscriptMessageSelectionProvider sessionId="s1" eligibleMessageIdsInOrder={['m1']}>
                        <MessageView message={message} metadata={null} sessionId="s1" />
                    </TranscriptMessageSelectionProvider>
                </HappierUiPlatformProvider>,
            );

            const copyButtons = screen.findAll(
                (node: any) => node.type === 'Pressable' && node.props?.testID === 'transcript-message-copy:m1',
            );
            expect(copyButtons.length).toBe(1);
            const minimumSize = platformOS === 'android' ? 48 : 44;
            // Each action keeps its drawn square; its hit area reaches half the gap to each neighbour and
            // never falls below the WCAG 24 floor (on the web frame: react-native-web ignores `hitSlop`).
            const copyStyle = typeof copyButtons[0].props.style === 'function'
                ? copyButtons[0].props.style({ pressed: false })
                : copyButtons[0].props.style;
            const copyDrawn = { width: Number(flattenStyle(copyStyle).width), height: Number(flattenStyle(copyStyle).height) };
            const copyArea = await layoutHitArea(() => screen.findByTestId('transcript-message-copy:m1'), copyDrawn);
            expect(copyDrawn.width).toBeLessThan(minimumSize);
            expect(Math.min(copyArea.width, copyArea.height)).toBeGreaterThanOrEqual(HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE);

            const selectButtons = screen.findAll(
                (node: any) => node.type === 'Pressable' && node.props?.testID === 'transcript-message-select:m1',
            );
            expect(selectButtons.length).toBe(1);
            const selectStyle = typeof selectButtons[0].props.style === 'function'
                ? selectButtons[0].props.style({ pressed: false })
                : selectButtons[0].props.style;
            // Its drawn box is the 16 px icon plus 6 px padding on each side, which the layout engine reports; the renderer cannot measure it.
            const selectDrawn = { width: 28, height: 28 };
            const selectArea = await layoutHitArea(() => screen.findByTestId('transcript-message-select:m1'), selectDrawn);
            expect(Math.min(selectArea.width, selectArea.height)).toBeGreaterThanOrEqual(HAPPIER_POINTER_MINIMUM_INTERACTIVE_TARGET_SIZE);

            await act(async () => {
                selectButtons[0].props.onPress?.({} as never);
            });
            const selectionCheckbox = screen.findByTestId('transcript-message-select-checkbox:m1');
            if (!selectionCheckbox) throw new Error('expected transcript selection checkbox to render');
            const selectionAnchorStyle = findNearestAncestorStyle(selectionCheckbox);
            expect(selectionAnchorStyle).toMatchObject({ position: 'absolute', right: 0 });
            expect(selectionAnchorStyle).not.toHaveProperty('left');
            expect(selectionAnchorStyle).not.toHaveProperty('marginBottom');

            const holds = screen.findAllByType('GestureDetector').map((node) =>
                findGestureByKind(node.props.gesture as TestGestureChain, 'longPress')).filter((gesture) => gesture?.__config.enabled);
            expect(holds).toHaveLength(1);
            await act(async () => { holds[0]!.__handlers.onStart?.(); });
            const { ContextMenu } = await import('@/components/ui/forms/dropdown/ContextMenu');
            expect(screen.findByType(ContextMenu).props).toMatchObject({ open: true, items: expect.arrayContaining([
                expect.objectContaining({ id: 'copy' }), expect.objectContaining({ id: 'select' }),
            ]) });
            // The hold uses the native recognizer without acquiring a parent JS responder.
            expect(screen.findAll((node) => typeof node.type === 'string' && typeof node.props.onLongPress === 'function')).toHaveLength(0);

            // The open context menu is the only menu: it is the hold's own anchored menu, with no dropdown trigger.
            const dropdowns = screen.findAllByType('DropdownMenu');
            expect(dropdowns).toHaveLength(1);
            expect(dropdowns[0]!.props.trigger).toBeNull();
        },
    );

    it.each([
        ['ios', true],
        ['android', true],
    ] as const)(
        'sets transcript markdown selectability on %s to %s',
        async (platformOS, expectedSelectable) => {
            platformState.os = platformOS;
            const { MessageView } = await import('./MessageView');
            const { renderWithSessionTranscriptSource: renderScreen } = await import('@/dev/testkit/sessionTranscriptSource');
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
        const Clipboard = await import('expo-clipboard');
        const { sync } = await import('@/sync/sync');
        const { MessageView } = await import('./MessageView');
        const { renderWithSessionTranscriptSource: renderScreen } = await import('@/dev/testkit/sessionTranscriptSource');
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
