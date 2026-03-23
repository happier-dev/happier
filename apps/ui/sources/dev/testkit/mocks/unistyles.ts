import type { PlainObject } from './_shared';
import { mergeObjects } from './_shared';
import { createThemeFixture, createThemeRuntimeFixture, type TestThemeRuntimeFixture } from '../fixtures/themeFixtures';

export type TestUnistylesOverrides = Readonly<{
    theme?: PlainObject;
    rt?: Partial<TestThemeRuntimeFixture>;
    runtime?: PlainObject;
}>;

export async function createUnistylesMock(overrides?: TestUnistylesOverrides) {
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

    return {
        useUnistyles: () => ({ theme, rt }),
        StyleSheet: {
            create: (input: unknown) =>
                typeof input === 'function'
                    ? (input as (theme: unknown, runtime: unknown) => unknown)(theme, rt)
                    : input,
            configure: () => {},
            absoluteFillObject: {},
        },
        UnistylesRuntime: runtimeModule,
    };
}

export function installUnistylesMock(overrides?: TestUnistylesOverrides) {
    return async () => createUnistylesMock(overrides);
}
