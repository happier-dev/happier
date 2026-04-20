import { resolve } from 'node:path';

import { defineConfig } from 'vitest/config';

import { resolveVitestFeatureTestExcludeGlobs } from '../../scripts/testing/featureTestGating';
import {
    createWorkspacePackageSourcesPlugin,
    type WorkspacePackageSpec,
} from '../../scripts/testing/vitestWorkspacePackageResolution';

const workspacePackages: readonly WorkspacePackageSpec[] = [
    {
        packageName: '@happier-dev/protocol',
        packageSourceRoot: resolve('../../packages/protocol/src'),
    },
    {
        packageName: '@happier-dev/agents',
        packageSourceRoot: resolve('../../packages/agents/src'),
    },
] as const;

export default defineConfig({
    test: {
        globals: false,
        environment: 'node',
        env: {
            HAPPIER_FEATURE_POLICY_ENV: '',
        },
        include: [
            'src/**/*.{spec,test}.ts',
            'src/**/*.{spec,test}.tsx',
        ],
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
    plugins: [
        createWorkspacePackageSourcesPlugin(workspacePackages),
    ],
});
