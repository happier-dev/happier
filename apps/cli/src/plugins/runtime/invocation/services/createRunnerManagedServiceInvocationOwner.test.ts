import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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
import {
    createPluginManifestV2Fixture,
} from '@/plugins/testkit/manifestV2Fixture';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import { resolveAgentContributionQualifiedId } from '@/plugins/projection/registry/agentRoutingIdentity';
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
        sourceCustody: {
            kind: 'managed' as const,
            immutableGenerationId: 'occurrenceId-one',
            installSource: 'localPath' as const,
        },
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
            gatewayPlacement: { kind: 'sessionMachine' },
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
        agentTargetKey: 'agent:happier.agent.opencode/opencode',
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
        occurrenceId: 'opencode-occurrence',
        sourceCustody: {
            kind: 'managed' as const,
            immutableGenerationId: 'opencode-occurrenceId',
            installSource: 'localPath' as const,
        },
        manifestAuthority: 'external',
        operationClaimId: 'session-demand:session-one:opencode-occurrenceId',
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
 * The owner derives HostAccess from the ingested occurrenceId manifest, so the
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
    const manifest = {
        ...OPENCODE_PLUGIN_MANIFEST,
        id: 'acme.opencode-managed-service-owner',
    };
    const moduleBytes = 'export function createRuntime() { throw new Error("unused"); }';
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
    const immutableGenerationId = `managed-service-owner-${createHash('sha256')
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
        updatePolicy: 'allowed',
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
        manifestAuthority: 'external',
        factories: [{
            localAgentId: 'opencode',
            locator,
            normalizedModulePath: 'agent/runtime.mjs',
            loadMode: 'immutable-js',
        }],
    });
    const retainedAgent = createAgentSessionRunnerFactoryBinding({
        v: 1,
        pluginId: manifest.id,
        pluginVersion: manifest.version,
        agentId: 'opencode',
        localAgentId: 'opencode',
        sourceCustody: {
            kind: 'managed',
            immutableGenerationId,
            installSource: 'localPath',
        },
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

async function prepareDevelopmentRetainedAgentFixture() {
    const happyHomeDir = await mkdtemp(join(
        tmpdir(),
        'happier-managed-service-owner-development-home-',
    ));
    const sourceRootPath = await realpath(await mkdtemp(join(
        tmpdir(),
        'happier-managed-service-owner-development-source-',
    )));
    const paths = resolvePluginStorePaths({ happyHomeDir });
    const pluginId = 'acme.development-service-owner';
    const pluginVersion = '1.0.0';
    const localAgentId = 'opencode';
    const manifest = createPluginManifestV2Fixture({
        id: pluginId,
        version: pluginVersion,
        contributes: {
            agents: [{
                id: localAgentId,
                title: 'Development service owner',
                runtime: { kind: 'custom' },
                primary: 'sessions',
                capabilities: {
                    sessions: {
                        open: ['create'],
                        delivery: ['newTurn'],
                        cancel: true,
                    },
                },
            }],
        },
    });
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
        'export function createRuntime() { throw new Error("unused"); }',
        'utf8',
    );
    const locator = {
        module: './agent/runtime',
        export: 'createRuntime',
        runtimeApiVersion: 1 as const,
    };
    const retainedAgent = createAgentSessionRunnerFactoryBinding({
        v: 1,
        pluginId,
        pluginVersion,
        agentId: `${pluginId}/${localAgentId}`,
        localAgentId,
        sourceCustody: {
            kind: 'development',
            registeredRootId: sourceRootPath,
        },
        locator,
        normalizedModulePath: 'agent/runtime.mjs',
        loadMode: 'source-ts',
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
                provenance: 'external',
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
            const lifetime = new AbortController();
            const local = owner.owners.createOperationServices({
                plugin: {
                    id: fixture.retainedAgent.pluginId,
                    version: fixture.retainedAgent.pluginVersion,
                },
                contribution: {
                    id: fixture.retainedAgent.localAgentId,
                    qualifiedId: resolveAgentContributionQualifiedId({
                        pluginId: fixture.retainedAgent.pluginId,
                        localId: fixture.retainedAgent.localAgentId,
                    }),
                },
                occurrenceId: fixture.retainedAgent.sourceCustody.kind === 'managed'
                    ? fixture.retainedAgent.sourceCustody.immutableGenerationId
                    : fixture.sourceRootPath,
                sourceCustody: fixture.retainedAgent.sourceCustody,
                correlationId: 'unadmitted-bootstrap',
                surface: 'agent',
                signal: lifetime.signal,
                isOccurrenceCurrent: () => !lifetime.signal.aborted,
            }, {
                filesystemRoots: {
                    pluginData: join(fixture.happyHomeDir, 'plugin-data'),
                    workspace: fixture.sourceRootPath,
                    projects: new Map(),
                },
                hostAccessRequests: owner.hostAccessRequests,
            });
            // An Agent operation has no admitted Machine bootstrap credential.
            // Its real local facade must refuse, never become an absent service
            // or acquire a daemon-backed bootstrap authority.
            expect(local.availability('machineProvisioners')).toEqual({
                status: 'unavailable', code: 'plugin_service_unavailable',
            });
            expect(() => local.machineProvisioners.materializeBootstrapCredential({ kind: 'bytes' }))
                .toThrow(expect.objectContaining({ code: 'plugin_service_unavailable' }));
            let effectReached = false;
            expect(() => local.machineProvisioners.withBootstrapCredentialFile({ relativePath: 'bootstrap/key' }, async () => {
                effectReached = true;
            })).toThrow(expect.objectContaining({ code: 'plugin_service_unavailable' }));
            expect(effectReached).toBe(false);
            // The declaration-only pre-bridge Exec is not an Agent launch
            // authority. Only the rebound original daemon Exec may publish
            // a usable managedServices facade.
            expect(local.availability('managedServices')).toEqual({
                status: 'unavailable', code: 'plugin_service_unavailable',
            });
            await expect(local.managedServices.supervise({
                id: 'unbound-agent-server',
                mode: { kind: 'spawn', launch: { executable: { kind: 'systemTool', id: 'unbound' }, args: [] }, endpoint: { kind: 'none' } },
                healthCheck: { kind: 'none' },
            })).rejects.toMatchObject({ code: 'plugin_managed_service_unavailable' });
        } finally {
            await owner?.owners.dispose();
            await fixture.cleanup();
        }
    });

    it('requires and accepts the daemon-attested occurrence for a development Agent owner', async () => {
        const fixture = await prepareDevelopmentRetainedAgentFixture();
        let owner: Awaited<ReturnType<
            typeof createRunnerManagedServiceInvocationOwner
        >> | null = null;
        const authority = {
            happyHomeDir: fixture.happyHomeDir,
            publicReleaseRing: 'stable' as const,
            path: join(fixture.happyHomeDir, 'authority.json'),
            sessionId: 'session-development-service-owner',
            runner: {
                pid: 1,
                processStartTimeMs: 1,
                processCommandHash: 'a'.repeat(64),
                snapshotIdentity: 'runner-development-service-owner',
            },
            retainedAgent: fixture.retainedAgent,
        };
        try {
            owner = await createRunnerManagedServiceInvocationOwner({
                paths: fixture.paths,
                authority,
                retainedAgent: fixture.retainedAgent,
                developmentOccurrenceId:
                    'occurrence:development-service-owner:current',
            });
            expect(owner.verifiedAgentDeclaration.definition.id)
                .toBe('opencode');

            await expect(createRunnerManagedServiceInvocationOwner({
                paths: fixture.paths,
                authority,
                retainedAgent: fixture.retainedAgent,
            })).rejects.toThrow(
                'Development retained Agent binding requires a daemon-attested current occurrence',
            );
        } finally {
            await owner?.owners.dispose();
            await fixture.cleanup();
        }
    });

    it('keeps a projected endpoint bound to exact direct Session, contribution, and retained occurrenceId facts', async () => {
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
                sourceCustody: projection.sourceCustody,
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
            {
                ...projection,
                sourceCustody: {
                    kind: 'managed' as const,
                    immutableGenerationId: 'other-occurrenceId',
                    installSource: 'localPath' as const,
                },
            },
        ]) {
            expect(binding.bindExactEndpoint({
                identity: {
                    pluginId: identity.pluginId,
                    contributionId: identity.contributionId,
                    sessionId: identity.sessionId,
                    sourceCustody: identity.sourceCustody,
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

    function exactHandleReadHarness(chunks: readonly Uint8Array[]) {
        const request = vi.fn(async () => Object.freeze({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: Object.freeze({}),
            body: new ReadableStream<Uint8Array>({
                start(controller) {
                    for (const chunk of chunks) controller.enqueue(chunk);
                    controller.close();
                },
            }),
        }));
        const binding = createRunnerManagedServiceEndpointProjectionBinding({
            publishEndpointProjection: async (input) =>
                createManagedServiceEndpointProjectionV1(input).projectionToken,
            releaseEndpointProjection: async () => true,
        }, {
            resolveExactHandleRequestPort: () => Object.freeze({
                request,
                isCurrent: async () => true,
            }),
        });
        const route = {
            kind: 'exactHandle' as const,
            claim: exactHandleClaim(),
            serviceId: 'provider-wrapper',
        };
        const open = async (requestId: string) => await binding.endpointReadPort.open({
            v: 1,
            requestId,
            route,
            pathAndQuery: '/session/events',
            method: 'GET',
            headers: {},
            timeoutMs: 1_000,
        });
        return { binding, route, open };
    }

    // The public request contract gives post-header body lifetime to the caller signal and the
    // exact handle. A backpressured consumer that spends a long time on one chunk is still a
    // current caller, so the transport must not decide on its own that the stream is abandoned.
    it('keeps an admitted response readable across a long consumer gap', async () => {
        vi.useFakeTimers();
        try {
            const { binding, route, open } = exactHandleReadHarness([
                new Uint8Array([1]),
                new Uint8Array([2]),
            ]);
            const requestId = '00000000-0000-4000-8000-0000000000a1';

            await expect(open(requestId)).resolves.toMatchObject({ status: 'opened' });
            await expect(binding.endpointReadPort.next({ v: 1, requestId, route }))
                .resolves.toMatchObject({ status: 'chunk' });

            await vi.advanceTimersByTimeAsync(600_000);

            await expect(binding.endpointReadPort.next({ v: 1, requestId, route }))
                .resolves.toMatchObject({ status: 'chunk' });
        } finally {
            vi.useRealTimers();
        }
    });

    it('admits a finite endpoint read once and consumes chunks without permission revalidation', async () => {
        const input = projectionInput();
        const projection = createManagedServiceEndpointProjectionV1(input);
        let current = true;
        const claimEndpointRead = vi.fn(async () => {
            if (!current) throw new Error('Endpoint admission withdrawn');
            return { daemonCapability: 'finite-admitted-capability' };
        });
        // These callbacks are the runner-to-daemon transport boundary; the
        // endpoint routing, active-read record and body consumption stay real.
        const validateEndpointRead = vi.fn(async () => current);
        const binding = createRunnerManagedServiceEndpointProjectionBinding({
            publishEndpointProjection: async value => createManagedServiceEndpointProjectionV1(value).projectionToken,
            releaseEndpointProjection: async () => true,
        }, {
            claimEndpointRead,
            validateEndpointRead,
            resolveProjectedManagedServiceRequest: () => async () => ({
                ok: true, status: 200, statusText: 'OK', headers: {},
                body: new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(new Uint8Array([1]));
                        controller.enqueue(new Uint8Array([2]));
                        controller.close();
                    },
                }),
            }),
        });
        await binding.publishEndpointProjection(input);
        const requestId = '00000000-0000-4000-8000-0000000000b1';
        const route = { kind: 'endpointProjection' as const, projectionToken: projection.projectionToken };
        const open = (id: string) => binding.endpointReadPort.open({
            v: 1, requestId: id,
            route: { kind: 'endpointProjection', projection },
            pathAndQuery: '/session', method: 'GET', headers: {},
        });
        await expect(open(requestId)).resolves.toMatchObject({ status: 'opened' });
        current = false;
        for (const value of [1, 2]) {
            await expect(binding.endpointReadPort.next({ v: 1, requestId, route }))
                .resolves.toMatchObject({ status: 'chunk', dataBase64: Buffer.from([value]).toString('base64') });
        }
        await expect(binding.endpointReadPort.next({ v: 1, requestId, route })).resolves.toMatchObject({ status: 'end' });
        expect(claimEndpointRead).toHaveBeenCalledTimes(1);
        expect(validateEndpointRead).not.toHaveBeenCalled();
        await expect(open('00000000-0000-4000-8000-0000000000b2')).resolves.toMatchObject({ status: 'unavailable' });
    });

    it('keeps caller-owned concurrent reads admitted and independently cancellable', async () => {
        const { binding, route, open } = exactHandleReadHarness([new Uint8Array([1])]);
        const requestIdFor = (index: number) =>
            `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

        for (let index = 0; index < 129; index += 1) {
            await expect(open(requestIdFor(index))).resolves.toMatchObject({ status: 'opened' });
        }

        await expect(binding.endpointReadPort.cancel({ v: 1, requestId: requestIdFor(0), route }))
            .resolves.toMatchObject({ status: 'cancelled', cancelled: true });
        await expect(binding.endpointReadPort.next({ v: 1, requestId: requestIdFor(128), route }))
            .resolves.toMatchObject({ status: 'chunk' });
        await expect(open(requestIdFor(9_999))).resolves.toMatchObject({ status: 'opened' });
        for (let index = 1; index < 129; index += 1) {
            await binding.endpointReadPort.cancel({ v: 1, requestId: requestIdFor(index), route });
        }
        await binding.endpointReadPort.cancel({ v: 1, requestId: requestIdFor(9_999), route });
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
        const openRequest = {
            v: 1 as const,
            requestId,
            route,
            interactive: true as const,
            pathAndQuery: '/session',
            method: 'POST' as const,
            headers: { 'content-type': 'application/json' },
            bodyBase64: Buffer.from('{"hello":true}').toString('base64'),
            timeoutMs: 1_000,
        };
        await expect(binding.endpointReadPort.open(openRequest)).resolves.toMatchObject({ status: 'opened' });
        await expect(binding.endpointReadPort.cancel({
            v: 1,
            requestId,
            route,
        })).resolves.toMatchObject({ status: 'cancelled', cancelled: true });
        expect(request).toHaveBeenCalledOnce();
        expect(request).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({ interactive: true }),
        }));
        expect(isCurrent).toHaveBeenCalled();
    });
});
