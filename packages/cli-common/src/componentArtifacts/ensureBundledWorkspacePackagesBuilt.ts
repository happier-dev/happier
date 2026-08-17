import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
    collectPackageBuildOutputTargets,
    isLocalPackageBuildOutputTarget,
    resolvePackageBuildOutputTargetMatches,
} from '../../packageBuildOutputTargets.mjs';

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
        publicationMode?: 'live' | 'artifact';
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

function isWorkspacePackageBuilt(srcDir: string): boolean {
    const pkgJsonPath = join(srcDir, 'package.json');
    if (!existsSync(pkgJsonPath)) {
        return directoryHasAtLeastOneFile(join(srcDir, 'dist'));
    }

    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    const expectedTargets = collectPackageBuildOutputTargets(pkgJson)
        .filter(isLocalPackageBuildOutputTarget);
    if (expectedTargets.length === 0) {
        return directoryHasAtLeastOneFile(join(srcDir, 'dist'));
    }

    return expectedTargets.every((target) => resolvePackageBuildOutputTargetMatches({
        packageDir: srcDir,
        outputDir: join(srcDir, 'dist'),
        target,
    }).length > 0);
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
        {
            quiet: false,
            env: process.env,
            includeDevDependencies: false,
            publicationMode: 'artifact',
        },
    );

    for (const bundle of params.bundles) {
        if (!isWorkspacePackageBuilt(bundle.srcDir)) {
            throw new Error(
                `[component-artifacts] bundled workspace package build did not produce dist output: ${bundle.packageName} (${join(bundle.srcDir, 'dist')})`,
            );
        }
    }
}
