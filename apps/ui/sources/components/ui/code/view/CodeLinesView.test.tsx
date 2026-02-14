import React from 'react';
import renderer from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', () => ({
    View: ({ children, ...props }: any) => React.createElement('View', props, children),
    FlatList: (props: any) => React.createElement('FlatList', props),
}));

vi.mock('./CodeLineRow', () => ({
    CodeLineRow: (props: any) => React.createElement('CodeLineRow', props),
}));

describe('CodeLinesView', () => {
    it('passes extraData to FlatList when renderAfterLine is provided', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <CodeLinesView
                    lines={[
                        {
                            id: '1',
                            sourceIndex: 0,
                            kind: 'context',
                            oldLine: 1,
                            newLine: 1,
                            renderPrefixText: '',
                            renderCodeText: 'const x = 1;',
                            renderIsHeaderLine: false,
                            selectable: false,
                        },
                    ]}
                    renderAfterLine={() => React.createElement('After')}
                />,
            );
        });

        const list = (tree as renderer.ReactTestRenderer).root.findByType('FlatList' as any);
        expect(list.props.extraData).toBeTruthy();
    });

    it('passes commentActive to CodeLineRow when isCommentActive reports true', async () => {
        const { CodeLinesView } = await import('./CodeLinesView');

        let tree!: renderer.ReactTestRenderer;
        renderer.act(() => {
            tree = renderer.create(
                <CodeLinesView
                    virtualized={false}
                    lines={[
                        {
                            id: '1',
                            sourceIndex: 0,
                            kind: 'context',
                            oldLine: 1,
                            newLine: 1,
                            renderPrefixText: '',
                            renderCodeText: 'const x = 1;',
                            renderIsHeaderLine: false,
                            selectable: false,
                        },
                    ]}
                    isCommentActive={(line) => line.id === '1'}
                />,
            );
        });

        const rows = (tree as renderer.ReactTestRenderer).root.findAllByType('CodeLineRow' as any);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.props.commentActive).toBe(true);
    });
});
