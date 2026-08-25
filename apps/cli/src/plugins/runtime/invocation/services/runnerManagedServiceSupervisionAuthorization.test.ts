import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PLUGIN_MANIFEST as CLIPROXYAPI_PLUGIN_MANIFEST } from '@happier-dev/plugins-cliproxyapi/manifest';
import { PLUGIN_MANIFEST as OPENCODE_PLUGIN_MANIFEST } from '@happier-dev/plugins-opencode/manifest';
import {
    ProviderManagedRuntimeDeclarationV1Schema,
    resolveProviderManagedRuntimeDeclarationV1,
    type PluginEnginesV2,
} from '@happier-dev/protocol';
import type { ManagedServiceSpec } from '@happier-dev/plugin-sdk/managed-services';

import {
    createAgentSessionRunnerFactoryBinding,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
    createImmutablePluginGenerationRecordFromSource,
    persistInstallationStateRevision,
    persistValidatedAgentSessionRunnerFactories,
    prepareImmutablePluginGeneration,
} from '@/plugins/store/registry/generationStore';
import { RunnerDaemonManagedProviderBootstrapV1Schema } from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import {
    authorizeRunnerManagedProviderServerSupervision,
    authorizeRunnerManagedServiceSupervision,
    projectRunnerManagedProviderServerLaunchAuthority,
} from './runnerManagedServiceSupervisionAuthorization';

async function prepareOpenCodeAgentSupervisionFixture(input: Readonly<{
    pluginId: string;
    manifestAuthority: 'external' | 'bundled_first_party';
    engines: PluginEnginesV2;
}>) {
    const happyHomeDir = await mkdtemp(join(
        tmpdir(),
        'happier-agent-supervision-home-',
    ));
    const sourceRootPath = await mkdtemp(join(
        tmpdir(),
        'happier-agent-supervision-source-',
    ));
    const toolRootPath = await mkdtemp(join(
        tmpdir(),
        'happier-agent-supervision-tool-',
    ));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const moduleBytes = 'export function createRuntime() { throw new Error("unused"); }';
    const manifest = {
        ...OPENCODE_PLUGIN_MANIFEST,
        id: input.pluginId,
        engines: input.engines,
    };
    await mkdir(join(sourceRootPath, '.happier-plugin'), {
        recursive: true,
    });
    await mkdir(join(sourceRootPath, 'agent'), { recursive: true });
    await writeFile(
        join(sourceRootPath, '.happier-plugin', 'plugin.json'),
        JSON.stringify(manifest),
        'utf8',
    );
    await writeFile(
        join(sourceRootPath, 'agent', 'runtime.mjs'),
        moduleBytes,
        'utf8',
    );
    const immutableGenerationId = `agent-supervision-${createHash('sha256')
        .update(sourceRootPath)
        .digest('hex')
        .slice(0, 16)}`;
    const record = await createImmutablePluginGenerationRecordFromSource({
        pluginId: manifest.id,
        sourceRootPath,
        manifestRelativePath: '.happier-plugin/plugin.json',
        distribution: {
            kind: 'localPath',
            canonicalPath: sourceRootPath,
        },
        updatePolicy: 'manual',
        createdAtMs: 1,
        immutableGenerationId,
    });
    await prepareImmutablePluginGeneration({
        paths,
        sourceRootPath,
        record,
    });
    const locator = {
        module: './agent/runtime',
        export: 'createRuntime',
        runtimeApiVersion: 1 as const,
    };
    await persistValidatedAgentSessionRunnerFactories({
        paths,
        record,
        manifestAuthority: input.manifestAuthority,
        factories: [{
            localAgentId: 'opencode',
            locator,
            normalizedModulePath: 'agent/runtime.mjs',
            loadMode: 'immutable-js',
        }],
    });
    const binding = createAgentSessionRunnerFactoryBinding({
        v: 1,
        pluginId: manifest.id,
        pluginVersion: manifest.version,
        agentId: 'opencode',
        localAgentId: 'opencode',
        immutableGenerationId,
        locator,
        normalizedModulePath: 'agent/runtime.mjs',
        loadMode: 'immutable-js',
    });
    const executablePath = join(toolRootPath, 'opencode');
    await writeFile(executablePath, '', 'utf8');
    await chmod(executablePath, 0o700);
    return {
        paths,
        binding,
        executablePath,
        request: {
            contributionId: `${manifest.id}/agents/opencode`,
            serverId: 'opencode-server',
            immutableGenerationId,
            executable: {
                kind: 'systemTool' as const,
                id: 'opencode-cli',
            },
            environmentKeys: [],
        },
        processEnv: { PATH: toolRootPath },
        async cleanup() {
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(sourceRootPath, { recursive: true, force: true });
            await rm(toolRootPath, { recursive: true, force: true });
        },
    };
}

