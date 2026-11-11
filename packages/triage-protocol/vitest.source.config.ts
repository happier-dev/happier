import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

import { workspacePackageSourcesPlugin } from '../../apps/cli/scripts/vitestWorkspacePackageResolution';
import { resolveVitestWorkers } from '../../scripts/testing/vitestWorkers';

const packageRoot = dirname(fileURLToPath(import.meta.url));

/** Owner-level RED/GREEN uses moving source; publication tests keep the built harness. */
export default defineConfig({
    root: packageRoot,
    plugins: [workspacePackageSourcesPlugin],
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
