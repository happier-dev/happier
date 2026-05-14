import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ReactTestInstance } from 'react-test-renderer';

import { flattenTestStyle, renderScreen } from '@/dev/testkit';
import type { ThemeProfileV1 } from '@/theme/profiles/themeProfileTypes';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});

vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});

vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});

const profile = (lightOverrides: ThemeProfileV1['overrides']['light']): ThemeProfileV1 => ({
    schemaVersion: 1,
    id: 'preview-profile',
    name: 'Preview profile',
    createdAt: '2026-05-12T00:00:00.000Z',
    updatedAt: '2026-05-12T00:00:00.000Z',
    base: { light: 'light', dark: 'dark' },
    overrides: {
        light: lightOverrides,
        dark: {},
    },
});

function findPreviewCard(screen: Awaited<ReturnType<typeof renderScreen>>): ReactTestInstance {
    return screen.findAllByType('View').find((node) => {
        const style = flattenTestStyle(node.props.style);
        return style.borderRadius === 14 && style.gap === 10;
    }) ?? (() => {
        throw new Error('expected preview card to render');
    })();
}

function hasShadow(style: Record<string, unknown>): boolean {
    return style.boxShadow !== undefined || style.shadowOpacity !== undefined || style.elevation !== undefined;
}

describe('ThemeProfilePreviewPane surface chrome', () => {
    it('does not add border, highlight, or shadow chrome when surface chrome tokens are transparent', async () => {
        const { ThemeProfilePreviewPane } = await import('./ThemeProfilePreviewPane');

        const screen = await renderScreen(React.createElement(ThemeProfilePreviewPane, {
            mode: 'light',
            profile: profile({
                'border.surface': 'transparent',
                'effect.surfaceHighlight': 'transparent',
            }),
        }));

        const style = flattenTestStyle(findPreviewCard(screen).props.style);
        expect(style.borderWidth).toBe(0);
        expect(style.borderTopWidth).toBe(0);
        expect(hasShadow(style)).toBe(false);
    });

    it('lets custom themes opt into visible preview surface chrome', async () => {
        const { ThemeProfilePreviewPane } = await import('./ThemeProfilePreviewPane');

        const screen = await renderScreen(React.createElement(ThemeProfilePreviewPane, {
            mode: 'light',
            profile: profile({
                'border.surface': 'rgba(0,0,0,0.08)',
                'effect.surfaceHighlight': 'rgba(255,255,255,0.04)',
            }),
        }));

        const style = flattenTestStyle(findPreviewCard(screen).props.style);
        expect(style.borderColor).toBe('rgba(0,0,0,0.08)');
        expect(Number(style.borderWidth)).toBeGreaterThan(0);
        expect(style.borderTopColor).toBe('rgba(0,0,0,0.08)');
        expect(Number(style.borderTopWidth)).toBeGreaterThan(0);
        expect(hasShadow(style)).toBe(true);
    });

    it('renders preview status chrome from the draft theme instead of the active app theme', async () => {
        const { ThemeProfilePreviewPane } = await import('./ThemeProfilePreviewPane');

        const screen = await renderScreen(React.createElement(ThemeProfilePreviewPane, {
            mode: 'light',
            profile: profile({
                'state.success.background': 'rgba(1,2,3,0.25)',
                'state.success.border': 'rgba(1,2,3,0.50)',
                'state.success.foreground': '#010203',
            }),
        }));

        const pill = screen.findByTestId('settings-theme-profile-preview-status') ?? (() => {
            throw new Error('expected preview status pill');
        })();
        const label = screen.findByTestId('settings-theme-profile-preview-status:label') ?? (() => {
            throw new Error('expected preview status label');
        })();
        const dot = screen.findByTestId('settings-theme-profile-preview-status:dot') ?? (() => {
            throw new Error('expected preview status dot');
        })();
        const pillStyle = flattenTestStyle(pill.props.style);
        const labelStyle = flattenTestStyle(label.props.style);
        const dotStyle = flattenTestStyle(dot.props.style);

        expect(pillStyle.backgroundColor).toBe('rgba(1,2,3,0.25)');
        expect(pillStyle.borderColor).toBe('rgba(1,2,3,0.50)');
        expect(labelStyle.color).toBe('#010203');
        expect(dotStyle.backgroundColor).toBe('#010203');
    });
});
