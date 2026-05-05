import { createThemeFixture, createThemeRuntimeFixture, type TestThemeRuntimeFixture } from '../fixtures/themeFixtures';
import type { PlainObject } from './_shared';
import { mergeObjects } from './_shared';

export type TestUnistylesRuntimeOverrides = Readonly<{
    theme?: PlainObject;
    rt?: Partial<TestThemeRuntimeFixture>;
    runtime?: PlainObject;
    styleSheet?: PlainObject;
}>;

function flattenStyle(style: unknown): Record<string, unknown> {
    if (!style) return {};
    if (Array.isArray(style)) {
        const out: Record<string, unknown> = {};
        for (const entry of style) {
            Object.assign(out, flattenStyle(entry));
        }
        return out;
    }
    if (typeof style === 'object') {
        return style as Record<string, unknown>;
    }
    return {};
}

export async function createUnistylesRuntime(overrides?: TestUnistylesRuntimeOverrides) {
    const theme = createThemeFixture(overrides?.theme);
    const rt = createThemeRuntimeFixture(overrides?.rt);
    const runtimeModule = mergeObjects(
        {
            setAdaptiveThemes: (..._args: unknown[]) => {},
            setTheme: (..._args: unknown[]) => {},
            setRootViewBackgroundColor: (..._args: unknown[]) => {},
        },
        overrides?.runtime,
    );
    const styleSheetModule = mergeObjects(
        {
            create: (input: unknown) =>
                typeof input === 'function'
                    ? (input as (theme: unknown, runtime: unknown) => unknown)(theme, rt)
                    : input,
            flatten: (value: unknown) => {
                if (Array.isArray(value) || (value && typeof value === 'object')) {
                    return flattenStyle(value);
                }
                return value;
            },
            configure: () => {},
            absoluteFillObject: {},
        },
        overrides?.styleSheet,
    );

    return {
        useUnistyles: () => ({ theme, rt }),
        StyleSheet: styleSheetModule,
        UnistylesRuntime: runtimeModule,
    };
}

export function installUnistylesRuntime(overrides?: TestUnistylesRuntimeOverrides) {
    return async () => createUnistylesRuntime(overrides);
}
