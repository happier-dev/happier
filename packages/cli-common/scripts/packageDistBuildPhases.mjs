import { existsSync } from 'node:fs';
import { mkdtemp, rename, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { verifyPackageExportTargets } from './verifyExports.mjs';

async function removeDir(path) {
    await rm(path, { recursive: true, force: true });
}

async function runTscBuild({ packageDir, stagingDistDir, env }) {
    const result = spawnSync('tsc', ['-p', 'tsconfig.json', '--outDir', stagingDistDir], {
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
    buildIntoDistDir = runTscBuild,
    env = process.env,
    mkdtempImpl = mkdtemp,
    removeDirImpl = removeDir,
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

    await renameImpl(stageDistDir, buildPlan.distDir);
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
