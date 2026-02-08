import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';

import baseConfig from './vitest.config';

const base = baseConfig as any;

export default defineConfig({
    define: base.define,
    optimizeDeps: base.optimizeDeps,
    test: {
        ...(base.test ?? {}),
        include: [
            'sources/**/*.integration.test.{ts,tsx}',
            'sources/**/*.real.integration.test.{ts,tsx}',
            'sources/**/*.integration.spec.{ts,tsx}',
            'sources/**/*.e2e.test.{ts,tsx}',
        ],
        exclude: [],
        testTimeout: 60_000,
    },
    resolve: {
        ...(base.resolve ?? {}),
        alias: base.resolve?.alias ?? [
            { find: '@', replacement: resolve('./sources') },
        ],
    },
});
