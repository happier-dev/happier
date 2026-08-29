import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
    ProviderConnectionIdSchema,
    type ProviderRuntimeBindingBasisV1,
} from '@happier-dev/protocol';
import type {
    AgentRuntime,
} from '@happier-dev/plugin-sdk/agents/runtime';
import type {
    ManagedServiceHandle,
    ManagedServiceSnapshot,
    ManagedServices,
} from '@happier-dev/plugin-sdk/managed-services';

const mocks = vi.hoisted(() => ({
    readAuthority: vi.fn(),
    loadFactory: vi.fn(),
    externalSessionsCompanion: null as unknown,
    dispatch: vi.fn(),
    resolveTurnContributions: vi.fn(),
    admitSessionInput: vi.fn(),
    authorizeModelTransition: vi.fn(),
    createOperationServices: vi.fn(),
    createRunnerManagedServiceInvocationOwner: vi.fn(),
    verifiedAgentProvenance: 'first_party' as 'first_party' | 'external',
    bindManagedServicesCustodyRequestPort: vi.fn(),
    bindManagedServices: vi.fn(),
    resolveAuthorizedManagedProviderServices: vi.fn(),
    readCurrentProviderPluginHardRevocationRevision: vi.fn(),
    projectManagedProviderEndpointAccess: vi.fn(),
    bindAgentExternalSessionsManagedEndpoint: vi.fn(),
    managedEndpointRead: vi.fn(),
    updateSessionMarkerRunnerManagedProviderAuthority: vi.fn(),
    attachExactRunnerRetainedPluginGenerations: vi.fn(),
    readCurrentPluginImmutableGenerationIntegrityCurrentness: vi.fn(),
    readPrivateBearerFile: vi.fn(),
    createRunnerAgentDaemonFacets: vi.fn(),
    facetBindSession: vi.fn(),
    facetVoiceResolveDeclaration: vi.fn(),
    disposeDaemonFacets: vi.fn(),
    disposeInvocationServices: vi.fn(),
    prepareRunnerDaemonPluginServices: vi.fn(),
}));

vi.mock('@/daemon/agentRuntime/sessionBridgeAuthorization', () => ({
    readCurrentRunnerAgentRuntimeDaemonServiceAuthority:
        mocks.readAuthority,
}));

vi.mock('@/daemon/sessionRegistry', () => ({
    updateSessionMarkerRunnerManagedProviderAuthority:
        mocks.updateSessionMarkerRunnerManagedProviderAuthority,
}));
vi.mock('@/plugins/store/registry/generationCustodyRetirement', () => ({
    attachExactRunnerRetainedPluginGenerations:
        mocks.attachExactRunnerRetainedPluginGenerations,
}));
vi.mock('@/plugins/store/registry/generationStore', () => ({
    readCurrentPluginImmutableGenerationIntegrityCurrentness:
        mocks
            .readCurrentPluginImmutableGenerationIntegrityCurrentness,
}));
vi.mock('@/plugins/runtime/runner/loadRetainedAgentRuntimeLeaf', () => ({
    loadRetainedAgentRuntimeLeaf: async (...args: readonly unknown[]) => ({
        factory: await mocks.loadFactory(...args),
        ...(mocks.externalSessionsCompanion
            ? { externalSessions: mocks.externalSessionsCompanion }
            : {}),
    }),
}));
vi.mock('./agentRuntimeDaemonServiceAuthorityClient', () => ({
    dispatchCurrentAgentRuntimeDaemonServiceRequest: mocks.dispatch,
    dispatchCurrentRunnerDaemonPluginService: mocks.dispatch,
    isCurrentRunnerAgentRuntimeDaemonServiceAuthorityTransition:
        vi.fn(() => false),
    resolveCurrentAgentRuntimeDaemonTurnContributions:
        mocks.resolveTurnContributions,
    admitCurrentRunnerSessionInput: mocks.admitSessionInput,
    authorizeCurrentAgentRuntimeDaemonModelTransition:
        mocks.authorizeModelTransition,
}));
vi.mock('@/plugins/runtime/invocation/services/createRunnerManagedServiceInvocationOwner', () => ({
    createRunnerManagedServiceInvocationOwner:
        mocks.createRunnerManagedServiceInvocationOwner,
}));
vi.mock('@/daemon/privateBearerFile', () => ({
    readPrivateBearerFile: mocks.readPrivateBearerFile,
}));
vi.mock('./runnerAgentDaemonFacets', () => ({
    createRunnerAgentDaemonFacets:
        mocks.createRunnerAgentDaemonFacets,
}));
vi.mock('./runnerDaemonPluginServices', () => ({
    prepareRunnerDaemonPluginServices:
        mocks.prepareRunnerDaemonPluginServices,
}));

import {
    createRunnerAgentSessionRuntimeBootstrap,
    createRunnerAgentSessionRuntimeSource,
} from './runnerAgentSessionRuntimeSource';
import {
    AgentRuntimeDaemonServiceRequestV1Schema,
} from './agentRuntimeDaemonServiceProtocol';
import type {
    RunnerManagedProviderCustodyScopeV1,
} from './runnerManagedServicesCustody';

const daemonWitness = Object.freeze({
    inputId: 'input-1',
    turnId: 'turn-1',
    userMessageSeq: 7,
    userMessageSeqs: Object.freeze([7]),
});
const witness = Object.freeze({
    ...daemonWitness,
    causalPermissionAuthority: Object.freeze({
        kind: 'admittedSessionInputV1' as const,
        admittedPermissionCeiling: 'read-only',
    }),
});

function exactAgentDeclaration(id = 'codex') {
    return {
        id,
        title: {
            key: 'agents.codex.title',
            fallback: 'Codex',
        },
        runtime: { kind: 'custom' as const },
        primary: 'sessions' as const,
        capabilities: {
            sessions: {
                open: ['create' as const],
                delivery: ['newTurn' as const],
                cancel: true,
            },
        },
    };
}

function exactAgentDescriptorDeclaration(id = 'codex') {
    return {
        provenance: 'first_party' as const,
        source: { kind: 'bundled' as const },
        definition: exactAgentDeclaration(id),
    };
}

function authority() {
    return {
        v: 2 as const,
        sessionId: 'session-1',
        runner: {
            pid: process.pid,
            processStartTimeMs: 1,
            processCommandHash: 'a'.repeat(64),
            snapshotIdentity: 'runner-snapshot',
        },
        retainedAgent: {
            v: 1 as const,
            pluginId: 'happier.agent.codex',
            pluginVersion: '1.0.0',
            agentId: 'codex',
            localAgentId: 'codex',
            immutableGenerationId: 'immutable-generation-1',
            locator: {
                module: './agent/runtime.js',
                export: 'createRuntime',
                runtimeApiVersion: 1 as const,
            },
            normalizedModulePath: 'agent/runtime.js',
            loadMode: 'immutable-js' as const,
        },
        httpPort: 40123,
        capability: 'A'.repeat(43),
    };
}

