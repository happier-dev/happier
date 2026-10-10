import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { lightTheme } from '@/theme';
import { HappierMaterialRoleProvider } from '@happier-dev/plugin-ui/presentation';

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

function flatten(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('TabBadge', () => {
    it('keeps neutral compact counts and diff chips translucent without fading their values', async () => {
        const { TabBadge } = await import('./TabBadge');
        const screen = await renderScreen(<HappierMaterialRoleProvider role="chrome" resolveMaterialColor={() => 'rgba(235, 230, 225, 0.1)'}>
            <TabBadge variant="count" tone="neutral" size="compact" value={4} testID="neutral-count" />
            <TabBadge variant="diff" added={2} removed={1} changedFileCount={3} testID="diff-count" />
            <TabBadge variant="count" tone="attention" value={4} testID="attention-count" />
        </HappierMaterialRoleProvider>);
        for (const id of ['neutral-count', 'diff-count']) {
            expect(flatten(screen.findByTestId(id)!.props.style).backgroundColor).toBe('rgba(235, 230, 225, 0.1)');
        }
        expect(flatten(screen.findByTestId('attention-count')!.props.style).backgroundColor).toBe(lightTheme.colors.state.attention.foreground);
        expect(screen.findByTestId('neutral-count')!.findAll(node => typeof node.type === 'string' && String(node.type) === 'Text').some(node => node.children.includes('4'))).toBe(true);
    });
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
