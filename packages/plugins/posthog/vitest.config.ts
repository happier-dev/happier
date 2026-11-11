import { createRequire } from 'node:module';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';

import { defineConfig } from 'vitest/config';

import { workspacePackageSourcesPlugin } from '../../../apps/cli/scripts/vitestWorkspacePackageResolution';

const requireUiDependency = createRequire(new URL('../../../apps/ui/package.json', import.meta.url));

/**
 * The PostHog source binds to current workspace source of the SDK, the shared Triage
 * source adapter, the shared Triage protocol, the canonical Protocol package and the
 * Plugin UI package rather than to a previously built copy of any of them. A stale nested copy of Protocol is what makes a
 * manifest that parses in production fail here for reasons the source never caused.
 */

/**
 * The detail surface's React imports resolve to the same React and React Native Web
 * instances the UI package's own mounted tests use. Production externalization is
 * unchanged: the packed artifact still takes React from the host runtime.
 */
const reactNativeWebAliases = [
    { find: /^react$/u, replacement: requireUiDependency.resolve('react') },
    { find: /^react\/jsx-runtime$/u, replacement: requireUiDependency.resolve('react/jsx-runtime') },
    { find: /^react\/jsx-dev-runtime$/u, replacement: requireUiDependency.resolve('react/jsx-dev-runtime') },
    { find: /^react-dom\/client$/u, replacement: requireUiDependency.resolve('react-dom/client') },
    { find: /^react-dom$/u, replacement: requireUiDependency.resolve('react-dom') },
    { find: /^react-native$/u, replacement: requireUiDependency.resolve('react-native-web/dist/index.js') },
    // Match the canonical plugin-ui RNW platform boundary; Vite does not select .web files.
    { find: /^react-native-svg$/u, replacement: requireUiDependency.resolve('react-native-svg/lib/module/elements.web.js') },
];

/** Source-only PostHog checks run against this package's real parsers and mappers. */
export default defineConfig({
    resolve: { alias: reactNativeWebAliases, dedupe: ['react', 'react-dom'] },
    plugins: [workspacePackageSourcesPlugin],
    test: {
        ...resolveVitestWorkers(),
        testTimeout: 15000,
        environment: 'node',
        include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
        exclude: ['node_modules/**', 'dist/**'],
    },
});
