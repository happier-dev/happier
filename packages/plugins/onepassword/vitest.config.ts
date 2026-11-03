import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
export default defineConfig({
    root: resolve(repoRoot, 'packages/plugins/onepassword'),
    plugins: [createWorkspacePackageSourcesPlugin([
        { packageName: '@happier-dev/plugin-sdk', packageSourceRoot: resolve(repoRoot, 'packages/plugin-sdk/src') },
        { packageName: '@happier-dev/protocol', packageSourceRoot: resolve(repoRoot, 'packages/protocol/src') },
        { packageName: '@happier-dev/cli-common', packageSourceRoot: resolve(repoRoot, 'packages/cli-common/src') },
    ])],
    test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
