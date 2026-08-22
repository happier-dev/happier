import {
    copyFile,
    mkdir,
    mkdtemp,
    readFile,
    rm,
    stat,
    symlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import type {
    ConnectedAccountMaterialization as PluginConnectedAccountMaterialization,
} from '@happier-dev/plugin-sdk/connected-accounts';

import { createResolvedContributionRegistry } from '@/plugins/projection/registry/createResolvedContributionRegistry';
import type {
    StablePluginConnectedAccountsOwner,
} from './invocation/services/connectedAccounts';
import { resolvePluginStorePaths } from '../store/paths';
import {
    createNativeAgentCurrentSessionUiServices,
} from '@/agent/runtime/registry/engineRegistry/nativeAgentSessionInteractions';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';

describe('resolveExecutablePluginRuntimeRegistry managed-services production owner', () => {
    it('materializes private Connected Account files for daemon custody and removes them with the registry lifecycle', async () => {
        const happyHomeDir = await mkdtemp(
            join(tmpdir(), 'happier-daemon-managed-service-files-home-'),
        );
        const toolRoot = join(happyHomeDir, 'fixture-tools');
        await mkdir(toolRoot, { recursive: true });
        const pluginId = 'acme.daemon-managed-service-files';
        const agentId = 'credential-file-agent';
        const systemToolId = 'credential-file-runtime';
        const toolName = process.platform === 'win32'
            ? 'credential-file-runtime.exe'
            : 'credential-file-runtime';
        const toolPath = join(toolRoot, toolName);
        if (process.platform === 'win32') {
            await copyFile(process.execPath, toolPath);
        } else {
            await symlink(process.execPath, toolPath);
        }
        const credentialBytes = new Uint8Array([
            0x00, 0xff, 0x41, 0x0a, 0x7b, 0x7d,
        ]);
        const receiptPath = join(happyHomeDir, 'child-receipt.json');
        const previousPath = process.env.PATH;
        process.env.PATH = `${toolRoot}${delimiter}${previousPath ?? ''}`;
        const materialize = vi.fn<
            StablePluginConnectedAccountsOwner['materialize']
        >(async (input): Promise<PluginConnectedAccountMaterialization> => {
            expect(input.request).toEqual({
                kind: 'files',
                fileIds: ['upstream-credential'],
            });
            return Object.freeze({
                kind: 'files' as const,
                files: Object.freeze({
                    'upstream-credential': credentialBytes,
                }),
            });
        });
        const connectedAccounts = Object.freeze({
            getBinding: vi.fn(async () => null),
            requestSelection: vi.fn(async () => {
                throw new Error('Unexpected Connected Account selection');
            }),
            materialize,
            listAccounts: async () => {
                throw new Error('Connected Account listing is outside this fixture');
            },
            materializeListedAccount: async () => {
                throw new Error('Exact-listed Connected Account materialization is outside this fixture');
            },
            watch: vi.fn(() => Object.freeze({ dispose() {} })),
        }) satisfies StablePluginConnectedAccountsOwner;
        const sourceSpec = Object.freeze({
            kind: 'path' as const,
            locator: '/plugins/acme.daemon-managed-service-files',
            trustPolicy: 'local_trusted' as const,
            installPolicy: 'link' as const,
            resolvedVersion: '1.0.0',
        });
        const runtime = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            connectedAccounts,
            contributes: createResolvedContributionRegistry({
                agents: [{
                    id: agentId,
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: {
                        kindVersion: 1,
                        id: agentId,
                        ownedBackendIds: [],
                    },
                    richDefinition: {
                        provenance: 'external',
                        definition: {
                            id: agentId,
                            title: 'Credential-file Agent',
                            runtime: {
                                kind: 'acp',
                                transport: {
                                    kind: 'stdio',
                                    executable: {
                                        kind: 'systemTool',
                                        id: systemToolId,
                                    },
                                },
                            },
                            primary: 'sessions',
                            capabilities: {
                                sessions: {
                                    open: ['create'],
                                    delivery: ['newTurn'],
                                    cancel: true,
                                },
                            },
                            connectedAccounts: [{
                                purpose: 'provider.inference',
                                service: 'upstream-account',
                                required: true,
                                materializationKinds: ['files'],
                            }],
                        },
                    },
                    pluginId,
                    hostAccess: {
                        required: [{
                            id: 'managed-process',
                            capability: 'process',
                            reason: 'Run the credential-file fixture',
                            scope: {
                                executables: [{
                                    kind: 'systemTool',
                                    id: systemToolId,
                                }],
                                envKeys: [
                                    'UPSTREAM_CREDENTIAL_PATH',
                                ],
                            },
                        }],
                        optional: [],
                    },
                    sourceSpec,
                }],
                systemTools: [{
                    provenance: 'external',
                    source: { kind: 'path' },
                    pluginId,
                    sourceSpec,
                    definition: {
                        id: systemToolId,
                        title: 'Credential-file runtime',
                        executableNames: [toolName],
                    },
                }],
                activationTargets: [],
            }),
            generation: 29,
            generationAuthority: {
                commit: null,
                generations: new Map(),
                rejectedGenerations: new Map(),
                unavailableBundledPackageNames: new Set(),
                isCurrent: async () => true,
            },
        });
        try {
            const services = await runtime.createAgentInvocationServices({
                pluginId,
                pluginVersion: '1.0.0',
                agentId,
                generation: '29',
                correlationId: 'daemon-managed-service-files',
                cwd: happyHomeDir,
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
                session: {
                    id: 'daemon-managed-service-session',
                    current: createNativeAgentCurrentSessionUiServices({
                        permissionHandler: null,
                        pluginId,
                        contributionId: agentId,
                        runtimeId: agentId,
                        sessionId: 'daemon-managed-service-session',
                        generationId: '29',
                        isCurrent: () => true,
                    }),
                },
            });
            const handle = await services.managedServices.supervise({
                id: 'credential-file-fixture',
                credentialBindings: [{
                    purpose: 'provider.inference',
                    request: {
                        kind: 'files',
                        fileIds: ['upstream-credential'],
                    },
                    injection: {
                        kind: 'files',
                        pathsByFileId: {
                            'upstream-credential': {
                                environmentKey:
                                    'UPSTREAM_CREDENTIAL_PATH',
                            },
                        },
                    },
                }],
                mode: {
                    kind: 'spawn',
                    launch: {
                        executable: {
                            kind: 'systemTool',
                            id: systemToolId,
                        },
                        args: [
                            '-e',
                            [
                                "const fs = require('node:fs');",
                                'const credentialPath = process.env.UPSTREAM_CREDENTIAL_PATH;',
                                'const contents = fs.readFileSync(credentialPath);',
                                'fs.writeFileSync(process.argv[1], JSON.stringify({',
                                '  credentialPath,',
                                "  base64: contents.toString('base64'),",
                                '  mode: fs.statSync(credentialPath).mode & 0o777,',
                                '}));',
                                'setInterval(() => {}, 1_000);',
                            ].join('\n'),
                            receiptPath,
                        ],
                    },
                    endpoint: {
                        kind: 'assignAndInject',
                        port: { kind: 'allocated' },
                    },
                },
                healthCheck: { kind: 'none' },
            });
            await expect(handle.waitUntilHealthy()).resolves.toMatchObject({
                id: 'credential-file-fixture',
                state: 'healthy',
                mode: 'spawn',
            });
            type ChildReceipt = Readonly<{
                credentialPath: string;
                base64: string;
                mode: number;
            }>;
            const receipt = await vi.waitFor(async (): Promise<ChildReceipt> => {
                const parsed = JSON.parse(
                    await readFile(receiptPath, 'utf8'),
                ) as ChildReceipt;
                expect(parsed.base64).toBe(
                    Buffer.from(credentialBytes).toString('base64'),
                );
                return parsed;
            });
            const credentialPath = receipt.credentialPath;
            const credentialRoot = join(
                resolvePluginStorePaths({ happyHomeDir }).secretsDir,
                'managed-services',
            );
            const confined = relative(
                resolve(credentialRoot),
                resolve(credentialPath),
            );
            expect(
                confined === '..'
                || confined.startsWith(`..${sep}`)
                || isAbsolute(confined),
            ).toBe(false);
            await expect(readFile(credentialPath)).resolves.toEqual(
                Buffer.from(credentialBytes),
            );
            if (process.platform !== 'win32') {
                expect(receipt.mode).toBe(0o600);
            }

            await runtime.dispose();
            await expect(stat(credentialPath)).rejects.toMatchObject({
                code: 'ENOENT',
            });
            expect(handle.snapshot().state).toBe('stopped');
            expect(materialize).toHaveBeenCalledTimes(1);
        } finally {
            await runtime.dispose();
            if (previousPath === undefined) delete process.env.PATH;
            else process.env.PATH = previousPath;
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });

    it('supervises and retires a daemon-scoped service through the sole invocation assembly', async () => {
        const happyHomeDir = await mkdtemp(
            join(tmpdir(), 'happier-daemon-managed-services-home-'),
        );
        const pluginId = 'acme.daemon-managed-services';
        const agentId = 'bounded-agent';
        const runtime = await resolveExecutablePluginRuntimeRegistry({
            happyHomeDir,
            contributes: createResolvedContributionRegistry({
                agents: [{
                    id: agentId,
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: {
                        kindVersion: 1,
                        id: agentId,
                        ownedBackendIds: [],
                    },
                    richDefinition: {
                        provenance: 'external',
                        definition: {
                            id: agentId,
                            title: 'Bounded managed-services Agent',
                            runtime: {
                                kind: 'acp',
                                transport: {
                                    kind: 'stdio',
                                    executable: {
                                        kind: 'systemTool',
                                        id: 'unused-fixture-tool',
                                    },
                                },
                            },
                            primary: 'sessions',
                            capabilities: {
                                sessions: {
                                    open: ['create'],
                                    delivery: ['newTurn'],
                                    cancel: true,
                                },
                            },
                        },
                    },
                    pluginId,
                    hostAccess: { required: [], optional: [] },
                    sourceSpec: {
                        kind: 'path',
                        locator: '/plugins/acme.daemon-managed-services',
                        trustPolicy: 'local_trusted',
                        installPolicy: 'link',
                        resolvedVersion: '1.0.0',
                    },
                }],
                activationTargets: [],
            }),
            generation: 23,
            generationAuthority: {
                commit: null,
                generations: new Map(),
                rejectedGenerations: new Map(),
                unavailableBundledPackageNames: new Set(),
                isCurrent: async () => true,
            },
        });
        let handle: Awaited<ReturnType<
            Awaited<ReturnType<typeof runtime.createAgentInvocationServices>>[
                'managedServices'
            ]['supervise']
        >> | null = null;

        try {
            const services = await runtime.createAgentInvocationServices({
                pluginId,
                pluginVersion: '1.0.0',
                agentId,
                generation: '23',
                correlationId: 'daemon-managed-services-production',
                cwd: happyHomeDir,
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
            });

            expect(services.availability('managedServices')).toEqual({
                status: 'available',
            });
            handle = await services.managedServices.supervise({
                id: 'fixture-endpoint',
                mode: {
                    kind: 'attach',
                    baseUrl: 'http://127.0.0.1:4312',
                },
                healthCheck: { kind: 'none' },
            });
            await expect(handle.waitUntilHealthy()).resolves.toMatchObject({
                id: 'fixture-endpoint',
                state: 'healthy',
                mode: 'attach',
                baseUrl: 'http://127.0.0.1:4312',
            });

            await runtime.dispose();
            expect(handle.snapshot().state).toBe('stopped');
        } finally {
            await runtime.dispose();
            await rm(happyHomeDir, { recursive: true, force: true });
        }
    });
});
