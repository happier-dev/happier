import { lightTheme } from '@/theme';

import type { PlainObject } from '../mocks/_shared';
import { mergeObjects } from '../mocks/_shared';

export type TestThemeRuntimeFixture = Readonly<{
    themeName: string;
    colorScheme: 'light' | 'dark';
    breakpoint: string;
    insets: { top: number; right: number; bottom: number; left: number; ime: number };
    screen: { width: number; height: number };
    orientation: 'portrait' | 'landscape';
    fontScale: number;
    pixelRatio: number;
    rtl: boolean;
    statusBar: { height: number };
}>;

export function createThemeFixture(overrides?: PlainObject): PlainObject {
    return mergeObjects(lightTheme as PlainObject, overrides);
}

export function createThemeRuntimeFixture(overrides?: Partial<TestThemeRuntimeFixture>): TestThemeRuntimeFixture {
    return {
        themeName: 'light',
        colorScheme: 'light',
        breakpoint: 'lg',
        insets: { top: 0, right: 0, bottom: 0, left: 0, ime: 0 },
        screen: { width: 1200, height: 800 },
        orientation: 'portrait',
        fontScale: 1,
        pixelRatio: 2,
        rtl: false,
        statusBar: { height: 0 },
        ...(overrides ?? {}),
    };
}
