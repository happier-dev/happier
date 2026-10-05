import { resolveVitestWorkers } from '../../scripts/testing/vitestWorkers';
import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        ...resolveVitestWorkers(),
        globals: false,
        environment: 'node',
        exclude: ['**/node_modules/**', '**/dist/**'],
    },
})
