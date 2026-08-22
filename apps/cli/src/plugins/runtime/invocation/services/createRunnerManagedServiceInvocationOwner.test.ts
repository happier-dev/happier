import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import {
    ingestPluginManifestV2,
    ProviderConnectionIdSchema,
    type ProviderRuntimeBindingBasisV1,
} from '@happier-dev/protocol';
import {
    PLUGIN_MANIFEST as OPENCODE_PLUGIN_MANIFEST,
} from '@happier-dev/plugins-opencode/manifest';
import type {
    ManagedServiceRequest,
    ManagedServiceResponse,
} from '@happier-dev/plugin-sdk/managed-services';

import type {
    RunnerManagedProviderCustodyClaimV1,
} from '@/agent/runtime/session/process/runnerManagedServicesCustody';
import {
    createManagedServiceEndpointProjectionV1,
    type ManagedServiceEndpointProjectionInputV1,
} from './managedServiceEndpointProjection';
import {
    createRunnerManagedServiceEndpointProjectionBinding,
    createRunnerManagedServiceInvocationOwner,
} from './createRunnerManagedServiceInvocationOwner';
import {
    createAgentSessionRunnerFactoryBinding,
} from '@/plugins/runtime/runner/agentSessionRunnerFactoryBinding';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
    createImmutablePluginGenerationRecordFromSource,
    persistValidatedAgentSessionRunnerFactories,
    prepareImmutablePluginGeneration,
} from '@/plugins/store/registry/generationStore';

function projectionInput(baseUrl = 'http://127.0.0.1:4312') {
    const endpoint = new URL(baseUrl);
    return {
        sessionId: 'session-one',
        pluginId: 'opencode',
        contributionId: 'opencode/agent',
        serverId: 'opencode-server',
        instanceId: 'instance-one',
        immutableGenerationId: 'generation-one',
        custodyOwner: 'sessionRunner' as const,
        mode: 'managedSpawn' as const,
        endpoint: {
            baseUrl,
            host: '127.0.0.1' as const,
            port: Number(endpoint.port),
        },
        process: {
            pid: 42,
            startIdentity: 'runner-start-42',
        },
        createdAtMs: 1_000,
    };
}

function exactHandleClaim(): RunnerManagedProviderCustodyClaimV1 {
    const runtimeBindingBasis: ProviderRuntimeBindingBasisV1 = {
        v: 1,
        deployment: {
            kind: 'managedLocal',
            implementationIdentity: {
                pluginId: 'opencode',
                localId: 'opencode',
            },
            managedRuntime: {
                kind: 'managed',
                dependencies: [],
                endpointTemplateIds: ['messages'],
                connectedAccounts: [],
                requestAuthUses: [],
            },
            purposeBindings: { v: 1, bindings: [] },
        },
        agentTargetKey: 'backend:opencode',
        connectionId: ProviderConnectionIdSchema.parse('connection-opencode'),
        contributionKey: 'opencode/opencode',
        endpoint: {
            endpointTemplateId: 'messages',
            protocol: 'openai-chat',
            publicHeaders: {},
        },
        runtimeCredentialTransport: null,
        prepared: { v: 1, materialization: 'spawnEnv' },
        adapterVersion: 1,
        credentialAuthorization: {
            connectionSecurityFingerprint: 'connection-security',
            grantFingerprint: 'connection-grant',
        },
        agentSupport: {
            acceptsProtocols: ['openai-chat'],
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
    };
    return Object.freeze({
        v: 1,
        sessionId: 'session-one',
        runtimeBindingBasis,
        pluginId: 'opencode',
        providerLocalId: 'opencode',
        activationGeneration: 'opencode-generation',
        immutableGenerationId: 'opencode-generation',
        manifestAuthority: 'external',
        operationClaimId: 'session-demand:session-one:opencode-generation',
    });
}

function projectedRequestResolver(
    observed: ManagedServiceRequest[],
): (
    projection: ReturnType<typeof createManagedServiceEndpointProjectionV1>,
) => (request: ManagedServiceRequest) => Promise<ManagedServiceResponse> {
    return () => async (request) => {
        observed.push(request);
        return Object.freeze({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: Object.freeze({ 'content-type': 'text/plain' }),
            body: new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('endpoint-body'));
                    controller.close();
                },
            }),
        });
    };
}

