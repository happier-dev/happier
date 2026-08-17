import { defineConfig } from 'vitest/config';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    createWorkspacePackageSourcesPlugin,
    type WorkspacePackageSpec,
} from '../../scripts/testing/vitestWorkspacePackageResolution';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, '../..');

const workspacePackages: readonly WorkspacePackageSpec[] = [
    {
        packageName: '@happier-dev/plugin-sdk',
        packageSourceRoot: resolve(repoRoot, 'packages/plugin-sdk/src'),
    },
    {
        packageName: '@happier-dev/protocol',
        packageSourceRoot: resolve(repoRoot, 'packages/protocol/src'),
    },
];

export default defineConfig({
    root: packageRoot,
    plugins: [createWorkspacePackageSourcesPlugin(workspacePackages)],
    test: {
        include: ['src/**/*.test.ts'],
        pool: 'forks',
        maxWorkers: 1,
        minWorkers: 1,
        fileParallelism: false,
    },
});
