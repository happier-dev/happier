import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { readBundledWorkspacePackageNames } from '@happier-dev/cli-common/workspaces';

export const CLI_SHARED_DEP_TEST_FIXTURE_PACKAGE_NAMES = [
    'agents',
    'cli-common',
    'connection-supervisor',
    'plugin-sdk',
    'peer-mediation',
    'protocol',
    'transfers',
    'release-runtime',
] as const;

export type CliSharedDepPackageName = string;

export function resolveCliWorkspacePackageDir(rootDir: string, packageName: CliSharedDepPackageName): string {
    if (packageName.startsWith('plugins-')) {
        return resolve(rootDir, 'packages', 'plugins', packageName.slice('plugins-'.length));
    }
    return resolve(rootDir, 'packages', packageName);
}

export function resolveCliBundledWorkspacePackageDir(rootDir: string, packageName: CliSharedDepPackageName): string {
    return resolve(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', packageName);
}

export function resolveCliSharedDepPackageNames(rootDir: string): CliSharedDepPackageName[] {
    const packageJsonPath = resolve(rootDir, 'apps', 'cli', 'package.json');
    if (!existsSync(packageJsonPath)) {
        throw new Error(`Missing CLI package manifest: ${packageJsonPath}`);
    }

    try {
        const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as unknown;
        const workspaceNames = readBundledWorkspacePackageNames(packageJson)
            .map((packageName) => packageName.slice('@happier-dev/'.length).trim())
            .filter(Boolean);
        if (workspaceNames.length === 0) {
            throw new Error(`CLI package manifest has no @happier-dev bundled dependencies: ${packageJsonPath}`);
        }
        return [...new Set(workspaceNames)];
    } catch (error) {
        if (error instanceof Error && error.message.includes(packageJsonPath)) throw error;
        throw new Error(
            `Unable to read CLI bundled dependency contract: ${packageJsonPath}`,
            { cause: error },
        );
    }
}
