import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { renderScreen } from '@/dev/testkit';
import type { BadgeGridItem } from '../BadgeGrid';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock(
        {
                    Platform: {
                        OS: 'web',
                    },
                    View: 'View',
                    Text: 'Text',
                }
    );
});

vi.mock('@expo/vector-icons', async () => {
    const { createExpoVectorIconsMock } = await import('@/dev/testkit/mocks/icons');
    return createExpoVectorIconsMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/components/ui/text/Text', () => ({
    Text: (
        { children, ...props }: { children?: React.ReactNode } & Record<string, unknown>,
    ) => React.createElement('Text', props, children),
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

async function renderBadgeGrid(items: ReadonlyArray<BadgeGridItem>) {
    const { BadgeGrid } = await import('../BadgeGrid');
    return renderScreen(<BadgeGrid items={items} />);
}

describe('BadgeGrid', () => {
    it('renders the correct number of badges', async () => {
        const screen = await renderBadgeGrid(SAMPLE_ITEMS);
        expect(screen.findAllByType('Ionicons')).toHaveLength(5);
        const content = screen.getTextContent();
        expect(content).toContain('Resume');
        expect(content).toContain('Sessions');
        expect(content).toContain('Models');
        expect(content).toContain('Local Control');
        expect(content).toContain('Voice');
    });

    it('renders correct icon for each status', async () => {
        const screen = await renderBadgeGrid([
            { id: 'pos', label: 'Pos', status: 'positive' },
            { id: 'neg', label: 'Neg', status: 'negative' },
            { id: 'neu', label: 'Neu', status: 'neutral' },
            { id: 'warn', label: 'Warn', status: 'warning' },
        ]);
        expect(screen.findAllByProps({ name: 'checkmark-circle' })).toHaveLength(1);
        expect(screen.findAllByProps({ name: 'close-circle' })).toHaveLength(1);
        expect(screen.findAllByProps({ name: 'ellipse' })).toHaveLength(1);
        expect(screen.findAllByProps({ name: 'warning' })).toHaveLength(1);
    });

    it('renders detail text when provided', async () => {
        const screen = await renderBadgeGrid([{ id: 'a', label: 'Alpha', status: 'positive', detail: 'v2.1' }]);
        expect(screen.getTextContent()).toContain('v2.1');
    });

    it('renders empty when items is empty', async () => {
        const screen = await renderBadgeGrid([]);
        expect(screen.findAllByType('Ionicons')).toHaveLength(0);
        expect(screen.getTextContent()).toBe('');
    });
});
