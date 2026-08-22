import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
    createActionExecutor,
    getActionSpec,
    type ActionExecutorDeps,
    type ActionId,
    type ScmActionExecute,
} from '@happier-dev/protocol';

import { createPluginInvocationActionsService } from './actions';
import { createPluginActionCallerMaterializationFixture } from './actionCaller.testkit';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
import { createScmBackendRegistry } from '@/scm/registry';
import type { ScmBackend } from '@/scm/types';

const SCM_ACTION_INPUTS = Object.freeze([
    ['scm.pullRequest.list', { cwd: '/workspace' }],
    ['scm.pullRequest.get', { cwd: '/workspace', prReference: { number: 1 } }],
    ['scm.pullRequest.openOrReuse', { cwd: '/workspace', base: 'main' }],
    ['scm.pullRequest.openCompose', { cwd: '/workspace', base: 'main', head: 'feature' }],
    ['scm.pullRequest.checkout', { cwd: '/workspace', prReference: { number: 1 } }],
    ['scm.pullRequest.prepareWorktree', {
        cwd: '/workspace',
        sourcePath: '/workspace',
        prReference: { number: 1 },
    }],
    ['scm.pullRequest.runStacked', { cwd: '/workspace', action: 'push' }],
    ['scm.repository.clone', {
        provider: {
            id: 'github:github.com',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.com',
        },
        repository: {
            nameWithOwner: 'acme/repo',
            visibility: 'private',
            cloneUrl: 'https://example.com/acme/repo.git',
        },
        destinationParentPath: '/workspace',
        destinationDirectoryName: 'repo',
        protocol: 'https',
        confirmed: true,
        authorizationToken: 'clone-repository',
    }],
    ['scm.repository.init', { cwd: '/workspace' }],
    ['scm.repository.removeIndexLock', {
        cwd: '/workspace',
        confirmed: true,
        confirmationToken: 'remove-stale-index-lock',
    }],
    ['scm.hostingRepository.describePublishTargets', { cwd: '/workspace' }],
    ['scm.hostingRepository.publish', {
        cwd: '/workspace',
        providerKind: 'github',
        owner: 'acme',
        repositoryName: 'repo',
        visibility: 'private',
    }],
    ['scm.diffSummary.generate', {
        cwd: '/workspace',
        source: { kind: 'workingTree' },
    }],
] as const satisfies readonly (readonly [ActionId, unknown])[]);

const scmMaterialization = createPluginActionCallerMaterializationFixture('acme.scm');

describe('plugin invocation SCM actions', () => {
    it('dispatches every plugin-visible scm.* ActionSpec through the real ActionsService and ActionExecutor', async () => {
        const scmActionExecute = vi.fn<ScmActionExecute>(async () => ({
            ok: false as const,
            errorCode: 'test_stop_after_scm_dispatch',
            error: 'test_stop_after_scm_dispatch',
        }));
        const actionExecutor = createActionExecutor({
            scmActionExecute,
            isActionApprovalRequired: () => false,
        } as unknown as ActionExecutorDeps);
        const service = createPluginInvocationActionsService({
            seed: {
                plugin: { id: 'acme.scm', version: '1.0.0' },
                resolveCurrentPluginMaterializationRef:
                    scmMaterialization.resolveCurrentPluginMaterializationRef,
                generation: 'generation-1',
                surface: 'agent',
                session: { id: 'session-1' },
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            },
            actionExecutor,
            invokeContributedAction: vi.fn(),
        });

        for (const [actionId, input] of SCM_ACTION_INPUTS) {
            expect(getActionSpec(actionId).inputSchema.safeParse(input).success, actionId).toBe(true);
            await expect(service.execute(actionId, input)).rejects.toMatchObject({
                code: 'test_stop_after_scm_dispatch',
            });
        }

        expect(scmActionExecute.mock.calls.map(([request]) => request.actionId)).toEqual(
            SCM_ACTION_INPUTS.map(([actionId]) => actionId),
        );
        expect(scmActionExecute).toHaveBeenCalledWith(expect.objectContaining({
            actionId: 'scm.diffSummary.generate',
            input: {
                cwd: '/workspace',
                source: { kind: 'workingTree' },
            },
            context: expect.objectContaining({
                defaultSessionId: 'session-1',
                surface: 'plugin',
                actionCaller: expect.objectContaining({
                    kind: 'plugin',
                    pluginId: 'acme.scm',
                    materialization: scmMaterialization.materialization,
                }),
                signal: expect.any(AbortSignal),
            }),
        }));
    });

    it('executes a real repository operation through ActionsService and the RPC-shared SCM owner', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-plugin-scm-action-'));
        const repository = join(workspace, 'repository');
        mkdirSync(repository, { recursive: true });
        try {
            const registry = createScmBackendRegistry([{
                id: 'git',
                kind: 'git',
                selection: {
                    modeSelectionScores: { '.git': 200 },
                    preferenceAllowedModes: ['.git'],
                },
                detectRepo: async () => ({ isRepo: false, rootPath: null, mode: null }),
                repositoryInit: async ({ context, request }: Parameters<NonNullable<ScmBackend['repositoryInit']>>[0]) => {
                    execFileSync('git', [
                        'init',
                        ...(request.initialBranch ? ['--initial-branch', request.initialBranch] : []),
                    ], { cwd: context.cwd, stdio: 'ignore' });
                    return { success: true, alreadyInitialized: false };
                },
            } as unknown as ScmBackend]);
            const actionExecutor = createActionExecutor({
                scmActionExecute: async ({ actionId, input, context }: Parameters<ScmActionExecute>[0]) => await executeScmActionOperation({
                    actionId,
                    input,
                    workingDirectory: workspace,
                    accessPolicy: { kind: 'restrictedRoots', roots: [workspace] },
                    registry,
                    ...(context.signal ? { signal: context.signal } : {}),
                }),
                isActionApprovalRequired: () => false,
            } as unknown as ActionExecutorDeps);
            const service = createPluginInvocationActionsService({
                seed: {
                    plugin: { id: 'acme.scm', version: '1.0.0' },
                    resolveCurrentPluginMaterializationRef:
                        scmMaterialization.resolveCurrentPluginMaterializationRef,
                    generation: 'generation-1',
                    surface: 'agent',
                    session: { id: 'session-1' },
                    signal: new AbortController().signal,
                    isGenerationCurrent: () => true,
                },
                actionExecutor,
                invokeContributedAction: vi.fn(),
            });

            await expect(service.execute('scm.repository.init', {
                cwd: repository,
                initialBranch: 'main',
            })).resolves.toMatchObject({
                success: true,
                alreadyInitialized: false,
            });
            expect(execFileSync('git', ['rev-parse', '--is-inside-work-tree'], {
                cwd: repository,
                encoding: 'utf8',
            }).trim()).toBe('true');
        } finally {
            rmSync(workspace, { recursive: true, force: true });
        }
    });
});
