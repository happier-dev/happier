import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());

function flatten(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) return Object.assign({}, ...style.map(flatten));
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

describe('AppRailBadge', () => {
    it('folds semantic priority before numeric magnitude and never adds unrelated domains', async () => {
        const { resolveStrongestAppRailBadge } = await import('./AppRailBadge');
        expect(resolveStrongestAppRailBadge([{ kind: 'count', tone: 'neutral', value: 99 },
            { kind: 'dot', tone: 'attention' }])).toEqual({ kind: 'dot', tone: 'attention' });
        expect(resolveStrongestAppRailBadge([{ kind: 'count', tone: 'neutral', value: 3 },
            { kind: 'count', tone: 'neutral', value: 8 }])).toEqual({ kind: 'count', tone: 'neutral', value: 8 });
        expect(resolveStrongestAppRailBadge([null, { kind: 'count', tone: 'attention', value: 0 }])).toBeNull();
    });
    it('anchors every badge at the glyph box corner, a count and a dot each at one size', async () => {
        const { AppRailBadge } = await import('./AppRailBadge');
        const { APP_RAIL_BADGE } = await import('./appRailMetrics');
        const count = await renderScreen(<AppRailBadge signal={{ kind: 'count', value: 3, tone: 'attention' }} testID="badge" />);
        const countStyle = flatten(count.findByTestId('badge')!.props.style);
        expect(countStyle).toMatchObject({
            position: 'absolute',
            left: APP_RAIL_BADGE.anchorLeftPx,
            top: APP_RAIL_BADGE.anchorTopPx,
            height: APP_RAIL_BADGE.countSizePx + 2 * APP_RAIL_BADGE.ringPx,
            borderWidth: APP_RAIL_BADGE.ringPx,
        });
        expect(count.getTextContent()).toBe('3');

        const many = await renderScreen(<AppRailBadge signal={{ kind: 'count', value: 250, tone: 'accent' }} testID="badge" />);
        expect(many.getTextContent()).toBe('99+');

        const dot = await renderScreen(<AppRailBadge signal={{ kind: 'dot', tone: 'accent' }} testID="badge" />);
        const dotStyle = flatten(dot.findByTestId('badge')!.props.style);
        expect(dotStyle).toMatchObject({
            left: APP_RAIL_BADGE.anchorLeftPx,
            top: APP_RAIL_BADGE.anchorTopPx,
            width: APP_RAIL_BADGE.dotSizePx + 2 * APP_RAIL_BADGE.ringPx,
            height: APP_RAIL_BADGE.dotSizePx + 2 * APP_RAIL_BADGE.ringPx,
        });
        expect(dot.getTextContent()).toBe('');
    });

    it('draws needs-action in the attention amber and everything else in the ink, never blue or red', async () => {
        const { AppRailBadge } = await import('./AppRailBadge');
        const { lightTheme } = await import('@/theme');
        const fill = async (tone: 'attention' | 'accent' | 'neutral', kind: 'count' | 'dot') => {
            const signal = kind === 'count' ? { kind, value: 4, tone } as const : { kind, tone } as const;
            const screen = await renderScreen(<AppRailBadge signal={signal} testID="badge" />);
            return flatten(screen.findByTestId('badge')!.props.style).backgroundColor;
        };
        for (const kind of ['count', 'dot'] as const) {
            expect(await fill('attention', kind)).toBe(lightTheme.colors.state.attention.foreground);
            expect(await fill('accent', kind)).toBe(lightTheme.colors.text.primary);
            expect(await fill('neutral', kind)).toBe(lightTheme.colors.text.tertiary);
        }
    });

    it('is amber only for what needs action', async () => {
        const { resolveAppRailBadgeTone } = await import('./AppRailBadge');
        expect(resolveAppRailBadgeTone({ source: 'updates', failed: true })).toBe('attention');
        expect(resolveAppRailBadgeTone({ source: 'updates', failed: false })).toBe('accent');
        expect(resolveAppRailBadgeTone({ source: 'plugin', tone: 'danger' })).toBe('attention');
        expect(resolveAppRailBadgeTone({ source: 'plugin', tone: 'warning' })).toBe('attention');
        // A static label ("Beta") asks for nothing: it stays quiet.
        expect(resolveAppRailBadgeTone({ source: 'plugin', tone: 'info' })).toBe('neutral');
        expect(resolveAppRailBadgeTone({ source: 'plugin', tone: 'neutral' })).toBe('neutral');
    });

    it('counts the Inbox in amber only for what needs the person; anything else is a quiet dot (owner 2026-11-10)', async () => {
        const { resolveAppRailInboxBadge } = await import('./AppRailBadge');
        expect(resolveAppRailInboxBadge({ count: 0, needsYouCount: 0 })).toBeNull();
        expect(resolveAppRailInboxBadge({ count: 140, needsYouCount: 0 })).toEqual({ kind: 'dot', tone: 'neutral' });
        expect(resolveAppRailInboxBadge({ count: 140, needsYouCount: 2 })).toEqual({ kind: 'count', value: 2, tone: 'attention' });
        // Not yet known: the existing quiet dot stays until the summary settles.
        expect(resolveAppRailInboxBadge({ count: null, needsYouCount: null })).toEqual({ kind: 'dot', tone: 'neutral' });
    });

});
