import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { lightTheme } from '@/theme';

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

function flatten(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('TabBadge', () => {
    it('fills a needs-you count in the attention amber and a neutral count in the ink, never red or blue', async () => {
        const { TabBadge } = await import('./TabBadge');
        const fill = async (tone?: 'attention' | 'neutral') => {
            const screen = await renderScreen(<TabBadge variant="count" value={4} tone={tone} testID="badge" />);
            return flatten(screen.findByTestId('badge')!.props.style).backgroundColor;
        };

        expect(await fill('attention')).toBe(lightTheme.colors.state.attention.foreground);
        // A count with no tone is something waiting on the person (a friend request, a sign-in).
        expect(await fill(undefined)).toBe(lightTheme.colors.state.attention.foreground);
        expect(await fill('neutral')).toBe(lightTheme.colors.text.secondary);
    });

    it('draws a needs-you dot in the same attention amber', async () => {
        const { TabBadge } = await import('./TabBadge');
        const screen = await renderScreen(<TabBadge variant="dot" tone="attention" testID="dot" />);
        expect(flatten(screen.findByTestId('dot')!.props.style).backgroundColor).toBe(lightTheme.colors.state.attention.foreground);
    });
});
