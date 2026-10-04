import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

import { createWorkspacePackageSourcesPlugin } from '../../../scripts/testing/vitestWorkspacePackageResolution.ts';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));

// Git owner tests consume the current SDK/Protocol sources, not a stale bundled copy.
export default defineConfig({
    plugins: [createWorkspacePackageSourcesPlugin([
        { packageName: '@happier-dev/cli-common', packageSourceRoot: resolve(packageRoot, '../../cli-common/src') },
        { packageName: '@happier-dev/plugin-sdk', packageSourceRoot: resolve(packageRoot, '../../plugin-sdk/src') },
        { packageName: '@happier-dev/protocol', packageSourceRoot: resolve(packageRoot, '../../protocol/src') },
    ], 'happier-scm-git-workspace-package-sources')],
    test: {
        ...resolveVitestWorkers(),
        environment: 'node',
        exclude: [...configDefaults.exclude],
        server: {
            deps: { inline: [/^@happier-dev\/(?:cli-common|plugin-sdk|protocol)(?:\/|$)/] },
        },
    },
});
