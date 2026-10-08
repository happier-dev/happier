import { resolveVitestWorkers } from '../../scripts/testing/vitestWorkers.ts';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configDefaults, defineConfig } from 'vitest/config';

import {
    createWorkspacePackageSourcesPlugin,
    type WorkspacePackageSpec,
} from '../../scripts/testing/vitestWorkspacePackageResolution.ts';
import { ISOLATED_EXAMPLE_BUILD_ROOT } from './scripts/buildExampleProjects.mjs';
import { PLUGIN_SDK_AUTHORED_TEST_INCLUDE } from './vitest.config.ts';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const workspacePackages: readonly WorkspacePackageSpec[] = [
    {
        packageName: '@happier-dev/plugin-sdk',
        packageSourceRoot: resolve(packageRoot, 'src'),
    },
    {
        packageName: '@happier-dev/agents',
        packageSourceRoot: resolve(packageRoot, '../agents/src'),
    },
    {
        packageName: '@happier-dev/protocol',
        packageSourceRoot: resolve(packageRoot, '../protocol/src'),
    },
    {
        packageName: '@happier-dev/cli-common',
        packageSourceRoot: resolve(packageRoot, '../cli-common/src'),
    },
    {
        packageName: '@happier-dev/triage-protocol',
        packageSourceRoot: resolve(packageRoot, '../triage-protocol/src'),
    },
] as const;

/**
 * Source-level Protocol/SDK/Agent tests must exercise the current normalizer
 * rather than a vendored package copy. In particular, Agent re-exports must
 * share Protocol's runtime identity with the SDK's direct projection.
 * Package-boundary tests retain their explicit built-copy lanes.
 *
 * `@happier-dev/cli-common` is listed for the same reason and needs it more: this package
 * deliberately resolves the private physical copies under its own `node_modules` (see
 * `scripts/bundleWorkspaceDeps.mjs`), so without this a source test would silently exercise
 * whatever cli-common snapshot the last bundle produced rather than the owner it imports.
 * Triage's feature protocol is likewise resolved here so source-authoring fixtures do not
 * install a file-local mock for another workspace's real public entrypoint.
 */
export default defineConfig({
    plugins: [createWorkspacePackageSourcesPlugin(
        workspacePackages,
        'happier-plugin-sdk-source-workspace-package-sources',
    )],
    test: {
        ...resolveVitestWorkers(),
        // Keep source validation rooted at the authored tree. Prepared API
        // publishers intentionally create complete package-local `.tmp.*`
        // copies, and a concurrent copy must never become a second test tree.
        include: [...PLUGIN_SDK_AUTHORED_TEST_INCLUDE],
        env: {
            HAPPIER_PLUGIN_SDK_SOURCE_ONLY: '1',
        },
        exclude: [
            ...configDefaults.exclude,
            'scripts/*.test.mjs',
            'examples/**/test/*.test.mjs',
            // The example build lane copies each tracked example — its
            // `test/index.test.mjs` included — into this package-owned build
            // root. Those copies are `node --test` suites owned by the adjacent
            // lane, so Vitest must not collect them here: it reports every copy
            // as a file with no suites. The root name has one owner, so read it
            // from the builder rather than respelling it.
            `${ISOLATED_EXAMPLE_BUILD_ROOT}/**`,
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
