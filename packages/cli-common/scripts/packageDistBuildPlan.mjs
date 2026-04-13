import { join } from 'node:path';

export function createPackageDistBuildPlan({
    packageDir,
    pid = process.pid,
    now = Date.now(),
} = {}) {
    if (!packageDir) {
        throw new Error('createPackageDistBuildPlan requires packageDir');
    }

    const resolvedPackageDir = packageDir;
    return Object.freeze({
        packageDir: resolvedPackageDir,
        distDir: join(resolvedPackageDir, 'dist'),
        backupDir: join(resolvedPackageDir, `.dist.hstack-backup.${pid}.${now}`),
        stageRootPrefix: join(resolvedPackageDir, '.dist.hstack-stage-'),
    });
}
