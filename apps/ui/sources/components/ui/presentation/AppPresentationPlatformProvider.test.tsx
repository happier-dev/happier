import * as React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, type ReactTestInstance } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderScreen } from '@/dev/testkit';
import { createLayoutChangeEvent } from '@/dev/testkit/fixtures/nativeEventFixtures';
import { readHitArea } from '@/dev/testkit/harness/hitFrameReach';

const platformState = vi.hoisted(() => ({
    os: 'ios' as 'android' | 'ios' | 'web',
}));

// Lays the pressable out at its drawn size (how the shared owner learns the drawn box), then reads the hit area it publishes.
async function layoutHitArea(read: () => ReactTestInstance | null | undefined, drawn: Readonly<{ width: number; height: number }>) {
    const before = read();
    if (!before || typeof before.props.onLayout !== 'function') throw new Error('The control declares no hit area to measure (no onLayout)');
    await act(async () => { before.props.onLayout(createLayoutChangeEvent({ x: 0, y: 0, ...drawn })); });
    const after = read();
    if (!after) throw new Error('The control unmounted while its hit area was measured');
    return readHitArea(after, drawn);
}

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

vi.mock('@/utils/platform/desktopHost', async (importOriginal) => {
    const { createDesktopHostModuleMock } = await import('@/dev/testkit/mocks/desktopHost');
    return createDesktopHostModuleMock({ importOriginal, overrides: {
    isDesktopHost: () => false,
    } });
});

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
        it(`gives the core IconButton a ${minimum}pt ${platform} touch target as its hit area, not its drawn size`, async () => {
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

            const style = resolvePressableStyle(screen.findByTestId('root-environment-icon-button')?.props.style);
            expect(style.width).toBe(28);
            expect(style.height).toBe(28);

            const area = await layoutHitArea(() => screen.findHostByTestId('root-environment-icon-button'), { width: 28, height: 28 });
            expect(area.width).toBeGreaterThanOrEqual(minimum);
            expect(area.height).toBeGreaterThanOrEqual(minimum);
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

        const style = resolvePressableStyle(screen.findByTestId('root-environment-icon-button')?.props.style);
        expect(style.width).toBe(28);
        expect(style.height).toBe(28);

        // A precise pointer gets no touch reach: the hit area stays the compact drawn square.
        const area = await layoutHitArea(() => screen.findHostByTestId('root-environment-icon-button'), { width: 28, height: 28 });
        expect(area.width).toBe(28);
        expect(area.height).toBe(28);
    });

    it('is mounted once above the boot gate in each independently selected production root', () => {
        const rootLayout = readFileSync(join(process.cwd(), 'sources/app/_layout.tsx'), 'utf8');

        for (const [start, end, boot] of [
            ['EmbedRootLayout', 'EmbedAppBoot', 'EmbedAppBoot'],
            ['FullAppRootLayout', 'AppBoot', 'AppBoot'],
        ]) {
            const root = rootLayout.slice(
                rootLayout.indexOf(`function ${start}()`),
                rootLayout.indexOf(`function ${end}(`),
            );
            expect(root.match(/<AppPresentationPlatformProvider>/g)).toHaveLength(1);
            expect(root).toMatch(new RegExp(
                `<AppPresentationPlatformProvider>(?:(?!</AppPresentationPlatformProvider>)[\\s\\S])*`
                + `<WebCryptoStartupGate>(?:(?!</WebCryptoStartupGate>)[\\s\\S])*<${boot}(?:\\s|/|>)`,
            ));
        }
    });
    it('shares native no-drag admission between routed viewers and floating companions', () => {
        const rootLayout = readFileSync(join(process.cwd(), 'sources/app/_layout.tsx'), 'utf8');
        const runtimeMounts = readFileSync(join(process.cwd(), 'sources/components/appShell/runtime/AuthenticatedAppRuntimeMounts.tsx'), 'utf8');
        expect(/<CompanionNoDragRegionProvider>(?:(?!<\/CompanionNoDragRegionProvider>)[\s\S])*<AppBoot/.test(rootLayout)).toBe(true);
        expect(runtimeMounts.includes('<CompanionNoDragRegionProvider>')).toBe(false);
    });
});
