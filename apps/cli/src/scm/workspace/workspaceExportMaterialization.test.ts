import { spawn } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { createScmBackendRegistry } from '@/scm/registry';
import { computeWorkspaceSyncRootFingerprint, readWorkspaceSyncRootObjectIdentity } from '@/workspaces/sync/workspaceSyncRootIdentity';
import { buildScmWorkspaceIntegrationWorkspaceExportArtifactsWithBlobProviderFromTransferEntries } from './workspaceExportArtifacts';
import {
    beginWorkspaceTargetMaterialization,
    inspectCommittedWorkspaceTargetMaterialization,
    materializeWorkspaceExportArtifactsWithScmWorkspace,
    recoverInterruptedWorkspaceTargetMaterialization,
    rehydrateWorkspaceTargetMaterialization,
    removeCommittedWorkspaceTargetMaterialization,
    type WorkspaceTargetMaterializationReceiptV1,
} from './workspaceExportMaterialization';

const childFixturePath = join(dirname(fileURLToPath(import.meta.url)), 'workspaceExportMaterialization.child.ts');

async function waitForFile(path: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (!(await access(path).then(() => true, () => false))) {
        if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

const naming = {
    siblingCopySuffixBase: 'copy',
    backupDirectoryPrefix: '.backup',
    stagingIdPrefix: 'staging',
} as const;
const registry = createScmBackendRegistry([]);
describe('workspace export materialization custody', () => {
    it('observes current regular-file bytes in the owned copy including nested warm caches without following outside symlinks', async () => {
        const fixture = await realpath(await mkdtemp(join(tmpdir(), 'workspace-export-owned-size-')));
        try {
            const target = join(fixture, 'copy');
            const receiptPath = join(fixture, 'receipt.json');
            const materialization = await beginWorkspaceTargetMaterialization({ targetPath: target, backupDirectoryPrefix: '.backup', receiptPath });
            await mkdir(target);
            await writeFile(join(target, 'copy.txt'), 'copy');
            await materialization.custody.bindPromotedTarget();
            await materialization.custody.commit();
            const receiptBytes = await readFile(receiptPath, 'utf8');
            // Measurement is passive and demand-local, not another persisted receipt field.
            const request = { targetPath: target, receiptPath, measureSize: true as const };
            await expect(inspectCommittedWorkspaceTargetMaterialization(request)).resolves.toMatchObject({ sizeBytes: 4 });
            await mkdir(join(target, 'nested'));
            await writeFile(join(target, 'nested', 'binary.bin'), Buffer.from([0, 1, 2, 3, 4]));
            await mkdir(join(target, '.cache', 'compiler'), { recursive: true });
            await writeFile(join(target, '.cache', 'compiler', 'warm.bin'), Buffer.alloc(17));
            const outside = join(fixture, 'outside');
            await mkdir(outside);
            await writeFile(join(outside, 'private.bin'), Buffer.alloc(4096));
            await symlink(outside, join(target, 'outside-directory'), process.platform === 'win32' ? 'junction' : 'dir');
            if (process.platform !== 'win32') {
                await symlink(join(outside, 'private.bin'), join(target, 'outside-file'));
            }
            await expect(inspectCommittedWorkspaceTargetMaterialization(request)).resolves.toMatchObject({ sizeBytes: 26 });
            expect(await readFile(receiptPath, 'utf8')).toBe(receiptBytes);
            expect(await readFile(join(outside, 'private.bin'))).toEqual(Buffer.alloc(4096));
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });
    it('removes only the reviewed committed copy while preserving sibling and user-created roots', async () => {
        const fixture = await realpath(await mkdtemp(join(tmpdir(), 'workspace-export-reviewed-removal-')));
        try {
            const target = join(fixture, 'copy');
            const sibling = join(fixture, 'copy-other');
            const receiptPath = join(fixture, 'receipt.json');
            await mkdir(sibling);
            await writeFile(join(sibling, 'user.txt'), 'user');
            const materialization = await beginWorkspaceTargetMaterialization({ targetPath: target, backupDirectoryPrefix: '.backup', receiptPath });
            await mkdir(target);
            await writeFile(join(target, 'copy.txt'), 'copy');
            await materialization.custody.bindPromotedTarget();
            await materialization.custody.commit();
            const rootFingerprint = await computeWorkspaceSyncRootFingerprint(target);
            await materialization.custody.abort();
            await expect(readFile(join(target, 'copy.txt'), 'utf8')).resolves.toBe('copy');
            await expect(removeCommittedWorkspaceTargetMaterialization({ targetPath: sibling, receiptPath, rootFingerprint }))
                .rejects.toMatchObject({ code: 'workspace_target_materialization_manual_recovery' });
            await expect(removeCommittedWorkspaceTargetMaterialization({ targetPath: sibling, receiptPath: join(fixture, 'absent.json'), rootFingerprint }))
                .rejects.toMatchObject({ code: 'workspace_copy_not_owned' });
            await removeCommittedWorkspaceTargetMaterialization({ targetPath: target, receiptPath, rootFingerprint });
            await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
            await expect(readFile(join(sibling, 'user.txt'), 'utf8')).resolves.toBe('user');
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it.each(['replacement', 'symlink'] as const)('refuses committed-copy removal after a %s replaces the root', async (change) => {
        const fixture = await realpath(await mkdtemp(join(tmpdir(), 'workspace-export-stale-removal-')));
        try {
            const target = join(fixture, 'copy');
            const original = join(fixture, 'original');
            const receiptPath = join(fixture, 'receipt.json');
            const materialization = await beginWorkspaceTargetMaterialization({ targetPath: target, backupDirectoryPrefix: '.backup', receiptPath });
            await mkdir(target);
            await writeFile(join(target, 'copy.txt'), 'copy');
            await materialization.custody.bindPromotedTarget();
            await materialization.custody.commit();
            const rootFingerprint = await computeWorkspaceSyncRootFingerprint(target);
            await rename(target, original);
            if (change === 'symlink') await symlink(original, target, 'dir');
            else await mkdir(target);
            const inspection = { targetPath: target, receiptPath, rootFingerprint, measureSize: true as const };
            await expect(inspectCommittedWorkspaceTargetMaterialization(inspection))
                .rejects.toMatchObject({ code: 'workspace_target_materialization_manual_recovery' });
            await expect(removeCommittedWorkspaceTargetMaterialization({ targetPath: target, receiptPath, rootFingerprint }))
                .rejects.toMatchObject({ code: 'workspace_target_materialization_manual_recovery' });
            await expect(readFile(join(original, 'copy.txt'), 'utf8')).resolves.toBe('copy');
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('retains the exact moved copy for inspection after failed removal and refuses a blind replay', async () => {
        const fixture = await realpath(await mkdtemp(join(tmpdir(), 'workspace-export-unknown-removal-')));
        try {
            const target = join(fixture, 'copy');
            const receiptPath = join(fixture, 'receipt.json');
            const materialization = await beginWorkspaceTargetMaterialization({ targetPath: target, backupDirectoryPrefix: '.backup', receiptPath });
            await mkdir(target);
            await writeFile(join(target, 'copy.txt'), 'copy');
            await materialization.custody.bindPromotedTarget();
            await materialization.custody.commit();
            const request = { targetPath: target, receiptPath, rootFingerprint: await computeWorkspaceSyncRootFingerprint(target) };
            await expect(removeCommittedWorkspaceTargetMaterialization(request, {
                removeTarget: async () => { throw Object.assign(new Error('filesystem refused removal'), { code: 'EACCES' }); },
            })).rejects.toMatchObject({ code: 'EACCES' });
            const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as WorkspaceTargetMaterializationReceiptV1;
            expect(receipt.removalTargetName).toBeDefined();
            const removalPath = join(fixture, receipt.removalTargetName!);
            await expect(readFile(join(removalPath, 'copy.txt'), 'utf8')).resolves.toBe('copy');
            await expect(removeCommittedWorkspaceTargetMaterialization(request)).rejects.toMatchObject({
                code: 'workspace_copy_removal_unknown', targetPath: target, removalPath,
            });
            await expect(readFile(join(removalPath, 'copy.txt'), 'utf8')).resolves.toBe('copy');
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });
    it('fails closed when an admitted empty target becomes non-empty immediately before replacement', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'workspace-export-target-fence-'));
        try {
            const target = join(fixture, 'target');
            await mkdir(target);
            const admittedIdentity = await readWorkspaceSyncRootObjectIdentity(target);
            await expect(beginWorkspaceTargetMaterialization({
                targetPath: target,
                backupDirectoryPrefix: '.backup',
                targetFence: { state: 'empty', identity: admittedIdentity },
            }, {
                replaceTarget: async (from, to) => {
                    await writeFile(join(target, 'intervening.txt'), 'external');
                    await rename(from, to);
                },
            })).rejects.toMatchObject({ code: 'approval_stale' });
            await expect(readFile(join(target, 'intervening.txt'), 'utf8')).resolves.toBe('external');
            await expect(readdir(fixture)).resolves.toEqual(['target']);
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('rejects an old partial receipt without touching either pathname', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'workspace-export-custody-partial-receipt-'));
        try {
            const target = join(fixture, 'target');
            const backup = join(fixture, '.backup.00000000-0000-4000-8000-000000000000');
            await mkdir(target);
            await mkdir(backup);
            await writeFile(join(target, 'target.txt'), 'target');
            await writeFile(join(backup, 'backup.txt'), 'backup');

            await expect(rehydrateWorkspaceTargetMaterialization({
                targetPath: target,
                backupDirectoryPrefix: '.backup',
                receipt: { v: 1, previousTargetName: '.backup.00000000-0000-4000-8000-000000000000' } as WorkspaceTargetMaterializationReceiptV1,
            })).rejects.toMatchObject({ code: 'workspace_target_materialization_manual_recovery' });
            await expect(readFile(join(target, 'target.txt'), 'utf8')).resolves.toBe('target');
            await expect(readFile(join(backup, 'backup.txt'), 'utf8')).resolves.toBe('backup');
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('preserves both pathnames when receipt identity proof is unavailable', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'workspace-export-custody-identity-unavailable-'));
        try {
            const target = join(fixture, 'target');
            const backupName = '.backup.00000000-0000-4000-8000-000000000000';
            const backup = join(fixture, backupName);
            await mkdir(target);
            await mkdir(backup);
            await writeFile(join(target, 'target.txt'), 'target');
            await writeFile(join(backup, 'backup.txt'), 'backup');

            await expect(rehydrateWorkspaceTargetMaterialization({
                targetPath: target,
                backupDirectoryPrefix: '.backup',
                receipt: {
                    v: 1,
                    previousTargetName: backupName,
                    originalTargetIdentity: null,
                    promotedTargetIdentity: null,
                    expectedBackupIdentity: null,
                },
            })).rejects.toMatchObject({ code: 'workspace_target_materialization_manual_recovery' });
            await expect(readFile(join(target, 'target.txt'), 'utf8')).resolves.toBe('target');
            await expect(readFile(join(backup, 'backup.txt'), 'utf8')).resolves.toBe('backup');
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('rehydrates rollback custody after the materializing process is killed', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'workspace-export-custody-crash-'));
        const target = join(fixture, 'target');
        const receiptPath = join(fixture, 'receipt.json');
        await mkdir(target);
        await writeFile(join(target, 'old.txt'), 'old');
        const child = spawn(process.execPath, [
            '--import',
            'tsx',
            childFixturePath,
            target,
            receiptPath,
        ], {
            cwd: join(dirname(childFixturePath), '../../..'),
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr?.setEncoding('utf8');
        child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
        try {
            await waitForFile(receiptPath);
            child.kill('SIGKILL');
            await new Promise<void>((resolve, reject) => {
                child.once('error', reject);
                child.once('exit', () => resolve());
            });
            await expect(readFile(join(target, 'new.txt'), 'utf8')).resolves.toBe('new');
            const receipt = JSON.parse(await readFile(receiptPath, 'utf8')) as WorkspaceTargetMaterializationReceiptV1;
            const recovered = await rehydrateWorkspaceTargetMaterialization({
                targetPath: target,
                backupDirectoryPrefix: '.backup',
                receipt,
            });
            expect(recovered).not.toBeNull();
            if (!recovered) throw new Error('materialization custody was already settled');
            await recovered.abort();
            await expect(readFile(join(target, 'old.txt'), 'utf8')).resolves.toBe('old');
            await expect(readFile(join(target, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        } catch (error) {
            throw new Error(`child-process recovery failed: ${stderr}`, { cause: error });
        } finally {
            child.kill('SIGKILL');
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('treats a missing named backup as an already-crossed commit boundary', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'workspace-export-custody-committed-'));
        try {
            const target = join(fixture, 'target');
            await mkdir(target);
            await writeFile(join(target, 'old.txt'), 'old');
            const materialization = await beginWorkspaceTargetMaterialization({
                targetPath: target,
                backupDirectoryPrefix: '.backup',
            });
            await mkdir(target);
            await writeFile(join(target, 'new.txt'), 'new');
            await materialization.custody.bindPromotedTarget();
            await materialization.custody.commit();

            await expect(rehydrateWorkspaceTargetMaterialization({
                targetPath: target,
                backupDirectoryPrefix: '.backup',
                receipt: materialization.custody.receipt,
            })).resolves.toBeNull();
            await expect(readFile(join(target, 'new.txt'), 'utf8')).resolves.toBe('new');
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('rejects a receipt that names anything outside the canonical backup namespace', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'workspace-export-custody-unsafe-'));
        try {
            const target = join(fixture, 'target');
            await mkdir(target);
            await writeFile(join(target, 'keep.txt'), 'keep');
            const identity = await readWorkspaceSyncRootObjectIdentity(target);
            await expect(rehydrateWorkspaceTargetMaterialization({
                targetPath: target,
                backupDirectoryPrefix: '.backup',
                receipt: {
                    v: 1,
                    previousTargetName: '../other',
                    originalTargetIdentity: identity,
                    promotedTargetIdentity: identity,
                    expectedBackupIdentity: identity,
                },
            })).rejects.toThrow('Invalid workspace target materialization receipt');
            await expect(readFile(join(target, 'keep.txt'), 'utf8')).resolves.toBe('keep');
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('keeps a replaced target recoverable until abort restores it', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'workspace-export-custody-'));
        try {
            const source = join(fixture, 'source');
            const target = join(fixture, 'target');
            await mkdir(source);
            await mkdir(target);
            await writeFile(join(source, 'new.txt'), 'new');
            await writeFile(join(target, 'old.txt'), 'old');
            const built = await buildScmWorkspaceIntegrationWorkspaceExportArtifactsWithBlobProviderFromTransferEntries({
                entries: [{ relativePath: 'new.txt', sourcePath: join(source, 'new.txt') }],
            });

            const materialized = await materializeWorkspaceExportArtifactsWithScmWorkspace({
                workspaceExportArtifacts: built.workspaceExportArtifacts,
                targetPath: target,
                conflictPolicy: 'replace_existing',
                blobProvider: built.blobProvider,
                registry,
                naming,
            });

            await expect(readFile(join(target, 'new.txt'), 'utf8')).resolves.toBe('new');
            expect((await readdir(fixture)).some((name) => name.startsWith('.backup.'))).toBe(true);
            await materialized.custody.abort();
            await expect(readFile(join(target, 'old.txt'), 'utf8')).resolves.toBe('old');
            await expect(readFile(join(target, 'new.txt'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
            expect((await readdir(fixture)).some((name) => name.startsWith('.backup.'))).toBe(false);
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('preserves an unrelated object that replaced the target before abort', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'workspace-export-custody-abort-replaced-'));
        try {
            const target = join(fixture, 'target');
            await mkdir(target);
            await writeFile(join(target, 'old.txt'), 'old');
            const materialization = await beginWorkspaceTargetMaterialization({
                targetPath: target,
                backupDirectoryPrefix: '.backup',
            });
            await mkdir(target);
            await writeFile(join(target, 'new.txt'), 'new');
            await materialization.custody.bindPromotedTarget();

            // A user, IDE or SCM replaces the promoted tree at the same pathname.
            await rename(target, join(fixture, 'detached-promoted'));
            await mkdir(target);
            await writeFile(join(target, 'user.txt'), 'unrelated');

            await expect(materialization.custody.abort()).rejects.toMatchObject({
                code: 'workspace_target_materialization_manual_recovery',
            });
            await expect(readFile(join(target, 'user.txt'), 'utf8')).resolves.toBe('unrelated');
            expect((await readdir(fixture)).some((name) => name.startsWith('.backup.'))).toBe(true);
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('preserves an unrelated object that replaced the expected backup before commit', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'workspace-export-custody-commit-backup-'));
        try {
            const target = join(fixture, 'target');
            await mkdir(target);
            await writeFile(join(target, 'old.txt'), 'old');
            const materialization = await beginWorkspaceTargetMaterialization({
                targetPath: target,
                backupDirectoryPrefix: '.backup',
            });
            await mkdir(target);
            await writeFile(join(target, 'new.txt'), 'new');
            await materialization.custody.bindPromotedTarget();

            const backupName = (await readdir(fixture)).find((name) => name.startsWith('.backup.'))!;
            const backupPath = join(fixture, backupName);
            await rename(backupPath, join(fixture, 'detached-backup'));
            await mkdir(backupPath);
            await writeFile(join(backupPath, 'user.txt'), 'unrelated');

            await expect(materialization.custody.commit()).rejects.toMatchObject({
                code: 'workspace_target_materialization_manual_recovery',
            });
            await expect(readFile(join(backupPath, 'user.txt'), 'utf8')).resolves.toBe('unrelated');
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('keeps the original backup when the target was replaced before commit', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'workspace-export-custody-commit-target-'));
        try {
            const target = join(fixture, 'target');
            await mkdir(target);
            await writeFile(join(target, 'old.txt'), 'old');
            const materialization = await beginWorkspaceTargetMaterialization({
                targetPath: target,
                backupDirectoryPrefix: '.backup',
            });
            await mkdir(target);
            await writeFile(join(target, 'new.txt'), 'new');
            await materialization.custody.bindPromotedTarget();

            await rename(target, join(fixture, 'detached-promoted'));
            await mkdir(target);
            await writeFile(join(target, 'user.txt'), 'unrelated');

            await expect(materialization.custody.commit()).rejects.toMatchObject({
                code: 'workspace_target_materialization_manual_recovery',
            });
            const backupName = (await readdir(fixture)).find((name) => name.startsWith('.backup.'))!;
            await expect(readFile(join(fixture, backupName, 'old.txt'), 'utf8')).resolves.toBe('old');
            await expect(readFile(join(target, 'user.txt'), 'utf8')).resolves.toBe('unrelated');
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('preserves a replaced target during restart recovery', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'workspace-export-custody-recover-replaced-'));
        try {
            const target = join(fixture, 'target');
            const receiptPath = join(fixture, 'receipt.json');
            await mkdir(target);
            await writeFile(join(target, 'old.txt'), 'old');
            const materialization = await beginWorkspaceTargetMaterialization({
                targetPath: target,
                backupDirectoryPrefix: '.backup',
                receiptPath,
            });
            await mkdir(target);
            await writeFile(join(target, 'new.txt'), 'new');
            await materialization.custody.bindPromotedTarget();

            await rename(target, join(fixture, 'detached-promoted'));
            await mkdir(target);
            await writeFile(join(target, 'user.txt'), 'unrelated');

            await expect(recoverInterruptedWorkspaceTargetMaterialization({
                targetPath: target,
                backupDirectoryPrefix: '.backup',
                receiptPath,
            })).rejects.toMatchObject({ code: 'workspace_target_materialization_manual_recovery' });
            await expect(readFile(join(target, 'user.txt'), 'utf8')).resolves.toBe('unrelated');
            const backupName = (await readdir(fixture)).find((name) => name.startsWith('.backup.'))!;
            await expect(readFile(join(fixture, backupName, 'old.txt'), 'utf8')).resolves.toBe('old');
            await expect(access(receiptPath)).resolves.toBeUndefined();
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('finishes rollback recovery after the backup was restored but its receipt was not yet removed', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'workspace-export-custody-abort-crash-'));
        try {
            const target = join(fixture, 'target');
            const receiptPath = join(fixture, 'receipt.json');
            await mkdir(target);
            await writeFile(join(target, 'old.txt'), 'old');
            const materialization = await beginWorkspaceTargetMaterialization({
                targetPath: target,
                backupDirectoryPrefix: '.backup',
                receiptPath,
            });
            await mkdir(target);
            await writeFile(join(target, 'new.txt'), 'new');
            await materialization.custody.bindPromotedTarget();

            await rm(target, { recursive: true, force: true });
            await rename(materialization.previousTargetPath!, target);

            await expect(recoverInterruptedWorkspaceTargetMaterialization({
                targetPath: target,
                backupDirectoryPrefix: '.backup',
                receiptPath,
            })).resolves.toBe(true);
            await expect(readFile(join(target, 'old.txt'), 'utf8')).resolves.toBe('old');
            expect((await readdir(target)).filter((name) => name.startsWith('.happier-materialization-'))).toEqual([]);
            await expect(access(receiptPath)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('surfaces manual recovery when rollback cannot safely restore the original target', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'workspace-export-custody-abort-error-'));
        try {
            const source = join(fixture, 'source');
            const target = join(fixture, 'target');
            const receiptPath = join(fixture, 'receipt.json');
            await mkdir(source);
            await mkdir(target);
            await writeFile(join(source, 'new.txt'), 'new');
            await writeFile(join(target, 'old.txt'), 'old');
            const built = await buildScmWorkspaceIntegrationWorkspaceExportArtifactsWithBlobProviderFromTransferEntries({
                entries: [{ relativePath: 'new.txt', sourcePath: join(source, 'new.txt') }],
            });
            await expect(materializeWorkspaceExportArtifactsWithScmWorkspace({
                workspaceExportArtifacts: built.workspaceExportArtifacts,
                targetPath: target,
                conflictPolicy: 'replace_existing',
                blobProvider: built.blobProvider,
                registry,
                naming,
                materializationReceiptPath: receiptPath,
                assertCanContinue: async () => {
                    const promotedTargetExists = await access(join(target, 'new.txt')).then(
                        () => true,
                        () => false,
                    );
                    if (!promotedTargetExists) return;
                    await rm(target, { recursive: true, force: true });
                    await mkdir(target);
                    await writeFile(join(target, 'user.txt'), 'unrelated');
                    throw new Error('operation cancelled');
                },
            })).rejects.toMatchObject({
                code: 'workspace_target_materialization_manual_recovery',
            });
            await expect(readFile(join(target, 'user.txt'), 'utf8')).resolves.toBe('unrelated');
            await expect(access(receiptPath)).resolves.toBeUndefined();
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('preserves a replaced target when the original target was absent', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'workspace-export-custody-absent-original-'));
        try {
            const target = join(fixture, 'target');
            const materialization = await beginWorkspaceTargetMaterialization({
                targetPath: target,
                backupDirectoryPrefix: '.backup',
            });
            expect(materialization.previousTargetPath).toBeUndefined();
            await mkdir(target);
            await writeFile(join(target, 'new.txt'), 'new');
            await materialization.custody.bindPromotedTarget();

            await rename(target, join(fixture, 'detached-promoted'));
            await mkdir(target);
            await writeFile(join(target, 'user.txt'), 'unrelated');

            await expect(materialization.custody.abort()).rejects.toMatchObject({
                code: 'workspace_target_materialization_manual_recovery',
            });
            await expect(readFile(join(target, 'user.txt'), 'utf8')).resolves.toBe('unrelated');
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('removes an absent original target that was never replaced on abort', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'workspace-export-custody-absent-abort-'));
        try {
            const target = join(fixture, 'target');
            const materialization = await beginWorkspaceTargetMaterialization({
                targetPath: target,
                backupDirectoryPrefix: '.backup',
            });
            await mkdir(target);
            await writeFile(join(target, 'new.txt'), 'new');
            await materialization.custody.bindPromotedTarget();
            await materialization.custody.abort();
            await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('deletes the replaced-target backup only when custody commits', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'workspace-export-custody-'));
        try {
            const source = join(fixture, 'source');
            const target = join(fixture, 'target');
            const receiptPath = join(fixture, 'materialization.json');
            await mkdir(source);
            await mkdir(target);
            await writeFile(join(source, 'new.txt'), 'new');
            await writeFile(join(target, 'old.txt'), 'old');
            const built = await buildScmWorkspaceIntegrationWorkspaceExportArtifactsWithBlobProviderFromTransferEntries({
                entries: [{ relativePath: 'new.txt', sourcePath: join(source, 'new.txt') }],
            });
            const materialized = await materializeWorkspaceExportArtifactsWithScmWorkspace({
                workspaceExportArtifacts: built.workspaceExportArtifacts,
                targetPath: target,
                conflictPolicy: 'replace_existing',
                blobProvider: built.blobProvider,
                registry,
                naming,
                materializationReceiptPath: receiptPath,
            });

            expect((await readdir(fixture)).some((name) => name.startsWith('.backup.'))).toBe(true);
            await expect(access(receiptPath)).resolves.toBeUndefined();
            await materialized.custody.commit();
            await expect(readFile(join(target, 'new.txt'), 'utf8')).resolves.toBe('new');
            expect((await readdir(fixture)).some((name) => name.startsWith('.backup.'))).toBe(false);
            expect(JSON.parse(await readFile(receiptPath, 'utf8'))).toMatchObject({ committed: { canonicalRoot: target } });
            await recoverInterruptedWorkspaceTargetMaterialization({ targetPath: target, backupDirectoryPrefix: '.backup', receiptPath });
            await expect(readFile(join(target, 'new.txt'), 'utf8')).resolves.toBe('new');
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });

    it('keeps materialization custody metadata outside the synchronized workspace', async () => {
        const fixture = await mkdtemp(join(tmpdir(), 'workspace-export-no-in-root-custody-'));
        try {
            const target = join(fixture, 'target');
            const receiptPath = join(fixture, 'materialization.json');
            const materialization = await beginWorkspaceTargetMaterialization({
                targetPath: target,
                backupDirectoryPrefix: '.backup',
                receiptPath,
            });
            await mkdir(target);
            await writeFile(join(target, 'user.txt'), 'user');
            await materialization.custody.bindPromotedTarget();

            expect(await readdir(target)).toEqual(['user.txt']);
            await expect(access(receiptPath)).resolves.toBeUndefined();
            await materialization.custody.commit();
        } finally {
            await rm(fixture, { recursive: true, force: true });
        }
    });
});
