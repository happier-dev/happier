import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { createWorkspacePackageSourcesPlugin } from '../../scripts/testing/vitestWorkspacePackageResolution';
import { resolveVitestWorkers } from '../../scripts/testing/vitestWorkers';

const packageRoot = dirname(fileURLToPath(import.meta.url));
export default defineConfig({
    root: packageRoot,
    plugins: [createWorkspacePackageSourcesPlugin(['databases', 'database-protocol', 'protocol'].map(name => ({
        packageName: `@happier-dev/${name}`,
        packageSourceRoot: resolve(packageRoot, '..', name, 'src'),
    })))],
    test: { ...resolveVitestWorkers(), environment: 'node', include: ['src/**/*.test.ts'] },
});
