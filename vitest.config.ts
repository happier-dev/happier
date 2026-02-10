import { defineConfig } from 'vitest/config'

// Root-level Vitest config is intentionally minimal.
// It exists mainly to prevent accidental test discovery under local/ephemeral
// folders (like `.project/review-worktrees/**`) when someone runs `vitest` from
// the monorepo root.
export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        exclude: ['**/.project/**', '**/node_modules/**', '**/dist/**'],
    },
})

