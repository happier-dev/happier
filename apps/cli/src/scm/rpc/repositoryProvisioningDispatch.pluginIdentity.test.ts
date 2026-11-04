import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { createScmBackendRegistry } from '@/scm/registry';
import type { ScmBackend } from '@/scm/types';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createGitScmBackendRuntimeRegistration } from '../../../../../packages/plugins/scm-git/src/backend';
import { createScmHostingProviderRuntimeServicesForTest } from '../../../../../packages/plugins/scm-git/src/testkit/scmRuntime.test-support';
import { createBareRemoteRepository, createWorkspace, makeCloneTargetDescription,
    makeProviderRegistry, makeRequest, runGit } from '../../../../../packages/plugins/scm-git/src/operations/repositoryCloneOperations.test-support';

import { runScmRepositoryCloneRoute, runScmRepositoryInitRoute } from './repositoryProvisioningDispatch';

describe('clone initial-checkout callback boundary', () => {
    for (const callback of ['built-in', 'ignores-pin', 'omits-head-fact'] as const) {
        it(`settles exact pin honestly for ${callback}`, async () => {
            const parent = createWorkspace();
            const remote = createBareRemoteRepository();
            const source = join(dirname(remote), 'source');
            const pin = runGit(source, ['rev-parse', 'HEAD']);
            writeFileSync(join(source, 'README.md'), 'advanced upstream main\n');
            runGit(source, ['add', 'README.md']);
            runGit(source, ['commit', '-m', 'advance upstream main']);
            runGit(source, ['push', remote, 'main']);
            const newer = runGit(source, ['rev-parse', 'HEAD']);
            const registration = createGitScmBackendRuntimeRegistration();
            const lifecycle = registration.handlers.lifecycle;
            const clone = lifecycle?.clone;
            if (!clone || !registration.runtime) throw new Error('Git clone registration unavailable');
            const supplyingRegistration = callback === 'built-in' ? registration : {
                ...registration,
                handlers: { ...registration.handlers, lifecycle: { ...lifecycle,
                    // Genuine external plugin boundary: an old callback can ignore
                    // unknown operands or omit facts. All internal Git logic stays real.
                    clone: async (input: Parameters<typeof clone>[0]) => {
                        const result = await clone({ ...input, request: callback === 'ignores-pin'
                            ? makeRequest(input.request.destinationParentPath, remote, input.request.destinationDirectoryName)
                            : input.request });
                        if (callback !== 'omits-head-fact' || !result.success || !result.snapshot) return result;
                        const { headOid: _unavailable, ...branch } = result.snapshot.branch;
                        return { ...result, snapshot: { ...result.snapshot, branch } };
                    },
                } },
            };
            const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
                definition: { id: 'git', kind: 'git' }, qualifiedId: 'example.scm/git',
                executableDefinition: registration.runtime, registration: supplyingRegistration,
                hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(
                    makeProviderRegistry(makeCloneTargetDescription(remote))),
            })]);
            const request = { ...makeRequest(parent, remote), initialCheckout: { branch: 'main' as const, commit: pin } };
            const result = await runScmRepositoryCloneRoute({ request, workingDirectory: parent, registry });
            const destinationPath = join(parent, request.destinationDirectoryName);
            if (callback === 'built-in') {
                expect(result).toMatchObject({ success: true, destinationPath,
                    snapshot: { branch: { head: 'main', detached: false, headOid: pin } } });
            } else if (callback === 'ignores-pin') {
                expect(result).toMatchObject({ success: false, destinationPath, errorCode: 'SCM_SOURCE_CHANGED',
                    outcome: { kind: 'failed', repositoryState: { headOid: newer } } });
            } else {
                expect(result).toMatchObject({ success: false, destinationPath, errorCode: 'COMMAND_OUTCOME_UNKNOWN',
                    outcome: { kind: 'outcome_unknown', reconciliation: { kind: 'repository_status', cwd: destinationPath } } });
            }
            expect(runGit(destinationPath, ['branch', '--show-current'])).toBe('main');
            expect(runGit(destinationPath, ['rev-parse', 'HEAD'])).toBe(callback === 'ignores-pin' ? newer : pin);
            expect(runGit(source, ['rev-parse', 'HEAD'])).toBe(newer);
        });
    }
});

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
