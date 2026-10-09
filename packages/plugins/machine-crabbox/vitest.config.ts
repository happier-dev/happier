import { defineConfig } from 'vitest/config';
import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
export default defineConfig({
    root,
    plugins: [createWorkspacePackageSourcesPlugin([
        { packageName: '@happier-dev/protocol', packageSourceRoot: resolve(root, '../../protocol/src') },
        { packageName: '@happier-dev/plugin-sdk', packageSourceRoot: resolve(root, '../../plugin-sdk/src') },
    ])],
    test: { ...resolveVitestWorkers(), environment: 'node', include: ['src/**/*.test.ts'] },
});
