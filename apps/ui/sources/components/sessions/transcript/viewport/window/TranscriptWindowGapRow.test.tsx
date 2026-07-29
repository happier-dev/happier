import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen, standardCleanup } from '@/dev/testkit';

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock({
        theme: {
            colors: {
                border: { default: '#cccccc' },
                surface: { base: '#ffffff' },
                text: { primary: '#111111', secondary: '#666666' },
            },
        },
    });
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key) => key });
});
vi.mock('@expo/vector-icons', () => ({
    Ionicons: (props: Record<string, unknown>) => React.createElement('Ionicons', props),
}));

describe('TranscriptWindowGapRow', () => {
    afterEach(() => {
        standardCleanup();
    });

    it('exposes passive directional reading semantics for both gap boundaries', async () => {
        const { TranscriptWindowGapRow } = await import('./TranscriptWindowGapRow');
        const older = await renderScreen(
            <TranscriptWindowGapRow
                gap={{
                    direction: 'older',
                    id: 'transcript-window-gap:window-1:older',
                    kind: 'transcript-window-gap',
                }}
            />,
        );
        const olderChip = older.findByTestId('transcript-window-gap-chip:older');
        expect(older.findByTestId('transcript-window-gap-title:older')?.props.children)
            .toBe('session.transcriptGap.earlierMessages');
        expect(olderChip?.props.accessibilityLabel).toBe('session.transcriptGap.earlierMessages');
        expect(olderChip?.props.accessibilityRole).toBe('text');
        expect(olderChip?.props.onPress).toBeUndefined();
        await older.unmount();

        const newer = await renderScreen(
            <TranscriptWindowGapRow
                gap={{
                    direction: 'newer',
                    id: 'transcript-window-gap:window-1:newer',
                    kind: 'transcript-window-gap',
                }}
            />,
        );
        const newerChip = newer.findByTestId('transcript-window-gap-chip:newer');
        expect(newer.findByTestId('transcript-window-gap-title:newer')?.props.children)
            .toBe('session.transcriptGap.laterMessages');
        expect(newerChip?.props.accessibilityLabel).toBe('session.transcriptGap.laterMessages');
        expect(newerChip?.props.accessibilityRole).toBe('text');
        expect(newerChip?.props.onPress).toBeUndefined();
        await newer.unmount();
    });
});
