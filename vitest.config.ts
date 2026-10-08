import { defineConfig } from 'vitest/config'

import { resolveVitestFeatureTestExcludeGlobs } from './scripts/testing/featureTestGating.ts'
import { resolveVitestWorkers } from './scripts/testing/vitestWorkers.ts'

// Root-level Vitest config is intentionally minimal.
// It exists mainly to prevent accidental test discovery under local/ephemeral
// folders (like `.project/review-worktrees/**`) when someone runs `vitest` from
// the monorepo root.
export default defineConfig({
    test: {
        ...resolveVitestWorkers(),
        globals: false,
        environment: 'node',
        env: {
            HAPPIER_FEATURE_POLICY_ENV: '',
        },
        exclude: [
            '**/.project/**',
            '**/.worktrees/**',
            '**/.dev/**',
            '**/output/**',
            '**/node_modules/**',
            '**/dist/**',
            ...resolveVitestFeatureTestExcludeGlobs(),
        ],
    },
})
