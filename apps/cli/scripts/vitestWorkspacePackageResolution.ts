import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    createWorkspacePackageSourcesPlugin,
    readHostWorkspacePackageSpecs,
} from '../../../scripts/testing/vitestWorkspacePackageResolution.ts';

const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(cliRoot, '..', '..');

const workspacePackages = readHostWorkspacePackageSpecs(repoRoot, cliRoot);

export const workspacePackageOptimizationExcludes = workspacePackages.map((workspacePackage) => (
    workspacePackage.packageName
));

export const workspacePackageSourcesPlugin = createWorkspacePackageSourcesPlugin(
    workspacePackages,
    'happier-cli-workspace-package-sources',
    // CLI composed tests consume authored host surfaces, including host-only UI exports.
    { exportConditions: ['happier-source'] },
);
