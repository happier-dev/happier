import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
    root: dirname(fileURLToPath(import.meta.url)),
    test: {
        include: ['src/**/*.test.ts'],
        pool: 'forks',
        maxWorkers: 1,
        minWorkers: 1,
        fileParallelism: false,
    },
});
