import { createRequire } from 'node:module';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';

import { defineConfig } from 'vitest/config';

import { workspacePackageSourcesPlugin } from '../../../apps/cli/scripts/vitestWorkspacePackageResolution';

const requireUiDependency = createRequire(new URL('../../../apps/ui/package.json', import.meta.url));

// The detail surface is a React Native surface, so its checks must resolve the same React
// and react-native-web instances the UI package's own test project uses. Production
// externalization of those modules is unchanged.
const reactNativeWebAliases = [
  { find: /^react$/u, replacement: requireUiDependency.resolve('react') },
  { find: /^react\/jsx-runtime$/u, replacement: requireUiDependency.resolve('react/jsx-runtime') },
  { find: /^react\/jsx-dev-runtime$/u, replacement: requireUiDependency.resolve('react/jsx-dev-runtime') },
  { find: /^react-dom\/client$/u, replacement: requireUiDependency.resolve('react-dom/client') },
  { find: /^react-dom$/u, replacement: requireUiDependency.resolve('react-dom') },
  { find: /^react-native$/u, replacement: requireUiDependency.resolve('react-native-web/dist/index.js') },
  // Metro selects SVG's web implementation by platform extension; Vite needs the same boundary.
  { find: /^react-native-svg$/u, replacement: requireUiDependency.resolve('react-native-svg/lib/module/elements.web.js') },
];

/** Source-only GitHub checks must not resolve stale copied SDK/Protocol packages. */
export default defineConfig({
  resolve: { alias: reactNativeWebAliases, dedupe: ['react', 'react-dom'] },
  plugins: [workspacePackageSourcesPlugin],
  test: {
    ...resolveVitestWorkers(),
    // Mitigate Vitest 3 fork RPC timeouts until the shared upgrade includes vitest#8297.
    pool: 'threads',
    testTimeout: 60000,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    exclude: ['node_modules/**', 'dist/**'],
    // React's dev/prod CJS build is chosen by NODE_ENV, and only the dev
    // build exports `act`. Pin it so an exported production NODE_ENV in a
    // contributor shell cannot fail every mounted-surface test at once.
    env: { HAPPIER_FEATURE_POLICY_ENV: '', NODE_ENV: 'test' },
  },
});
