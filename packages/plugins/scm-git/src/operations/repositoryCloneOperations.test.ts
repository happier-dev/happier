import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  SCM_OPERATION_ERROR_CODES,
  type ScmRepositoryCloneInput,
} from '@happier-dev/plugin-sdk/scm';
import { type HostingProviderRuntimeServices as ScmHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting';
import { runWithHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk/scm/hosting/runtime';
import { describe, expect, it } from 'vitest';
import { createScmBackendRegistry } from '@/scm/registry';
import { createRegisteredScmBackendAdapter } from '@/scm/pluginBackends/registeredScmBackendAdapter';
import { runScmRepositoryCloneRoute } from '@/scm/rpc/repositoryProvisioningDispatch';
import { createGitScmBackendRuntimeRegistration } from '../backend.js';
import { createScmHostingProviderRuntimeServicesForTest } from '../testkit/scmRuntime.test-support.js';
import { createRealGitScmBackendRuntimeServices } from '../testkit/scmRuntime.test-support.js';
import { runWithBackendRuntimeServices, type BackendRuntimeServices } from '@happier-dev/plugin-sdk/scm/backend';
import { createGithubRepositoryProvisioningAdapter } from '../../../scm-github/src/repositoryProvisioning/createRepositoryWithAuthFallback.js';
import { createGithubRepositoryRestAdapter } from '../../../scm-github/src/repositoryProvisioning/githubRepositoryRestAdapter.js';
import { runScmCommand } from '../runtime.js';

import {
    cloneWithRealGitRuntime,
    createBareRemoteRepository,
    createInMemorySnapshot,
    createWorkspace,
    getRepositoryCloneOperation,
    makeCloneTargetDescription,
    makeContext,
    makeProviderRegistry,
    makeRequest,
    runGit,
} from './repositoryCloneOperations.test-support.js';

describe('git repository clone operation', () => {
    it('keeps connected clone credentials in the host transport and out of workspace processes and results', async () => {
        const parent = createWorkspace();
        const secret = 'private-clone-token';
        const signal = new AbortController().signal;
        const authorizationHeader = `Basic ${Buffer.from(`x-access-token:${secret}`).toString('base64')}`;
        const description = makeCloneTargetDescription('/tmp/authenticated-clone.git');
        let transported: Parameters<NonNullable<BackendRuntimeServices['repositoryTransport']>['run']>[0] | undefined;
        const clone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(description, {
                describeCloneTargets: async () => description,
                resolveCloneAuthentication: async () => ({ kind: 'available', authorizationHeader }),
            }),
            runtimeServices: createScmHostingProviderRuntimeServicesForTest(),
        });
        const response = await runWithBackendRuntimeServices({ ...createRealGitScmBackendRuntimeServices(),
            // Genuine network/process boundary: this private host callback never runs in the target.
            repositoryTransport: { requiresConnectedAccount: true, run: async input => {
                transported = input;
                return { success: false, exitCode: 128, stdout: secret,
                    stderr: `fatal: Authentication failed ${authorizationHeader}` };
            } },
        }, () => clone({ ...{ context: makeContext(parent), signal,
            request: { ...makeRequest(parent, '/tmp/authenticated-clone.git'), authentication: 'connected_account' as const } } }));
        expect(transported?.repositories).toEqual([{ url: 'file:///tmp/authenticated-clone.git', authorizationHeader }]);
        expect(transported?.command.signal).toBe(signal);
        expect(JSON.stringify(transported?.command)).not.toContain(authorizationHeader);
        expect(response).toMatchObject({ success: false, errorCode: 'REMOTE_AUTH_REQUIRED' });
        expect(JSON.stringify(response)).not.toContain(secret);
        expect(JSON.stringify(response)).not.toContain(authorizationHeader);
    });

    it('refuses a connected-account clone before Git when the provider cannot supply credentials', async () => {
        const parent = createWorkspace();
        const remote = createBareRemoteRepository();
        const clone = getRepositoryCloneOperation({ registry: makeProviderRegistry(makeCloneTargetDescription(remote)) });
        const response = await cloneWithRealGitRuntime(clone, { context: makeContext(parent),
            request: { ...makeRequest(parent, remote), authentication: 'connected_account' } });
        expect(response).toMatchObject({ success: false, errorCode: 'REMOTE_AUTH_REQUIRED',
            remediation: { kind: 'auth_required' } });
        expect(existsSync(join(parent, 'happier'))).toBe(false);
    });

    it('uses the bound HTTPS credential for a private repository without a per-clone account selection', async () => {
        const parent = createWorkspace();
        const remote = createBareRemoteRepository();
        const description = makeCloneTargetDescription(remote);
        const authorizationHeader = 'Basic fixture';
        const hostingServices = createScmHostingProviderRuntimeServicesForTest();
        let transported: readonly { url: string; authorizationHeader: string }[] | undefined;
        let transportFailure: unknown;
        const clone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(description, {
                describeCloneTargets: async () => ({ ...description,
                    auth: { state: 'authenticated', profileKind: 'connected_account' },
                    repository: { ...description.repository, visibility: 'private' },
                }),
                resolveCloneAuthentication: async () => ({ kind: 'available', authorizationHeader }),
            }),
            runtimeServices: hostingServices,
            // The simulated private forge refuses Git without an authenticated host transport.
            runCommand: async () => ({ success: false, exitCode: 128, stdout: '', stderr: 'fatal: Authentication failed' }),
        });
        const response = await runWithBackendRuntimeServices({
            ...createRealGitScmBackendRuntimeServices(),
            repositoryTransport: { requiresConnectedAccount: false, run: async ({ repositories, command }) => {
                transported = repositories;
                try {
                    const stdout = runGit(command.cwd, [...command.args]);
                    return { success: true, exitCode: 0, stdout, stderr: '' };
                } catch (error) {
                    transportFailure = error;
                    throw error;
                }
            } },
        }, () => runWithHostingProviderRuntimeServices(hostingServices, () =>
            clone({ context: makeContext(parent), request: makeRequest(parent, remote) })));

        expect(transported).toEqual([{ url: `file://${remote}`, authorizationHeader }]);
        if (transportFailure) throw transportFailure;
        if (!response.success) throw new Error(`${response.errorCode}: ${response.error}`);
        expect(response).toMatchObject({ success: true, repository: { visibility: 'private' } });
        expect(runGit(response.destinationPath, ['rev-parse', 'HEAD'])).toBe(runGit(remote, ['rev-parse', 'HEAD']));
    });

    it('clones a private repository discovered with a Machine GitHub CLI login and no Connected Account', async () => {
        const parent = createWorkspace();
        const remote = createBareRemoteRepository();
        const cloneUrl = 'https://github.com/happier-dev/happier.git';
        const adapter = createGithubRepositoryProvisioningAdapter({ restAdapter: createGithubRepositoryRestAdapter({
            fetcher: async (_url, init) => {
                if (new Headers(init?.headers).get('authorization') !== 'Bearer fixture-gh-cli-token') {
                    return new Response(null, { status: 404 });
                }
                return Response.json({ full_name: 'happier-dev/happier', html_url: cloneUrl.slice(0, -4),
                    clone_url: cloneUrl, visibility: 'private', default_branch: 'main' });
            },
        }) });
        const registry = makeProviderRegistry(makeCloneTargetDescription(remote), adapter);
        const hostingServices: ScmHostingProviderRuntimeServices = {
            ...createScmHostingProviderRuntimeServicesForTest(registry),
            resolveScmHostingTokenMaterialization: async input => input.boundAccountOnly
                ? { kind: 'missing', reason: 'account_unbound' }
                : { kind: 'available', token: 'fixture-gh-cli-token' },
        };
        const clone = getRepositoryCloneOperation({
            registry,
            runtimeServices: hostingServices,
            // Route native Git's network access to the fixture repository.
            runCommand: input => runScmCommand({ ...input, env: { ...input.env,
                GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `url.file://${remote}.insteadOf`, GIT_CONFIG_VALUE_0: cloneUrl } }),
        });
        const response = await cloneWithRealGitRuntime(clone, { context: makeContext(parent), request: makeRequest(parent, remote) },
            { hostingProviderRuntimeServices: hostingServices });

        if (!response.success) throw new Error(`${response.errorCode}: ${response.error}`);
        expect(response).toMatchObject({ success: true, repository: { visibility: 'private' } });
        expect(runGit(response.destinationPath, ['rev-parse', 'HEAD'])).toBe(runGit(remote, ['rev-parse', 'HEAD']));
    });

    it.each(['feature/project-files', 'refs/heads/feature/project-files'])('clones the selected remote branch %s with its upstream instead of the remote default', async branch => {
        const parent = createWorkspace();
        const remote = createBareRemoteRepository();
        const source = join(dirname(remote), 'source');
        runGit(source, ['switch', '-c', 'feature/project-files']);
        writeFileSync(join(source, 'sentinel.txt'), 'selected branch\n');
        runGit(source, ['add', 'sentinel.txt']);
        runGit(source, ['commit', '-m', 'selected branch']);
        runGit(source, ['push', remote, 'feature/project-files']);
        const clone = getRepositoryCloneOperation({ registry: makeProviderRegistry(makeCloneTargetDescription(remote)) });
        const response = await cloneWithRealGitRuntime(clone, { context: makeContext(parent),
            request: { ...makeRequest(parent, remote), initialCheckout: { branch } } });
        expect(response).toMatchObject({ success: true, snapshot: { branch: { head: 'feature/project-files', detached: false } } });
        if (!response.success) throw new Error(response.error);
        expect(runGit(response.destinationPath, ['rev-parse', 'HEAD'])).toBe(runGit(source, ['rev-parse', 'HEAD']));
        expect(runGit(response.destinationPath, ['rev-parse', '--abbrev-ref', '@{upstream}'])).toBe('origin/feature/project-files');
    });

    it.each([
        { authenticated: false, phase: 'scm.repository_auth.target_state' },
        { authenticated: true, phase: 'scm.repository_auth.git' },
    ])('identifies the failed authentication precondition ($phase)', async ({ authenticated, phase }) => {
        const parent = createWorkspace();
        const description = makeCloneTargetDescription('/tmp/qa-auth-refusal.git');
        const clone = getRepositoryCloneOperation({
            registry: makeProviderRegistry({ ...description, auth: authenticated ? description.auth
                : { state: 'authentication_required', profileKind: 'unknown',
                    remediation: { kind: 'auth_required', action: 'provider_login' } } }),
            // Native process boundary; target selection and Git error classification stay real.
            runCommand: async () => ({ success: false, exitCode: 128, stdout: '', stderr: 'fatal: Authentication failed' }),
        });
        const response = await cloneWithRealGitRuntime(clone, { context: makeContext(parent),
            request: makeRequest(parent, '/tmp/qa-auth-refusal.git') });
        expect(response).toMatchObject({ success: false, errorCode: 'REMOTE_AUTH_REQUIRED',
            failureCause: { phase, errorClass: 'Error', errorCode: null, httpStatus: null } });
        expect(response).toMatchObject({ remediation: { kind: 'auth_required', label: expect.any(String),
            ...(!authenticated ? { action: 'provider_login' } : {}) } });
        expect(existsSync(join(parent, 'happier'))).toBe(false);
    });

    it('does not publish a fresh clone when its reviewed initial commit is unavailable', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const clone = getRepositoryCloneOperation({ registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)) });
        const response = await cloneWithRealGitRuntime(clone, { context: makeContext(parent),
            request: { ...makeRequest(parent, remotePath), initialCheckout: { branch: 'main', commit: 'f'.repeat(40) } } });
        expect(response).toMatchObject({ success: false });
        expect(existsSync(join(parent, 'happier'))).toBe(false);
        expect(runGit(join(dirname(remotePath), 'source'), ['branch', '--show-current'])).toBe('main');
    });

    it('checks out a reviewed commit that the origin serves only by exact object ID', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const source = join(dirname(remotePath), 'source');
        writeFileSync(join(source, 'README.md'), 'exact reviewed commit\n');
        runGit(source, ['add', 'README.md']);
        runGit(source, ['commit', '-m', 'reviewed contents']);
        const pin = runGit(source, ['rev-parse', 'HEAD']);
        runGit(source, ['push', remotePath, 'HEAD:refs/private/reviewed']);
        runGit(remotePath, ['config', 'uploadpack.hideRefs', 'refs/private']);
        runGit(remotePath, ['config', 'uploadpack.allowTipSHA1InWant', 'true']);

        const clone = getRepositoryCloneOperation({ registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)) });
        const response = await cloneWithRealGitRuntime(clone, { context: makeContext(parent),
            request: { ...makeRequest(parent, remotePath), initialCheckout: { branch: null, commit: pin } } });

        expect(response).toMatchObject({ success: true, snapshot: { branch: { detached: true, headOid: pin } } });
        if (!response.success) throw new Error(response.error);
        expect(runGit(response.destinationPath, ['show', 'HEAD:README.md'])).toBe('exact reviewed commit');
    });

    it.each(['main', null] as const)('creates initial %s at an exact reviewed commit before publishing a fresh clone even when upstream main advanced', async branch => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const source = join(dirname(remotePath), 'source');
        const pin = runGit(source, ['rev-parse', 'HEAD']);
        const history = runGit(source, ['rev-list', pin]);
        writeFileSync(join(source, 'README.md'), 'new upstream main\n');
        runGit(source, ['add', 'README.md']);
        runGit(source, ['commit', '-m', 'advance upstream main']);
        const newer = runGit(source, ['rev-parse', 'HEAD']);
        runGit(source, ['push', remotePath, 'main']);
        const clone = getRepositoryCloneOperation({ registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)) });
        const request = { ...makeRequest(parent, remotePath), initialCheckout: { branch, commit: pin } };
        const response = await cloneWithRealGitRuntime(clone, { context: makeContext(parent), request });
        expect(response.success).toBe(true);
        if (!response.success) throw new Error(response.error);
        expect({ current: runGit(response.destinationPath, ['branch', '--show-current']),
            head: runGit(response.destinationPath, ['rev-parse', 'HEAD']),
            main: runGit(response.destinationPath, ['rev-parse', 'main']) })
            .toEqual({ current: branch ?? '', head: pin, main: branch === null ? newer : pin });
        expect(runGit(response.destinationPath, ['rev-list', 'HEAD'])).toBe(history);
        expect(response.snapshot?.branch).toMatchObject({ detached: branch === null, headOid: pin });
        expect(runGit(source, ['rev-parse', 'main'])).toBe(newer);
        const repeated = await cloneWithRealGitRuntime(clone, { context: makeContext(parent),
            request: { ...request, initialCheckout: { branch, commit: newer } } });
        expect(repeated).toMatchObject({ success: false, errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH });
        expect(runGit(response.destinationPath, ['rev-parse', 'main'])).toBe(branch === null ? newer : pin);
    });

    it.each(['refs/tags/v1.0.0', 'HEAD'])('materializes latest stable or default branch at %s on main with original history', async initialCheckoutRef => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const source = join(dirname(remotePath), 'source');
        runGit(source, ['branch', '-m', 'develop']);
        const stable = runGit(source, ['rev-parse', 'HEAD']);
        runGit(source, ['tag', '-a', 'v1.0.0', '-m', 'Stable release']);
        writeFileSync(join(source, 'README.md'), 'development after stable\n');
        runGit(source, ['add', 'README.md']);
        runGit(source, ['commit', '-m', 'advance development']);
        runGit(source, ['push', remotePath, 'develop', '--tags']);
        runGit(remotePath, ['symbolic-ref', 'HEAD', 'refs/heads/develop']);
        const expected = initialCheckoutRef === 'HEAD' ? runGit(source, ['rev-parse', 'HEAD']) : stable;
        const description = { ...makeCloneTargetDescription(remotePath), initialCheckoutRef };
        const registration = createGitScmBackendRuntimeRegistration();
        if (!registration.runtime) throw new Error('Git clone runtime unavailable');
        const registry = createScmBackendRegistry([createRegisteredScmBackendAdapter({
            definition: { id: 'git', kind: 'git' }, qualifiedId: 'happier.scm.git/git',
            executableDefinition: registration.runtime, registration,
            hostingProviderRuntimeServices: createScmHostingProviderRuntimeServicesForTest(makeProviderRegistry(description)),
        })]);
        const response = await cloneWithRealGitRuntime(({ request }) => runScmRepositoryCloneRoute({ request, workingDirectory: parent, registry }),
            { context: makeContext(parent), request: { ...makeRequest(parent, remotePath), initialCheckout: { branch: 'main', revision: 'latest-stable' } } });
        expect(response.success).toBe(true);
        if (!response.success) throw new Error(response.error);
        expect(runGit(response.destinationPath, ['branch', '--show-current'])).toBe('main');
        expect(runGit(response.destinationPath, ['rev-parse', 'HEAD'])).toBe(expected);
        expect(runGit(response.destinationPath, ['rev-list', 'HEAD'])).toBe(runGit(source, ['rev-list', expected]));
        expect(response.snapshot?.branch).toMatchObject({ head: 'main', headOid: expected, detached: false });
    });

    it('refuses an unregistered provider or an unrecognized deployment before creating a checkout', async () => {
        const parent = createWorkspace();
        const description = makeCloneTargetDescription('/tmp/unused.git');
        const repositoryClone = getRepositoryCloneOperation({ registry: makeProviderRegistry(description) });
        for (const [provider, errorCode] of [
            [{ ...description.repository.provider, id: 'missing/provider' }, SCM_OPERATION_ERROR_CODES.BACKEND_UNAVAILABLE],
            [{ ...description.repository.provider, baseUrl: 'https://attacker.example' }, SCM_OPERATION_ERROR_CODES.INVALID_REQUEST],
        ] as const) {
            const response = await cloneWithRealGitRuntime(repositoryClone, {
                context: makeContext(parent),
                request: { ...makeRequest(parent, '/tmp/unused.git'), provider },
            });
            expect(response).toMatchObject({ success: false, errorCode });
            expect(existsSync(join(parent, 'happier'))).toBe(false);
        }
    });

    it('uses the current host runtime services for clone target discovery', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const serviceLabels = new Map<ScmHostingProviderRuntimeServices, string>();
        const observedServiceLabels: string[] = [];
        const description = makeCloneTargetDescription(remotePath);

        function createRuntimeServices(label: string): ScmHostingProviderRuntimeServices {
            const services: ScmHostingProviderRuntimeServices = {};
            serviceLabels.set(services, label);
            return services;
        }

        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(description, {
                    describeCloneTargets: async ({ runtimeServices }: {
                        runtimeServices?: ScmHostingProviderRuntimeServices;
                    }) => {
                        observedServiceLabels.push(runtimeServices ? serviceLabels.get(runtimeServices) ?? 'unknown' : 'missing');
                        return description;
                    },
            }),
            runCommand: async (request) => {
                const destinationArg = request.args[3];
                if (typeof destinationArg !== 'string') {
                    throw new Error('expected clone destination argument');
                }
                mkdirSync(resolve(destinationArg, '.git'), { recursive: true });
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
            detectRepo: async ({ cwd }) => ({ isRepo: true, rootPath: cwd, mode: '.git' }),
            readSnapshot: async ({ context }) => createInMemorySnapshot(context),
        });

        const firstServices = createRuntimeServices('first');
        const secondServices = createRuntimeServices('second');

        {
            const response = await cloneWithRealGitRuntime(repositoryClone, {
                context: makeContext(parent),
                request: makeRequest(parent, remotePath, 'first-clone'),
            }, {
                hostingProviderRuntimeServices: firstServices,
            });
            if (!response.success) throw new Error(response.error);
            expect(response.success).toBe(true);
        }
        {
            const response = await cloneWithRealGitRuntime(repositoryClone, {
                context: makeContext(parent),
                request: makeRequest(parent, remotePath, 'second-clone'),
            }, {
                hostingProviderRuntimeServices: secondServices,
            });
            if (!response.success) throw new Error(response.error);
            expect(response.success).toBe(true);
        }

        expect(observedServiceLabels).toEqual(['first', 'second']);
    });

    it('requires provider-owned clone target discovery instead of trusting request clone URLs', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(makeCloneTargetDescription(remotePath), null),
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: makeRequest(parent, remotePath),
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.FEATURE_UNSUPPORTED,
        });
        expect(existsSync(join(parent, 'happier'))).toBe(false);
    });

    it('rejects pre-existing empty destination directories before running clone', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const destination = join(parent, 'happier');
        mkdirSync(destination);
        let cloneAttempts = 0;
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry(makeCloneTargetDescription(remotePath)),
            runCommand: async () => {
                cloneAttempts += 1;
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: makeRequest(parent, remotePath),
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_PATH,
        });
        expect(cloneAttempts).toBe(0);
        expect(existsSync(join(destination, '.git'))).toBe(false);
    });

    it('uses the routed provider deployment and sanitized repository selector for clone target discovery', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const canonicalProvider = {
            id: 'happier.scm.forge.github/github',
            kind: 'github',
            displayName: 'GitHub',
            baseUrl: 'https://github.com',
            urlSafety: { allowedSchemes: ['https:'] },
        } satisfies ScmRepositoryCloneInput['provider'];
        const observed: Array<Readonly<{
            providerBaseUrl: string;
            hasCloneUrl: boolean;
            hasSshUrl: boolean;
        }>> = [];
        const clonedUrls: string[] = [];
        const description = makeCloneTargetDescription(remotePath);
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry({ ...description,
                repository: { ...description.repository, provider: canonicalProvider } }, {
                    describeCloneTargets: async ({ provider, repository }) => {
                        observed.push({
                            providerBaseUrl: provider.baseUrl,
                            hasCloneUrl: 'cloneUrl' in repository,
                            hasSshUrl: 'sshUrl' in repository,
                        });
                        return {
                            auth: { state: 'authenticated', profileKind: 'provider_cli' },
                            repository: {
                                provider,
                                nameWithOwner: repository.nameWithOwner,
                                webUrl: `${provider.baseUrl}/${repository.nameWithOwner}`,
                                cloneUrl: `${provider.baseUrl}/${repository.nameWithOwner}.git`,
                                visibility: repository.visibility,
                                defaultBranch: repository.defaultBranch,
                            },
                            targets: [
                                {
                                    protocol: 'https',
                                    url: `${provider.baseUrl}/${repository.nameWithOwner}.git`,
                                    isDefault: true,
                                },
                            ],
                        };
                    },
            }),
            runCommand: async (request) => {
                clonedUrls.push(request.args[2] ?? '');
                const destinationArg = request.args[3];
                if (typeof destinationArg !== 'string') {
                    throw new Error('expected clone destination argument');
                }
                mkdirSync(resolve(destinationArg, '.git'), { recursive: true });
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
            detectRepo: async () => ({ isRepo: true, rootPath: resolve(parent, 'happier'), mode: '.git' }),
            readSnapshot: async ({ context }) => createInMemorySnapshot(context),
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: {
                ...makeRequest(parent, remotePath),
                provider: {
                    ...canonicalProvider,
                },
                repository: {
                    nameWithOwner: 'happier-dev/happier',
                    webUrl: 'https://attacker.example/happier-dev/happier',
                    cloneUrl: 'https://attacker.example/happier-dev/happier.git',
                    sshUrl: 'git@attacker.example:happier-dev/happier.git',
                    visibility: 'public',
                    defaultBranch: 'main',
                },
            },
        });

        expect(response.success).toBe(true);
        expect(observed).toEqual([
            {
                providerBaseUrl: 'https://github.com',
                hasCloneUrl: false,
                hasSshUrl: false,
            },
        ]);
        expect(clonedUrls).toEqual(['https://github.com/happier-dev/happier.git']);
        expect(clonedUrls).not.toContain('https://attacker.example/happier-dev/happier.git');
    });

    it('rejects clone targets that look like Git options before running clone', async () => {
        const parent = createWorkspace();
        const cloneArgs: string[][] = [];
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry({
                ...makeCloneTargetDescription('/tmp/unused.git'),
                targets: [
                    {
                        protocol: 'https',
                        url: '--upload-pack=malicious-helper',
                        isDefault: true,
                    },
                ],
            }),
            runCommand: async (request) => {
                cloneArgs.push([...request.args]);
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: makeRequest(parent, '/tmp/unused.git'),
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(cloneArgs).toEqual([]);
    });

    it('rejects provider clone targets that violate registered URL safety before running clone', async () => {
        const parent = createWorkspace();
        const cloneAttempts: string[][] = [];
        const description = makeCloneTargetDescription('/tmp/unused.git');
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry({
                ...description,
                repository: {
                    ...description.repository,
                    provider: {
                        ...description.repository.provider,
                        urlSafety: { allowedSchemes: ['https:'] },
                    },
                },
                targets: [
                    {
                        protocol: 'https',
                        url: 'file:///tmp/untrusted.git',
                        isDefault: true,
                    },
                ],
            }),
            runCommand: async (request) => {
                cloneAttempts.push([...request.args]);
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: makeRequest(parent, '/tmp/unused.git'),
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(cloneAttempts).toEqual([]);
    });

    it('rejects provider clone targets with embedded URL credentials before running clone', async () => {
        const parent = createWorkspace();
        const cloneAttempts: string[][] = [];
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry({
                ...makeCloneTargetDescription('/tmp/unused.git'),
                targets: [
                    {
                        protocol: 'https',
                        url: 'https://token@github.com/happier-dev/happier.git',
                        isDefault: true,
                    },
                ],
            }),
            runCommand: async (request) => {
                cloneAttempts.push([...request.args]);
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: makeRequest(parent, '/tmp/unused.git'),
        });

        expect(response).toMatchObject({
            success: false,
            errorCode: SCM_OPERATION_ERROR_CODES.INVALID_REQUEST,
        });
        expect(cloneAttempts).toEqual([]);
    });

    it('allows SSH clone targets with a URL username', async () => {
        const parent = createWorkspace();
        const destination = resolve(parent, 'happier');
        const cloneArgs: string[][] = [];
        const description = makeCloneTargetDescription('/tmp/unused.git');
        const repositoryClone = getRepositoryCloneOperation({
            registry: makeProviderRegistry({
                ...description,
                repository: {
                    ...description.repository,
                    provider: {
                        ...description.repository.provider,
                        urlSafety: { allowedSchemes: ['https:', 'ssh:'] },
                    },
                },
                targets: [
                    {
                        protocol: 'ssh',
                        url: 'ssh://git@github.com/happier-dev/happier.git',
                        isDefault: true,
                    },
                ],
            }),
            runCommand: async (request) => {
                cloneArgs.push([...request.args]);
                const destinationArg = request.args[3];
                if (typeof destinationArg !== 'string') {
                    throw new Error('expected clone destination argument');
                }
                mkdirSync(resolve(destinationArg, '.git'), { recursive: true });
                return { success: true, stdout: '', stderr: '', exitCode: 0 };
            },
            detectRepo: async () => ({ isRepo: true, rootPath: destination, mode: '.git' }),
            readSnapshot: async ({ context }) => createInMemorySnapshot(context),
        });

        const response = await cloneWithRealGitRuntime(repositoryClone, {
            context: makeContext(parent),
            request: {
                ...makeRequest(parent, '/tmp/unused.git'),
                protocol: 'ssh',
            },
        });

        expect(response).toMatchObject({
            success: true,
            cloneProtocol: 'ssh',
            cloneUrl: 'ssh://git@github.com/happier-dev/happier.git',
        });
        expect(cloneArgs).toHaveLength(1);
    });

});
