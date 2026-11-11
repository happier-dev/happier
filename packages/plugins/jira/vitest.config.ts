import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { workspacePackageSourcesPlugin } from '../../../apps/cli/scripts/vitestWorkspacePackageResolution';

const requireUiDependency = createRequire(new URL('../../../apps/ui/package.json', import.meta.url));

const root = dirname(fileURLToPath(import.meta.url));
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
    plugins: [workspacePackageSourcesPlugin],
    test: { ...resolveVitestWorkers(), environment: 'node', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
});
