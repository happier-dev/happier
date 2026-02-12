import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, it, vi } from 'vitest';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { runScmRoute } from './dispatch';

type TestResponse = {
    success: boolean;
    error?: string;
    errorCode?: string;
};

describe('runScmRoute', () => {
    it('returns INVALID_PATH when cwd fails validation', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-dispatch-'));
        const runWithBackend = vi.fn();

        const response = await runScmRoute<{ cwd?: string }, TestResponse>({
            request: { cwd: '/definitely/outside/workspace' },
            workingDirectory: workspace,
            onNonRepository: () => ({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY }),
            runWithBackend,
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.INVALID_PATH);
        expect(runWithBackend).not.toHaveBeenCalled();
    });

    it('calls onNonRepository when no backend matches the cwd', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-dispatch-'));
        const onNonRepository = vi.fn().mockResolvedValue({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY,
            error: 'Not a repository',
        } satisfies TestResponse);
        const runWithBackend = vi.fn();

        const response = await runScmRoute<{ cwd?: string }, TestResponse>({
            request: { cwd: '.' },
            workingDirectory: workspace,
            onNonRepository,
            runWithBackend,
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY);
        expect(onNonRepository).toHaveBeenCalledTimes(1);
        expect(runWithBackend).not.toHaveBeenCalled();
    });

    it('falls back to non-repository handler when no backend matches preference', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-dispatch-'));
        const onNonRepository = vi.fn().mockResolvedValue({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY,
            error: 'Not a repository',
        } satisfies TestResponse);
        const runWithBackend = vi.fn();

        const response = await runScmRoute<{
            cwd?: string;
            backendPreference?: { kind: 'prefer'; backendId: 'git' | 'sapling' };
        }, TestResponse>({
            request: {
                cwd: '.',
                backendPreference: { kind: 'prefer', backendId: 'git' },
            },
            workingDirectory: workspace,
            onNonRepository,
            runWithBackend,
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY);
        expect(onNonRepository).toHaveBeenCalledTimes(1);
        expect(runWithBackend).not.toHaveBeenCalled();
    });
});
