import * as React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native-unistyles', () => ({
    useUnistyles: () => ({
        theme: {
            colors: {
                textSecondary: '#666666',
                textTertiary: '#444444',
            },
        },
    }),
}));

vi.mock('@/components/ui/text/Text', () => ({
    Text: (props: any) => React.createElement('Text', props, props.children),
}));

describe('AgentInputChipLabel', () => {
    it('renders the count in parentheses with tertiary color styling', async () => {
        const { AgentInputChipLabel } = await import('./AgentInputChipLabel');

        let tree: renderer.ReactTestRenderer | null = null;
        act(() => {
            tree = renderer.create(
                <AgentInputChipLabel
                    label="MCP"
                    count={3}
                    textStyle={{ color: '#ffffff', fontSize: 13 }}
                    countTextStyle={{ color: '#444444' }}
                />,
            );
        });

        const textNodes = tree!.root.findAllByType('Text' as any);
        expect(textNodes.map((node: any) => node.props.children).flat().join('')).toContain('MCP');
        expect(textNodes.map((node: any) => node.props.children).flat().join('')).toContain('(3)');
        expect(textNodes.some((node: any) => {
            const style = node.props?.style;
            if (Array.isArray(style)) {
                return style.some((entry) => entry?.color === '#444444');
            }
            return style?.color === '#444444';
        })).toBe(true);
    });
});
