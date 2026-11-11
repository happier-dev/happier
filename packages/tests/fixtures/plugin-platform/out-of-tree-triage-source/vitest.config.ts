import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../../../../scripts/testing/vitestWorkers';
import { workspacePackageSourcesPlugin } from '../../../../../apps/cli/scripts/vitestWorkspacePackageResolution';

export default defineConfig({
    root: dirname(fileURLToPath(import.meta.url)),
    plugins: [workspacePackageSourcesPlugin],
    test: {
        ...resolveVitestWorkers(),
        environment: 'node',
        include: ['test/**/*.vitest.test.mjs'],
    },
});
