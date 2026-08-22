import * as React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';

const platformState = vi.hoisted(() => ({
    os: 'ios' as 'android' | 'ios' | 'web',
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    const reactNative = await createReactNativeWebMock();

    return {
        ...reactNative,
        Platform: {
            ...reactNative.Platform,
            get OS() {
                return platformState.os;
            },
            select: <T,>(options: Readonly<{ android?: T; ios?: T; native?: T; web?: T; default?: T }>) => (
                options[platformState.os] ?? options.native ?? options.default
            ),
        },
    };
});

vi.mock('@/utils/platform/desktopHost', () => ({
    isDesktopHost: () => false,
}));

import { IconButton } from '../buttons/IconButton';
import { AppPresentationPlatformProvider } from './AppPresentationPlatformProvider';

function flattenStyle(style: unknown): Record<string, unknown> {
    if (Array.isArray(style)) {
        return Object.assign({}, ...style.map(flattenStyle));
    }
    return style && typeof style === 'object' ? style as Record<string, unknown> : {};
}

function resolvePressableStyle(style: unknown): Record<string, unknown> {
    return flattenStyle(typeof style === 'function'
        ? style({
            pressed: false,
            hovered: false,
            focused: false,
            selected: false,
            busy: false,
            disabled: false,
        })
        : style);
}

afterEach(() => {
    platformState.os = 'ios';
});

describe('AppPresentationPlatformProvider', () => {
    for (const [platform, minimum] of [
        ['android', 48],
        ['ios', 44],
    ] as const) {
        it(`gives the core IconButton a ${minimum}pt physical ${platform} target without hit slop`, async () => {
            platformState.os = platform;

            const screen = await renderScreen(
                <AppPresentationPlatformProvider>
                    <IconButton
                        testID="root-environment-icon-button"
                        iconName="copy"
                        accessibilityLabel="Copy address"
                        onPress={() => undefined}
                    />
                </AppPresentationPlatformProvider>,
            );

            const pressable = screen.findByTestId('root-environment-icon-button');
            const style = resolvePressableStyle(pressable?.props.style);

            expect(style.minWidth).toBeGreaterThanOrEqual(minimum);
            expect(style.minHeight).toBeGreaterThanOrEqual(minimum);
            expect(pressable?.props.hitSlop).toBeUndefined();
        });
    }

    it('keeps the core IconButton compact on the web pointer layout', async () => {
        platformState.os = 'web';

        const screen = await renderScreen(
            <AppPresentationPlatformProvider>
                <IconButton
                    testID="root-environment-icon-button"
                    iconName="copy"
                    accessibilityLabel="Copy address"
                    onPress={() => undefined}
                />
            </AppPresentationPlatformProvider>,
        );

        const pressable = screen.findByTestId('root-environment-icon-button');
        const style = resolvePressableStyle(pressable?.props.style);

        expect(style.width).toBe(28);
        expect(style.height).toBe(28);
        expect(pressable?.props.hitSlop).toBe(8);
    });

    it('is mounted once above the production root boot gate', () => {
        const rootLayout = readFileSync(join(process.cwd(), 'sources/app/_layout.tsx'), 'utf8');

        expect(rootLayout.match(/<AppPresentationPlatformProvider>/g)).toHaveLength(1);
        expect(rootLayout).toMatch(
            /<AppPresentationPlatformProvider>[\s\S]*<WebCryptoStartupGate>[\s\S]*<AppBoot/,
        );
    });
});
