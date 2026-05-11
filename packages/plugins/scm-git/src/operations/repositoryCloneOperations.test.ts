import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { SCM_OPERATION_ERROR_CODES, type ScmRepositoryCloneInput } from '@happier-dev/protocol';
import { type ScmHostingProviderRuntimeServices } from '@happier-dev/plugin-sdk';
import { describe, expect, it } from 'vitest';

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
} from './repositoryCloneOperations.test-support.js';

describe('git repository clone operation', () => {
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
            registry: {
                getProvider: () => description.repository.provider,
                getAdapter: () => ({
                    describeCloneTargets: async ({ runtimeServices }: {
                        runtimeServices?: ScmHostingProviderRuntimeServices;
                    }) => {
                        observedServiceLabels.push(runtimeServices ? serviceLabels.get(runtimeServices) ?? 'unknown' : 'missing');
                        return description;
                    },
                }),
            },
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
            registry: {
                getAdapter: () => undefined,
            },
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

    it('uses the registered provider descriptor and sanitized repository selector for clone target discovery', async () => {
        const parent = createWorkspace();
        const remotePath = createBareRemoteRepository();
        const canonicalProvider = {
            id: 'scm.github',
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
        const repositoryClone = getRepositoryCloneOperation({
            registry: {
                getProvider: () => canonicalProvider,
                getAdapter: () => ({
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
            },
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
                    baseUrl: 'https://attacker.example',
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

    it('passes clone targets after an option terminator', async () => {
        const parent = createWorkspace();
        const destination = resolve(parent, 'happier');
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
            request: makeRequest(parent, '/tmp/unused.git'),
        });

        expect(response.success).toBe(true);
        expect(cloneArgs).toHaveLength(1);
        expect(cloneArgs[0]?.slice(0, 3)).toEqual(['clone', '--', '--upload-pack=malicious-helper']);
        expect(cloneArgs[0]?.[3]).not.toBe(destination);
    });

});
