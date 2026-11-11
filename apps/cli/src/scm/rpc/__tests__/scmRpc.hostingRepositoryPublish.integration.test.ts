import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

import {
    SCM_OPERATION_ERROR_CODES,
    type ScmHostingRepositoryDescribePublishTargetsRequest,
    type ScmHostingRepositoryDescribePublishTargetsResponse,
    type ScmHostingRepositoryPublishRequest,
    type ScmHostingRepositoryPublishResponse,
} from '@happier-dev/protocol';
import { RPC_METHODS } from '@happier-dev/protocol/rpc';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { describe, expect, it } from 'vitest';

import { createTestGitRpcManager, createTestRpcManager, runGit as git } from './testRpcHarness';
import { executeScmActionOperation } from '@/scm/actions/executeScmActionOperation';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { createScmHostingProviderRegistry } from '@/scm/hostingProviders/registry';
import { createGitScmBackendRuntimeRegistration } from '../../../../../../packages/plugins/scm-git/src/backend';
import { createGithubRepositoryRestAdapter } from '../../../../../../packages/plugins/scm-github/src/repositoryProvisioning/githubRepositoryRestAdapter';
import { githubHostingProviderAdapter } from '../../../../../../packages/plugins/scm-github/src/adapter';
import { PLUGIN_MANIFEST } from '../../../../../../packages/plugins/scm-github/src/manifest';

