import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

import baseConfig from './vitest.config';
import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';

const base = baseConfig as any;

export default defineConfig({
    define: base.define,
    optimizeDeps: base.optimizeDeps,
    test: {
        ...(base.test ?? {}),
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
        exclude: [...resolveVitestFeatureTestExcludeGlobs()],
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
