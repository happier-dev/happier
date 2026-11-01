import { resolveVitestWorkers } from '../../../scripts/testing/vitestWorkers';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configDefaults, defineConfig } from 'vitest/config';

import { createWorkspacePackageSourcesPlugin, readHostWorkspacePackageSpecs } from '../../../scripts/testing/vitestWorkspacePackageResolution.ts';

const packageRoot = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = resolve(packageRoot, '../../..');

// Git owner tests consume the current SDK/Protocol sources, not a stale bundled copy.
export default defineConfig({
    // Compose the real host registry in plugin contract tests rather than a descriptor mock.
    resolve: { alias: { '@': resolve(packageRoot, '../../../apps/cli/src') } },
    plugins: [createWorkspacePackageSourcesPlugin(
        readHostWorkspacePackageSpecs(repoRoot, resolve(repoRoot, 'apps/cli')),
        'happier-scm-git-workspace-package-sources',
    )],
    test: {
        ...resolveVitestWorkers(),
        environment: 'node',
        exclude: [...configDefaults.exclude],
        server: {
            deps: { inline: [/^@happier-dev\/(?:cli-common|plugin-sdk|protocol)(?:\/|$)/] },
        },
    },
});
