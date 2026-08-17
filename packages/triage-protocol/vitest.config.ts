import { defineConfig } from 'vitest/config';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export default defineConfig({
    root: dirname(fileURLToPath(import.meta.url)),
    test: {
        include: ['src/**/*.test.ts'],
        globalSetup: ['./vitest.globalSetup.mjs'],
        pool: 'forks',
        maxWorkers: 1,
        minWorkers: 1,
        fileParallelism: false,
    },
});
