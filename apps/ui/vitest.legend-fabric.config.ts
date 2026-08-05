import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

import nativeConfig from './vitest.legend-native.config';
import { SHIPPED_NATIVE_LEGEND_INCLUDE_GLOB } from './vitest.integration.config';
import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';

const native = nativeConfig as any;

/**
 * The lane that executes the SHIPPED native path: Legend's native build, `Platform.OS === 'ios'`
 * (or `'android'` via `HAPPIER_LEGEND_NATIVE_OS`), New Architecture ON.
 *
 * Why this is a separate lane rather than a flag inside `vitest.legend-native.config.ts`:
 * `IsNewArchitecture` is captured from `global.nativeFabricUIManager` when the Legend build is
 * evaluated (react-native.mjs:366-367), and `PlatformAdjustBreaksScroll` from `Platform.OS` at the
 * same moment. Both are therefore whole-run decisions, exactly like build resolution is for the
 * lane this extends - a single Vitest run cannot hand one file old architecture and another file
 * new architecture.
 *
 * `vitest.legend-native.config.ts` is left on old architecture on purpose. Its existing assertions
 * were written against `PositionViewAnimated` rows and the `.measure()` layout fallback; flipping it
 * would silently re-interpret all of them. That lane keeps old-architecture native coverage; this
 * one adds the configuration the user actually runs.
 *
 * To write a test here: name the file `*.fabric.native.real.integration.test.tsx` and call
 * `assertShippedNativeLegendRuntime(...)` after the first layout. Nothing else is required - the
 * setup file below owns the environment, so a test file cannot forget to install it.
 *
 * The include glob itself lives in `vitest.integration.config.ts` so the three lane configs stay
 * acyclic.
 */
export default defineConfig({
    ...native,
    test: {
        ...(native.test ?? {}),
        include: [SHIPPED_NATIVE_LEGEND_INCLUDE_GLOB],
        exclude: [...resolveVitestFeatureTestExcludeGlobs()],
        // Appended, not replacing: the shared `sources/dev/vitestSetup.ts` still owns the general
        // test environment. This file only adds the two module-evaluation-time facts, and it must
        // run after the shared setup so the `react-native` stub it mutates is already resolvable.
        setupFiles: [
            ...(native.test?.setupFiles ?? []),
            resolve('./sources/dev/testkit/legend/shippedNativeLegendSetup.ts'),
        ],
    },
});
