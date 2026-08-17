import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

import { createWorkspacePackageSourcesPlugin } from '../../scripts/testing/vitestWorkspacePackageResolution.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
    plugins: [createWorkspacePackageSourcesPlugin([
        {
            packageName: '@happier-dev/protocol',
            packageSourceRoot: resolve(here, '../protocol/src'),
        },
    ], 'happier-plugin-sdk-facade-current-workspace-package-sources')],
});
