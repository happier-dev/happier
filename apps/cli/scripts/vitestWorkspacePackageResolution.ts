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
        devDependencies?: Readonly<Record<string, unknown>>;
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

    // Tests may consume a first-party public contribution before it joins the
    // runtime bundle. Declared test dependencies do not change that membership.
    for (const packageName of Object.keys(cliPackageJson.devDependencies ?? {}).sort()) {
        if (!packageName.startsWith(FIRST_PARTY_PLUGIN_PACKAGE_PREFIX)) continue;
        const packageSourceRoot = resolve(repoRoot, 'packages', 'plugins',
            packageName.slice(FIRST_PARTY_PLUGIN_PACKAGE_PREFIX.length), 'src');
        if (!existsSync(packageSourceRoot)) {
            throw new Error(`Missing source root for CLI plugin test dependency ${packageName}: ${packageSourceRoot}`);
        }
        addWorkspacePackage({ packageName, packageSourceRoot });
    }

    // Source entrypoints also consume first-party runtime dependencies. Resolve
    // that same closure from source rather than requiring their dist outputs.
    const pending = [...workspacePackages.values()];
    for (let index = 0; index < pending.length; index += 1) {
        const owner = pending[index]!;
        const manifest = JSON.parse(readFileSync(resolve(owner.packageSourceRoot, '..', 'package.json'), 'utf8')) as Readonly<{
            dependencies?: Readonly<Record<string, unknown>>;
        }>;
        for (const packageName of Object.keys(manifest.dependencies ?? {}).sort()) {
            if (!packageName.startsWith(FIRST_PARTY_PACKAGE_PREFIX) || workspacePackages.has(packageName)) continue;
            const packageRoot = packageName.startsWith(FIRST_PARTY_PLUGIN_PACKAGE_PREFIX)
                ? resolve(repoRoot, 'packages', 'plugins', packageName.slice(FIRST_PARTY_PLUGIN_PACKAGE_PREFIX.length))
                : resolve(repoRoot, 'packages', packageName.slice(FIRST_PARTY_PACKAGE_PREFIX.length));
            const packageSourceRoot = resolve(packageRoot, 'src');
            if (!existsSync(packageSourceRoot)) {
                throw new Error(`Missing source root for ${owner.packageName} workspace dependency ${packageName}: ${packageSourceRoot}`);
            }
            const dependency = { packageName, packageSourceRoot };
            addWorkspacePackage(dependency);
            pending.push(dependency);
        }
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