function managedProviderRuntimeBindingBasis(
    connectionId: string,
): ProviderRuntimeBindingBasisV1 {
    return {
        v: 1,
        agentTargetKey: 'backend:claude',
        connectionId: ProviderConnectionIdSchema.parse(connectionId),
        contributionKey: 'acme.providers/gateway',
        runtimeCredentialTransport: null,
        prepared: { v: 1, materialization: 'spawnEnv' },
        adapterVersion: 1,
        agentSupport: {
            acceptsProtocols: ['anthropic'],
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
                pluginId: 'acme.providers',
                localId: 'gateway',
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
        endpoint: {
            endpointTemplateId: 'messages',
            protocol: 'anthropic',
            publicHeaders: {},
        },
        credentialAuthorization: {
            connectionSecurityFingerprint: 'connection-security',
            grantFingerprint: 'grant',
        },
    };
}

function managedProviderScope(
    immutableGenerationId: string,
    manifestAuthority: 'external' | 'bundled_first_party' = 'external',
): RunnerManagedProviderCustodyScopeV1 {
    return Object.freeze({
        v: 1,
        sessionId: 'session-1',
        runtimeBindingBasis:
            managedProviderRuntimeBindingBasis(
                `connection-${immutableGenerationId}`,
            ),
        pluginId: 'acme.providers',
        providerLocalId: 'gateway',
        activationGeneration: immutableGenerationId,
        immutableGenerationId,
        manifestAuthority,
        operationClaimId:
            `session-demand:session-1:${immutableGenerationId}`,
    });
}

function managedProviderSnapshot(): ManagedServiceSnapshot {
    return Object.freeze({
        id: 'provider-wrapper',
        state: 'healthy',
        mode: 'attach',
        baseUrl: 'http://127.0.0.1:4312',
        startedAtMs: 1_000,
        lastHealthyAtMs: 1_001,
        diagnostics: Object.freeze([]),
        diagnosticsTruncated: false,
    });
}

function cleanupDeferred(): Readonly<{
    promise: Promise<void>;
    resolve(): void;
    reject(error: unknown): void;
}> {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<void>((settle, fail) => {
        resolve = settle;
        reject = fail;
    });
    return Object.freeze({ promise, resolve, reject });
}

describe('runner Agent session runtime source', () => {
    beforeEach(() => {
        mocks.verifiedAgentProvenance = 'first_party';
        vi.clearAllMocks();
        mocks.externalSessionsCompanion = null;
        mocks.readAuthority.mockResolvedValue(authority());
        mocks.readPrivateBearerFile.mockResolvedValue(JSON.stringify({
            v: 1,
            descriptor: {
                v: 1,
                pluginId: 'happier.agent.codex',
                pluginVersion: '1.0.0',
                agentId: 'codex',
                backendId: 'codex',
                generation: 'activation-generation-1',
                immutableGenerationId: 'immutable-generation-1',
                agentDeclaration:
                    exactAgentDescriptorDeclaration(),
                runtimeAuthority: {
                    runtimeCapabilities: ['sessionHooks'],
                },
            },
        }));
        mocks.createOperationServices.mockReturnValue({
            availability: () => ({ status: 'unavailable' }),
        });
        mocks.prepareRunnerDaemonPluginServices
            .mockResolvedValue({
                availability: () => ({
                    status: 'unavailable',
                }),
            });
        mocks.createRunnerManagedServiceInvocationOwner.mockImplementation(
            async (input) => ({
            owners: {
                createOperationServices:
                    mocks.createOperationServices,
                dispose:
                    mocks.disposeInvocationServices,
            },
            verifiedAgentDeclaration: {
                definition: exactAgentDeclaration((input as Readonly<{
                    retainedAgent: Readonly<{ localAgentId: string }>;
                }>).retainedAgent.localAgentId),
                provenance: mocks.verifiedAgentProvenance,
            },
            hostAccessRequests: [],
            clearEndpointAuth: vi.fn(),
            bindManagedServices: mocks.bindManagedServices,
            bindManagedServicesCustodyRequestPort:
                mocks.bindManagedServicesCustodyRequestPort,
            resolveAuthorizedManagedProviderServices:
                mocks.resolveAuthorizedManagedProviderServices,
            readCurrentProviderPluginHardRevocationRevision:
                mocks
                    .readCurrentProviderPluginHardRevocationRevision,
            projectManagedProviderEndpointAccess:
                mocks.projectManagedProviderEndpointAccess,
            bindAgentExternalSessionsManagedEndpoint:
                mocks.bindAgentExternalSessionsManagedEndpoint,
            }),
        );
        mocks.managedEndpointRead.mockResolvedValue({
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: Object.freeze({}),
            body: null,
        });
        mocks.bindAgentExternalSessionsManagedEndpoint
            .mockReturnValue(mocks.managedEndpointRead);
        mocks.readCurrentProviderPluginHardRevocationRevision
            .mockResolvedValue(4);
        mocks.updateSessionMarkerRunnerManagedProviderAuthority
            .mockResolvedValue(true);
        mocks.attachExactRunnerRetainedPluginGenerations
            .mockImplementation(async (input) => await input.attach());
        mocks.readCurrentPluginImmutableGenerationIntegrityCurrentness
            .mockResolvedValue(true);
        mocks.createRunnerAgentDaemonFacets
            .mockImplementation(async ({ authority: input }) => ({
                externalSessionHostOperations:
                    { bindSession: mocks.facetBindSession },
                agentSessionRealtimeVoiceAuthority:
                    {
                        generation:
                            input.retainedAgent
                                .immutableGenerationId,
                        policyAgentRef: {
                            pluginId:
                                input.retainedAgent.pluginId,
                            localId:
                                input.retainedAgent.localAgentId,
                        },
                        resolveDeclaration:
                            mocks.facetVoiceResolveDeclaration,
                        isCurrent: vi.fn(() => true),
                        resolveProviderGeneration:
                            vi.fn(() => 'voice-generation-1'),
                        resolveRetirementSignal:
                            vi.fn(() => null),
                        resolveConversation:
                            vi.fn(() => null),
                    },
                dispose: mocks.disposeDaemonFacets,
            }));
        mocks.facetBindSession.mockReturnValue({
            executeFollow: vi.fn(),
            executeProviderSessionFollow: vi.fn(),
            retire: vi.fn(),
        });
    });

    it('loads only the retained factory leaf and keeps one local runtime across daemon authority rotation', async () => {
        const runtime = { sessions: { open: vi.fn() } };
        const factory = vi.fn(async () => runtime);
        const admissionRequests: unknown[] = [];
        mocks.loadFactory.mockResolvedValue(factory);
        mocks.dispatch.mockImplementation(async (input) => {
            const request = input.createRequest('B'.repeat(43));
            admissionRequests.push(request);
            return {
                ok: true,
                result: {
                    kind: 'turn.admission',
                    status: 'admitted',
                    witness: request.operation.witness,
                },
            };
        });
        const source = await createRunnerAgentSessionRuntimeSource({
            happyHomeDir: '/tmp/happier-runner-source',
            publicReleaseRing: 'stable',
            authorityFilePath: '/tmp/happier-runner-source/authority.json',
        });
        expect(source).not.toBeNull();
        expect(mocks.bindManagedServicesCustodyRequestPort)
            .toHaveBeenCalledWith(expect.objectContaining({
                request: expect.any(Function),
                isCurrent: expect.any(Function),
            }));
        expect(source!.identity).not.toHaveProperty('runtimeAuthority');
        expect(source!.externalSessionHostOperations)
            .toBeDefined();
        expect(source!.retainedExternalSessionProviderOps)
            .toBeDefined();
        expect(source!.agentSessionRealtimeVoiceAuthority)
            .toMatchObject({
                generation: 'immutable-generation-1',
            });
        expect(mocks.createRunnerAgentDaemonFacets)
            .toHaveBeenCalledWith({
                authority: expect.objectContaining({
                    sessionId: 'session-1',
                    retainedAgent: authority().retainedAgent,
                }),
                readActiveTurnAdmissionWitness:
                    expect.any(Function),
                resolveRetainedExternalSessionProviderOps:
                    expect.any(Function),
            });
        const facetInput =
            mocks.createRunnerAgentDaemonFacets.mock.calls[0]?.[0] as
                | Readonly<{
                    readActiveTurnAdmissionWitness?(): unknown;
                    resolveRetainedExternalSessionProviderOps?(): Promise<unknown>;
                }>
                | undefined;
        expect(
            facetInput?.readActiveTurnAdmissionWitness?.(),
        ).toBeNull();
        await expect(
            facetInput?.resolveRetainedExternalSessionProviderOps?.(),
        ).resolves.toBeNull();

        const controller = new AbortController();
        const signal = controller.signal;
        await expect(source!.createRuntime({ signal })).resolves.toBe(runtime);
        await source!.createInvocationServices({
            pluginId: 'happier.agent.codex',
            pluginVersion: '1.0.0',
            agentId: 'codex',
            generation: 'immutable-generation-1',
            correlationId: 'session-1',
            cwd: '/repo',
            environment: { LATE: 'yes' },
            providerBindingActive: true,
            signal,
            session: {
                id: 'session-1',
                current: {} as never,
            },
            readActiveTurnAdmissionWitness: () => witness,
            isGenerationCurrent: () => true,
        });
        expect(
            mocks.prepareRunnerDaemonPluginServices,
        ).toHaveBeenCalledWith(
            expect.objectContaining({
                invocationId: 'session-1',
                signal,
                readActiveTurnAdmissionWitness:
                    expect.any(Function),
                local: expect.objectContaining({
                    availability: expect.any(Function),
                }),
            }),
        );
        expect(
            facetInput?.readActiveTurnAdmissionWitness?.(),
        ).toEqual(witness);
        expect(mocks.loadFactory).toHaveBeenCalledOnce();
        expect(factory).toHaveBeenCalledWith({
            plugin: {
                id: 'happier.agent.codex',
                version: '1.0.0',
            },
            agent: { id: 'codex' },
            signal,
        });

        await source!.authorizeNewTurn(witness, { signal });
        await source!.authorizeNewTurn({
            ...witness,
            inputId: 'input-2',
            turnId: 'turn-2',
        }, { signal });
        expect(factory).toHaveBeenCalledOnce();
        expect(mocks.dispatch).toHaveBeenCalledTimes(2);
        expect(admissionRequests.every((request) => (
            AgentRuntimeDaemonServiceRequestV1Schema.safeParse(request).success
        ))).toBe(true);
        expect(admissionRequests).toContainEqual(expect.objectContaining({
            operation: expect.objectContaining({
                kind: 'turn.admission.authorize',
                witness: daemonWitness,
            }),
        }));
    });

    it('keeps installed Agents with one local id distinct through runner construction', async () => {
        mocks.verifiedAgentProvenance = 'external';
        const localAgentId = 'assistant';
        const entries = [
            {
                pluginId: 'acme.alpha',
                routingId: 'acme.alpha/assistant',
                qualifiedAgentId: 'acme.alpha/agents/assistant',
                generation: 'immutable-alpha',
                path: '/tmp/happier-runner-source/alpha.json',
            },
            {
                pluginId: 'acme.beta',
                routingId: 'acme.beta/assistant',
                qualifiedAgentId: 'acme.beta/agents/assistant',
                generation: 'immutable-beta',
                path: '/tmp/happier-runner-source/beta.json',
            },
        ] as const;
        const authorities = new Map(
            entries.map((entry) => {
                const base = authority();
                return [entry.path, {
                    ...base,
                    sessionId: `${entry.pluginId}-session`,
                    retainedAgent: {
                        ...base.retainedAgent,
                        pluginId: entry.pluginId,
                        agentId: entry.routingId,
                        localAgentId,
                        immutableGenerationId: entry.generation,
                    },
                }];
            }),
        );
        mocks.readAuthority.mockImplementation(async (input) =>
            authorities.get(input.path) ?? null);

        const runtimes = new Map<string, AgentRuntime>();
        const factories = new Map<string, ReturnType<typeof vi.fn>>();
        for (const entry of entries) {
            const runtime = Object.freeze({
                sessions: Object.freeze({ open: vi.fn() }),
            });
            const factory = vi.fn(async () => runtime);
            runtimes.set(entry.routingId, runtime);
            factories.set(entry.routingId, factory);
        }
        mocks.loadFactory.mockImplementation(async (input) => {
            const binding = (input as Readonly<{
                binding: Readonly<{ agentId: string }>;
            }>).binding;
            const factory = factories.get(binding.agentId);
            if (!factory) throw new Error(`Missing factory for ${binding.agentId}`);
            return factory;
        });

        const sources = await Promise.all(entries.map((entry) =>
            createRunnerAgentSessionRuntimeSource({
                happyHomeDir: '/tmp/happier-runner-source',
                publicReleaseRing: 'stable',
                authorityFilePath: entry.path,
            }),
        ));
        expect(sources.every((source) => source !== null)).toBe(true);
        // `identity.agentId` is the canonical host routing id; the qualified
        // `/agents/` caller grammar stays confined to invocation seeds.
        expect(sources.map((source) => source?.identity.agentId)).toEqual([
            entries[0].routingId,
            entries[1].routingId,
        ]);
        expect(new Set(sources.map((source) => source?.identity.agentId)).size)
            .toBe(2);

        const signal = new AbortController().signal;
        for (const [index, source] of sources.entries()) {
            const entry = entries[index];
            if (!source) throw new Error('Missing runner source');
            await expect(source.createRuntime({ signal }))
                .resolves.toBe(runtimes.get(entry.routingId));
            await source.createInvocationServices({
                pluginId: entry.pluginId,
                pluginVersion: '1.0.0',
                agentId: entry.qualifiedAgentId,
                generation: entry.generation,
                correlationId: `${entry.pluginId}-session`,
                cwd: '/repo',
                environment: {},
                providerBindingActive: false,
                signal,
                session: {
                    id: `${entry.pluginId}-session`,
                    current: {} as never,
                },
                isGenerationCurrent: () => true,
            });
        }

        for (const entry of entries) {
            expect(factories.get(entry.routingId)).toHaveBeenCalledWith({
                plugin: {
                    id: entry.pluginId,
                    version: '1.0.0',
                },
                agent: { id: localAgentId },
                signal,
            });
        }
        expect(mocks.createOperationServices.mock.calls.map(([seed]) => seed))
            .toEqual(expect.arrayContaining(entries.map((entry) =>
                expect.objectContaining({
                    plugin: {
                        id: entry.pluginId,
                        version: '1.0.0',
                    },
                    contribution: {
                        id: localAgentId,
                        qualifiedId: entry.qualifiedAgentId,
                    },
                }),
            )));
    });

    it('binds the exact loader companion into the retained follow resolver and fences it on retirement', async () => {
        const runtime = { sessions: { open: vi.fn() } };
        mocks.loadFactory.mockResolvedValue(async () => runtime);
        const pageTranscript = vi.fn(async (request: Readonly<{
            managedEndpointRead(input: Readonly<{
                pathAndQuery: string;
                headers?: Readonly<Record<string, string>>;
            }>): Promise<unknown>;
        }>) => {
            await request.managedEndpointRead({
                pathAndQuery: '/session/remote-g/message',
                headers: { accept: 'application/json' },
            });
            return {
                ok: true as const,
                value: {
                    items: [],
                    nextCursor: null,
                    tailCursor: 'cursor-g',
                    hasMore: false,
                    truncated: false,
                },
            };
        });
        mocks.externalSessionsCompanion = Object.freeze({
            resolveSource: async (request: Readonly<{ source: unknown }>) => ({
                ok: true as const,
                value: { source: request.source },
            }),
            listCandidates: async () => ({
                ok: true as const,
                value: { candidates: [], nextCursor: null },
            }),
            resolveLinkIdentity: async (request: Readonly<{
                source: unknown;
                remoteSessionId: string;
            }>) => ({
                ok: true as const,
                value: {
                    source: request.source,
                    remoteSessionId: request.remoteSessionId,
                },
            }),
            resolveLinkedIdentity: async (request: Readonly<{
                source: unknown;
                remoteSessionId: string;
            }>) => ({
                ok: true as const,
                value: {
                    source: request.source,
                    remoteSessionId: request.remoteSessionId,
                },
            }),
            pageTranscript,
            readAfterTranscript: async () => ({
                ok: true as const,
                value: { outcome: 'already_current' as const },
            }),
        });
        const source = await createRunnerAgentSessionRuntimeSource({
            happyHomeDir: '/tmp/happier-runner-source',
            publicReleaseRing: 'stable',
            authorityFilePath:
                '/tmp/happier-runner-source/authority.json',
        });
        const facetInput =
            mocks.createRunnerAgentDaemonFacets.mock.calls[0]?.[0];
        const retainedOps = await facetInput
            ?.resolveRetainedExternalSessionProviderOps?.();
        expect(retainedOps).not.toBeNull();
        await expect(retainedOps?.pageTranscript({
            source: {
                kind: 'testSource',
                baseUrl: 'http://127.0.0.1:4312',
            },
            remoteSessionId: 'remote-g',
            direction: 'older',
            maxBytes: 524_288,
            maxItems: 1,
        })).resolves.toMatchObject({
            tailCursor: expect.stringMatching(
                /^happier_external_cursor_v1:/u,
            ),
        });
        expect(pageTranscript).toHaveBeenCalledOnce();
        expect(
            mocks.bindAgentExternalSessionsManagedEndpoint,
        ).toHaveBeenCalledWith({
            identity: {
                pluginId: 'happier.agent.codex',
                agentId: 'codex',
                generation: 'immutable-generation-1',
                contributionQualifiedId:
                    'happier.agent.codex/agents/codex',
                immutableGenerationId:
                    'immutable-generation-1',
            },
            signal: expect.any(AbortSignal),
        });
        expect(mocks.managedEndpointRead).toHaveBeenCalledWith({
            pathAndQuery: '/session/remote-g/message',
            headers: { accept: 'application/json' },
        });
        // The retained Session's own private composition surface reads the
        // same exact companion; a separate case below proves that directly.
        const privateComposition =
            source!.retainedExternalSessionProviderOps!;

        await source?.retire?.();
        await expect(retainedOps?.pageTranscript({
            source: {
                kind: 'testSource',
                baseUrl: 'http://127.0.0.1:4312',
            },
            remoteSessionId: 'remote-g',
            direction: 'older',
            maxBytes: 524_288,
            maxItems: 1,
        })).rejects.toMatchObject({
            code: 'unavailable',
        });
        await expect(privateComposition.pageTranscript!({
            source: {
                kind: 'testSource',
                baseUrl: 'http://127.0.0.1:4312',
            },
            remoteSessionId: 'remote-g',
            direction: 'older',
            maxBytes: 524_288,
            maxItems: 1,
        })).rejects.toMatchObject({
            code: 'unavailable',
        });
        expect(pageTranscript).toHaveBeenCalledOnce();
        expect(
            mocks.bindAgentExternalSessionsManagedEndpoint,
        ).toHaveBeenCalledOnce();
        expect(mocks.managedEndpointRead).toHaveBeenCalledOnce();
    });

    it('composes the retained private External Sessions surface from the exact loader companion, never the daemon current-global facet', async () => {
        const runtime = { sessions: { open: vi.fn() } };
        mocks.loadFactory.mockResolvedValue(async () => runtime);
        const resolveSource = vi.fn(async (request: Readonly<{
            source: unknown;
        }>) => ({
            ok: true as const,
            // The exact generation is the only authority allowed to normalize
            // this Session's source. After G->H the current generation may
            // normalize differently, so a normalization only G performs is the
            // discriminating witness that H never answered.
            value: {
                source: {
                    ...(request.source as Record<string, unknown>),
                    normalizedBy: 'immutable-generation-1',
                },
            },
        }));
        mocks.externalSessionsCompanion = Object.freeze({
            resolveSource,
            listCandidates: async () => ({
                ok: true as const,
                value: { candidates: [], nextCursor: null },
            }),
            resolveLinkIdentity: async () => ({
                ok: false as const,
                code: 'candidate_not_found',
            }),
            resolveLinkedIdentity: async () => ({
                ok: false as const,
                code: 'candidate_not_found',
            }),
            pageTranscript: async () => ({
                ok: false as const,
                code: 'candidate_not_found',
            }),
            readAfterTranscript: async () => ({
                ok: true as const,
                value: { outcome: 'already_current' as const },
            }),
        });
        const source = await createRunnerAgentSessionRuntimeSource({
            happyHomeDir: '/tmp/happier-runner-source',
            publicReleaseRing: 'stable',
            authorityFilePath:
                '/tmp/happier-runner-source/authority.json',
        });

        await expect(
            source!.retainedExternalSessionProviderOps!.validateSource!({
                source: { kind: 'testSource' },
            }),
        ).resolves.toMatchObject({
            ok: true,
            source: {
                kind: 'testSource',
                normalizedBy: 'immutable-generation-1',
            },
        });
        expect(resolveSource).toHaveBeenCalledOnce();
        // Nothing crossed the runner-to-daemon service boundary: the private
        // composition never asks the daemon's current generation to answer for
        // this Session.
        expect(mocks.dispatch).not.toHaveBeenCalled();
    });

    it('fails the retained private composition closed when the retained generation has no External Sessions companion', async () => {
        const runtime = { sessions: { open: vi.fn() } };
        mocks.loadFactory.mockResolvedValue(async () => runtime);
        mocks.externalSessionsCompanion = null;
        const source = await createRunnerAgentSessionRuntimeSource({
            happyHomeDir: '/tmp/happier-runner-source',
            publicReleaseRing: 'stable',
            authorityFilePath:
                '/tmp/happier-runner-source/authority.json',
        });

        await expect(
            source!.retainedExternalSessionProviderOps!.validateSource!({
                source: { kind: 'testSource' },
            }),
        ).rejects.toMatchObject({
            code: 'plugin_external_sessions_companion_unavailable',
        });
        expect(mocks.dispatch).not.toHaveBeenCalled();
    });

    it('retries early managed Provider preparation only after a proven before-effect refusal', async () => {
        const refused = Object.assign(
            new Error('daemon A had no invocation'),
            { code: 'plugin_services_invocation_unavailable' },
        );
        mocks.prepareRunnerDaemonPluginServices
            .mockRejectedValueOnce(refused)
            .mockResolvedValueOnce({
                availability: () => ({ status: 'unavailable' }),
            });
        mocks.dispatch.mockResolvedValue(null);
        const source = await createRunnerAgentSessionRuntimeSource({
            happyHomeDir: '/tmp/happier-runner-source',
            publicReleaseRing: 'stable',
            authorityFilePath:
                '/tmp/happier-runner-source/authority.json',
        });
        const signal = new AbortController().signal;
        const input = {
            sessionId: 'session-1',
            cwd: '/repo',
            environment: Object.freeze({ BASE: 'public' }),
            signal,
            session: {
                id: 'session-1',
                current: {} as never,
            },
            readActiveTurnAdmissionWitness: () => witness,
        } as const;

        await expect(source!.prepareManagedProviderBinding!(input))
            .rejects.toBe(refused);
        await expect(source!.prepareManagedProviderBinding!(input))
            .resolves.toBeNull();
        expect(mocks.prepareRunnerDaemonPluginServices)
            .toHaveBeenCalledTimes(2);
        expect(mocks.createOperationServices)
            .toHaveBeenNthCalledWith(
                2,
                expect.objectContaining({
                    correlationId: 'session-1',
                }),
                expect.objectContaining({
                    environment: { BASE: 'public' },
                }),
            );
    });

    it('binds only daemon-produced exact Provider bootstrap facts into runner-local SVC09', async () => {
        const agentConnectedAccounts = Object.freeze({ agent: true });
        const providerConnectedAccounts = Object.freeze({ provider: true });
        const runnerLocalExec = Object.freeze({ runner: true });
        const scope = managedProviderScope('provider-p');
        const isCurrent = vi.fn(() => true);
        mocks.createOperationServices.mockReturnValue({
            availability: () => ({ status: 'unavailable' }),
            exec: runnerLocalExec,
        });
        mocks.bindManagedServices.mockReturnValue(
            Object.freeze({ dependencies: {} as never }),
        );
        mocks.prepareRunnerDaemonPluginServices.mockImplementationOnce(
            async (input) => {
                input.bindManagedServices?.({
                    connectedAccounts: agentConnectedAccounts,
                    exec: runnerLocalExec,
                    managedProvider: Object.freeze({
                        bootstrap: Object.freeze({
                            v: 1,
                            scope,
                            requestAuth: null,
                            providerPluginHardRevocationRevisionAtAdmission:
                                4,
                        }),
                        connectedAccounts: providerConnectedAccounts,
                        exec: runnerLocalExec,
                        isCurrent,
                    }),
                });
                return Object.freeze({
                    availability: () => ({ status: 'unavailable' }),
                });
            },
        );
        const source = await createRunnerAgentSessionRuntimeSource({
            happyHomeDir: '/tmp/happier-runner-source',
            publicReleaseRing: 'stable',
            authorityFilePath:
                '/tmp/happier-runner-source/authority.json',
        });
        const signal = new AbortController().signal;

        await source!.createInvocationServices({
            pluginId: 'happier.agent.codex',
            pluginVersion: '1.0.0',
            agentId: 'codex',
            generation: 'immutable-generation-1',
            correlationId: 'session-1',
            cwd: '/repo',
            environment: {},
            providerBindingActive: true,
            signal,
            session: {
                id: 'session-1',
                current: {} as never,
            },
            isGenerationCurrent: () => true,
        });

        expect(mocks.bindManagedServices).toHaveBeenCalledOnce();
        expect(mocks.bindManagedServices).toHaveBeenCalledWith({
            seed: expect.objectContaining({
                generation: 'immutable-generation-1',
                contribution: expect.objectContaining({
                    qualifiedId:
                        'happier.agent.codex/agents/codex',
                }),
            }),
            agent: {
                connectedAccounts: agentConnectedAccounts,
                exec: runnerLocalExec,
            },
            managedProvider: {
                bootstrap: {
                    v: 1,
                    scope,
                    requestAuth: null,
                    providerPluginHardRevocationRevisionAtAdmission:
                        4,
                },
                connectedAccounts: providerConnectedAccounts,
                exec: runnerLocalExec,
                isCurrent,
            },
        });
    });

    it('composes exact adopted Provider custody through the claimed source and retires it once', async () => {
        const current = managedProviderSnapshot();
        const dispose = vi.fn(async () => undefined);
        const managedHandle: ManagedServiceHandle = Object.freeze({
            snapshot: () => current,
            observe: () => Object.freeze({ dispose() {} }),
            waitUntilHealthy: async () => current,
            async request() {
                throw new Error('Unexpected managed service request');
            },
            stop: async () => Object.freeze({
                status: 'stopped' as const,
            }),
            dispose,
        });
        const supervise = vi.fn<ManagedServices['supervise']>(
            async () => managedHandle,
        );
        mocks.resolveAuthorizedManagedProviderServices
            .mockResolvedValue(Object.freeze({
                services: Object.freeze({
                    dependencies: {} as never,
                    supervise,
                }),
                providerPluginHardRevocationRevisionAtAdmission: 4,
            }));
        const projectionCleanup = vi.fn(async () => undefined);
        mocks.projectManagedProviderEndpointAccess.mockResolvedValue(
            Object.freeze({
                access: Object.freeze({
                    endpointUrl: (endpointTemplateId: string) =>
                        endpointTemplateId === 'chat'
                            ? 'http://127.0.0.1:4312/v1/chat/completions'
                            : null,
                    fetch: vi.fn(async () => new Response()),
                }),
                isCurrent: () => true,
                cleanup: projectionCleanup,
            }),
        );
        mocks.loadFactory.mockResolvedValue(
            vi.fn(async () => ({ sessions: { open: vi.fn() } })),
        );

        const source = await createRunnerAgentSessionRuntimeSource({
            happyHomeDir: '/tmp/happier-runner-source',
            publicReleaseRing: 'stable',
            authorityFilePath:
                '/tmp/happier-runner-source/authority.json',
        });
        const custody = source?.managedServicesCustodyPort;
        expect(custody).toBeDefined();
        mocks.readCurrentPluginImmutableGenerationIntegrityCurrentness
            .mockImplementation(async (input) =>
                input.retainedManifestAuthority
                    === 'bundled_first_party');
        const scopeP = managedProviderScope(
            'provider-p',
            'bundled_first_party',
        );
        const spec = Object.freeze({
            id: 'provider-wrapper',
            mode: Object.freeze({
                kind: 'attach' as const,
                baseUrl: 'http://127.0.0.1:4312',
            }),
            healthCheck: Object.freeze({ kind: 'none' as const }),
        });

        await expect(custody!.dispatch({
            v: 1,
            kind: 'supervise',
            scope: scopeP,
            spec,
        })).resolves.toMatchObject({
            kind: 'handle',
            custodyScope: scopeP,
        });
        await expect(custody!.dispatch({
            v: 1,
            kind: 'projectEndpointAccess',
            claim: scopeP,
            serviceId: spec.id,
            endpoints: [{
                endpointTemplateId: 'chat',
                servicePath: '/v1/chat/completions',
            }],
        })).resolves.toMatchObject({ kind: 'projected' });
        await expect(custody!.dispatch({
            v: 1,
            kind: 'commitAdoption',
            claim: scopeP,
            serviceId: spec.id,
        })).resolves.toMatchObject({ kind: 'adopted' });
        expect(
            mocks.updateSessionMarkerRunnerManagedProviderAuthority,
        ).toHaveBeenCalledWith({
            pid: process.pid,
            sessionId: 'session-1',
            processCommandHash: 'a'.repeat(64),
            processStartTimeMs: 1,
            authority: {
                pluginId: scopeP.pluginId,
                immutableGenerationId:
                    scopeP.immutableGenerationId,
                manifestAuthority: scopeP.manifestAuthority,
                hardRevocationRevisionAtAdmission: 4,
            },
        });
        await expect(custody!.dispatch({
            v: 1,
            kind: 'readAdoptedPublicOutcome',
            claim: scopeP,
        })).resolves.toEqual({
            v: 1,
            kind: 'adoptedPublicOutcome',
            outcome: {
                operationClaimId: scopeP.operationClaimId,
                serviceId: spec.id,
                endpointTemplateIds: ['chat'],
                endpoints: [{
                    endpointTemplateId: 'chat',
                    servicePath: '/v1/chat/completions',
                    endpointUrl:
                        'http://127.0.0.1:4312/v1/chat/completions',
                }],
                endpointAccess: 'runnerProjected',
            },
        });
        await expect(custody!.dispatch({
            v: 1,
            kind: 'adopt',
            claim: scopeP,
            serviceId: spec.id,
        })).resolves.toMatchObject({
            kind: 'handle',
            custodyScope: scopeP,
        });
        await expect(custody!.dispatch({
            v: 1,
            kind: 'supervise',
            scope: managedProviderScope('provider-q'),
            spec,
        })).rejects.toMatchObject({
            code: 'plugin_managed_service_unavailable',
        });
        expect(supervise).toHaveBeenCalledOnce();
        expect(
            mocks.resolveAuthorizedManagedProviderServices,
        ).toHaveBeenCalledOnce();
        expect(
            mocks.resolveAuthorizedManagedProviderServices,
        ).toHaveBeenCalledWith(scopeP);
        expect(
            mocks.readCurrentProviderPluginHardRevocationRevision,
        ).toHaveBeenCalledWith(scopeP.pluginId);
        expect(
            mocks.readCurrentPluginImmutableGenerationIntegrityCurrentness,
        ).toHaveBeenCalledWith({
            paths: expect.any(Object),
            pluginId: scopeP.pluginId,
            immutableGenerationId: scopeP.immutableGenerationId,
            bundledArtifacts: expect.any(Array),
            retainedManifestAuthority: scopeP.manifestAuthority,
        });
        expect(
            mocks.projectManagedProviderEndpointAccess,
        ).toHaveBeenCalledWith(expect.objectContaining({
            scope: scopeP,
            service: managedHandle,
        }));

        await source!.retire?.();
        await source!.retire?.();
        expect(
            mocks.updateSessionMarkerRunnerManagedProviderAuthority,
        ).toHaveBeenLastCalledWith({
            pid: process.pid,
            sessionId: 'session-1',
            processCommandHash: 'a'.repeat(64),
            processStartTimeMs: 1,
            authority: null,
            expectedAuthority: {
                pluginId: scopeP.pluginId,
                immutableGenerationId:
                    scopeP.immutableGenerationId,
                manifestAuthority: scopeP.manifestAuthority,
                hardRevocationRevisionAtAdmission: 4,
            },
        });
        expect(dispose).toHaveBeenCalledOnce();
        expect(projectionCleanup).toHaveBeenCalledOnce();
        expect(mocks.disposeInvocationServices)
            .toHaveBeenCalledOnce();
    });

    it('waits for every retirement owner, aggregates failures, and retries rejected cleanup', async () => {
        const daemonCleanup = cleanupDeferred();
        const invocationCleanup = cleanupDeferred();
        const daemonFailure = new Error('daemon cleanup failed');
        const invocationFailure = new Error(
            'invocation cleanup failed',
        );
        mocks.disposeDaemonFacets
            .mockImplementationOnce(async () =>
                await daemonCleanup.promise)
            .mockResolvedValueOnce(undefined);
        mocks.disposeInvocationServices
            .mockImplementationOnce(async () =>
                await invocationCleanup.promise)
            .mockResolvedValueOnce(undefined);

        const source = await createRunnerAgentSessionRuntimeSource({
            happyHomeDir: '/tmp/happier-runner-source',
            publicReleaseRing: 'stable',
            authorityFilePath:
                '/tmp/happier-runner-source/authority.json',
        });
        expect(source).not.toBeNull();

        let retirementSettled = false;
        const retirement = source!.retire!().then(
            () => Object.freeze({ status: 'fulfilled' as const }),
            (error: unknown) => Object.freeze({
                status: 'rejected' as const,
                error,
            }),
        ).finally(() => {
            retirementSettled = true;
        });
        daemonCleanup.reject(daemonFailure);
        await Promise.resolve();
        await Promise.resolve();
        expect(retirementSettled).toBe(false);
        expect(mocks.disposeInvocationServices).toHaveBeenCalledOnce();

        invocationCleanup.reject(invocationFailure);
        const outcome = await retirement;
        expect(outcome).toMatchObject({
            status: 'rejected',
            error: expect.any(AggregateError),
        });
        if (
            outcome.status !== 'rejected'
            || !(outcome.error instanceof AggregateError)
        ) {
            throw new Error('Expected aggregate retirement failure');
        }
        expect(outcome.error.errors).toEqual([
            daemonFailure,
            invocationFailure,
        ]);

        await expect(source!.retire!()).resolves.toBeUndefined();
        expect(mocks.disposeDaemonFacets).toHaveBeenCalledTimes(2);
        expect(mocks.disposeInvocationServices).toHaveBeenCalledTimes(2);
    });

    it('admits the exact immutable runner when activation and immutable generations differ', async () => {
        const runtime = { sessions: { open: vi.fn() } };
        mocks.loadFactory.mockResolvedValue(
            vi.fn(async () => runtime),
        );
        const source =
            await createRunnerAgentSessionRuntimeBootstrap({
                happyHomeDir: '/tmp/happier-runner-source',
                publicReleaseRing: 'stable',
                bootstrapFilePath:
                    '/tmp/happier-runner-source/bootstrap.json',
                authorityFilePath:
                    '/tmp/happier-runner-source/authority.json',
            });
        expect(source).not.toBeNull();
        expect(source!.identity.isCurrent()).toBe(false);
        expect(source!.identity.generation)
            .toBe('immutable-generation-1');
        expect(source!.externalSessionHostOperations)
            .toBeDefined();
        expect(source!.agentSessionRealtimeVoiceAuthority)
            .toMatchObject({
                generation: 'immutable-generation-1',
                policyAgentRef: {
                    pluginId: 'happier.agent.codex',
                    localId: 'codex',
                },
            });
        expect(
            source!.agentSessionRealtimeVoiceAuthority!
                .isCurrent({
                    pluginId: 'happier.voice.elevenlabs',
                    localId: 'conversation',
                }),
        ).toBe(false);
        expect(mocks.readAuthority).not.toHaveBeenCalled();
        await expect(source!.createRuntime({
            signal: new AbortController().signal,
        })).rejects.toMatchObject({
            code: 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING',
        });
        expect(mocks.loadFactory).not.toHaveBeenCalled();

        const signalController = new AbortController();
        const signal = signalController.signal;
        await source!.prepareForSession?.({
            sessionId: 'session-1',
            signal,
        });
        expect(mocks.readAuthority).toHaveBeenCalledWith(
            expect.objectContaining({
                expectedSessionId: 'session-1',
            }),
        );
        expect(source!.identity.isCurrent()).toBe(true);
        expect(source!.identity.generation)
            .toBe('immutable-generation-1');
        expect(
            source!.agentSessionRealtimeVoiceAuthority!
                .isCurrent({
                    pluginId: 'happier.voice.elevenlabs',
                    localId: 'conversation',
                }),
        ).toBe(true);
        await expect(source!.createRuntime({ signal }))
            .resolves.toBe(runtime);
        await expect(source!.prepareForSession?.({
            sessionId: 'session-other',
            signal,
        })).rejects.toMatchObject({
            code: 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING',
        });
        signalController.abort();
        await vi.waitFor(() => {
            expect(mocks.disposeDaemonFacets)
                .toHaveBeenCalledOnce();
            expect(mocks.disposeInvocationServices)
                .toHaveBeenCalledOnce();
        });
    });

    it('forwards Composer reference resolution through the claimed runner authority', async () => {
        const resolution = {
            id: 'issue-1',
            label: 'Issue 1',
            context: 'Issue 1 is ready for review.',
        };
        mocks.resolveTurnContributions.mockResolvedValue({
            kind: 'composerReference',
            resolution,
        });
        const source = await createRunnerAgentSessionRuntimeBootstrap({
            happyHomeDir: '/tmp/happier-runner-source',
            publicReleaseRing: 'stable',
            bootstrapFilePath:
                '/tmp/happier-runner-source/bootstrap.json',
            authorityFilePath:
                '/tmp/happier-runner-source/authority.json',
        });
        const signal = new AbortController().signal;
        const request = {
            sessionId: 'session-1',
            reference: {
                pluginId: 'acme.providers',
                localId: 'gateway',
            },
            candidateId: 'issue-1',
            signal,
        };

        await expect(
            source!.daemonTurnContributionsBridge!
                .resolveComposerReference(request),
        ).rejects.toMatchObject({
            code: 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING',
        });

        await source!.prepareForSession?.({
            sessionId: 'session-1',
            signal,
        });

        await expect(
            source!.daemonTurnContributionsBridge!
                .resolveComposerReference(request),
        ).resolves.toEqual(resolution);
        expect(mocks.resolveTurnContributions)
            .toHaveBeenCalledWith(expect.objectContaining({
                authority: expect.objectContaining({
                    sessionId: 'session-1',
                }),
                request: {
                    kind: 'composerReference',
                    reference: {
                        pluginId: 'acme.providers',
                        localId: 'gateway',
                    },
                    candidateId: 'issue-1',
                },
                signal,
            }));
    });

    it('forwards Composer attachment dispatch resolution through the claimed runner authority', async () => {
        const result = {
            attachments: [{
                instanceId: 'review-1',
                status: 'ready' as const,
                context: 'Fresh review context.',
                data: { refreshed: true },
            }],
        };
        mocks.resolveTurnContributions.mockResolvedValue({
            kind: 'composerAttachment',
            result,
        });
        const source = await createRunnerAgentSessionRuntimeBootstrap({
            happyHomeDir: '/tmp/happier-runner-source',
            publicReleaseRing: 'stable',
            bootstrapFilePath:
                '/tmp/happier-runner-source/bootstrap.json',
            authorityFilePath:
                '/tmp/happier-runner-source/authority.json',
        });
        const signal = new AbortController().signal;
        const request = {
            sessionId: 'session-1',
            attachment: {
                pluginId: 'acme.review',
                localId: 'review-comment',
            },
            request: {
                sessionId: 'session-1',
                localId: 'local-1',
                attachments: [{
                    instanceId: 'review-1',
                    key: 'review-1',
                    value: { reviewId: '42' },
                }],
            },
            signal,
        } as const;
        const attachmentBridge = source!
            .daemonTurnContributionsBridge as unknown as {
                resolveComposerAttachment(
                    input: typeof request,
                ): Promise<typeof result>;
            };

        await expect(
            attachmentBridge.resolveComposerAttachment(request),
        ).rejects.toMatchObject({
            code: 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING',
        });

        await source!.prepareForSession?.({
            sessionId: 'session-1',
            signal,
        });

        await expect(
            attachmentBridge.resolveComposerAttachment(request),
        ).resolves.toEqual(result);
        expect(mocks.resolveTurnContributions)
            .toHaveBeenCalledWith(expect.objectContaining({
                authority: expect.objectContaining({
                    sessionId: 'session-1',
                }),
                request: {
                    kind: 'composerAttachment',
                    attachment: {
                        pluginId: 'acme.review',
                        localId: 'review-comment',
                    },
                    request: {
                        sessionId: 'session-1',
                        localId: 'local-1',
                        attachments: [{
                            instanceId: 'review-1',
                            key: 'review-1',
                            value: { reviewId: '42' },
                        }],
                    },
                },
                signal,
            }));
    });

    it('forwards Composer attachment post-acceptance notification through the claimed runner authority', async () => {
        mocks.resolveTurnContributions.mockResolvedValue({
            kind: 'composerAttachmentAccepted',
        });
        const source = await createRunnerAgentSessionRuntimeBootstrap({
            happyHomeDir: '/tmp/happier-runner-source',
            publicReleaseRing: 'stable',
            bootstrapFilePath:
                '/tmp/happier-runner-source/bootstrap.json',
            authorityFilePath:
                '/tmp/happier-runner-source/authority.json',
        });
        const signal = new AbortController().signal;
        const request = {
            sessionId: 'session-1',
            attachment: {
                pluginId: 'acme.review',
                localId: 'review-comment',
            },
            event: {
                sessionId: 'session-1',
                localId: 'local-1',
                attachments: [{
                    instanceId: 'review-1',
                    key: 'review-1',
                    value: { reviewId: '42' },
                }],
            },
            signal,
        } as const;
        const attachmentBridge = source!
            .daemonTurnContributionsBridge as unknown as {
                afterComposerAttachmentMessageAccepted(
                    input: typeof request,
                ): Promise<void>;
            };

        await expect(
            attachmentBridge.afterComposerAttachmentMessageAccepted(request),
        ).rejects.toMatchObject({
            code: 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING',
        });

        await source!.prepareForSession?.({
            sessionId: 'session-1',
            signal,
        });

        await expect(
            attachmentBridge.afterComposerAttachmentMessageAccepted(request),
        ).resolves.toBeUndefined();
        expect(mocks.resolveTurnContributions)
            .toHaveBeenCalledWith(expect.objectContaining({
                authority: expect.objectContaining({
                    sessionId: 'session-1',
                }),
                request: {
                    kind: 'composerAttachmentAccepted',
                    attachment: {
                        pluginId: 'acme.review',
                        localId: 'review-comment',
                    },
                    event: {
                        sessionId: 'session-1',
                        localId: 'local-1',
                        attachments: [{
                            instanceId: 'review-1',
                            key: 'review-1',
                            value: { reviewId: '42' },
                        }],
                    },
                },
                signal,
            }));
    });

    it('forwards exact Session machine admission only after the runner claims the same Session authority', async () => {
        mocks.admitSessionInput.mockResolvedValue({
            status: 'accepted',
            localId: 'local-1',
        });
        const source = await createRunnerAgentSessionRuntimeBootstrap({
            happyHomeDir: '/tmp/happier-runner-source',
            publicReleaseRing: 'stable',
            bootstrapFilePath:
                '/tmp/happier-runner-source/bootstrap.json',
            authorityFilePath:
                '/tmp/happier-runner-source/authority.json',
        });
        const signal = new AbortController().signal;
        const request = {
            v: 1 as const,
            sessionId: 'session-1',
            targetMachineId: 'machine-1',
            localId: 'local-1',
            content: {
                t: 'plain' as const,
                v: { role: 'user' as const },
            },
            requestedAction: { v: 1 as const, kind: 'enqueue' as const },
        };

        await expect(source!.daemonTurnContributionsBridge!.admitSessionInput?.({
            sessionId: 'session-1',
            request,
            signal,
        })).rejects.toMatchObject({
            code: 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING',
        });

        await source!.prepareForSession?.({ sessionId: 'session-1', signal });
        await expect(source!.daemonTurnContributionsBridge!.admitSessionInput?.({
            sessionId: 'session-1',
            request,
            signal,
        })).resolves.toEqual({ status: 'accepted', localId: 'local-1' });
        expect(mocks.admitSessionInput).toHaveBeenCalledWith(expect.objectContaining({
            authority: expect.objectContaining({ sessionId: 'session-1' }),
            request,
            signal,
        }));

        await expect(source!.daemonTurnContributionsBridge!.admitSessionInput?.({
            sessionId: 'session-wrong',
            request: { ...request, sessionId: 'session-wrong' },
            signal,
        })).resolves.toEqual({
            status: 'rejected',
            code: 'session_input_source_authority_mismatch',
        });
        expect(mocks.admitSessionInput).toHaveBeenCalledOnce();
    });

    it('forwards next-turn Agent composition through the claimed runner authority', async () => {
        const composition = {
            kind: 'composition' as const,
            managedPluginIds: ['example.agent-context-companion'],
            selectedTools: [],
            selectedToolBindings: [],
            promptAssetBlocks: [],
            toolPromptContributions: [],
            additionalInstructions: [{
                pluginId: 'example.agent-context-companion',
                text: 'Use the bounded companion context for this turn.',
            }],
        };
        mocks.resolveTurnContributions.mockResolvedValue(composition);
        const source = await createRunnerAgentSessionRuntimeBootstrap({
            happyHomeDir: '/tmp/happier-runner-source',
            publicReleaseRing: 'stable',
            bootstrapFilePath:
                '/tmp/happier-runner-source/bootstrap.json',
            authorityFilePath:
                '/tmp/happier-runner-source/authority.json',
        });
        const signal = new AbortController().signal;
        const request = {
            sessionId: 'session-1',
            runtimeFamily: 'hostSession' as const,
            machineId: 'machine-1',
            featureIds: ['execution.runs'],
            signal,
        };
        const compositionBridge = source!.daemonTurnContributionsBridge as unknown as {
            resolveAgentComposition(input: typeof request): Promise<typeof composition>;
        };

        await expect(
            compositionBridge.resolveAgentComposition(request),
        ).rejects.toMatchObject({
            code: 'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING',
        });

        await source!.prepareForSession?.({
            sessionId: 'session-1',
            signal,
        });

        await expect(
            compositionBridge.resolveAgentComposition(request),
        ).resolves.toEqual(composition);
        expect(mocks.resolveTurnContributions)
            .toHaveBeenCalledWith(expect.objectContaining({
                authority: expect.objectContaining({
                    sessionId: 'session-1',
                }),
                request: {
                    kind: 'composition',
                    runtimeFamily: 'hostSession',
                    machineId: 'machine-1',
                    featureIds: ['execution.runs'],
                },
                signal,
            }));
    });

    it('claims an OhMyPi-style local Agent id against its separate catalog backend id', async () => {
        const baseAuthority = authority();
        mocks.readAuthority.mockResolvedValue({
            ...baseAuthority,
            retainedAgent: {
                ...baseAuthority.retainedAgent,
                pluginId: 'happier.agent.ohmypi',
                agentId: 'ohMyPi',
                localAgentId: 'ohmypi',
            },
        });
        mocks.readPrivateBearerFile.mockResolvedValue(JSON.stringify({
            v: 1,
            descriptor: {
                v: 1,
                pluginId: 'happier.agent.ohmypi',
                pluginVersion: '1.0.0',
                agentId: 'ohMyPi',
                backendId: 'ohMyPi',
                generation: 'activation-generation-1',
                immutableGenerationId: 'immutable-generation-1',
                agentDeclaration:
                    exactAgentDescriptorDeclaration('ohmypi'),
                runtimeAuthority: {
                    runtimeCapabilities: ['sessionHooks'],
                },
            },
        }));
        const source = await createRunnerAgentSessionRuntimeBootstrap({
            happyHomeDir: '/tmp/happier-runner-source',
            publicReleaseRing: 'stable',
            bootstrapFilePath:
                '/tmp/happier-runner-source/bootstrap.json',
            authorityFilePath:
                '/tmp/happier-runner-source/authority.json',
        });

        expect(source?.identity).toMatchObject({
            agentId: 'ohMyPi',
            backendId: 'ohMyPi',
        });
        await expect(source?.prepareForSession?.({
            sessionId: 'session-1',
            signal: new AbortController().signal,
        })).resolves.toBeUndefined();
        expect(source?.identity).toMatchObject({
            agentId: 'ohMyPi',
            backendId: 'ohMyPi',
        });
    });

    it.each([
        {
            identityField: 'plugin-local Agent',
            descriptorIdentity: { agentId: 'ohMyPi-other' },
        },
        {
            identityField: 'catalog backend',
            descriptorIdentity: { backendId: 'ohMyPi-other' },
        },
    ])(
        'rejects an OhMyPi-style bootstrap whose $identityField differs from the exact runner',
        async ({ descriptorIdentity }) => {
            const baseAuthority = authority();
            mocks.readAuthority.mockResolvedValue({
                ...baseAuthority,
                retainedAgent: {
                    ...baseAuthority.retainedAgent,
                    pluginId: 'happier.agent.ohmypi',
                    agentId: 'ohMyPi',
                    localAgentId: 'ohmypi',
                },
            });
            mocks.readPrivateBearerFile.mockResolvedValue(JSON.stringify({
                v: 1,
                descriptor: {
                    v: 1,
                    pluginId: 'happier.agent.ohmypi',
                    pluginVersion: '1.0.0',
                    agentId: 'ohMyPi',
                    backendId: 'ohMyPi',
                    generation: 'activation-generation-1',
                    immutableGenerationId:
                        'immutable-generation-1',
                    ...descriptorIdentity,
                    agentDeclaration:
                        exactAgentDescriptorDeclaration('ohmypi'),
                    runtimeAuthority: {
                        runtimeCapabilities: ['sessionHooks'],
                    },
                },
            }));
            const source =
                await createRunnerAgentSessionRuntimeBootstrap({
                    happyHomeDir: '/tmp/happier-runner-source',
                    publicReleaseRing: 'stable',
                    bootstrapFilePath:
                        '/tmp/happier-runner-source/bootstrap.json',
                    authorityFilePath:
                        '/tmp/happier-runner-source/authority.json',
                });

            await expect(source?.prepareForSession?.({
                sessionId: 'session-1',
                signal: new AbortController().signal,
            })).rejects.toMatchObject({
                code:
                    'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING',
            });
            expect(source?.identity.isCurrent()).toBe(false);
        },
    );

    it.each([
        {
            identityField: 'immutable generation',
            descriptorIdentity: {
                immutableGenerationId:
                    'immutable-generation-other',
            },
        },
        {
            identityField: 'plugin',
            descriptorIdentity: {
                pluginId: 'happier.agent.other',
            },
        },
        {
            identityField: 'Agent',
            descriptorIdentity: {
                agentId: 'other',
            },
        },
    ])(
        'rejects a bootstrap whose $identityField identity differs from the exact runner',
        async ({ descriptorIdentity }) => {
            mocks.readPrivateBearerFile.mockResolvedValue(
                JSON.stringify({
                    v: 1,
                    descriptor: {
                        v: 1,
                        pluginId: 'happier.agent.codex',
                        pluginVersion: '1.0.0',
                        agentId: 'codex',
                        backendId: 'codex',
                        generation: 'activation-generation-1',
                        immutableGenerationId:
                            'immutable-generation-1',
                        ...descriptorIdentity,
                        agentDeclaration:
                            exactAgentDescriptorDeclaration(),
                        runtimeAuthority: {
                            runtimeCapabilities: ['sessionHooks'],
                        },
                    },
                }),
            );
            const source =
                await createRunnerAgentSessionRuntimeBootstrap({
                    happyHomeDir:
                        '/tmp/happier-runner-source',
                    publicReleaseRing: 'stable',
                    bootstrapFilePath:
                        '/tmp/happier-runner-source/bootstrap.json',
                    authorityFilePath:
                        '/tmp/happier-runner-source/authority.json',
                });

            await expect(source!.prepareForSession?.({
                sessionId: 'session-1',
                signal: new AbortController().signal,
            })).rejects.toMatchObject({
                code:
                    'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING',
            });
            expect(mocks.disposeDaemonFacets)
                .toHaveBeenCalledOnce();
            expect(mocks.disposeInvocationServices)
                .toHaveBeenCalledOnce();
            expect(source!.identity.isCurrent()).toBe(false);
        },
    );

    it('retires an exact claimed source when the bootstrap G declaration differs from verified authority', async () => {
        mocks.readPrivateBearerFile.mockResolvedValue(
            JSON.stringify({
                v: 1,
                descriptor: {
                    v: 1,
                    pluginId: 'happier.agent.codex',
                    pluginVersion: '1.0.0',
                    agentId: 'codex',
                    backendId: 'codex',
                    generation:
                        'activation-generation-1',
                    immutableGenerationId:
                        'immutable-generation-1',
                    agentDeclaration: {
                        ...exactAgentDescriptorDeclaration(),
                        definition: {
                            ...exactAgentDeclaration(),
                            capabilities: {
                                sessions: {
                                    open: ['resume'],
                                    delivery: ['newTurn'],
                                    cancel: true,
                                },
                            },
                        },
                    },
                    runtimeAuthority: {
                        runtimeCapabilities: [
                            'sessionHooks',
                        ],
                    },
                },
            }),
        );
        const source =
            await createRunnerAgentSessionRuntimeBootstrap({
                happyHomeDir:
                    '/tmp/happier-runner-source',
                publicReleaseRing: 'stable',
                bootstrapFilePath:
                    '/tmp/happier-runner-source/bootstrap.json',
                authorityFilePath:
                    '/tmp/happier-runner-source/authority.json',
            });

        await expect(source!.prepareForSession?.({
            sessionId: 'session-1',
            signal: new AbortController().signal,
        })).rejects.toMatchObject({
            code:
                'RUNNER_AGENT_SESSION_RUNTIME_SOURCE_MISSING',
        });
        expect(mocks.disposeDaemonFacets)
            .toHaveBeenCalledOnce();
        expect(mocks.disposeInvocationServices)
            .toHaveBeenCalledOnce();
        expect(source!.identity.isCurrent()).toBe(false);
    });

    it('keeps retained G1 and G2 isolated while a new Session selects H', async () => {
        const generationInputs = [
            {
                generation: 'immutable-generation-g1',
                sessionId: 'session-g1',
                pluginVersion: '1.0.0',
            },
            {
                generation: 'immutable-generation-g2',
                sessionId: 'session-g2',
                pluginVersion: '1.1.0',
            },
            {
                generation: 'immutable-generation-h',
                sessionId: 'session-new-h',
                pluginVersion: '2.0.0',
            },
        ] as const;
        const authorities = new Map<
            string,
            ReturnType<typeof authority>
        >(
            generationInputs.map((input) => {
                const base = authority();
                return [
                    `/tmp/happier-runner-source/${input.generation}.json`,
                    {
                        ...base,
                        sessionId: input.sessionId,
                        retainedAgent: {
                            ...base.retainedAgent,
                            pluginVersion: input.pluginVersion,
                            immutableGenerationId: input.generation,
                        },
                    },
                ] as const;
            }),
        );
        mocks.readAuthority.mockImplementation(async (input) => {
            const request = input as Readonly<{
                path: string;
                expectedSessionId?: string;
            }>;
            const exact = authorities.get(request.path) ?? null;
            return exact?.sessionId === request.expectedSessionId
                ? exact
                : null;
        });

        const runtimes = new Map<string, AgentRuntime>();
        const factories = new Map<string, ReturnType<typeof vi.fn>>();
        for (const input of generationInputs) {
            const runtime: AgentRuntime = Object.freeze({
                sessions: Object.freeze({
                    open: vi.fn(async () => {
                        throw new Error('not opened by the source test');
                    }),
                }),
            });
            runtimes.set(input.generation, runtime);
            factories.set(
                input.generation,
                vi.fn(async () => runtime),
            );
        }
        mocks.loadFactory.mockImplementation(async (input) => {
            const generation = (
                input as Readonly<{
                    binding: Readonly<{
                        immutableGenerationId: string;
                    }>;
                }>
            ).binding.immutableGenerationId;
            const factory = factories.get(generation);
            if (!factory) {
                throw new Error(`Missing factory for ${generation}`);
            }
            return factory;
        });

        const privateFacets = new Map<string, Readonly<{
            externalSessionHostOperations: Readonly<{
                bindSession: ReturnType<typeof vi.fn>;
            }>;
            voiceAuthority: Readonly<{
                generation: string;
                resolveDeclaration: ReturnType<typeof vi.fn>;
            }>;
            dispose: ReturnType<typeof vi.fn>;
        }>>();
        mocks.createRunnerAgentDaemonFacets.mockImplementation(
            async (input) => {
                const generation = (
                    input as Readonly<{
                        authority: Readonly<{
                            retainedAgent: Readonly<{
                                immutableGenerationId: string;
                                pluginId: string;
                                localAgentId: string;
                            }>;
                        }>;
                    }>
                ).authority.retainedAgent
                    .immutableGenerationId;
                const bindSession = vi.fn();
                const resolveDeclaration = vi.fn();
                const dispose = vi.fn(async () => undefined);
                const externalSessionHostOperations =
                    Object.freeze({ bindSession });
                const voiceAuthority = Object.freeze({
                    generation,
                    policyAgentRef: Object.freeze({
                        pluginId: 'happier.agent.codex',
                        localId: 'codex',
                    }),
                    resolveDeclaration,
                    isCurrent: vi.fn(() => true),
                    resolveProviderGeneration: vi.fn(() => null),
                    resolveRetirementSignal: vi.fn(() => null),
                    resolveConversation: vi.fn(() => null),
                });
                privateFacets.set(generation, {
                    externalSessionHostOperations,
                    voiceAuthority,
                    dispose,
                });
                return {
                    externalSessionHostOperations,
                    agentSessionRealtimeVoiceAuthority:
                        voiceAuthority,
                    dispose,
                };
            },
        );

        const services = new Map<string, Readonly<{
            generation: string;
            availability(): Readonly<{ status: 'unavailable' }>;
        }>>();
        mocks.prepareRunnerDaemonPluginServices.mockImplementation(
            async (input) => {
                const invocation = input as Readonly<{
                    invocationId: string;
                }>;
                const generation = invocation.invocationId
                    .replace(/^invocation-/u, '');
                const service = Object.freeze({
                    generation,
                    availability: () => ({
                        status: 'unavailable' as const,
                    }),
                });
                services.set(generation, service);
                return service;
            },
        );

        const createSource = async (
            input: typeof generationInputs[number],
        ) => {
            const source = await createRunnerAgentSessionRuntimeSource({
                happyHomeDir: '/tmp/happier-runner-source',
                publicReleaseRing: 'stable',
                authorityFilePath:
                    `/tmp/happier-runner-source/${input.generation}.json`,
                expectedSessionId: input.sessionId,
            });
            if (!source) {
                throw new Error(`Missing source for ${input.generation}`);
            }
            return source;
        };
        const createServices = async (
            source: Awaited<ReturnType<typeof createSource>>,
            input: typeof generationInputs[number],
            signal: AbortSignal,
        ) => await source.createInvocationServices({
            pluginId: 'happier.agent.codex',
            pluginVersion: input.pluginVersion,
            agentId: 'codex',
            generation: input.generation,
            correlationId: `invocation-${input.generation}`,
            cwd: '/repo',
            environment: {},
            providerBindingActive: false,
            signal,
            session: {
                id: input.sessionId,
                current: {} as never,
            },
            readActiveTurnAdmissionWitness: () => witness,
            isGenerationCurrent: () => true,
        });

        const signal = new AbortController().signal;
        const g1 = await createSource(generationInputs[0]);
        const g2 = await createSource(generationInputs[1]);
        const g1Runtime = await g1.createRuntime({ signal });
        const g2Runtime = await g2.createRuntime({ signal });
        const g1Services = await createServices(
            g1,
            generationInputs[0],
            signal,
        );
        const g2Services = await createServices(
            g2,
            generationInputs[1],
            signal,
        );

        // H is admitted only for the newly created Session. G1 and G2 stay
        // bound to their exact sources after H exists.
        const h = await createSource(generationInputs[2]);
        const hRuntime = await h.createRuntime({ signal });
        const hServices = await createServices(
            h,
            generationInputs[2],
            signal,
        );

        expect(g1.identity.generation)
            .toBe('immutable-generation-g1');
        expect(g2.identity.generation)
            .toBe('immutable-generation-g2');
        expect(h.identity.generation)
            .toBe('immutable-generation-h');
        expect([g1Runtime, g2Runtime, hRuntime])
            .toEqual([
                runtimes.get('immutable-generation-g1'),
                runtimes.get('immutable-generation-g2'),
                runtimes.get('immutable-generation-h'),
            ]);
        expect(new Set([g1Runtime, g2Runtime, hRuntime]).size)
            .toBe(3);
        expect(new Set([g1Services, g2Services, hServices]).size)
            .toBe(3);
        expect([
            g1Services,
            g2Services,
            hServices,
        ].map((service) => (
            service as unknown as Readonly<{ generation: string }>
        ).generation)).toEqual([
            'immutable-generation-g1',
            'immutable-generation-g2',
            'immutable-generation-h',
        ]);

        const g1Private = privateFacets.get(
            'immutable-generation-g1',
        );
        const g2Private = privateFacets.get(
            'immutable-generation-g2',
        );
        const hPrivate = privateFacets.get(
            'immutable-generation-h',
        );
        expect(g1Private).toBeDefined();
        expect(g2Private).toBeDefined();
        expect(hPrivate).toBeDefined();
        expect(new Set([
            g1Private!.externalSessionHostOperations,
            g2Private!.externalSessionHostOperations,
            hPrivate!.externalSessionHostOperations,
        ]).size).toBe(3);
        expect(new Set([
            g1Private!.voiceAuthority.resolveDeclaration,
            g2Private!.voiceAuthority.resolveDeclaration,
            hPrivate!.voiceAuthority.resolveDeclaration,
        ]).size).toBe(3);
        // Each retained generation composes External Sessions from its own
        // exact authority. One shared current-global object here would mean a
        // G Session reading H's source normalization and link identity.
        expect(new Set([
            g1.retainedExternalSessionProviderOps,
            g2.retainedExternalSessionProviderOps,
            h.retainedExternalSessionProviderOps,
        ]).size).toBe(3);
        for (const retained of [
            g1.retainedExternalSessionProviderOps,
            g2.retainedExternalSessionProviderOps,
            h.retainedExternalSessionProviderOps,
        ]) {
            expect(retained).toBeDefined();
        }

        await expect(g1.createRuntime({ signal }))
            .resolves.toBe(g1Runtime);
        await expect(g2.createRuntime({ signal }))
            .resolves.toBe(g2Runtime);
        await expect(h.createRuntime({ signal }))
            .resolves.toBe(hRuntime);
        for (const input of generationInputs) {
            expect(factories.get(input.generation))
                .toHaveBeenCalledOnce();
        }
        expect(mocks.loadFactory).toHaveBeenCalledTimes(3);
        expect(mocks.createRunnerAgentDaemonFacets)
            .toHaveBeenCalledTimes(3);

        await Promise.all([
            g1.retire?.(),
            g2.retire?.(),
            h.retire?.(),
        ]);
        for (const input of generationInputs) {
            expect(privateFacets.get(input.generation)?.dispose)
                .toHaveBeenCalledOnce();
        }
    });

    it('does not expose an ordinary-update terminal successor transition', async () => {
        const runtimeG = { sessions: { open: vi.fn() } };
        const factoryG = vi.fn(async () => runtimeG);
        mocks.loadFactory.mockResolvedValue(factoryG);
        const source =
            await createRunnerAgentSessionRuntimeBootstrap({
                happyHomeDir: '/tmp/happier-runner-source',
                publicReleaseRing: 'stable',
                bootstrapFilePath:
                    '/tmp/happier-runner-source/bootstrap.json',
                authorityFilePath:
                    '/tmp/happier-runner-source/authority.json',
            });
        const signal = new AbortController().signal;
        await source!.prepareForSession?.({
            sessionId: 'session-1',
            signal,
        });
        await expect(source!.createRuntime({ signal }))
            .resolves.toBe(runtimeG);

        expect(source).not.toHaveProperty(
            'resolveTerminalGenerationTransition',
        );
        expect(factoryG).toHaveBeenCalledTimes(1);
        expect(source!.identity.pluginVersion).toBe('1.0.0');
        expect(source!.identity.generation)
            .toBe('immutable-generation-1');
        await expect(source!.createRuntime({ signal }))
            .resolves.toBe(runtimeG);
        expect(factoryG).toHaveBeenCalledTimes(1);
    });
});
