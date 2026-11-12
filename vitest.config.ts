import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

import { resolveVitestFeatureTestExcludeGlobs } from './scripts/testing/featureTestGating.ts'
import { resolveVitestWorkers } from './scripts/testing/vitestWorkers.ts'
import { createWorkspacePackageSourcesPlugin, readHostWorkspacePackageSpecs } from './scripts/testing/vitestWorkspacePackageResolution.ts'

const repoRoot = fileURLToPath(new URL('.', import.meta.url))
const protocolRoot = fileURLToPath(new URL('./packages/protocol/', import.meta.url))
const workspacePackages = readHostWorkspacePackageSpecs(repoRoot, protocolRoot, ['protocol', 'cli-common'].map(name => ({
    packageName: `@happier-dev/${name}`,
    packageSourceRoot: fileURLToPath(new URL(`./packages/${name}/src`, import.meta.url)),
})))

// Root-level Vitest config is intentionally minimal.
// It serves package suites such as protocol and prevents accidental discovery
// under local/ephemeral folders when Vitest runs from the monorepo root.
export default defineConfig({
    plugins: [createWorkspacePackageSourcesPlugin(workspacePackages, 'happier-root-workspace-package-sources')],
    test: {
        ...resolveVitestWorkers(),
        globals: false,
        environment: 'node',
        setupFiles: [fileURLToPath(new URL('./packages/protocol/src/test/zodLocaleSetup.ts', import.meta.url))],
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
