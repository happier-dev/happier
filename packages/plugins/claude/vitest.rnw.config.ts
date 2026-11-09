import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';

const requireUiDependency = createRequire(new URL('../../../apps/ui/package.json', import.meta.url));
const repoRoot = resolve(__dirname, '../../..');

// The public semantic adapter mounts real RNW with the same React instance as React DOM.
export default defineConfig({
  root: __dirname,
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^react$/u, replacement: requireUiDependency.resolve('react') },
      { find: /^react\/jsx-runtime$/u, replacement: requireUiDependency.resolve('react/jsx-runtime') },
      { find: /^react\/jsx-dev-runtime$/u, replacement: requireUiDependency.resolve('react/jsx-dev-runtime') },
      { find: /^react-dom\/client$/u, replacement: requireUiDependency.resolve('react-dom/client') },
      { find: /^react-dom$/u, replacement: requireUiDependency.resolve('react-dom') },
      { find: /^react-native$/u, replacement: requireUiDependency.resolve('react-native-web/dist/index.js') },
      { find: /^react-native-svg$/u, replacement: requireUiDependency.resolve('react-native-svg/lib/module/elements.web.js') },
    ],
  },
  plugins: [createWorkspacePackageSourcesPlugin([
    { packageName: '@happier-dev/deployment-protocol', packageSourceRoot: resolve(repoRoot, 'packages/deployment-protocol/src') },
    { packageName: '@happier-dev/protocol', packageSourceRoot: resolve(repoRoot, 'packages/protocol/src') },
    { packageName: '@happier-dev/agents', packageSourceRoot: resolve(repoRoot, 'packages/agents/src') },
    { packageName: '@happier-dev/cli-common', packageSourceRoot: resolve(repoRoot, 'packages/cli-common/src') },
    { packageName: '@happier-dev/triage-protocol', packageSourceRoot: resolve(repoRoot, 'packages/triage-protocol/src') },
    { packageName: '@happier-dev/plugin-sdk', packageSourceRoot: resolve(repoRoot, 'packages/plugin-sdk/src') },
    { packageName: '@happier-dev/plugin-ui', packageSourceRoot: resolve(repoRoot, 'packages/plugin-ui/src') },
  ])],
  test: {
    ...resolveVitestWorkers(),
    environment: 'jsdom',
    include: ['src/**/*.rnw.test.tsx'],
    exclude: ['node_modules/**', 'dist/**'],
    env: { NODE_ENV: 'development' },
  },
});
