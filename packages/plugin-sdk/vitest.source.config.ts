import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

import {
    createWorkspacePackageSourcesPlugin,
    type WorkspacePackageSpec,
} from '../../scripts/testing/vitestWorkspacePackageResolution.ts';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const workspacePackages: readonly WorkspacePackageSpec[] = [
    {
        packageName: '@happier-dev/plugin-sdk',
        packageSourceRoot: resolve(packageRoot, 'src'),
    },
    {
        packageName: '@happier-dev/protocol',
        packageSourceRoot: resolve(packageRoot, '../protocol/src'),
    },
    {
        packageName: '@happier-dev/cli-common',
        packageSourceRoot: resolve(packageRoot, '../cli-common/src'),
    },
] as const;

/**
 * Source-level Protocol/SDK tests must exercise the current normalizer rather
 * than a vendored package copy. Package-boundary tests retain their explicit
 * built-copy lanes.
 *
 * `@happier-dev/cli-common` is listed for the same reason and needs it more: this package
 * deliberately resolves the private physical copies under its own `node_modules` (see
 * `scripts/bundleWorkspaceDeps.mjs`), so without this a source test would silently exercise
 * whatever cli-common snapshot the last bundle produced rather than the owner it imports.
 */
export default defineConfig({
    plugins: [createWorkspacePackageSourcesPlugin(
        workspacePackages,
        'happier-plugin-sdk-source-workspace-package-sources',
    )],
    test: {
        env: {
            HAPPIER_PLUGIN_SDK_SOURCE_ONLY: '1',
        },
        exclude: [
            ...configDefaults.exclude,
            'scripts/*.test.mjs',
            'examples/**/test/*.test.mjs',
        ],
        server: {
            deps: {
                // Source-level SDK tests must transform Protocol and the SDK
                // through Vite so the aliases below win over stale workspace
                // dist copies.
                inline: [
                    /^@happier-dev\/plugin-sdk(?:\/|$)/,
                    /^@happier-dev\/protocol(?:\/|$)/,
                ],
            },
        },
    },
});
