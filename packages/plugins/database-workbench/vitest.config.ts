import { defineConfig } from 'vitest/config';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';

const root = fileURLToPath(new URL('.', import.meta.url));
const requireUiDependency = createRequire(new URL('../../../apps/ui/package.json', import.meta.url));
// Surface tests load the same React/RNW instances as the UI package's RNW project (inspector's recipe).
const reactNativeWebAliases = [
    { find: /^react$/u, replacement: requireUiDependency.resolve('react') },
    { find: /^react\/jsx-runtime$/u, replacement: requireUiDependency.resolve('react/jsx-runtime') },
    { find: /^react\/jsx-dev-runtime$/u, replacement: requireUiDependency.resolve('react/jsx-dev-runtime') },
    { find: /^react-dom\/client$/u, replacement: requireUiDependency.resolve('react-dom/client') },
    { find: /^react-dom$/u, replacement: requireUiDependency.resolve('react-dom') },
    { find: /^react-native$/u, replacement: requireUiDependency.resolve('react-native-web/dist/index.js') },
    { find: /^react-native-svg$/u, replacement: requireUiDependency.resolve('react-native-svg/lib/module/elements.web.js') },
];
export default defineConfig({
    root,
    resolve: { alias: reactNativeWebAliases, dedupe: ['react', 'react-dom'] },
    plugins: [createWorkspacePackageSourcesPlugin(['databases', 'database-protocol', 'protocol', 'plugin-sdk', 'plugin-ui'].map(name => ({
        packageName: `@happier-dev/${name}`, packageSourceRoot: resolve(root, '../..', name, 'src'),
    })))],
    test: { ...resolveVitestWorkers(), environment: 'node', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
});
