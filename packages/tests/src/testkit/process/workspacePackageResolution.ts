import { resolve } from 'node:path';

export const CLI_SHARED_DEP_PACKAGE_NAMES = [
    'agents',
    'cli-common',
    'connection-supervisor',
    'protocol',
    'transfers',
    'release-runtime',
] as const;

export type CliSharedDepPackageName = (typeof CLI_SHARED_DEP_PACKAGE_NAMES)[number];

export function resolveCliWorkspacePackageDir(rootDir: string, packageName: CliSharedDepPackageName): string {
    return resolve(rootDir, 'packages', packageName);
}

export function resolveCliBundledWorkspacePackageDir(rootDir: string, packageName: CliSharedDepPackageName): string {
    return resolve(rootDir, 'apps', 'cli', 'node_modules', '@happier-dev', packageName);
}
