import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import {
    createWorkspacePackageSourcesPlugin,
    type WorkspacePackageSpec,
} from '../../../scripts/testing/vitestWorkspacePackageResolution';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, '../../..');

/**
 * The PostHog source binds to current workspace source of the SDK, the shared Triage
 * protocol, the canonical Protocol package and the Plugin UI package rather than to a
 * previously built copy of any of them. A stale nested copy of Protocol is what makes a
 * manifest that parses in production fail here for reasons the source never caused.
 */
const workspacePackages: readonly WorkspacePackageSpec[] = [
    {
        packageName: '@happier-dev/plugin-sdk',
        packageSourceRoot: resolve(repoRoot, 'packages/plugin-sdk/src'),
    },
    {
        packageName: '@happier-dev/protocol',
        packageSourceRoot: resolve(repoRoot, 'packages/protocol/src'),
    },
    {
        packageName: '@happier-dev/plugin-ui',
        packageSourceRoot: resolve(repoRoot, 'packages/plugin-ui/src'),
    },
    {
        packageName: '@happier-dev/triage-protocol',
        packageSourceRoot: resolve(repoRoot, 'packages/triage-protocol/src'),
    },
];

/**
 * The detail surface's React imports resolve to the same React and React Native Web
 * instances the UI package's own mounted tests use. Production externalization is
 * unchanged: the packed artifact still takes React from the host runtime.
 */
const reactNativeWebAliases = [
    { find: /^react$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react/index.js') },
    { find: /^react\/jsx-runtime$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react/jsx-runtime.js') },
    { find: /^react\/jsx-dev-runtime$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react/jsx-dev-runtime.js') },
    { find: /^react-dom\/client$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react-dom/client.js') },
    { find: /^react-dom$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react-dom/index.js') },
    { find: /^react-native$/u, replacement: resolve(repoRoot, 'apps/ui/node_modules/react-native-web/dist/index.js') },
];

/** Source-only PostHog checks run against this package's real parsers and mappers. */
export default defineConfig({
    resolve: { alias: reactNativeWebAliases, dedupe: ['react', 'react-dom'] },
    plugins: [createWorkspacePackageSourcesPlugin(workspacePackages)],
    test: {
        environment: 'node',
        include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
        exclude: ['node_modules/**', 'dist/**'],
    },
});
