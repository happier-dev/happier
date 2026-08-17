import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWorkspacePackageSourcesPlugin } from '../../scripts/testing/vitestWorkspacePackageResolution.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

export const serverWorkspacePackageSourcesPlugin = createWorkspacePackageSourcesPlugin([
    {
        packageName: '@happier-dev/agents',
        packageSourceRoot: resolve(repoRoot, 'packages', 'agents', 'src'),
    },
    {
        packageName: '@happier-dev/cli-common',
        packageSourceRoot: resolve(repoRoot, 'packages', 'cli-common', 'src'),
    },
    {
        packageName: '@happier-dev/protocol',
        packageSourceRoot: resolve(repoRoot, 'packages', 'protocol', 'src'),
    },
], 'happier-server-workspace-package-sources');
