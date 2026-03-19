import React from 'react';
import renderer, { act } from 'react-test-renderer';
import { describe, expect, it, vi } from 'vitest';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async (importOriginal) => {
    const actual = await importOriginal<any>();
    return {
        ...actual,
        Platform: { ...(actual.Platform ?? {}), OS: 'web' },
        View: 'View',
        Text: 'Text',
        Pressable: ({ children, ...props }: any) => React.createElement('Pressable', props, children),
    };
});

vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            text: '#000',
            textSecondary: '#666',
            surface: '#fff',
            surfaceHigh: '#f5f5f5',
            divider: '#e0e0e0',
        },
    };
    return {
        useUnistyles: () => ({ theme }),
        StyleSheet: { create: (input: any) => (typeof input === 'function' ? input(theme) : input) },
    };
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: ({ children, ...props }: any) => React.createElement('Text', props, children),
}));

vi.mock('@/constants/Typography', () => ({
    Typography: { default: () => ({}) },
}));

const SAMPLE_ENTRIES = [
    { label: 'Theme', value: 'Dark' },
    { label: 'Language', value: 'English' },
    { label: 'Font', value: '16px' },
];

describe('SummaryCard', () => {
    it('renders label:value pairs', async () => {
        const { SummaryCard } = await import('../SummaryCard');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SummaryCard entries={SAMPLE_ENTRIES} />);
        });
        const texts = tree.root.findAllByType('Text' as any);
        const allText = texts.map((t) => t.children.join('')).join('|');
        expect(allText).toContain('Theme');
        expect(allText).toContain('Dark');
        expect(allText).toContain('Language');
        expect(allText).toContain('English');
    });

    it('wraps in Pressable when onPress is provided', async () => {
        const { SummaryCard } = await import('../SummaryCard');
        const onPress = vi.fn();
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SummaryCard entries={SAMPLE_ENTRIES} onPress={onPress} />);
        });
        const pressables = tree.root.findAllByType('Pressable' as any);
        expect(pressables.length).toBeGreaterThan(0);
    });

    it('renders as View (not Pressable) when onPress is omitted', async () => {
        const { SummaryCard } = await import('../SummaryCard');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SummaryCard entries={SAMPLE_ENTRIES} />);
        });
        const pressables = tree.root.findAllByType('Pressable' as any);
        expect(pressables).toHaveLength(0);
    });

    it('shows chevron when onPress is provided', async () => {
        const { SummaryCard } = await import('../SummaryCard');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <SummaryCard entries={SAMPLE_ENTRIES} onPress={() => {}} />,
            );
        });
        const json = tree.toJSON();
        const findChevron = (node: any): boolean => {
            if (!node) return false;
            if (node.props?.name === 'chevron-forward') return true;
            if (Array.isArray(node.children)) return node.children.some(findChevron);
            if (Array.isArray(node)) return node.some(findChevron);
            return false;
        };
        expect(findChevron(json)).toBe(true);
    });

    it('does not show chevron without onPress', async () => {
        const { SummaryCard } = await import('../SummaryCard');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<SummaryCard entries={SAMPLE_ENTRIES} />);
        });
        const json = tree.toJSON();
        const findChevron = (node: any): boolean => {
            if (!node) return false;
            if (node.props?.name === 'chevron-forward') return true;
            if (Array.isArray(node.children)) return node.children.some(findChevron);
            if (Array.isArray(node)) return node.some(findChevron);
            return false;
        };
        expect(findChevron(json)).toBe(false);
    });
});
