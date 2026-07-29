import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { describe, expect, it, vi } from 'vitest';
import { SCM_OPERATION_ERROR_CODES } from '@happier-dev/protocol';

import { createScmBackendRegistry } from '@/scm/registry';
import type { ScmBackend } from '@/scm/types';
import { runScmRoute } from './dispatch';

type TestResponse = {
    success: boolean;
    error?: string;
    errorCode?: string;
};

const emptyRegistry = createScmBackendRegistry([]);

describe('runScmRoute', () => {
    it('uses the non-repository handler for cwd outside the default directory when unrestricted', async () => {
        const suiteDir = mkdtempSync(join(tmpdir(), 'happier-scm-dispatch-'));
        const workspace = join(suiteDir, 'default');
        const external = join(suiteDir, 'external');
        mkdirSync(workspace, { recursive: true });
        mkdirSync(external, { recursive: true });
        const onNonRepository = vi.fn().mockResolvedValue({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY,
            error: 'Not a repository',
        } satisfies TestResponse);
        const runWithBackend = vi.fn();

        const response = await runScmRoute<{ cwd?: string }, TestResponse>({
            request: { cwd: external },
            workingDirectory: workspace,
            onNonRepository,
            runWithBackend,
            registry: emptyRegistry,
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY);
        expect(onNonRepository).toHaveBeenCalledTimes(1);
        expect(runWithBackend).not.toHaveBeenCalled();
    });

    it('returns INVALID_PATH when cwd fails validation', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-dispatch-'));
        const runWithBackend = vi.fn();

        const response = await runScmRoute<{ cwd?: string }, TestResponse>({
            request: { cwd: '/definitely/outside/workspace' },
            workingDirectory: workspace,
            accessPolicy: { kind: 'restrictedRoots', roots: [workspace] },
            onNonRepository: () => ({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY }),
            runWithBackend,
            registry: emptyRegistry,
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
            registry: emptyRegistry,
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
            registry: emptyRegistry,
        });

        expect(response.success).toBe(false);
        expect(response.errorCode).toBe(SCM_OPERATION_ERROR_CODES.NOT_REPOSITORY);
        expect(onNonRepository).toHaveBeenCalledTimes(1);
        expect(runWithBackend).not.toHaveBeenCalled();
    });

    it('accepts a unique legacy local-id preference resolved to a qualified backend', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-scm-dispatch-'));
        const registry = createScmBackendRegistry([{
            id: 'happier.scm.backend.sapling/sapling',
            localId: 'sapling',
            selection: {
                modeSelectionScores: { '.git': 100 },
                preferenceAllowedModes: ['.git'],
            },
            detectRepo: async () => ({
                isRepo: true,
                rootPath: workspace,
                mode: '.git',
            }),
        } as unknown as ScmBackend]); // Narrow route fixture; backend operations are exercised by runWithBackend.
        const runWithBackend = vi.fn().mockResolvedValue({ success: true });

        const response = await runScmRoute<{
            cwd?: string;
            backendPreference?: { kind: 'prefer'; backendId: 'sapling' };
        }, TestResponse>({
            request: {
                cwd: '.',
                backendPreference: { kind: 'prefer', backendId: 'sapling' },
            },
            workingDirectory: workspace,
            onNonRepository: () => ({ success: false }),
            runWithBackend,
            registry,
        });

        expect(response.success).toBe(true);
        expect(runWithBackend).toHaveBeenCalledWith(expect.objectContaining({
            selection: expect.objectContaining({
                backend: expect.objectContaining({
                    id: 'happier.scm.backend.sapling/sapling',
                }),
            }),
        }));
    });
});
