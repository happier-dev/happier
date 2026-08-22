import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    createWorkspacePackageSourcesPlugin,
    readBundledPluginWorkspacePackageSpecs,
    type WorkspacePackageSpec,
} from '../../../scripts/testing/vitestWorkspacePackageResolution.ts';

const FIRST_PARTY_PACKAGE_PREFIX = '@happier-dev/';
const FIRST_PARTY_PLUGIN_PACKAGE_PREFIX = `${FIRST_PARTY_PACKAGE_PREFIX}plugins-`;
const cliRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = resolve(cliRoot, '..', '..');

function readCliWorkspacePackageSpecs(): readonly WorkspacePackageSpec[] {
    const cliPackageJson = JSON.parse(readFileSync(resolve(cliRoot, 'package.json'), 'utf8')) as Readonly<{
        dependencies?: Readonly<Record<string, unknown>>;
    }>;
    const workspacePackages = new Map<string, WorkspacePackageSpec>();
    const addWorkspacePackage = (workspacePackage: WorkspacePackageSpec): void => {
        const existing = workspacePackages.get(workspacePackage.packageName);
        if (
            existing
            && existing.packageSourceRoot !== workspacePackage.packageSourceRoot
        ) {
            throw new Error(
                `Conflicting source roots for ${workspacePackage.packageName}: `
                + `${existing.packageSourceRoot} and ${workspacePackage.packageSourceRoot}`,
            );
        }
        workspacePackages.set(workspacePackage.packageName, workspacePackage);
    };

    for (const packageName of Object.keys(cliPackageJson.dependencies ?? {}).sort()) {
        if (
            !packageName.startsWith(FIRST_PARTY_PACKAGE_PREFIX)
            || packageName.startsWith(FIRST_PARTY_PLUGIN_PACKAGE_PREFIX)
        ) continue;

        const sourceRoot = resolve(
            repoRoot,
            'packages',
            packageName.slice(FIRST_PARTY_PACKAGE_PREFIX.length),
            'src',
        );
        if (!existsSync(sourceRoot)) {
            throw new Error(`Missing source root for CLI workspace dependency ${packageName}: ${sourceRoot}`);
        }
        addWorkspacePackage({ packageName, packageSourceRoot: sourceRoot });
    }

    for (const workspacePackage of readBundledPluginWorkspacePackageSpecs(repoRoot)) {
        addWorkspacePackage(workspacePackage);
    }

    return [...workspacePackages.values()].sort((left, right) => (
        left.packageName.localeCompare(right.packageName)
    ));
}

const workspacePackages = readCliWorkspacePackageSpecs();

export const workspacePackageOptimizationExcludes = workspacePackages.map((workspacePackage) => (
    workspacePackage.packageName
));

export const workspacePackageSourcesPlugin = createWorkspacePackageSourcesPlugin(
    workspacePackages,
    'happier-cli-workspace-package-sources',
);
