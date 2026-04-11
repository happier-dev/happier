import { existsSync, readFileSync, readdirSync } from 'node:fs';
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

function collectExpectedExportFileTargets(exportsField: unknown): string[] {
    const targets: string[] = [];
    const visit = (value: unknown): void => {
        if (!value) return;
        if (typeof value === 'string') {
            targets.push(value);
            return;
        }
        if (Array.isArray(value)) {
            for (const item of value) {
                visit(item);
            }
            return;
        }
        if (typeof value === 'object') {
            for (const item of Object.values(value as Record<string, unknown>)) {
                visit(item);
            }
        }
    };
    visit(exportsField);
    return targets;
}

function collectExpectedPackageFilesFromPackageJson(pkgJson: unknown): string[] {
    const candidates: string[] = [];
    if (pkgJson && typeof pkgJson === 'object') {
        for (const key of ['main', 'module', 'types'] as const) {
            const value = Reflect.get(pkgJson, key);
            if (typeof value === 'string' && value.trim()) {
                candidates.push(value.trim());
            }
        }
        candidates.push(...collectExpectedExportFileTargets(Reflect.get(pkgJson, 'exports')));
    }

    return [...new Set(candidates)].filter((value) => value.startsWith('./') || value.startsWith('dist/'));
}

function isWorkspacePackageBuilt(srcDir: string): boolean {
    const pkgJsonPath = join(srcDir, 'package.json');
    if (!existsSync(pkgJsonPath)) {
        return directoryHasAtLeastOneFile(join(srcDir, 'dist'));
    }

    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    const expectedFiles = collectExpectedPackageFilesFromPackageJson(pkgJson).map((path) => join(srcDir, path));
    if (expectedFiles.length === 0) {
        return directoryHasAtLeastOneFile(join(srcDir, 'dist'));
    }

    return expectedFiles.every((path) => existsSync(path));
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
        await params.runCommand(
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
