import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import { DisclosureCaret } from '@/components/ui/lists/DisclosureCaret';
import {
    installTranscriptCommonModuleMocks,
    resetTranscriptCommonModuleMockState,
} from '../transcriptTestHelpers';


(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

installTranscriptCommonModuleMocks({
    reactNative: async () => {
        const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
        return createReactNativeWebMock({
            Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
            View: ({ children, ...props }: any) => React.createElement('View', props, children),
        });
    },
    unistyles: async () => {
        const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
        return createUnistylesMock({
            theme: {
                colors: {
                    input: { background: '#222' },
                    text: '#fff',
                    textSecondary: '#aaa',
                    surface: '#111',
                    surfaceHigh: '#222',
                    surfacePressedOverlay: '#333',
                },
            },
        });
    },
});

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/components/sessions/transcript/motion/ThinkingPulseLabel', () => ({
    ThinkingPulseLabel: (props: any) => React.createElement('ThinkingPulseLabel', props),
}));

describe('ThinkingTimelineRow', () => {
    afterEach(() => {
        resetTranscriptCommonModuleMockState();
    });

    it('shows summary with ellipsis when collapsed and hides it when expanded', async () => {
        const { ThinkingTimelineRow } = await import('./ThinkingTimelineRow');

        let tree: renderer.ReactTestRenderer;
        tree = (await renderScreen(<ThinkingTimelineRow
                    id="t1"
                    createdAt={1}
                    label="Thinking"
                    summary="Hello world"
                    expandedByDefault={false}
                    pulseEnabled={false}
                    chrome="plain"
                >
                    {React.createElement('Text', { testID: 'body' }, 'BODY')}
                </ThinkingTimelineRow>)).tree;

        const summaryNode = tree!.findByProps({ testID: 'transcript-thinking-summary-inline' });
        expect(String(summaryNode.props.children)).toBe('Hello world…');
        // The header is a disclosure: the one shared caret, turned by its state.
        expect(tree!.findByType(DisclosureCaret).props.expanded).toBe(false);

        await act(async () => {
            await tree!.pressByTestIdAsync('transcript-thinking-header');
        });

        expect(tree!.findAllByTestId('transcript-thinking-summary-inline')).toHaveLength(0);
        expect(tree!.findByType(DisclosureCaret).props.expanded).toBe(true);
        expect(tree!.findAllByTestId('body')).toHaveLength(1);
    });
});
