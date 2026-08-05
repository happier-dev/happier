import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

import baseConfig from './vitest.config';
import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';

const base = baseConfig as any;

/**
 * Harnesses that must run against Legend's NATIVE build.
 *
 * `@legendapp/list/react-native` publishes conditional exports whose `react-native` condition is
 * only selected by Metro. Under Node/Vite resolution the subpath falls through to
 * `./react-native.web.mjs`, so anything importing the package specifier here silently mounts the
 * DOM implementation. Selecting the build is a whole-run resolution decision - one Vite server
 * cannot hand the web harnesses the web artifact and the native harnesses the native one - so this
 * config disowns the native glob and `vitest.legend-native.config.ts` owns it instead.
 */
export const NATIVE_LEGEND_INTEGRATION_INCLUDE_GLOB = 'sources/**/*.native.real.integration.test.{ts,tsx}';

/**
 * Harnesses that must run the SHIPPED native path: the native build AND `Platform.OS === 'ios'`
 * AND New Architecture ON. Owned by `vitest.legend-fabric.config.ts`.
 *
 * Declared here, next to the glob it deliberately overlaps, because both lane configs need it and
 * importing it across them would make the two configs cyclic. Note the overlap is intentional: this
 * pattern also matches `NATIVE_LEGEND_INTEGRATION_INCLUDE_GLOB`, so the exclusion already written
 * below keeps these files out of the web-resolving run, and the native lane excludes them too.
 */
export const SHIPPED_NATIVE_LEGEND_INCLUDE_GLOB = 'sources/**/*.fabric.native.real.integration.test.{ts,tsx}';

export default defineConfig({
    define: base.define,
    optimizeDeps: base.optimizeDeps,
    plugins: base.plugins,
    test: {
        ...(base.test ?? {}),
        server: {
            ...(base.test?.server ?? {}),
            deps: {
                ...(base.test?.server?.deps ?? {}),
                // The native applied-source guard imports Legend's native ESM artifact directly;
                // inline it so Vite can route its react-native imports through the node-safe alias.
                inline: [
                    ...(base.test?.server?.deps?.inline ?? []),
                    /@legendapp\/list/,
                ],
            },
        },
        // Integration tests are relatively few but heavy. Running them in a single thread is
        // more stable than the default multi-process fork pool under long-running SCM tests.
        pool: 'threads',
        poolOptions: {
            ...(base.test?.poolOptions ?? {}),
            threads: {
                ...(base.test?.poolOptions?.threads ?? {}),
                singleThread: true,
            },
        },
        include: [
            'sources/**/*.integration.test.{ts,tsx}',
            'sources/**/*.real.integration.test.{ts,tsx}',
            'sources/**/*.integration.spec.{ts,tsx}',
            'sources/**/*.e2e.test.{ts,tsx}',
        ],
        exclude: [
            ...resolveVitestFeatureTestExcludeGlobs(),
            // Owned by `vitest.legend-native.config.ts` (see the glob's docs above). Left in this
            // run, a native harness that imports the package specifier resolves Legend's web build
            // and fails in `commitLayoutEffects` with `target.addEventListener is not a function` -
            // a resolution error wearing a red badge.
            NATIVE_LEGEND_INTEGRATION_INCLUDE_GLOB,
        ],
        testTimeout: 120_000,
        hookTimeout: 120_000,
    },
    resolve: {
        ...(base.resolve ?? {}),
        alias: base.resolve?.alias ?? [
            { find: '@', replacement: resolve('./sources') },
        ],
    },
});
