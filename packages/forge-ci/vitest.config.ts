import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../scripts/testing/vitestWorkers';
import { createWorkspacePackageSourcesPlugin } from '../../scripts/testing/vitestWorkspacePackageResolution';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, '../..');
const requireUiDependency = createRequire(new URL('../../apps/ui/package.json', import.meta.url));

export default defineConfig({
  root: packageRoot,
  plugins: [createWorkspacePackageSourcesPlugin([
    { packageName: '@happier-dev/forge-ci', packageSourceRoot: resolve(packageRoot, 'src') },
    ...['plugin-sdk', 'plugin-ui', 'protocol', 'deployment-protocol', 'channels-protocol', 'triage-protocol', 'triage-sources', 'cli-common', 'agents', 'brand', 'release-runtime'].map(name => ({
      packageName: `@happier-dev/${name}`, packageSourceRoot: resolve(repoRoot, 'packages', name, 'src'),
    })),
  ])],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^react$/u, replacement: requireUiDependency.resolve('react') },
      { find: /^react\/jsx-runtime$/u, replacement: requireUiDependency.resolve('react/jsx-runtime') },
      { find: /^react\/jsx-dev-runtime$/u, replacement: requireUiDependency.resolve('react/jsx-dev-runtime') },
      { find: /^react-dom\/client$/u, replacement: requireUiDependency.resolve('react-dom/client') },
      { find: /^react-dom$/u, replacement: requireUiDependency.resolve('react-dom') },
      { find: /^react-test-renderer$/u, replacement: requireUiDependency.resolve('react-test-renderer') },
      { find: /^react-native$/u, replacement: requireUiDependency.resolve('react-native-web/dist/index.js') },
      { find: /^react-native-svg$/u, replacement: requireUiDependency.resolve('react-native-svg/lib/module/elements.web.js') },
    ],
  },
  test: {
    ...resolveVitestWorkers(), environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'], exclude: ['node_modules/**', 'dist/**'],
    env: { NODE_ENV: 'test' },
  },
});