/**
 * The owner derives HostAccess from the ingested generation manifest, so the
 * expectation reads the same canonical parse of the fixture bytes rather than
 * the cold `definePlugin` declaration, whose `hostAccess` is optional.
 */
function parsedOpenCodeHostAccess() {
    const parsed = ingestPluginManifestV2(OPENCODE_PLUGIN_MANIFEST);
    if (!parsed.ok) {
        throw new Error('Expected the OpenCode fixture manifest to be valid');
    }
    return parsed.manifest.hostAccess;
}

async function prepareRetainedAgentFixture() {
    const happyHomeDir = await mkdtemp(join(
        tmpdir(),
        'happier-managed-service-owner-home-',
    ));
    const sourceRootPath = await mkdtemp(join(
        tmpdir(),
        'happier-managed-service-owner-source-',
    ));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const moduleBytes = 'export function createRuntime() { throw new Error("unused"); }';
    await mkdir(join(sourceRootPath, '.happier-plugin'), {
        recursive: true,
    });
    await mkdir(join(sourceRootPath, 'agent'), { recursive: true });
    await writeFile(
        join(sourceRootPath, '.happier-plugin', 'plugin.json'),
        JSON.stringify(OPENCODE_PLUGIN_MANIFEST),
        'utf8',
    );
    await writeFile(
        join(sourceRootPath, 'agent', 'runtime.mjs'),
        moduleBytes,
        'utf8',
    );
    const immutableGenerationId = `managed-service-owner-${createHash('sha256')
        .update(sourceRootPath)
        .digest('hex')
        .slice(0, 16)}`;
    const record = await createImmutablePluginGenerationRecordFromSource({
        pluginId: OPENCODE_PLUGIN_MANIFEST.id,
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
        manifestAuthority: 'bundled_first_party',
        factories: [{
            localAgentId: 'opencode',
            locator,
            normalizedModulePath: 'agent/runtime.mjs',
            loadMode: 'immutable-js',
        }],
    });
    const retainedAgent = createAgentSessionRunnerFactoryBinding({
        v: 1,
        pluginId: OPENCODE_PLUGIN_MANIFEST.id,
        pluginVersion: OPENCODE_PLUGIN_MANIFEST.version,
        agentId: 'opencode',
        localAgentId: 'opencode',
        immutableGenerationId,
        locator,
        normalizedModulePath: 'agent/runtime.mjs',
        loadMode: 'immutable-js',
    });
    return {
        happyHomeDir,
        sourceRootPath,
        paths,
        retainedAgent,
        async cleanup() {
            await rm(happyHomeDir, { recursive: true, force: true });
            await rm(sourceRootPath, { recursive: true, force: true });
        },
    };
}

