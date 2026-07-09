import React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    createToolCallMessageFixture,
    renderStatefulToolCallsGroupView,
    renderToolCallsGroupView,
    standardCleanup,
} from '@/dev/testkit';
import { createReducer } from '@/sync/reducer/reducer';
import { installToolCallsGroupViewCommonModuleMocks } from './toolCallsGroupViewTestHelpers';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let toolChromeMode: 'activity_feed' | 'cards' = 'activity_feed';
let toolCallsGroupShowBackground: boolean = false;
installToolCallsGroupViewCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock(
            {
                Platform: { OS: 'ios', select: (values: any) => values?.ios ?? values?.default ?? null },
            },
        );
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock();
    },
    icons: async () => {
        const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
        return {
            ...createExpoVectorIconsMock(),
            Ionicons: (props: any) => React.createElement('Ionicons', { ...props, testID: `ionicons:${props.name}` }),
        };
    },
    text: async () => {
        const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
        return createTextModuleMock({
            translate: (key: string) => key,
        });
    },
    storage: async (importOriginal) => {
        const { createStorageModuleMock } = await import('@/dev/testkit/mocks/storage');
        return createStorageModuleMock({
            importOriginal,
            overrides: {
                useSetting: (key: string) => {
                    if (key === 'toolViewTimelineChromeMode') return toolChromeMode;
                    if (key === 'transcriptToolCallsCollapsedPreviewCount') return 0;
                    if (key === 'transcriptToolCallsGroupShowBackground') return toolCallsGroupShowBackground;
                    return null;
                },
                useSessionMessagesById: () => ({}),
                useSessionMessagesReducerState: () => createReducer(),
            },
        });
    },
});

vi.mock('@/components/tools/shell/views/ToolView', () => ({
    ToolView: (props: any) => React.createElement('ToolView', props),
}));

vi.mock('@/components/tools/shell/views/ToolTimelineRow', () => ({
    ToolTimelineRow: (props: any) => React.createElement('ToolTimelineRow', props),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptEnterWrapper', () => ({
    TranscriptEnterWrapper: (props: any) => React.createElement('TranscriptEnterWrapper', { ...props, testID: 'transcript-enter-wrapper' }, props.children),
}));

vi.mock('@/components/sessions/transcript/motion/TranscriptCollapsible', () => ({
    TranscriptCollapsible: (props: any) => React.createElement('TranscriptCollapsible', { ...props, testID: 'transcript-collapsible' }, props.children),
}));

describe('ToolCallsGroupView (motion wiring)', () => {
    afterEach(standardCleanup);

    it('wraps tool rows in TranscriptEnterWrapper and uses TranscriptCollapsible for expand/collapse', async () => {
        const toolMessages = [
            createToolCallMessageFixture({ id: 'm1', createdAt: 1 }),
            createToolCallMessageFixture({ id: 'm2', createdAt: 2 }),
        ];

        const screen = await renderStatefulToolCallsGroupView({
            toolMessages,
        });

        expect(screen.findAllByTestId('transcript-enter-wrapper')).toHaveLength(0);
        expect(screen.findByTestId('transcript-collapsible')).toBeNull();

        await screen.pressByTestIdAsync('transcript-tool-calls-preview-more');

        expect(screen.findAllByTestId('transcript-enter-wrapper')).toHaveLength(2);
        const collapsibleAfter = screen.findByTestId('transcript-collapsible') as any;
        expect(collapsibleAfter?.props.expanded).toBe(true);
    });

    it('shows a stack icon and toggles chevron direction when expanded', async () => {
        toolChromeMode = 'activity_feed';
        toolCallsGroupShowBackground = false;

        const toolMessages = [createToolCallMessageFixture({ id: 'm1', createdAt: 1 })];

        const screen = await renderStatefulToolCallsGroupView({
            status: 'completed',
            toolMessages,
        });

        expect(screen.findByTestId('ionicons:layers-outline')).not.toBeNull();
        expect(screen.findByTestId('ionicons:chevron-down-outline')).toBeNull();
        expect(screen.findByTestId('ionicons:chevron-up-outline')).toBeNull();

        await screen.pressByTestIdAsync('transcript-tool-calls-preview-more');

        expect(screen.findByTestId('ionicons:chevron-up-outline')).not.toBeNull();
    });

    it('applies a group background only when enabled in tool feed mode', async () => {
        const { ToolCallsGroupView } = await import('./ToolCallsGroupView');
        toolChromeMode = 'activity_feed';
        toolCallsGroupShowBackground = true;

        const toolMessages = [createToolCallMessageFixture({ id: 'm1', createdAt: 1 })];

        const screen = await renderToolCallsGroupView({
            status: 'completed',
            toolMessages,
        });

        const container = screen.findByTestId('transcript-tool-calls-group') as any;
        const styles = Array.isArray(container.props.style) ? container.props.style : [container.props.style];
        const backgroundEntry = styles.find((s: any) => s?.backgroundColor);
        expect(backgroundEntry?.backgroundColor).toBeTruthy();

        toolChromeMode = 'cards';
        await act(async () => {
            await screen.update(
                <ToolCallsGroupView
                    id="toolCalls:1"
                    status="completed"
                    toolMessages={toolMessages}
                    metadata={null}
                    sessionId="s1"
                    expanded={false}
                    setExpanded={vi.fn()}
                    interaction={{ canSendMessages: true, canApprovePermissions: true }}
                />,
            );
        });

        const containerCards = screen.findByTestId('transcript-tool-calls-group') as any;
        const stylesCards = Array.isArray(containerCards.props.style) ? containerCards.props.style : [containerCards.props.style];
        const backgroundEntryCards = stylesCards.find((s: any) => s?.backgroundColor);
        expect(backgroundEntryCards?.backgroundColor ?? null).not.toBe(backgroundEntry?.backgroundColor ?? null);
    });

    it('renders grouped tool rows through ToolView in cards mode when no structured message view is needed', async () => {
        toolChromeMode = 'cards';
        toolCallsGroupShowBackground = false;

        const screen = await renderToolCallsGroupView({
            status: 'completed',
            toolMessages: [createToolCallMessageFixture({ id: 'm1', createdAt: 1 })],
            expanded: true,
        });

        expect(screen.findAllByType('ToolView' as any)).toHaveLength(1);
        expect(screen.findAllByType('ToolTimelineRow' as any)).toHaveLength(0);
    });
});
