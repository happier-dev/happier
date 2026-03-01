import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@expo/vector-icons', () => ({ Ionicons: 'Ionicons' }));

vi.mock('react-native', () => ({
    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                text: '#fff',
                textSecondary: '#aaa',
                surface: '#111',
                surfaceHigh: '#222',
                surfacePressedOverlay: '#333',
            },
        },
    }),
    StyleSheet: {
        create: (input: any) =>
            typeof input === 'function'
                ? input(
                      {
                          colors: {
                              text: '#fff',
                              textSecondary: '#aaa',
                              surface: '#111',
                              surfaceHigh: '#222',
                              surfacePressedOverlay: '#333',
                          },
                      },
                      {},
                  )
                : input,
    },
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

vi.mock('@/components/sessions/transcript/motion/ThinkingPulseLabel', () => ({
    ThinkingPulseLabel: (props: any) => React.createElement('ThinkingPulseLabel', props),
}));

describe('ThinkingTimelineRow', () => {
    it('shows summary with ellipsis when collapsed and hides it when expanded', async () => {
        const { ThinkingTimelineRow } = await import('./ThinkingTimelineRow');

        let tree: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <ThinkingTimelineRow
                    id="t1"
                    createdAt={1}
                    label="Thinking"
                    summary="Hello world"
                    expandedByDefault={false}
                    pulseEnabled={false}
                    chrome="plain"
                >
                    {React.createElement('Text', { testID: 'body' }, 'BODY')}
                </ThinkingTimelineRow>,
            );
        });

        const summaryNode = tree!.root.findByProps({ testID: 'transcript-thinking-summary-inline' });
        expect(String(summaryNode.props.children)).toBe('Hello world…');
        const iconCollapsed = tree!.root.findAllByType('Ionicons').at(-1) as any;
        expect(iconCollapsed?.props?.name).toBe('chevron-down-outline');

        const header = tree!.root.findByProps({ testID: 'transcript-thinking-header' });
        await act(async () => {
            header.props.onPress();
        });

        expect(tree!.root.findAllByProps({ testID: 'transcript-thinking-summary-inline' })).toHaveLength(0);
        const iconExpanded = tree!.root.findAllByType('Ionicons').at(-1) as any;
        expect(iconExpanded?.props?.name).toBe('chevron-up-outline');
        expect(tree!.root.findAllByProps({ testID: 'body' })).toHaveLength(1);
    });
});
