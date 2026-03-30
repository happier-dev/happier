import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { RunCommand } from './commands.js';

export type BundledWorkspacePackage = Readonly<{
    packageName: string;
    srcDir: string;
}>;

function directoryHasAtLeastOneFile(dirPath: string): boolean {
    if (!existsSync(dirPath)) return false;
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const candidate = join(dirPath, entry.name);
        if (entry.isFile()) return true;
        if (entry.isDirectory() && directoryHasAtLeastOneFile(candidate)) return true;
    }
    return false;
}

function isWorkspacePackageBuilt(srcDir: string): boolean {
    return directoryHasAtLeastOneFile(join(srcDir, 'dist'));
}

export async function ensureBundledWorkspacePackagesBuilt(_params: Readonly<{
    repoRoot: string;
    bundles: ReadonlyArray<BundledWorkspacePackage>;
    yarn: Readonly<{ cmd: string; args: string[] }>;
    runCommand: RunCommand;
}>): Promise<void> {
    const params = _params;
    const missing = new Map<string, BundledWorkspacePackage>();
    for (const bundle of params.bundles) {
        if (!isWorkspacePackageBuilt(bundle.srcDir)) {
            missing.set(bundle.packageName, bundle);
        }
    }

    for (const bundle of missing.values()) {
        params.runCommand(
            params.yarn.cmd,
            [...params.yarn.args, 'workspace', bundle.packageName, 'build'],
            { cwd: params.repoRoot },
        );
        if (!isWorkspacePackageBuilt(bundle.srcDir)) {
            throw new Error(
                `[component-artifacts] bundled workspace package build did not produce dist output: ${bundle.packageName} (${join(bundle.srcDir, 'dist')})`,
            );
        }
    }
}
