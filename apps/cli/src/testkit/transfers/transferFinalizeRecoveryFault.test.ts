import {
    existsSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveWorkspaceFileUploadTarget } from '@/transfers/targets/resolveWorkspaceFileUploadTarget';

import {
    hashTransferRecoveryTestkitDestination,
    resolveStackTransferFinalizeRecoveryFault,
} from './transferFinalizeRecoveryFault';

const createdRoots: string[] = [];

function createRuntime(): Readonly<{
    runtimeDir: string;
    armFile: string;
    authority: string;
    env: Readonly<Record<string, string>>;
}> {
    const runtimeDir = mkdtempSync(join(tmpdir(), 'happier-transfer-recovery-testkit-'));
    createdRoots.push(runtimeDir);
    const authority = 'test-authority-0123456789abcdef0123456789abcdef';
    return {
        runtimeDir,
        armFile: join(runtimeDir, 'transfer-recovery-arm.json'),
        authority,
        env: {
            NODE_ENV: 'test',
            HAPPIER_STACK_PROCESS_KIND: 'daemon',
            HAPPIER_STACK_STACK: 'test-stack',
            HAPPIER_STACK_REPO_DIR: runtimeDir,
            HAPPIER_STACK_RUNTIME_DIR: runtimeDir,
            HAPPIER_STACK_TRANSFER_RECOVERY_TESTKIT: '1',
            HAPPIER_STACK_TRANSFER_RECOVERY_TESTKIT_AUTHORITY: authority,
            HAPPIER_STACK_TRANSFER_RECOVERY_TESTKIT_ARM_FILE: join(
                runtimeDir,
                'transfer-recovery-arm.json',
            ),
        },
    };
}

function writeArm(input: Readonly<{
    armFile: string;
    authority: string;
    destinationPath: string;
}>): void {
    writeFileSync(input.armFile, JSON.stringify({
        v: 1,
        authority: input.authority,
        fault: 'finalize_recovery_required_once',
        destinationPathSha256: hashTransferRecoveryTestkitDestination(
            input.destinationPath,
        ),
    }), { encoding: 'utf8', mode: 0o600 });
}

afterEach(() => {
    for (const root of createdRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

describe('transfer finalize recovery stack testkit', () => {
    it('is unavailable to production and ordinary daemon compositions', () => {
        const runtime = createRuntime();

        expect(resolveStackTransferFinalizeRecoveryFault({
            ...runtime.env,
            NODE_ENV: 'production',
        })).toBeNull();
        expect(resolveStackTransferFinalizeRecoveryFault({
            ...runtime.env,
            HAPPIER_STACK_TRANSFER_RECOVERY_TESTKIT: '0',
        })).toBeNull();
        expect(resolveStackTransferFinalizeRecoveryFault({
            ...runtime.env,
            HAPPIER_STACK_TRANSFER_RECOVERY_TESTKIT_ARM_FILE: join(
                runtime.runtimeDir,
                '..',
                'outside-arm.json',
            ),
        })).toBeNull();
    });

    it('preserves a mismatched arm, atomically consumes the exact destination once, and retries normally', async () => {
        const runtime = createRuntime();
        const destinationPath = join(runtime.runtimeDir, 'workspace', 'payload.txt');
        const stagedPath = join(runtime.runtimeDir, 'staged.upload');
        writeFileSync(stagedPath, 'payload', 'utf8');
        writeArm({
            armFile: runtime.armFile,
            authority: runtime.authority,
            destinationPath,
        });

        const finalizeFileOperations = resolveStackTransferFinalizeRecoveryFault(
            runtime.env,
        );
        expect(finalizeFileOperations).not.toBeNull();
        expect(finalizeFileOperations?.({
            uploadId: 'wrong-upload',
            tempPath: stagedPath,
            destPath: join(runtime.runtimeDir, 'workspace', 'other.txt'),
            overwrite: true,
        })).toBeNull();
        expect(existsSync(runtime.armFile)).toBe(true);

        const target = resolveWorkspaceFileUploadTarget({
            workingDirectory: runtime.runtimeDir,
            path: destinationPath,
            sizeBytes: 7,
            overwrite: true,
            finalizeFileOperations: finalizeFileOperations ?? undefined,
        });
        expect(target.success).toBe(true);
        if (!target.success) {
            return;
        }

        await expect(target.target.finalizeUpload({
            uploadId: 'exact-upload',
            tempPath: stagedPath,
            sizeBytes: 7,
            sha256: 'sha256:test',
        })).resolves.toMatchObject({
            success: false,
            errorCode: 'TRANSFER_FINALIZE_RECOVERY_REQUIRED',
            keepSession: true,
        });
        expect(existsSync(runtime.armFile)).toBe(false);
        expect(readFileSync(stagedPath, 'utf8')).toBe('payload');
        expect(readFileSync(destinationPath, 'utf8')).toBe('payload');

        await expect(target.target.finalizeUpload({
            uploadId: 'exact-upload',
            tempPath: stagedPath,
            sizeBytes: 7,
            sha256: 'sha256:test',
        })).resolves.toEqual({
            success: true,
            path: destinationPath,
            sizeBytes: 7,
        });
        expect(readFileSync(destinationPath, 'utf8')).toBe('payload');
    });
});
