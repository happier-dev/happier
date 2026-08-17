import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

const APP_ROOT = resolve(import.meta.dirname, '../..');
const PRESENTATION_ROOT = resolve(APP_ROOT, '../../packages/plugin-ui/src/presentation');

/**
 * The Unistyles Babel plugin is the only thing that turns a `react-native` host
 * import into the Unistyles component factory, and it only does so for files it
 * is configured to process. Happier core styles every surface with Unistyles
 * entries, whose values are defined NON-ENUMERABLE on web
 * (`removeInlineStyles`) precisely because the factory is expected to convert
 * them into a class name. A raw `react-native(-web)` component therefore reads
 * zero style properties and renders the platform default — which is what an
 * unprocessed shared primitive did to every dropdown, list row and label.
 *
 * The shared presentation primitives live outside `root: 'sources'`, so the app
 * config has to opt their folder in. This test asserts the resulting behaviour
 * (what Babel actually emits), not the option value, and includes a control
 * transform proving the assertion can fail.
 */
const HOST_COMPONENTS_BY_FILE: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['text/Text.tsx', ['Text']],
    ['status/Status.tsx', ['View']],
    ['status/StatusDot.tsx', ['View', 'Animated']],
    ['state/InfoState.tsx', ['View']],
    ['feedback/Spinner.tsx', ['View', 'ActivityIndicator']],
    ['interaction/Pressable.tsx', ['View', 'Pressable']],
    ['layout/Surface.tsx', ['View']],
    ['layout/Layout.tsx', ['View', 'ScrollView']],
    ['collection/List.tsx', ['View']],
];

/**
 * The Unistyles Babel plugin disables itself entirely when `NODE_ENV === 'test'`
 * (`plugin/src/index.ts` returns an empty visitor), which is exactly the
 * environment Vitest runs in — and the reason no existing unit test could see
 * this contract. Transform under the production bundler environment instead:
 * development output cannot close UI-PRES-REQ-07's production-transform gate.
 */
function withProductionBundlerNodeEnv<T>(run: () => T): T {
  const previous = process.env.NODE_ENV;
  Reflect.set(process.env, 'NODE_ENV', 'production');
    try {
        return run();
    } finally {
        if (previous === undefined) Reflect.deleteProperty(process.env, 'NODE_ENV');
        else Reflect.set(process.env, 'NODE_ENV', previous);
    }
}

function transformWithAppBabelConfig(
    relativePath: string,
    options?: Readonly<{ withoutAppConfig?: boolean }>,
): string {
    const babel = require('@babel/core') as typeof import('@babel/core');
    const filename = resolve(PRESENTATION_ROOT, relativePath);

    const result = withProductionBundlerNodeEnv(() => babel.transformSync(readFileSync(filename, 'utf8'), {
        filename,
        root: APP_ROOT,
        babelrc: false,
        cloneInputAst: false,
        envName: 'production',
        caller: { name: 'metro', platform: 'web', isDev: false, supportsStaticESM: false } as never,
        ...(options?.withoutAppConfig
            // The control: `root: 'sources'` alone, which is what the app used
            // before the shared primitives moved out of `apps/ui/sources`.
            ? {
                configFile: false as const,
                presets: ['babel-preset-expo'],
                plugins: [['react-native-unistyles/plugin', { root: 'sources' }]],
            }
            : { configFile: resolve(APP_ROOT, 'babel.config.js') }),
    }));

    return result?.code ?? '';
}

describe('babel.config.js — Unistyles host components for shared presentation primitives', () => {
    for (const [relativePath, hostComponents] of HOST_COMPONENTS_BY_FILE) {
        it(`rewrites ${relativePath} to the Unistyles component factories`, () => {
            const code = transformWithAppBabelConfig(relativePath);

            for (const hostComponent of hostComponents) {
                expect(
                    code,
                    `${relativePath} must render the Unistyles ${hostComponent}, otherwise every `
                    + 'Unistyles style handed to it is silently dropped',
                ).toContain(`react-native-unistyles/components/native/${hostComponent}`);
            }
        });
    }

    it('would not rewrite them under `root` alone, so the assertions above discriminate', () => {
        const code = transformWithAppBabelConfig('text/Text.tsx', { withoutAppConfig: true });

        expect(code).not.toContain('react-native-unistyles/components/native/Text');
    });
});
