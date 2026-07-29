import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createScmBackendRegistry } from '@/scm/registry';
import type { ScmBackend } from '@/scm/types';

import { runScmRepositoryInitRoute } from './repositoryProvisioningDispatch';

describe('repository provisioning plugin identity', () => {
    it('routes repository initialization through a qualified Git-kind plugin backend', async () => {
        const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-scm-plugin-init-'));
        const repositoryInit = vi.fn(async () => ({
            success: true as const,
            alreadyInitialized: false,
        }));
        const backend = {
            id: 'acme.scm/git',
            kind: 'git',
            selection: {
                modeSelectionScores: { '.git': 100 },
                preferenceAllowedModes: ['.git'],
            },
            detectRepo: async () => ({ isRepo: false, rootPath: null, mode: null }),
            repositoryInit,
        } as unknown as ScmBackend;

        try {
            await expect(runScmRepositoryInitRoute({
                request: { cwd: workingDirectory },
                workingDirectory,
                registry: createScmBackendRegistry([backend]),
            })).resolves.toMatchObject({
                success: true,
                alreadyInitialized: false,
            });
            expect(repositoryInit).toHaveBeenCalledTimes(1);
        } finally {
            await rm(workingDirectory, { recursive: true, force: true });
        }
    });

    it('gives an exact backend id precedence over a competing local id during initialization', async () => {
        const workingDirectory = await mkdtemp(join(tmpdir(), 'happier-scm-exact-init-'));
        const exactRepositoryInit = vi.fn(async () => ({
            success: true as const,
            alreadyInitialized: false,
        }));
        const competingRepositoryInit = vi.fn(async () => ({
            success: true as const,
            alreadyInitialized: false,
        }));
        const createBackend = (
            id: string,
            localId: string,
            repositoryInit: typeof exactRepositoryInit,
        ) => ({
            id,
            localId,
            kind: 'git',
            selection: {
                modeSelectionScores: { '.git': 100 },
                preferenceAllowedModes: ['.git'],
            },
            detectRepo: async () => ({ isRepo: false, rootPath: null, mode: null }),
            repositoryInit,
        }) as unknown as ScmBackend;

        try {
            await expect(runScmRepositoryInitRoute({
                request: {
                    cwd: workingDirectory,
                    backendPreference: { kind: 'prefer', backendId: 'git' },
                },
                workingDirectory,
                registry: createScmBackendRegistry([
                    createBackend('git', 'built-in-git', exactRepositoryInit),
                    createBackend('acme.scm/git', 'git', competingRepositoryInit),
                ]),
            })).resolves.toMatchObject({
                success: true,
                alreadyInitialized: false,
            });
            expect(exactRepositoryInit).toHaveBeenCalledTimes(1);
            expect(competingRepositoryInit).not.toHaveBeenCalled();
        } finally {
            await rm(workingDirectory, { recursive: true, force: true });
        }
    });
});
