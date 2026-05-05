import { basename, join } from 'node:path';

function workspacePackageLockSlug(packageDir, packageName) {
    const raw = String(packageName ?? '').trim() || basename(packageDir);
    const slug = raw.replace(/^@/, '').replace(/[^a-zA-Z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '');
    return slug || 'package';
}

export function createPackageDistBuildPlan({
    packageDir,
    packageName = '',
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
        lockPath: join(
            resolvedPackageDir,
            '..',
            '..',
            '.project',
            'tmp',
            'workspace-dist-builds',
            `${workspacePackageLockSlug(resolvedPackageDir, packageName)}.lock`,
        ),
        stageRootPrefix: join(resolvedPackageDir, '.dist.hstack-stage-'),
    });
}