describe('git RPC handlers (hosting repository publish)', () => {
    it.each(['directory', 'repository', 'missing'] as const)('discovers hosting accounts through Action and RPC at a %s destination', async (destinationKind) => {
        const repositoryPresent = destinationKind === 'repository';
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-hosting-targets-nonrepo-'));
        const cwd = destinationKind === 'missing' ? join(workspace, 'src') : workspace;
        // Only credential acquisition and GitHub HTTP are mocked; detection,
        // dispatch, the registered Git runtime and provider projection stay real.
        const adapter = createGithubRepositoryRestAdapter({
            resolveToken: async () => ({ kind: 'available', token: 'fixture-token' }),
            fetcher: async (url) => {
                const body = url.endsWith('/user/orgs') ? [{ login: 'bakery-team' }] : { login: 'alice' };
                return { ok: true, status: 200, statusText: 'OK', json: async () => body, text: async () => JSON.stringify(body) };
            },
        });
        const declaration = PLUGIN_MANIFEST.contributes.scmHostingProviders?.[0];
        if (!declaration) throw new Error('GitHub declaration missing');
        const { title, ...definition } = declaration;
        const hosting = createScmHostingProviderRegistry({
            providers: [{ ...definition, pluginId: PLUGIN_MANIFEST.id,
                displayName: typeof title === 'string' ? title : title.fallback }],
            runtimeRegistrations: [{ pluginId: PLUGIN_MANIFEST.id, occurrenceId: 'fixture', registration: {
                id: declaration.id, adapter: { routing: githubHostingProviderAdapter, repositoryPublishing: adapter },
            } }],
        });
        const registration = createGitScmBackendRuntimeRegistration();
        if (!registration.runtime) throw new Error('Git runtime missing');
        const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
            definition: { id: registration.id, kind: 'git' }, qualifiedId: `happier.scm.backend.git/${registration.id}`,
            executableDefinition: registration.runtime, registration,
            hostingProviderRuntimeServices: { resolveScmHostingProviderRegistry: async () => hosting },
        })]);
        try {
            if (repositoryPresent) {
                git(workspace, ['init', '-b', 'main']);
                git(workspace, ['remote', 'add', 'origin', 'https://github.com/alice/existing.git']);
            }
            const request = { cwd, providerKind: 'github' } as const;
            const { call } = createTestRpcManager({ workingDirectory: workspace, registry });
            const responses = [
                await executeScmActionOperation({ actionId: 'scm.hostingRepository.describePublishTargets', input: request, workingDirectory: workspace, registry }),
                await call<ScmHostingRepositoryDescribePublishTargetsResponse, ScmHostingRepositoryDescribePublishTargetsRequest>(
                    RPC_METHODS.SCM_HOSTING_REPOSITORY_DESCRIBE_PUBLISH_TARGETS, request),
            ];
            for (const response of responses) {
                expect(response, JSON.stringify(response)).toMatchObject({ success: true, auth: { state: 'authenticated' },
                    defaultRepositoryName: basename(cwd), targets: [
                        expect.objectContaining({ owner: 'alice' }), expect.objectContaining({ owner: 'bakery-team' }),
                    ] });
                expect(response).toMatchObject({ targets: expect.arrayContaining([expect.objectContaining({
                    provider: repositoryPresent ? expect.objectContaining({ nameWithOwner: 'alice/existing', remoteName: 'origin' })
                        : expect.not.objectContaining({ nameWithOwner: expect.anything() }),
                })]) });
            }
            // Account discovery must not create the future checkout parent. The
            // clone owner creates it only after the person confirms creation.
            if (destinationKind === 'missing') {
                expect(existsSync(cwd)).toBe(false);
                const executor = createActionExecutor({
                    scmActionExecute: async ({ actionId, input }) => executeScmActionOperation({
                        actionId, input, workingDirectory: workspace, registry,
                    }),
                });
                // This fixture admits publishing discovery but has no network
                // clone capability: reach that checkout refusal, not ROOT_NOT_FOUND
                // while checking the account against the default <home>/src path.
                expect(await executor.execute('projects.starters.create', {
                    serverId: 'home', machineId: 'machine', requestKey: 'starter-missing-parent', starterId: 'static-website',
                    description: 'A bakery website', destinationParentPath: cwd, destinationDirectoryName: 'bakery',
                    repository: { owner: 'alice', name: 'bakery' },
                }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }))
                    .toMatchObject({ ok: true, result: { kind: 'failed', phase: 'checkout', code: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED } });
                expect(existsSync(cwd)).toBe(false);
                expect(await executeScmActionOperation({ actionId: 'scm.hostingRepository.describePublishTargets',
                    input: request, workingDirectory: workspace, registry,
                    accessPolicy: { kind: 'restrictedRoots', roots: [join(workspace, 'allowed')] } }))
                    .toMatchObject({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH });
            }
            if (!repositoryPresent) {
                const destination = join(workspace, 'bakery');
                mkdirSync(destination);
                writeFileSync(join(destination, 'keep.txt'), 'existing destination');
                const executor = createActionExecutor({
                    scmActionExecute: async ({ actionId, input }) => executeScmActionOperation({
                        actionId, input, workingDirectory: workspace, registry,
                    }),
                });
                // Reach the real clone owner's no-overwrite refusal after account
                // discovery. This proves starter composition cannot mask describe
                // with an invented daemon answer or perform a network clone.
                expect(await executor.execute('projects.starters.create', {
                    serverId: 'home', machineId: 'machine', requestKey: 'starter-targets', starterId: 'static-website',
                    description: 'A bakery website', destinationParentPath: workspace, destinationDirectoryName: 'bakery',
                    repository: { owner: 'alice', name: 'bakery' },
                }, { surface: 'ui', authority: 'present_user', actionCaller: { kind: 'host' } }))
                    .toMatchObject({ ok: true, result: { kind: 'failed', phase: 'checkout', code: 'INVALID_PATH' } });
            }
        } finally {
            rmSync(workspace, { recursive: true, force: true });
        }
    });

    it('returns commit-required before provider or remote mutation when empty history push is requested', async () => {
        const workspace = mkdtempSync(join(tmpdir(), 'happier-git-hosting-publish-empty-'));
        git(workspace, ['init', '-b', 'main']);
        git(workspace, ['config', 'user.email', 'test@example.com']);
        git(workspace, ['config', 'user.name', 'Test User']);

        const { call } = createTestGitRpcManager({ workingDirectory: workspace });
        const response = await call<ScmHostingRepositoryPublishResponse, ScmHostingRepositoryPublishRequest>(
            RPC_METHODS.SCM_HOSTING_REPOSITORY_PUBLISH,
            {
                cwd: '.',
                providerKind: 'github',
                owner: 'happier-dev',
                repositoryName: 'empty-history',
                visibility: 'private',
                remoteName: 'origin',
                pushCurrentBranch: true,
            },
        );

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.COMMIT_REQUIRED,
            remediation: { kind: 'commit_required' },
        });
        expect(git(workspace, ['remote'])).toBe('');
    });
});