async function prepareProviderSupervisionFixture(input: Readonly<{
    manifestAuthority: 'external' | 'bundled_first_party';
}>) {
    const happyHomeDir = await mkdtemp(join(
        tmpdir(),
        'happier-provider-supervision-home-',
    ));
    const sourceRootPath = await mkdtemp(join(
        tmpdir(),
        'happier-provider-supervision-source-',
    ));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const manifest = CLIPROXYAPI_PLUGIN_MANIFEST;
    const executableBaseName = 'happier-cliproxyapi-managed';
    const executableName = process.platform === 'win32'
        ? `${executableBaseName}.exe`
        : executableBaseName;
    const executableBytes = '#!/bin/sh\nexit 0\n';
    await mkdir(join(sourceRootPath, '.happier-plugin'), {
        recursive: true,
    });
    await mkdir(join(sourceRootPath, 'tools', 'unpacked'), {
        recursive: true,
    });
    await writeFile(
        join(sourceRootPath, '.happier-plugin', 'plugin.json'),
        JSON.stringify(manifest),
        'utf8',
    );
    await writeFile(
        join(sourceRootPath, 'tools', 'unpacked', executableName),
        executableBytes,
        'utf8',
    );
    if (process.platform !== 'win32') {
        await chmod(
            join(sourceRootPath, 'tools', 'unpacked', executableName),
            0o755,
        );
    }
    const record = await createImmutablePluginGenerationRecordFromSource({
        pluginId: manifest.id,
        sourceRootPath,
        manifestRelativePath: '.happier-plugin/plugin.json',
        distribution: {
            kind: 'localPath',
            canonicalPath: sourceRootPath,
        },
        updatePolicy: 'manual',
        createdAtMs: 1,
        immutableGenerationId: 'provider-generation-p',
    });
    const prepared = await prepareImmutablePluginGeneration({
        paths,
        sourceRootPath,
        record,
    });
    if (input.manifestAuthority === 'external') {
        const distribution = {
            kind: 'localPath' as const,
            canonicalPath: sourceRootPath,
        };
        const installationState = await persistInstallationStateRevision({
            paths,
            state: {
                t: 'happier_plugin_installations_v1',
                schemaVersion: 1,
                revisionId: 'provider-supervision-state-p',
                createdAtMs: 1,
                plugins: {
                    [manifest.id]: {
                        enabled: true,
                        trust: {
                            pluginId: manifest.id,
                            distribution,
                            state: 'trusted',
                            approvedAtMs: 1,
                        },
                        source: { distribution },
                        updatePolicy: 'manual',
                        optionalAccess: [],
                    },
                },
                rollbackRetention: [],
            },
        });
        await mkdir(paths.stateDir, { recursive: true });
        await writeFile(paths.registryCurrentFilePath, JSON.stringify({
            t: 'happier_plugin_registry_commit_v1',
            schemaVersion: 1,
            revision: 1,
            transactionId: 'provider-supervision-commit-p',
            baseRevision: 0,
            installationState,
            pluginGenerations: { [manifest.id]: prepared.reference },
            createdAtMs: 1,
            creator: { pid: 1, instanceId: 'provider-supervision' },
        }), 'utf8');
    }
    const provider = (manifest.contributes.providers ?? [])[0]!;
    const managedRuntime = resolveProviderManagedRuntimeDeclarationV1({
        implementationIdentity: {
            pluginId: manifest.id,
            localId: provider.id,
        },
        managedRuntime: ProviderManagedRuntimeDeclarationV1Schema.parse(
            provider.managedRuntime,
        ),
    });
    const executable = {
        kind: 'packaged-runtime-binary' as const,
        directorySegments: ['tools', 'unpacked'],
        executableBaseName,
    };
    const bootstrap = RunnerDaemonManagedProviderBootstrapV1Schema.parse({
        v: 1,
        scope: {
            v: 1,
            sessionId: 'session-provider-p',
            runtimeBindingBasis: {
                v: 1,
                agentTargetKey: 'agent:acme-agent',
                connectionId: 'provider-connection-p',
                contributionKey: `${manifest.id}/${provider.id}`,
                runtimeCredentialTransport: null,
                prepared: { v: 1, materialization: 'spawnEnv' },
                adapterVersion: 1,
                agentSupport: {
                    acceptsProtocols: ['openai-responses'],
                    required: { streaming: true },
                    credentialSupport: {
                        supportsNoAuth: true,
                        apiKeyTransports: [],
                    },
                    authIsolation: {
                        suppressConnectedServiceIds: [],
                        ownedEnvKeys: [],
                    },
                    materialization: 'spawnEnv',
                    applyPolicy: 'restart_session',
                    supportsFreeformModelIds: true,
                },
                deployment: {
                    kind: 'managedLocal',
                    implementationIdentity: {
                        pluginId: manifest.id,
                        localId: provider.id,
                    },
                    managedRuntime,
                    purposeBindings: { v: 1, bindings: [] },
                },
                endpoint: {
                    endpointTemplateId: 'cliproxyapi-openai-responses',
                    protocol: 'openai-responses',
                    publicHeaders: {},
                },
                credentialAuthorization: {
                    connectionSecurityFingerprint: 'security-p',
                    grantFingerprint: 'grant-p',
                },
            },
            pluginId: manifest.id,
            providerLocalId: provider.id,
            activationGeneration: 'activation-p',
            immutableGenerationId: record.immutableGenerationId,
            manifestAuthority: input.manifestAuthority,
            operationClaimId: 'provider-operation-p',
        },
        requestAuth: {
            capabilityPath: 'provider-request-auth-p',
            requestAuthUses: managedRuntime.requestAuthUses,
        },
        providerPluginHardRevocationRevisionAtAdmission: 0,
    });
    const request = {
        contributionId: `${manifest.id}/providers/${provider.id}`,
        operationClaimId: bootstrap.scope.operationClaimId,
        serverId: 'cliproxyapi-managed',
        immutableGenerationId: bootstrap.scope.immutableGenerationId,
        executable,
        environmentKeys: [
            'HAPPIER_CLIPROXYAPI_DOWNSTREAM_BEARER',
            'HAPPIER_CLIPROXYAPI_REQUEST_AUTH_CAPABILITY_PATH',
            'HOST',
            'PORT',
        ],
    };
    return {
        paths,
        bootstrap,
        request,
        expectedLaunch: {
            serverId: request.serverId,
            executable: request.executable,
            environmentKeys: request.environmentKeys,
        },
        executablePath: await realpath(join(
            prepared.rootPath,
            'tools',
            'unpacked',
            executableName,
        )),
        async cleanup() {
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(sourceRootPath, { recursive: true, force: true });
        },
    };
}

