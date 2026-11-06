import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { createWorkspacePackageSourcesPlugin } from '../../scripts/testing/vitestWorkspacePackageResolution';
import { resolveVitestWorkers } from '../../scripts/testing/vitestWorkers';

const packageRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(packageRoot, '../..');

/** Owner-level RED/GREEN uses moving source; publication tests keep the built harness. */
export default defineConfig({
    root: packageRoot,
    plugins: [createWorkspacePackageSourcesPlugin(
        ['triage-protocol', 'channels-protocol', 'plugin-sdk', 'protocol', 'cli-common'].map(name => ({
            packageName: `@happier-dev/${name}`,
            packageSourceRoot: resolve(repoRoot, 'packages', name, 'src'),
        })),
    )],
    test: {
        ...resolveVitestWorkers(),
        environment: 'node',
        include: [
            'src/v1/**/*.test.ts', 'src/ci/**/*.test.ts',
            'src/releases/**/*.test.ts', 'src/testing/**/*.test.ts',
        ],
        exclude: ['node_modules/**', 'dist/**'],
    },
});