describe('runner managed-service invocation owner endpoint binding', () => {
    it('derives the verified Agent declaration and HostAccess from retained G without a caller-supplied declaration', async () => {
        const fixture = await prepareRetainedAgentFixture();
        let owner: Awaited<ReturnType<
            typeof createRunnerManagedServiceInvocationOwner
        >> | null = null;
        try {
            owner = await createRunnerManagedServiceInvocationOwner({
                paths: fixture.paths,
                authority: {
                    happyHomeDir: fixture.happyHomeDir,
                    publicReleaseRing: 'stable',
                    path: join(fixture.happyHomeDir, 'authority.json'),
                    sessionId: 'session-service-owner',
                    runner: {
                        pid: 1,
                        processStartTimeMs: 1,
                        processCommandHash: 'a'.repeat(64),
                        snapshotIdentity: 'runner-service-owner',
                    },
                    retainedAgent: fixture.retainedAgent,
                },
                retainedAgent: fixture.retainedAgent,
            });

            expect(owner.verifiedAgentDeclaration).toMatchObject({
                definition: {
                    id: (OPENCODE_PLUGIN_MANIFEST.contributes.agents ?? [])[0]!.id,
                },
                provenance: 'first_party',
            });
            const declaredHostAccess = parsedOpenCodeHostAccess();
            expect(owner.hostAccessRequests.map(({ required }) => required))
                .toEqual([
                    ...declaredHostAccess.required.map(() => true),
                    ...declaredHostAccess.optional.map(() => false),
                ]);
            expect(owner.hostAccessRequests.map(({ request }) => request.capability))
                .toEqual([
                    ...declaredHostAccess.required.map(
                        (request) => request.capability,
                    ),
                    ...declaredHostAccess.optional.map(
                        (request) => request.capability,
                    ),
                ]);
        } finally {
            await owner?.owners.dispose();
            await fixture.cleanup();
        }
    });

    it('keeps a projected endpoint bound to exact direct Session, contribution, and retained generation facts', async () => {
        const observed: ManagedServiceRequest[] = [];
        const remotePublish = vi.fn(async (
            input: ManagedServiceEndpointProjectionInputV1,
        ) =>
            createManagedServiceEndpointProjectionV1(input).projectionToken);
        const binding = createRunnerManagedServiceEndpointProjectionBinding({
            publishEndpointProjection: remotePublish,
            releaseEndpointProjection: async () => true,
        }, {
            resolveProjectedManagedServiceRequest: projectedRequestResolver(observed),
        });
        const input = projectionInput();
        const projection = createManagedServiceEndpointProjectionV1(input);

        await expect(binding.publishEndpointProjection(input)).resolves.toBe(
            projection.projectionToken,
        );
        const read = binding.bindExactEndpoint({
            identity: {
                pluginId: projection.pluginId,
                contributionId: projection.contributionId,
                sessionId: projection.sessionId,
                immutableGenerationId: projection.immutableGenerationId,
            },
            signal: new AbortController().signal,
        });
        expect(read).not.toBeNull();
        const response = await read!({
            pathAndQuery: '/session?limit=1',
            headers: { accept: 'application/json' },
        });
        expect(response.status).toBe(200);
        expect(Buffer.from((await response.body!.getReader().read()).value!).toString())
            .toBe('endpoint-body');
        expect(observed).toHaveLength(1);
        expect(remotePublish).toHaveBeenCalledWith(input);

        for (const identity of [
            { ...projection, pluginId: 'other-plugin' },
            { ...projection, contributionId: 'opencode/other' },
            { ...projection, sessionId: 'other-session' },
            { ...projection, immutableGenerationId: 'other-generation' },
        ]) {
            expect(binding.bindExactEndpoint({
                identity: {
                    pluginId: identity.pluginId,
                    contributionId: identity.contributionId,
                    sessionId: identity.sessionId,
                    immutableGenerationId: identity.immutableGenerationId,
                },
                signal: new AbortController().signal,
            })).toBeNull();
        }
    });

    it('rejects a daemon publication result that does not exactly reproduce the direct projection token', async () => {
        const binding = createRunnerManagedServiceEndpointProjectionBinding({
            publishEndpointProjection: async () => 'f'.repeat(64),
            releaseEndpointProjection: async () => true,
        });

        await expect(binding.publishEndpointProjection(projectionInput()))
            .rejects.toMatchObject({
                code: 'plugin_managed_server_projection_identity_mismatch',
            });
    });

    it('preserves exact-handle currentness and cancellation without endpoint projection authority', async () => {
        const request = vi.fn(async () => Object.freeze({
            ok: true,
            status: 201,
            statusText: 'Created',
            headers: Object.freeze({}),
            body: new ReadableStream<Uint8Array>({}),
        }));
        const isCurrent = vi.fn(async () => true);
        const binding = createRunnerManagedServiceEndpointProjectionBinding({
            publishEndpointProjection: async (input) =>
                createManagedServiceEndpointProjectionV1(input).projectionToken,
            releaseEndpointProjection: async () => true,
        }, {
            resolveExactHandleRequestPort: () => Object.freeze({
                request,
                isCurrent,
            }),
        });
        const route = {
            kind: 'exactHandle' as const,
            claim: exactHandleClaim(),
            serviceId: 'provider-wrapper',
        };
        const requestId = '00000000-0000-4000-8000-000000000001';
        await expect(binding.endpointReadPort.open({
            v: 1,
            requestId,
            route,
            pathAndQuery: '/session',
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            bodyBase64: Buffer.from('{"hello":true}').toString('base64'),
            timeoutMs: 1_000,
        })).resolves.toMatchObject({ status: 'opened' });
        await expect(binding.endpointReadPort.cancel({
            v: 1,
            requestId,
            route,
        })).resolves.toMatchObject({ status: 'cancelled', cancelled: true });
        expect(request).toHaveBeenCalledOnce();
        expect(isCurrent).toHaveBeenCalled();
    });
});
