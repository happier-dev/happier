import { defineConfig } from 'vitest/config';
import { build, normalizePath, type Plugin } from 'vite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
// Native Workers run outside Vitest's module graph. Compile this entry once
// from workspace source so each connection starts its own native Worker without
// reloading the full SDK graph or resolving stale workspace dist exports.
function sqliteWorkerFixture(): Plugin {
    const sourceRoot = normalizePath(resolve(root, 'src'));
    let directory: string | undefined;
    return {
        name: 'database-workbench-sqlite-worker-fixture',
        enforce: 'pre',
        async configureServer() {
            // Some tests first import the connection from inside an Action.
            // Finish compiling before Vitest starts timing any test.
            const output = await mkdtemp(resolve(tmpdir(), 'happier-workbench-worker-'));
            try {
                await build({
                    configFile: false, root, publicDir: false, logLevel: 'error',
                    ssr: { noExternal: true, resolve: { conditions: ['happier-source', 'node'] } },
                    build: {
                        ssr: resolve(sourceRoot, 'sqlite.ts'), outDir: output, emptyOutDir: false,
                        rollupOptions: { output: { format: 'es', entryFileNames: 'sqlite.mjs' } },
                    },
                });
                directory = output;
            } catch (error) {
                await rm(output, { recursive: true, force: true });
                throw error;
            }
        },
        resolveId(source, importer) {
            if (directory && source === './sqlite.js' && importer?.startsWith(`${sourceRoot}/`)) {
                return normalizePath(resolve(directory, 'sqlite.mjs'));
            }
        },
        async closeBundle() {
            if (directory) await rm(directory, { recursive: true, force: true });
        },
    };
}

export default defineConfig({
    root,
    resolve: { alias: reactNativeWebAliases, dedupe: ['react', 'react-dom'] },
    plugins: [sqliteWorkerFixture(), createWorkspacePackageSourcesPlugin([
        ...['databases', 'database-protocol', 'protocol', 'plugin-sdk', 'plugin-ui'].map(name => ({
            packageName: `@happier-dev/${name}`, packageSourceRoot: resolve(root, '../..', name, 'src'),
        })),
    ])],
    test: { ...resolveVitestWorkers(), environment: 'node', include: ['src/**/*.test.ts', 'src/**/*.test.tsx'] },
});
