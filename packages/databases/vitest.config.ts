import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { createWorkspacePackageSourcesPlugin, readHostWorkspacePackageSpecs } from '../../scripts/testing/vitestWorkspacePackageResolution';
import { resolveVitestWorkers } from '../../scripts/testing/vitestWorkers';

const packageRoot = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
    root: packageRoot,
    plugins: [createWorkspacePackageSourcesPlugin(readHostWorkspacePackageSpecs(resolve(packageRoot, '../..'), packageRoot, [
        { packageName: '@happier-dev/databases', packageSourceRoot: resolve(packageRoot, 'src') },
    ]))],
    test: { ...resolveVitestWorkers(), environment: 'node', include: ['src/**/*.test.ts'] },
});
