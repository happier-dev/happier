import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export type BundledWorkspacePackage = Readonly<{
    packageName: string;
    srcDir: string;
}>;

export type EnsureWorkspacePackagesBuiltByName = (
    repoRoot: string,
    packageNames: string[],
    options?: Readonly<{
        quiet?: boolean;
        env?: NodeJS.ProcessEnv;
        includeDevDependencies?: boolean;
    }>,
) => Promise<Readonly<{
    ok: boolean;
    built: string[];
    skipped: string[];
}>>;

async function loadWorkspaceBuildOwner(repoRoot: string): Promise<EnsureWorkspacePackagesBuiltByName> {
    const modulePath = join(repoRoot, 'scripts', 'workspaces', 'ensureWorkspacePackagesBuilt.mjs');
    if (!existsSync(modulePath)) {
        throw new Error(`[component-artifacts] missing canonical workspace build owner: ${modulePath}`);
    }
    const module = await import(pathToFileURL(modulePath).href) as {
        ensureWorkspacePackagesBuiltByName?: EnsureWorkspacePackagesBuiltByName;
    };
    if (typeof module.ensureWorkspacePackagesBuiltByName !== 'function') {
        throw new Error(`[component-artifacts] canonical workspace build owner has no by-name entrypoint: ${modulePath}`);
    }
    return module.ensureWorkspacePackagesBuiltByName;
}

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
    ensureWorkspacePackagesBuiltByName?: EnsureWorkspacePackagesBuiltByName;
}>): Promise<void> {
    const params = _params;
    const ensureWorkspacePackagesBuiltByName = params.ensureWorkspacePackagesBuiltByName
        ?? await loadWorkspaceBuildOwner(params.repoRoot);
    await ensureWorkspacePackagesBuiltByName(
        params.repoRoot,
        [...new Set(params.bundles.map((bundle) => bundle.packageName))],
        { quiet: false, env: process.env, includeDevDependencies: false },
    );

    for (const bundle of params.bundles) {
        if (!isWorkspacePackageBuilt(bundle.srcDir)) {
            throw new Error(
                `[component-artifacts] bundled workspace package build did not produce dist output: ${bundle.packageName} (${join(bundle.srcDir, 'dist')})`,
            );
        }
    }
}
