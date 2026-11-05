import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';

const requireUiDependency = createRequire(new URL('../../../apps/ui/package.json', import.meta.url));

const root = dirname(fileURLToPath(import.meta.url));
const repo = resolve(root, '../../..');
// The native setup renderer mounts through react-native-web against current workspace source.
export default defineConfig({
    root,
    resolve: { alias: [
        { find: /^react$/u, replacement: requireUiDependency.resolve('react') },
        { find: /^react\/jsx-runtime$/u, replacement: requireUiDependency.resolve('react/jsx-runtime') },
        { find: /^react\/jsx-dev-runtime$/u, replacement: requireUiDependency.resolve('react/jsx-dev-runtime') },
        { find: /^react-dom\/client$/u, replacement: requireUiDependency.resolve('react-dom/client') },
        { find: /^react-dom$/u, replacement: requireUiDependency.resolve('react-dom') },
        { find: /^react-native$/u, replacement: requireUiDependency.resolve('react-native-web/dist/index.js') },
        { find: /^react-native-svg$/u, replacement: requireUiDependency.resolve('react-native-svg/lib/module/elements.web.js') },
    ], dedupe: ['react', 'react-dom'] },
    plugins: [createWorkspacePackageSourcesPlugin(['plugin-sdk', 'protocol', 'plugin-ui'].map(name => ({
        packageName: `@happier-dev/${name}`, packageSourceRoot: resolve(repo, `packages/${name}/src`),
    })))],
    test: { ...resolveVitestWorkers(), environment: 'node', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
});
