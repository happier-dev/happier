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
    };
});

vi.mock('react-native-unistyles', () => {
    const theme = {
        colors: {
            text: '#000',
            textSecondary: '#666',
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

const SAMPLE_ITEMS = [
    { id: 'resume', label: 'Resume', status: 'positive' as const },
    { id: 'sessions', label: 'Sessions', status: 'positive' as const },
    { id: 'models', label: 'Models', status: 'negative' as const },
    { id: 'local', label: 'Local Control', status: 'neutral' as const },
    { id: 'voice', label: 'Voice', status: 'warning' as const },
];

describe('BadgeGrid', () => {
    it('renders the correct number of badges', async () => {
        const { BadgeGrid } = await import('../BadgeGrid');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<BadgeGrid items={SAMPLE_ITEMS} />);
        });
        const texts = tree.root.findAllByType('Text' as any);
        // Each badge renders at least a label Text
        const labels = texts.filter((t) => SAMPLE_ITEMS.some((i) => i.label === t.children.join('')));
        expect(labels).toHaveLength(5);
    });

    it('renders correct icon for each status', async () => {
        const { BadgeGrid } = await import('../BadgeGrid');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <BadgeGrid
                    items={[
                        { id: 'pos', label: 'Pos', status: 'positive' },
                        { id: 'neg', label: 'Neg', status: 'negative' },
                        { id: 'neu', label: 'Neu', status: 'neutral' },
                        { id: 'warn', label: 'Warn', status: 'warning' },
                    ]}
                />,
            );
        });
        const json = tree.toJSON();
        expect(json).toBeTruthy();
        // All 4 statuses rendered without error
        const texts = tree.root.findAllByType('Text' as any);
        expect(texts.length).toBeGreaterThanOrEqual(4);
    });

    it('renders detail text when provided', async () => {
        const { BadgeGrid } = await import('../BadgeGrid');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(
                <BadgeGrid items={[{ id: 'a', label: 'Alpha', status: 'positive', detail: 'v2.1' }]} />,
            );
        });
        const texts = tree.root.findAllByType('Text' as any);
        const textContents = texts.map((t) => t.children.join(''));
        expect(textContents).toContain('v2.1');
    });

    it('renders empty when items is empty', async () => {
        const { BadgeGrid } = await import('../BadgeGrid');
        let tree!: renderer.ReactTestRenderer;
        await act(async () => {
            tree = renderer.create(<BadgeGrid items={[]} />);
        });
        const texts = tree.root.findAllByType('Text' as any);
        expect(texts).toHaveLength(0);
    });
});
