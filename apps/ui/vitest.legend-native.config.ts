import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

import integrationConfig, {
    NATIVE_LEGEND_INTEGRATION_INCLUDE_GLOB,
    SHIPPED_NATIVE_LEGEND_INCLUDE_GLOB,
} from './vitest.integration.config';
import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';

const integration = integrationConfig as any;

/**
 * The integration lane for harnesses that must exercise Legend's NATIVE build.
 *
 * Everything is inherited from `vitest.integration.config.ts` except the two decisions this lane
 * exists to make - which package artifact `@legendapp/list/react-native` resolves to, and which
 * files run. Both are set explicitly rather than through `mergeConfig`, whose array concatenation
 * would append this lane's `include` to the shared globs (running the whole integration suite under
 * native resolution) and append the shared `exclude` - which now excludes exactly this lane's glob -
 * leaving the config with nothing to run.
 */
export default defineConfig({
    ...integration,
    test: {
        ...(integration.test ?? {}),
        include: [NATIVE_LEGEND_INTEGRATION_INCLUDE_GLOB],
        exclude: [
            ...resolveVitestFeatureTestExcludeGlobs(),
            // `foo.fabric.native.real.integration.test.tsx` also matches this lane's glob, and this
            // lane runs Legend on OLD architecture. Left in, those files would report green while
            // exercising `PositionViewAnimated` - the exact false-green this program was burned by.
            // `vitest.legend-fabric.config.ts` owns them.
            SHIPPED_NATIVE_LEGEND_INCLUDE_GLOB,
        ],
        server: {
            ...(integration.test?.server ?? {}),
            deps: {
                ...(integration.test?.server?.deps ?? {}),
                inline: [
                    ...(integration.test?.server?.deps?.inline ?? []),
                    // Restated rather than only inherited: the native artifact imports
                    // `react-native`, so it must be transformed by Vite for the node-safe
                    // `react-native` alias to apply. Externalized, Node loads it raw and the
                    // import fails outright - this lane cannot run without it.
                    /@legendapp\/list/,
                ],
            },
        },
    },
    resolve: {
        ...(integration.resolve ?? {}),
        // Ahead of the inherited aliases so the package specifier the product itself imports is
        // pinned to the installed native artifact. Aliasing the specifier (rather than having tests
        // reach into `node_modules/.../react-native.mjs` by relative path) keeps the harness on the
        // same import the app uses, so it still fails if that import mapping ever changes.
        alias: [
            {
                find: '@legendapp/list/react-native',
                replacement: resolve('./node_modules/@legendapp/list/react-native.mjs'),
            },
            ...(integration.resolve?.alias ?? []),
        ],
    },
});
