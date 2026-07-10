import { existsSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rename, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { verifyPackageExportTargets } from './verifyExports.mjs';
import { resolveTypeScriptCliInvocation } from '../../../scripts/workspaces/resolveTypeScriptCliInvocation.mjs';

async function removeDir(path) {
    await rm(path, { recursive: true, force: true });
}

function collectExportTargetStrings(value, acc) {
    if (typeof value === 'string') {
        acc.push(value);
        return;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return;
    }

    for (const nested of Object.values(value)) {
        collectExportTargetStrings(nested, acc);
    }
}

function isWithinDirectory(candidatePath, directoryPath) {
    const relativePath = relative(directoryPath, candidatePath);
    return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function collectPackageRootExportTargets(packageJson) {
    const targets = [];
    collectExportTargetStrings(packageJson?.exports ?? {}, targets);
    return [...new Set(targets)]
        .map((target) => String(target).trim())
        .filter((target) => target.startsWith('./'))
        .filter((target) => target !== './dist')
        .filter((target) => !target.startsWith('./dist/'));
}

function isTransientRenameError(error) {
    const code = error?.code;
    return code === 'ENOTEMPTY' || code === 'EBUSY' || code === 'EPERM' || code === 'EACCES';
}

export function resolveTypeScriptBuildInvocation({
    packageDir,
    repoRoot = resolve(packageDir, '..', '..'),
    processExecPath = process.execPath,
    requireResolve,
    readFileSyncImpl,
    tsconfigPath = 'tsconfig.json',
    outDir,
} = {}) {
    const invocation = resolveTypeScriptCliInvocation({
        repoRoot,
        workspaceDir: packageDir,
        processExecPath,
        requireResolve,
        readFileSyncImpl,
    });

    return {
        command: invocation.command,
        args: [...invocation.argsPrefix, '-p', tsconfigPath, '--outDir', outDir],
    };
}

async function runTscBuild({ packageDir, stagingDistDir, env }) {
    const invocation = resolveTypeScriptBuildInvocation({
        packageDir,
        outDir: stagingDistDir,
    });
    const result = spawnSync(invocation.command, invocation.args, {
        cwd: packageDir,
        env,
        stdio: 'inherit',
    });
    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(`[cli-common] tsc build failed with exit code ${result.status ?? 1}`);
    }
}

export async function stagePackageDistBuild({
    buildPlan,
    packageJson,
    buildIntoDistDir = runTscBuild,
    env = process.env,
    mkdtempImpl = mkdtemp,
    removeDirImpl = removeDir,
    copyImpl = cp,
    mkdirImpl = mkdir,
    existsSyncImpl = existsSync,
} = {}) {
    if (!buildPlan) {
        throw new Error('stagePackageDistBuild requires buildPlan');
    }

    const stageRoot = await mkdtempImpl(buildPlan.stageRootPrefix);
    const stageDistDir = join(stageRoot, 'dist');

    try {
        await buildIntoDistDir({
            packageDir: buildPlan.packageDir,
            stagingDistDir: stageDistDir,
            env,
        });
        for (const target of collectPackageRootExportTargets(packageJson)) {
            const sourcePath = resolve(buildPlan.packageDir, target);
            const stagedPath = resolve(stageRoot, target);
            if (!isWithinDirectory(stagedPath, stageRoot) || !existsSyncImpl(sourcePath)) {
                continue;
            }
            await mkdirImpl(dirname(stagedPath), { recursive: true });
            await copyImpl(sourcePath, stagedPath, {
                recursive: true,
                force: true,
                preserveTimestamps: true,
            });
        }
        return { stageRoot, stageDistDir };
    } catch (error) {
        await removeDirImpl(stageRoot).catch(() => {});
        throw error;
    }
}

export function verifyStagedPackageDistExports({
    stageRoot,
    packageJson,
    verifyPackageExportTargetsImpl = verifyPackageExportTargets,
}) {
    verifyPackageExportTargetsImpl({
        packageDir: stageRoot,
        packageJson,
    });
}

export async function swapStagedPackageDistIntoPlace({
    buildPlan,
    stageDistDir,
    existsSyncImpl = existsSync,
    renameImpl = rename,
    copyImpl = cp,
    removeDirImpl = removeDir,
} = {}) {
    if (!buildPlan) {
        throw new Error('swapStagedPackageDistIntoPlace requires buildPlan');
    }

    let distMovedToBackup = false;

    if (existsSyncImpl(buildPlan.backupDir)) {
        await removeDirImpl(buildPlan.backupDir);
    }
    if (existsSyncImpl(buildPlan.distDir)) {
        await renameImpl(buildPlan.distDir, buildPlan.backupDir);
        distMovedToBackup = true;
    }

    try {
        await renameImpl(stageDistDir, buildPlan.distDir);
    } catch (error) {
        if (isTransientRenameError(error)) {
            try {
                await removeDirImpl(buildPlan.distDir).catch(() => {});
                await copyImpl(stageDistDir, buildPlan.distDir, {
                    recursive: true,
                    force: true,
                    preserveTimestamps: true,
                });
                return { distMovedToBackup };
            } catch (copyError) {
                error.copyError = copyError;
            }
        }
        throw error;
    }
    return { distMovedToBackup };
}

export async function restorePackageDistFromBackup({
    buildPlan,
    distMovedToBackup,
    existsSyncImpl = existsSync,
    renameImpl = rename,
} = {}) {
    if (!buildPlan) {
        throw new Error('restorePackageDistFromBackup requires buildPlan');
    }

    if (!distMovedToBackup) {
        return;
    }

    if (!existsSyncImpl(buildPlan.distDir) && existsSyncImpl(buildPlan.backupDir)) {
        await renameImpl(buildPlan.backupDir, buildPlan.distDir).catch(() => {});
    }
}

export async function cleanupPackageDistBuildArtifacts({
    buildPlan,
    stageRoot,
    existsSyncImpl = existsSync,
    removeDirImpl = removeDir,
} = {}) {
    if (!buildPlan) {
        throw new Error('cleanupPackageDistBuildArtifacts requires buildPlan');
    }

    await removeDirImpl(stageRoot);
    if (existsSyncImpl(buildPlan.backupDir)) {
        await removeDirImpl(buildPlan.backupDir).catch(() => {});
    }
}
