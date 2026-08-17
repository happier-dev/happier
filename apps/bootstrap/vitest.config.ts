import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { createWorkspacePackageSourcesPlugin } from '../../scripts/testing/vitestWorkspacePackageResolution.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

export default defineConfig({
    plugins: [createWorkspacePackageSourcesPlugin([
        {
            packageName: '@happier-dev/agents',
            packageSourceRoot: resolve(repoRoot, 'packages', 'agents', 'src'),
        },
        {
            packageName: '@happier-dev/cli-common',
            packageSourceRoot: resolve(repoRoot, 'packages', 'cli-common', 'src'),
        },
        {
            packageName: '@happier-dev/protocol',
            packageSourceRoot: resolve(repoRoot, 'packages', 'protocol', 'src'),
        },
        {
            packageName: '@happier-dev/release-runtime',
            packageSourceRoot: resolve(repoRoot, 'packages', 'release-runtime', 'src'),
        },
        {
            packageName: '@happier-dev/tests',
            packageSourceRoot: resolve(repoRoot, 'packages', 'tests', 'src'),
        },
    ], 'happier-bootstrap-workspace-package-sources')],
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts'],
        hookTimeout: 60_000,
        testTimeout: 60_000,
    },
});
