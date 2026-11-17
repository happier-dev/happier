import { createRequire } from 'node:module';
import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';

const requireUiDependency = createRequire(new URL('../../../apps/ui/package.json', import.meta.url));

// Mounted RNW surface tests resolve the same React/RNW instances as the UI package's own test project.
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
 root: import.meta.dirname,
 resolve: { alias: reactNativeWebAliases, dedupe: ['react', 'react-dom'] },
 plugins: [createWorkspacePackageSourcesPlugin(['plugin-sdk','plugin-ui','protocol','database-protocol','databases','triage-protocol','triage-sources','deployment-protocol','cli-common','channels-protocol'].map(name => ({ packageName: `@happier-dev/${name}`, packageSourceRoot: resolve(import.meta.dirname, '../..', name, 'src') })))],
 test: { ...resolveVitestWorkers(), environment: 'node', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
});
