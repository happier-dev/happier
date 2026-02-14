import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';
import { Pressable, Text } from 'react-native';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
    Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
    TextInput: (props: any) => React.createElement('TextInput', props),
}));

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                divider: '#333',
                surface: '#111',
                surfaceHighest: '#222',
                surfacePressed: '#444',
                text: '#eee',
                textSecondary: '#aaa',
                textDestructive: '#f00',
                button: {
                    primary: { background: '#fff', tint: '#000' },
                    secondary: { surface: '#222', tint: '#eee' },
                },
            },
        },
    }),
    StyleSheet: {
        create: (v: any) => (typeof v === 'function' ? v({ colors: { textSecondary: '#aaa' } }) : v),
    },
}));

vi.mock('@/constants/Typography', () => ({
    Typography: {
        default: () => ({}),
    },
}));

vi.mock('@/components/ui/text/StyledText', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

describe('useCodeLinesReviewComments', () => {
    it('toggles an inline composer after pressing add-comment for a line', async () => {
        const { useCodeLinesReviewComments } = await import('./useCodeLinesReviewComments');

        const lines = [
            {
                id: 'f:1',
                sourceIndex: 0,
                kind: 'file',
                oldLine: null,
                newLine: 1,
                renderPrefixText: '',
                renderCodeText: 'const a = 1;',
                renderIsHeaderLine: false,
                selectable: true,
            },
        ] as any;

        function Harness() {
            const controls = useCodeLinesReviewComments({
                enabled: true,
                filePath: 'src/a.ts',
                source: 'file',
                lines,
                drafts: [],
            });

            return (
                <React.Fragment>
                    <Pressable onPress={() => controls!.onPressAddComment(lines[0])} />
                    <Text>{controls!.isCommentActive(lines[0]) ? 'active' : 'inactive'}</Text>
                    {controls!.renderAfterLine(lines[0])}
                </React.Fragment>
            );
        }

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(<Harness />);
        });

        expect(tree!.root.findAllByType('TextInput' as any)).toHaveLength(0);
        const statusBefore = tree!.root.findAllByType('Text' as any).map((n) => n.props.children).join(' ');
        expect(statusBefore).toContain('inactive');

        const pressable = tree!.root.findByType('Pressable' as any);
        await act(async () => {
            pressable.props.onPress();
        });

        const statusAfter = tree!.root.findAllByType('Text' as any).map((n) => n.props.children).join(' ');
        expect(statusAfter).toContain('active');
        const inputs = tree!.root.findAllByType('TextInput' as any);
        expect(inputs).toHaveLength(1);
        expect(inputs[0]!.props.placeholder).toBe('Add a review comment…');
    });
});