describe('runner managed-server supervision authorization', () => {
    it('projects a detached exact Provider spawn input while leaving attach unstamped', () => {
        const spawn = {
            id: 'provider-runtime',
            mode: {
                kind: 'spawn',
                launch: {
                    executable: {
                        kind: 'packaged-runtime-binary',
                        directorySegments: ['tools', 'unpacked'],
                        executableBaseName: 'provider-runtime',
                    },
                    env: { Z_LAST: 'opaque', A_FIRST: 'opaque' },
                },
                endpoint: {
                    kind: 'assignAndInject',
                    port: { kind: 'allocated' },
                    inject: {
                        portEnvironmentKey: 'PORT',
                        baseUrlEnvironmentKey: 'BASE_URL',
                    },
                },
            },
            clientAccess: {
                kind: 'hostBasic',
                username: 'opencode',
                injectPasswordEnvironmentKey: 'OPENCODE_SERVER_PASSWORD',
            },
            requestAuth: {
                kind: 'connectedAccountCapabilityPath',
                injectEnvironmentKey: 'REQUEST_AUTH_CAPABILITY',
            },
            credentialBindings: [{
                purpose: 'provider.inference',
                request: { kind: 'environment', keys: ['TOKEN'] },
                injection: {
                    kind: 'environment',
                    targetEnvironmentKeysByMaterializedKey: {
                        TOKEN: 'UPSTREAM_TOKEN',
                    },
                },
            }, {
                purpose: 'provider.files',
                request: { kind: 'files', fileIds: ['config'] },
                injection: {
                    kind: 'files',
                    pathsByFileId: {
                        config: { environmentKey: 'UPSTREAM_CONFIG' },
                    },
                },
            }],
        } as const satisfies ManagedServiceSpec;

        expect(projectRunnerManagedProviderServerLaunchAuthority(spawn))
            .toEqual({
                serverId: 'provider-runtime',
                executable: {
                    kind: 'packaged-runtime-binary',
                    directorySegments: ['tools', 'unpacked'],
                    executableBaseName: 'provider-runtime',
                },
                environmentKeys: [
                    'A_FIRST',
                    'BASE_URL',
                    'OPENCODE_SERVER_PASSWORD',
                    'PORT',
                    'REQUEST_AUTH_CAPABILITY',
                    'UPSTREAM_CONFIG',
                    'UPSTREAM_TOKEN',
                    'Z_LAST',
                ],
            });
        expect(projectRunnerManagedProviderServerLaunchAuthority({
            id: 'attached-provider-runtime',
            mode: { kind: 'attach', baseUrl: 'http://127.0.0.1:4312' },
        })).toBeNull();
    });

    it('authorizes a direct retained Agent binding from its exact generation', async () => {
        const fixture = await prepareOpenCodeAgentSupervisionFixture({
            pluginId: OPENCODE_PLUGIN_MANIFEST.id,
            manifestAuthority: 'bundled_first_party',
            engines: OPENCODE_PLUGIN_MANIFEST.engines,
        });
        try {
            await expect(authorizeRunnerManagedServiceSupervision({
                paths: fixture.paths,
                binding: fixture.binding,
                request: fixture.request,
                processEnv: fixture.processEnv,
            })).resolves.toMatchObject({
                launch: {
                    kind: 'daemonResolved',
                    value: { command: fixture.executablePath },
                },
            });
            await expect(authorizeRunnerManagedServiceSupervision({
                paths: fixture.paths,
                binding: fixture.binding,
                request: {
                    ...fixture.request,
                    immutableGenerationId: 'different-generation',
                },
                processEnv: fixture.processEnv,
            })).rejects.toMatchObject({
                code: 'plugin_managed_server_contribution_denied',
            });
        } finally {
            await fixture.cleanup();
        }
    });

    it('authorizes the exact admitted Provider P bootstrap and rejects claim or launch mismatches', async () => {
        const fixture = await prepareProviderSupervisionFixture({
            manifestAuthority: 'external',
        });
        try {
            await expect(authorizeRunnerManagedProviderServerSupervision({
                paths: fixture.paths,
                sessionId: fixture.bootstrap.scope.sessionId,
                bootstrap: fixture.bootstrap,
                expectedLaunch: fixture.expectedLaunch,
                request: fixture.request,
            })).resolves.toEqual({
                launch: {
                    kind: 'daemonResolved',
                    value: { command: fixture.executablePath },
                },
            });
            await expect(authorizeRunnerManagedProviderServerSupervision({
                paths: fixture.paths,
                sessionId: fixture.bootstrap.scope.sessionId,
                bootstrap: fixture.bootstrap,
                expectedLaunch: fixture.expectedLaunch,
                request: {
                    ...fixture.request,
                    operationClaimId: 'different-claim',
                },
            })).rejects.toMatchObject({
                code: 'plugin_managed_server_operation_claim_denied',
            });
            await expect(authorizeRunnerManagedProviderServerSupervision({
                paths: fixture.paths,
                sessionId: fixture.bootstrap.scope.sessionId,
                bootstrap: fixture.bootstrap,
                expectedLaunch: {
                    ...fixture.expectedLaunch,
                    environmentKeys: [],
                },
                request: fixture.request,
            })).rejects.toMatchObject({
                code: 'plugin_managed_server_launch_denied',
            });
        } finally {
            await fixture.cleanup();
        }
    });

    it('keeps a bundled first-party Provider bootstrap bound to runner packaged runtime', async () => {
        const fixture = await prepareProviderSupervisionFixture({
            manifestAuthority: 'bundled_first_party',
        });
        try {
            await expect(authorizeRunnerManagedProviderServerSupervision({
                paths: fixture.paths,
                sessionId: fixture.bootstrap.scope.sessionId,
                bootstrap: fixture.bootstrap,
                expectedLaunch: fixture.expectedLaunch,
                request: fixture.request,
            })).resolves.toEqual({
                launch: { kind: 'runnerPackagedRuntime' },
            });
        } finally {
            await fixture.cleanup();
        }
    });
});
