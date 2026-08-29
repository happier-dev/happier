import { copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { describe, expect, it, vi } from 'vitest';
import {
    ProviderConnectionIdSchema,
    type ProviderRuntimeBindingBasisV1,
} from '@happier-dev/protocol';
import type {
    ManagedDependenciesService,
    ManagedServiceHandle,
    ManagedServiceSnapshot,
    ManagedServiceSpec,
    ManagedServices } from '@happier-dev/plugin-sdk/managed-services';
import type {
    ConnectedAccountMaterialization as PluginConnectedAccountMaterialization,
} from '@happier-dev/plugin-sdk/connected-accounts';
import {
    PluginError,
    type PluginServices,
} from '@happier-dev/plugin-sdk';

import {
    RunnerAgentDaemonFacetOperationV1Schema,
} from '@/agent/runtime/session/process/agentRuntimeDaemonFacetProtocol';
import {
    createRunnerAgentDaemonFacets,
} from '@/agent/runtime/session/process/runnerAgentDaemonFacets';
import {
    AgentRuntimeDaemonServiceRequestV1Schema,
    AgentRuntimeDaemonServiceResponseV1Schema,
    type AgentRuntimeDaemonServiceResponseV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonServiceProtocol';
import {
    RunnerDaemonPluginServiceResultV1Schema,
    decodeRunnerDaemonPluginServiceWireValueV1,
    type RunnerDaemonPluginServiceOperationV1,
} from '@/agent/runtime/session/process/agentRuntimeDaemonPluginServicesProtocol';
import {
    createRunnerManagedServicesClient,
    createRunnerManagedServicesCustodyPort,
    type RunnerManagedProviderCustodyClaimV1,
    type RunnerManagedProviderCustodyScopeV1,
} from '@/agent/runtime/session/process/runnerManagedServicesCustody';
import {
    prepareRunnerDaemonPluginServices,
} from '@/agent/runtime/session/process/runnerDaemonPluginServices';
import {
    createRunnerAgentDaemonFacetService,
    type RunnerAgentDaemonFacetService,
} from '@/daemon/agentRuntime/runnerAgentDaemonFacetService';
import {
    createRunnerDaemonPluginServicesHost,
    type RunnerDaemonCurrentGlobalActionExecutor,
    type RunnerDaemonCurrentGlobalExternalSessionsOwner,
    type RunnerDaemonCurrentGlobalMcpOwner,
} from '@/daemon/agentRuntime/runnerDaemonPluginServicesHost';
import {
    createLocalPathPluginDistributionIdentity,
    createPluginTrustRecord,
} from '@/plugins/store/install/trustIdentity';
import {
    resolveMergedContributionRegistry,
} from '@/plugins/projection/registry/createResolvedContributionRegistry';
import {
    BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS,
} from '@/plugins/projection/registry/sources/generatedBundledPluginArtifacts';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import {
    PluginStateRecordSchema,
} from '@/plugins/store/state';
import {
    writeCommittedLocalPathPluginFixture,
} from '@/plugins/store/state.testkit';
import {
    readCurrentCommittedPluginGenerations,
} from '@/plugins/store/registry/generationStore';
import {
    createUnavailablePluginServices,
} from '@/plugins/runtime/invocation/services/unavailable';
import {
    loadRetainedAgentRuntimeLeaf,
} from '@/plugins/runtime/runner/loadRetainedAgentRuntimeLeaf';
import type {
    StablePluginConnectedAccountsOwner,
} from '@/plugins/runtime/invocation/services/connectedAccounts';
import {
    createExternalSessionHostOperationOwner,
    type ExternalSessionHostOperationSet,
} from '@/session/external/hostOperationOwner';
import type {
    ExternalSessionFollowHostOperation,
} from '@/session/external/followHostOperation';

import { resolveExecutablePluginRuntimeRegistry } from './resolveExecutablePluginRuntimeRegistry';
import {
    prepareBundledExecutableGenerationAdmission,
    selectBundledExecutableImmutableArtifacts,
} from './bundledActivationSource';
import { createPluginReloadController } from './reload/controller';

const externalSessionsBoundary = vi.hoisted(() => ({
    ensureExternalSessionLink: vi.fn(async () => ({
        sessionId: 'linked-current-global-routing',
    })),
    readStoredCredentials: vi.fn(async () => ({
        token: 'current-global-routing-token',
        encryption: null,
    })),
}));

vi.mock('@/api/session/external/linking/ensureExternalSessionLink', () => ({
    ensureExternalSessionLink: externalSessionsBoundary.ensureExternalSessionLink,
}));

vi.mock('@/persistence', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/persistence')>(),
    readStoredCredentials: externalSessionsBoundary.readStoredCredentials,
}));

const PLUGIN_ID = 'acme.retained-service-routing';
const AGENT_ID = 'routing-agent';
const SESSION_ID = 'session-retained-routing';
const DEPENDENCY_ID = 'routing-tool';
const MCP_SERVER_ID = 'routing-tools';
const MCP_CURRENT_ONLY_SERVER_ID = 'routing-current-only';
const MCP_DISCOVERY_SOURCE_ID = 'routing-discovery';
const VOICE_PROVIDER_ID = 'routing-realtime-voice';
const SOURCE = Object.freeze({ kind: 'retainedRoutingFixture' as const });
type TurnWitness = Readonly<{
    turnId: string;
    inputId: string;
    userMessageSeq: number | null;
    userMessageSeqs: readonly number[];
}>;
const FIRST_WITNESS = Object.freeze({
    turnId: 'turn-g-before-h',
    inputId: 'input-g-before-h',
    userMessageSeq: 1,
    userMessageSeqs: Object.freeze([1]),
}) satisfies TurnWitness;
const LATER_WITNESS = Object.freeze({
    turnId: 'turn-g-after-h',
    inputId: 'input-g-after-h',
    userMessageSeq: 2,
    userMessageSeqs: Object.freeze([2]),
}) satisfies TurnWitness;

function sameWitness(
    left: TurnWitness | undefined,
    right: TurnWitness,
): boolean {
    return Boolean(
        left
        && left.turnId === right.turnId
        && left.inputId === right.inputId
        && left.userMessageSeq === right.userMessageSeq
        && JSON.stringify(left.userMessageSeqs)
            === JSON.stringify(right.userMessageSeqs),
    );
}

async function createTrustedLocalLinkInstall(input: Readonly<{
    pluginRoot: string;
    version: string;
}>) {
    const distribution =
        await createLocalPathPluginDistributionIdentity(
            input.pluginRoot,
        );
    return Object.freeze({
        distribution,
        trust: createPluginTrustRecord({
            pluginId: PLUGIN_ID,
            distribution,
            approvedAtMs: Date.now(),
        }),
        install: Object.freeze({
            mode: 'link' as const,
            manifestVersion: input.version,
            installedPath: null,
            trust: createPluginTrustRecord({
                pluginId: PLUGIN_ID,
                distribution,
                approvedAtMs: Date.now(),
            }),
            updatePolicy: 'manual' as const,
            optionalAccess: Object.freeze([]),
        }),
    });
}

function pluginManifest(input: Readonly<{
    version: 'G' | 'H' | 'I';
    accountServiceId: string;
    toolName: string;
}>) {
    const manifestVersion = input.version === 'G'
        ? '1.0.0'
        : input.version === 'H'
            ? '2.0.0'
            : '3.0.0';
    return {
        schemaVersion: 2,
        id: PLUGIN_ID,
        version: manifestVersion,
        displayName: `Retained routing ${input.version}`,
        engines: { happier: '^0.2.0' },
        runtime: { apiVersion: 1 },
        entrypoints: { daemon: './daemon.mjs' },
        activation: { events: [{ kind: 'startup' }] },
        hostAccess: {
            required: [{
                id: 'routing-process',
                capability: 'process',
                reason: 'Run the exact retained managed dependency.',
                scope: {
                    executables: [{
                        kind: 'managedDependency',
                        id: DEPENDENCY_ID,
                    }],
                },
            }, {
                id: 'routing-mcp',
                capability: 'mcp',
                reason: 'Use the retained Agent admitted MCP maximum.',
                scope: {
                    serverRefs: [
                        MCP_SERVER_ID,
                    ],
                    discoverySourceRefs: [
                        MCP_DISCOVERY_SOURCE_ID,
                    ],
                    operations: [
                        'listTools',
                        'callTools',
                        'discover',
                    ],
                },
            }, {
                id: 'routing-network',
                capability: 'network',
                reason: 'Use the retained Agent declared HTTP endpoint.',
                scope: {
                    targets: [{
                        kind: 'fixedOrigin',
                        origin: 'https://policy.example.test',
                    }],
                    methods: ['GET'],
                },
            }, {
                id: 'routing-sessions-read',
                capability: 'sessions',
                reason: 'Read the current external-session projection.',
                scope: {
                    access: ['read'],
                },
            }],
            optional: [],
        },
        contributes: {
            settings: [{
                id: 'runner-preferences',
                title: 'Runner preferences',
                target: { kind: 'agent', agent: AGENT_ID },
                scope: 'daemon',
                fields: [{
                    id: 'retained-generation',
                    title: 'Retained generation',
                    schema: {
                        type: 'string',
                        enum: [input.version],
                    },
                    default: input.version,
                }],
            }],
            connectedAccountDescriptors: [{
                id: input.accountServiceId,
                title: `Account ${input.version}`,
                authentication: {
                    defaultModeId: 'manual',
                    modes: [{
                        id: 'manual',
                        kind: 'manual',
                        outcomeReconciliation: 'none',
                        fields: [{
                            id: 'token',
                            title: 'Token',
                            schema: { type: 'string', minLength: 1 },
                            secret: true,
                        }],
                    }],
                },
            }],
            managedDependencies: [{
                id: DEPENDENCY_ID,
                title: `Routing tool ${input.version}`,
                executable: input.toolName,
                sources: [{
                    kind: 'system',
                    executableNames: [input.toolName],
                }],
            }],
            mcp: {
                servers: [{
                    id: MCP_SERVER_ID,
                    title: `Routing tools ${input.version}`,
                    kind: 'dynamic',
                    sessionScope: 'session',
                }, ...(input.version === 'G' ? [] : [{
                    id: MCP_CURRENT_ONLY_SERVER_ID,
                    title: 'Current-only routing tools',
                    kind: 'dynamic' as const,
                    sessionScope: 'session' as const,
                }])],
                discoverySources: [{
                    id: MCP_DISCOVERY_SOURCE_ID,
                    title: 'Routing discovery',
                }],
            },
            requestInterceptors: input.version === 'G' ? [] : [{
                id: 'deny-retained-http',
                origins: ['https://policy.example.test'],
                methods: ['GET'],
            }],
            agents: [{
                id: AGENT_ID,
                title: `Routing Agent ${input.version}`,
                runtime: { kind: 'custom' },
                primary: 'sessions',
                connectedAccounts: [{
                    purpose: 'stable-account',
                    service: input.accountServiceId,
                    required: true,
                    materializationKinds: ['environment'],
                }],
                capabilities: {
                    surfaces: ['externalSessions'],
                    sessions: {
                        open: ['create'],
                        delivery: ['newTurn'],
                        cancel: true,
                    },
                },
                surfaces: {
                    externalSession: {
                        externalLinkedTakeover: {
                            writerSafety: 'unsupported',
                        },
                        sources: [{
                            sourceKind: SOURCE.kind,
                            terminalFollow: {
                                userRowClassification: 'explicitV1',
                            },
                            schema: {
                                fields: [{
                                    kind: 'literal',
                                    name: 'kind',
                                    value: SOURCE.kind,
                                }],
                            },
                            key: {
                                segments: [{
                                    kind: 'literal',
                                    value: SOURCE.kind,
                                }],
                            },
                            instances: [{
                                kind: 'default',
                                constants: {},
                            }],
                        }],
                    },
                },
            }],
            voiceProviders: [{
                id: VOICE_PROVIDER_ID,
                title: `Routing realtime ${input.version}`,
                kind: 'conversation',
                roles: ['realtime_conversation'],
                platforms: ['web'],
                capabilities: {
                    turn: { cancelResponse: false, bargeIn: false },
                },
                execution: {
                    kind: 'experimental_agent_session_realtime',
                    agent: AGENT_ID,
                    supportedRuntimeVersions: ['1.0.0'],
                },
                client: {
                    artifactId: 'routing-realtime-client',
                    modulePath: './voice.mjs',
                    exportName: 'activate',
                },
            }],
        },
    };
}

async function writePluginSource(input: Readonly<{
    pluginRoot: string;
    version: 'G' | 'H' | 'I';
    accountServiceId: string;
    toolName: string;
}>): Promise<void> {
    await mkdir(join(input.pluginRoot, '.happier-plugin'), {
        recursive: true,
    });
    await writeFile(
        join(input.pluginRoot, '.happier-plugin', 'plugin.json'),
        JSON.stringify(pluginManifest(input)),
        'utf8',
    );
    await writeFile(
        join(input.pluginRoot, 'agentRuntime.mjs'),
        `const version = ${JSON.stringify(input.version)};
        export const routingAgentRuntimeFactory = () => ({
            sessions: {
                async open(request) {
                    return {
                        sessionId: request.sessionId,
                        async send() { return { status: 'admitted' }; },
                        watch() { return { dispose() {} }; },
                        async dispose() {},
                        realtimeConversation: {
                            async inspect() {
                                return version === 'G'
                                    ? { status: 'available', transport: 'webrtc' }
                                    : {
                                        status: 'unavailable',
                                        reason: 'feature_unavailable',
                                        diagnostic: {
                                            code: 'current_generation_voice',
                                            severity: 'info',
                                        },
                                    };
                            },
                            async start() {
                                return {
                                    status: 'unavailable',
                                    diagnostic: {
                                        code: 'routing_realtime_not_started',
                                        severity: 'info',
                                    },
                                };
                            },
                        },
                    };
                }
            },
            async dispose() {}
        });
        export const routingExternalSessions = Object.freeze({
            async resolveSource(request) {
                return { ok: true, value: { source: request.source } };
            },
            async listCandidates(request) {
                return { ok: true, value: {
                    candidates: [{
                        remoteSessionId: request.cursor
                            ? 'current-' + version + '-page-2'
                            : 'current-' + version,
                        title: request.cursor
                            ? 'Current ' + version + ' page 2'
                            : 'Current ' + version,
                        updatedAtMs: version === 'H' ? 2 : 1,
                        linkData: { ownerVersion: version }
                    }],
                    nextCursor: request.cursor ? null : 'native-' + version + '-page-2'
                } };
            },
            async resolveLinkIdentity(request) {
                return { ok: true, value: {
                    source: request.source,
                    remoteSessionId: request.remoteSessionId,
                    linkData: { ...(request.linkData ?? {}), ownerVersion: version }
                } };
            },
            async resolveLinkedIdentity(request) {
                return { ok: true, value: {
                    source: request.source,
                    remoteSessionId: request.remoteSessionId,
                    linkData: { ...request.linkData, ownerVersion: version }
                } };
            },
            async pageTranscript() {
                return { ok: true, value: {
                    items: [], nextCursor: null, tailCursor: null,
                    hasMore: false, truncated: false
                } };
            },
            async readAfterTranscript() {
                return { ok: true, value: { outcome: 'already_current' } };
            }
        });\n`,
        'utf8',
    );
    await writeFile(
        join(input.pluginRoot, 'voice.mjs'),
        'export function activate() {}\n',
        'utf8',
    );
    await writeFile(
        join(input.pluginRoot, 'daemon.mjs'),
        `import {
            routingAgentRuntimeFactory,
            routingExternalSessions
        } from './agentRuntime.mjs';
        const version = ${JSON.stringify(input.version)};
        export function activate(api) {
            api.connectedAccounts.register(
                ${JSON.stringify(input.accountServiceId)},
                {
                    authentication: {
                        modes: {
                            manual: {
                                kind: 'manual',
                                async complete() {
                                    return {
                                        status: 'connected',
                                        accountId: 'fixture-account',
                                        displayName: 'Fixture account',
                                        scopes: []
                                    };
                                }
                            }
                        }
                    },
                    async refresh() {
                        return { status: 'unavailable' };
                    },
                    async revoke() {
                        return { status: 'remoteUnsupported' };
                    },
                    async status() {
                        return {
                            status: 'connected',
                            displayName: 'Fixture account'
                        };
                    },
                    async materialize() {
                        return {
                            kind: 'environment',
                            env: { ROUTING_ACCOUNT_VERSION: version }
                        };
                    }
                }
            );
            api.agents.register(
                ${JSON.stringify(AGENT_ID)},
                routingAgentRuntimeFactory,
                { sessionRunnerFactory: {
                    module: './agentRuntime.mjs',
                    export: 'routingAgentRuntimeFactory',
                    externalSessionsExport: 'routingExternalSessions',
                    runtimeApiVersion: 1
                } }
            );
            api.agents.registerExternalSessions(
                ${JSON.stringify(AGENT_ID)},
                routingExternalSessions
            );
            const createMcpRuntime = (id) => ({
                async dispose() {},
                async listTools() {
                    return { items: [{
                        name: id + '-' + version,
                        inputSchema: { type: 'object' }
                    }] };
                },
                async callTool(request) {
                    return {
                        generation: version,
                        serverId: id,
                        name: request.name
                    };
                },
                async listResources() { return { items: [] }; },
                async listResourceTemplates() { return { items: [] }; },
                async readResource(request) {
                    return { contents: [{
                        uri: request.uri,
                        text: version
                    }] };
                },
                async subscribeResource() {
                    return { async dispose() {} };
                },
                async listPrompts() { return { items: [] }; },
                async getPrompt() { return { messages: [] }; }
            });
            api.mcp.registerServer(
                ${JSON.stringify(MCP_SERVER_ID)},
                createMcpRuntime(${JSON.stringify(MCP_SERVER_ID)})
            );
            if (version !== 'G') {
                api.mcp.registerServer(
                    ${JSON.stringify(MCP_CURRENT_ONLY_SERVER_ID)},
                    createMcpRuntime(${JSON.stringify(MCP_CURRENT_ONLY_SERVER_ID)})
                );
            }
            api.mcp.registerDiscoverySource(
                ${JSON.stringify(MCP_DISCOVERY_SOURCE_ID)},
                async () => ({
                    items: [{
                        provider: {
                            pluginId: ${JSON.stringify(PLUGIN_ID)},
                            localId: ${JSON.stringify(MCP_DISCOVERY_SOURCE_ID)}
                        },
                        discoveryId: 'routing-' + version,
                        title: 'Routing discovery ' + version,
                        metadata: { generation: version }
                    }]
                })
            );
            if (version !== 'G') {
                api.interceptors.register(
                    'deny-retained-http',
                    async (request) => {
                        if (request.url.endsWith('/blocked')) {
                            return { decision: 'deny' };
                        }
                        if (
                            request.headers.authorization !== '[redacted]'
                            || request.headers['x-tenant-label'] !== 'caller-visible'
                        ) {
                            return { decision: 'deny' };
                        }
                        return {
                            decision: 'continue',
                            request: {
                                ...request,
                                headers: {
                                    ...request.headers,
                                    'x-tenant-label': 'rewritten-by-current-policy',
                                },
                            },
                        };
                    }
                );
            }
        }\n`,
        'utf8',
    );
}

async function installCurrentSource(input: Readonly<{
    happyHomeDir: string;
    pluginRoot: string;
    version: string;
}>): Promise<void> {
    const identity = await createTrustedLocalLinkInstall(input);
    const catalogRecord = PluginStateRecordSchema.parse({
        source: {
            kind: 'path',
            locator: input.pluginRoot,
            trustPolicy: 'local_trusted',
            installPolicy: 'link',
            resolvedPath: input.pluginRoot,
            manifestPath: join(
                input.pluginRoot,
                '.happier-plugin',
                'plugin.json',
            ),
        },
        compatibility: { status: 'compatible', diagnostics: [] },
        install: identity.install,
        state: { enabled: true },
    });
    await writeCommittedLocalPathPluginFixture({
        happyHomeDir: input.happyHomeDir,
        pluginId: PLUGIN_ID,
        sourceRootPath: input.pluginRoot,
        plugin: catalogRecord,
    });
}

async function readCurrentFixtureGenerationAuthority(input: Readonly<{
    happyHomeDir: string;
    expectedVersion: 'H' | 'I';
}>) {
    const contributes = await resolveMergedContributionRegistry({
        happyHomeDir: input.happyHomeDir,
    });
    const bundledArtifacts = selectBundledExecutableImmutableArtifacts({
        artifacts: BUNDLED_FIRST_PARTY_IMMUTABLE_ARTIFACTS,
        activationTargets: contributes.activationTargets,
    });
    await prepareBundledExecutableGenerationAdmission({
        artifacts: bundledArtifacts,
    });
    const generationAuthority =
        await readCurrentCommittedPluginGenerations(
            resolvePluginStorePaths({
                happyHomeDir: input.happyHomeDir,
            }),
            {
                bundledArtifacts,
                isolateInvalidInstalledGenerations: true,
            },
        );
    if (!generationAuthority?.generations.has(PLUGIN_ID)) {
        throw new Error(
            `Expected current ${input.expectedVersion} generation authority`,
        );
    }
    return generationAuthority;
}

function responseErrorCode(error: unknown): string {
    const explicit = error && typeof error === 'object'
        ? Reflect.get(error, 'code')
        : undefined;
    if (typeof explicit === 'string' && explicit.trim()) {
        return explicit;
    }
    if (error instanceof Error && error.message.trim()) {
        return error.message;
    }
    return 'agent_runtime_daemon_service_unavailable';
}

function facetLoopback(
    service: RunnerAgentDaemonFacetService,
    responses: AgentRuntimeDaemonServiceResponseV1[],
): NonNullable<
    Parameters<typeof createRunnerAgentDaemonFacets>[0]['dispatch']
> {
    return async (input) => {
        const request = AgentRuntimeDaemonServiceRequestV1Schema.parse(
            JSON.parse(JSON.stringify(
                input.createRequest('A'.repeat(43)),
            )),
        );
        let response: AgentRuntimeDaemonServiceResponseV1;
        try {
            const result = await service.dispatch({
                sessionId: input.authority.sessionId,
                runner: input.authority.runner,
                retainedAgent: input.authority.retainedAgent,
                operation:
                    RunnerAgentDaemonFacetOperationV1Schema.parse(
                        request.operation,
                    ),
                ...(input.signal ? { signal: input.signal } : {}),
            });
            response = { ok: true, result };
        } catch (error) {
            response = {
                ok: false,
                error: {
                    code: responseErrorCode(error),
                    message: error instanceof Error
                        ? error.message
                        : 'Daemon facet unavailable',
                },
            };
        }
        const parsed = AgentRuntimeDaemonServiceResponseV1Schema.parse(
            JSON.parse(JSON.stringify(response)),
        );
        responses.push(parsed);
        return parsed;
    };
}

function snapshot(id: string): ManagedServiceSnapshot {
    return Object.freeze({
        id,
        state: 'healthy',
        mode: 'attach',
        baseUrl: 'http://127.0.0.1:4312',
        startedAtMs: 1_000,
        lastHealthyAtMs: 1_001,
        diagnostics: Object.freeze([]),
        diagnosticsTruncated: false,
    });
}

function managedServiceHandle(id: string): ManagedServiceHandle {
    const current = snapshot(id);
    return Object.freeze({
        snapshot: () => current,
        observe(
            listener: Parameters<ManagedServiceHandle['observe']>[0],
        ) {
            listener(current);
            return Object.freeze({ dispose() {} });
        },
        waitUntilHealthy: async () => current,
        async request() {
            throw new Error('Unexpected managed service request');
        },
        stop: async () => Object.freeze({ status: 'stopped' as const }),
        async dispose() {},
    });
}

function providerRuntimeBindingBasis(): ProviderRuntimeBindingBasisV1 {
    return {
        v: 1,
        deployment: {
            kind: 'managedLocal',
            implementationIdentity: {
                pluginId: 'acme.provider-p',
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
        agentTargetKey: 'backend:routing-agent',
        connectionId:
            ProviderConnectionIdSchema.parse('connection-provider-p'),
        contributionKey: 'acme.provider-p/gateway',
        endpoint: {
            endpointTemplateId: 'messages',
            protocol: 'anthropic',
            publicHeaders: {},
        },
        runtimeCredentialTransport: null,
        prepared: { v: 1, materialization: 'spawnEnv' },
        adapterVersion: 1,
        credentialAuthorization: {
            connectionSecurityFingerprint: 'connection-security-p',
            grantFingerprint: 'provider-grant-p',
        },
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
    };
}

function providerScope(): RunnerManagedProviderCustodyScopeV1 {
    return Object.freeze({
        v: 1,
        sessionId: SESSION_ID,
        runtimeBindingBasis: providerRuntimeBindingBasis(),
        pluginId: 'acme.provider-p',
        providerLocalId: 'gateway',
        activationGeneration: 'provider-p-activation',
        immutableGenerationId: 'provider-p-generation',
        manifestAuthority: 'external',
        operationClaimId: 'session-demand:provider-p',
    });
}

function providerClaim(
    scope: RunnerManagedProviderCustodyScopeV1,
): RunnerManagedProviderCustodyClaimV1 {
    return Object.freeze({ ...scope });
}

describe('retained Agent composed daemon-service routing (integration)', () => {
    it('routes retained G through stable/current/private owners without H aliasing or replay and keeps adopted P distinct', async () => {
        const happyHomeDir = await mkdtemp(join(
            tmpdir(),
            'happier-retained-routing-home-',
        ));
        const pluginRoot = await mkdtemp(join(
            tmpdir(),
            'happier-retained-routing-plugin-',
        ));
        const toolRoot = await mkdtemp(join(
            tmpdir(),
            'happier-retained-routing-tools-',
        ));
        const toolSuffix = process.platform === 'win32' ? '.exe' : '';
        const gToolName = `retained-routing-g${toolSuffix}`;
        const hToolName = `retained-routing-h${toolSuffix}`;
        const gToolPath = join(toolRoot, gToolName);
        const hToolPath = join(toolRoot, hToolName);
        await Promise.all([
            process.platform === 'win32'
                ? copyFile(process.execPath, gToolPath)
                : symlink(process.execPath, gToolPath),
            process.platform === 'win32'
                ? copyFile(process.execPath, hToolPath)
                : symlink(process.execPath, hToolPath),
        ]);
        const originalPath = process.env.PATH;
        process.env.PATH = `${toolRoot}${delimiter}${originalPath ?? ''}`;

        const connectedAccountGetBinding = vi.fn<
            StablePluginConnectedAccountsOwner['getBinding']
        >(async (input) => Object.freeze({
            purpose: input.purpose.purpose,
            service: input.serviceRefs[0]!,
            account: Object.freeze({
                service: input.serviceRefs[0]!,
                accountId: 'account-retained-routing',
            }),
            target: Object.freeze({
                kind: 'group' as const,
                displayName: 'Live owner after H',
            }),
        }));
        const stableConnectedAccountsOwner = Object.freeze({
            getBinding: connectedAccountGetBinding,
            requestSelection: vi.fn<
                StablePluginConnectedAccountsOwner['requestSelection']
            >(async (input) => Object.freeze({
                purpose: input.purpose.purpose,
                service: input.serviceRefs[0]!,
                account: Object.freeze({
                    service: input.serviceRefs[0]!,
                    accountId: 'account-retained-routing',
                }),
                target: Object.freeze({
                    kind: 'group' as const,
                    displayName: 'Live owner after H',
                }),
            })),
            materialize: vi.fn<
                StablePluginConnectedAccountsOwner['materialize']
            >(async (input): Promise<
                PluginConnectedAccountMaterialization
            > => input.request.kind === 'environment'
                ? Object.freeze({
                    kind: 'environment',
                    env: Object.freeze({}),
                })
                : input.request.kind === 'httpHeaders'
                    ? Object.freeze({
                        kind: 'httpHeaders',
                        headers: Object.freeze({}),
                    })
                    : Object.freeze({
                        kind: 'files',
                        files: Object.freeze({}),
                    })),
            listAccounts: async () => {
                throw new Error('Connected Account listing is outside this fixture');
            },
            materializeListedAccount: async () => {
                throw new Error('Exact-listed Connected Account materialization is outside this fixture');
            },
            watch: vi.fn<StablePluginConnectedAccountsOwner['watch']>(
                () => Object.freeze({ dispose() {} }),
            ),
        }) satisfies StablePluginConnectedAccountsOwner;

        let gRegistry: Awaited<
            ReturnType<typeof resolveExecutablePluginRuntimeRegistry>
        > | null = null;
        let hRegistry: Awaited<
            ReturnType<typeof resolveExecutablePluginRuntimeRegistry>
        > | null = null;
        let pluginServicesHost: ReturnType<
            typeof createRunnerDaemonPluginServicesHost
        > | null = null;
        let reloadController: ReturnType<
            typeof createPluginReloadController
        > | null = null;
        const facetServices: RunnerAgentDaemonFacetService[] = [];
        const facetOwners: ReturnType<
            typeof createExternalSessionHostOperationOwner
        >[] = [];
        let providerCustody: ReturnType<
            typeof createRunnerManagedServicesCustodyPort
        > | null = null;
        let releaseGManagedDependencyRetention:
            (() => void) | null = null;
        const pluginServicesLifetime = new AbortController();
        const currentGlobalFollowOwner =
            createExternalSessionHostOperationOwner();
        const currentGlobalFollowSubscriptionDispose = vi.fn(async () => {});
        const currentGlobalFollowOperation:
            ExternalSessionFollowHostOperation = Object.freeze({
                async execute() {
                    return Object.freeze({
                        status: 'following' as const,
                        startingCursor: 'current-global-follow-cursor',
                        subscription: Object.freeze({
                            async dispose() {
                                await currentGlobalFollowSubscriptionDispose();
                            },
                        }),
                    });
                },
            });
        const currentGlobalFollowInstallation =
            await currentGlobalFollowOwner.install({
                followOperation: currentGlobalFollowOperation,
            });
        facetOwners.push(currentGlobalFollowOwner);
        try {
            await writePluginSource({
                pluginRoot,
                version: 'G',
                accountServiceId: 'account-g',
                toolName: gToolName,
            });
            await installCurrentSource({
                happyHomeDir,
                pluginRoot,
                version: '1.0.0',
            });
            const gContributes = await resolveMergedContributionRegistry({
                happyHomeDir,
            });
            expect(
                gContributes.pluginDiagnosticsByPluginId[PLUGIN_ID] ?? [],
            ).toEqual([]);
            expect(gContributes.activationTargets).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({ pluginId: PLUGIN_ID }),
                ]),
            );
            reloadController = createPluginReloadController({
                resolveRuntimeRegistry: async () => gRegistry!,
            });
            gRegistry = await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                generation: 1,
                connectedAccounts: stableConnectedAccountsOwner,
                currentGlobalExternalSessionsRouter:
                    reloadController.currentGlobalExternalSessions,
            });
            await gRegistry.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID,
                family: 'agents',
                localId: AGENT_ID,
            }]);
            expect(gRegistry.targetActivationFacts).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        pluginId: PLUGIN_ID,
                        status: 'active',
                        diagnostics: [],
                    }),
                ]),
            );
            expect(gRegistry.contributes.agents).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        pluginId: PLUGIN_ID,
                        id: AGENT_ID,
                    }),
                ]),
            );
            const gAgent = gRegistry.agentRuntimesByAgentId.get(AGENT_ID);
            expect(gAgent).toMatchObject({
                hasPrimaryRuntime: true,
                sessionRunnerFactoryBinding: {
                    normalizedModulePath: 'agentRuntime.mjs',
                },
            });
            const binding = gAgent?.sessionRunnerFactoryBinding;
            expect(binding).toBeDefined();
            if (!binding) return;
            const runner = Object.freeze({
                pid: process.pid,
                processStartTimeMs: 1,
                processCommandHash: 'a'.repeat(64),
                snapshotIdentity: 'retained-routing-runner',
            });
            const reserveManagedDependencyRetention =
                gRegistry.reserveManagedDependencyRetention;
            expect(reserveManagedDependencyRetention).toBeTypeOf('function');
            if (!reserveManagedDependencyRetention) return;
            const gManagedDependencyReservation =
                await reserveManagedDependencyRetention(
                    binding,
                );
            releaseGManagedDependencyRetention =
                gManagedDependencyReservation.release;
            const managedDependencyRetention =
                gManagedDependencyReservation.retention;
            expect(managedDependencyRetention).toMatchObject({
                qualifiedDependencyIds: [
                    `${PLUGIN_ID}/${DEPENDENCY_ID}`,
                ],
                sourceGenerationIds: [
                    binding.immutableGenerationId,
                ],
            });
            expect(gRegistry.generation).toBe(1);

            const initialRegistryLease =
                await reloadController.acquireRuntimeRegistry();
            expect(initialRegistryLease.registry).toBe(gRegistry);
            await initialRegistryLease.release();

            let activeWitness: TurnWitness | null = null;
            let invocationAuthorityCurrent = true;
            const createRetainedInvocation = vi.fn(async (input: Readonly<{
                binding: typeof binding;
                sessionId: string;
                correlationId: string;
                cwd: string;
                environment: Readonly<Record<string, string>>;
                providerBindingActive: boolean;
                signal: AbortSignal;
                isGenerationCurrent(): boolean;
                managedDependencyRetention:
                    typeof managedDependencyRetention;
            }>) => {
                const lease = await reloadController!
                    .acquireRuntimeRegistry();
                const createRetained = lease.registry
                    .createRetainedRunnerAgentInvocationServices;
                if (!createRetained) {
                    await lease.release();
                    throw new Error(
                        'retained service factory unavailable',
                    );
                }
                try {
                    const projection = await createRetained(input);
                    await lease.release();
                    return projection;
                } catch (error) {
                    await lease.release();
                    throw error;
                }
            });
            const authorizedLaunchCommands: string[] = [];
            const daemonPluginOperations:
                RunnerDaemonPluginServiceOperationV1[] = [];
            const completedDaemonPluginOperations:
                RunnerDaemonPluginServiceOperationV1[] = [];
            pluginServicesHost = createRunnerDaemonPluginServicesHost({
                async createInvocation(input) {
                    const retained = await createRetainedInvocation({
                        binding: input.retainedAgent,
                        sessionId: input.sessionId,
                        correlationId: input.invocationId,
                        cwd: pluginRoot,
                        environment: {},
                        providerBindingActive: false,
                        signal: input.signal,
                        isGenerationCurrent: () =>
                            invocationAuthorityCurrent,
                        managedDependencyRetention,
                    });
                    const currentGlobalMcp:
                        RunnerDaemonCurrentGlobalMcpOwner = Object.freeze({
                        async list(query) {
                            const currentLease = await reloadController!
                                .acquireRuntimeRegistry();
                            try {
                                const createCurrent = currentLease.registry
                                    .createRetainedRunnerAgentCurrentGlobalMcpService;
                                if (!createCurrent) {
                                    throw new Error(
                                        'current MCP service unavailable',
                                    );
                                }
                                return await (await createCurrent({
                                    binding: input.retainedAgent,
                                    sessionId: input.sessionId,
                                    correlationId: input.invocationId,
                                    signal: input.signal,
                                    isGenerationCurrent: () =>
                                        invocationAuthorityCurrent,
                                })).list(query);
                            } finally {
                                await currentLease.release();
                            }
                        },
                        async discover(provider, query, options) {
                            const currentLease = await reloadController!
                                .acquireRuntimeRegistry();
                            try {
                                const createCurrent = currentLease.registry
                                    .createRetainedRunnerAgentCurrentGlobalMcpService;
                                if (!createCurrent) {
                                    throw new Error(
                                        'current MCP service unavailable',
                                    );
                                }
                                return await (await createCurrent({
                                    binding: input.retainedAgent,
                                    sessionId: input.sessionId,
                                    correlationId: input.invocationId,
                                    signal: input.signal,
                                    isGenerationCurrent: () =>
                                        invocationAuthorityCurrent,
                                })).discover(provider, query, options);
                            } finally {
                                await currentLease.release();
                            }
                        },
                        async connect(ref, options) {
                            const currentLease = await reloadController!
                                .acquireRuntimeRegistry();
                            let transferred = false;
                            try {
                                const createCurrent = currentLease.registry
                                    .createRetainedRunnerAgentCurrentGlobalMcpService;
                                if (!createCurrent) {
                                    throw new Error(
                                        'current MCP service unavailable',
                                    );
                                }
                                const client = await (await createCurrent({
                                    binding: input.retainedAgent,
                                    sessionId: input.sessionId,
                                    correlationId: input.invocationId,
                                    signal: input.signal,
                                    isGenerationCurrent: () =>
                                        invocationAuthorityCurrent,
                                })).connect(ref, options);
                                let disposal: Promise<void> | null = null;
                                const dispose = () => {
                                    disposal ??= (async () => {
                                        await client.dispose();
                                        await currentLease.release();
                                    })();
                                    return disposal;
                                };
                                transferred = true;
                                return Object.freeze({
                                    listTools: client.listTools,
                                    callTool: client.callTool,
                                    listResources: client.listResources,
                                    listResourceTemplates:
                                        client.listResourceTemplates,
                                    readResource: client.readResource,
                                    subscribeResource:
                                        client.subscribeResource,
                                    listPrompts: client.listPrompts,
                                    getPrompt: client.getPrompt,
                                    dispose,
                                });
                            } finally {
                                if (!transferred) {
                                    await currentLease.release();
                                }
                            }
                        },
                    });
                    const withCurrentExternalSessions = async <T>(
                        operation: (
                            service:
                                RunnerDaemonCurrentGlobalExternalSessionsOwner,
                        ) => Promise<T>,
                    ): Promise<T> => {
                        const currentLease = await reloadController!
                            .acquireRuntimeRegistry();
                        try {
                            const createCurrent = currentLease.registry
                                .createRetainedRunnerAgentCurrentGlobalExternalSessionsService;
                            if (!createCurrent) {
                                throw new Error(
                                    'current External Sessions service unavailable',
                                );
                            }
                            return await operation(await createCurrent({
                                binding: input.retainedAgent,
                                sessionId: input.sessionId,
                                correlationId: input.invocationId,
                                signal: input.signal,
                                isGenerationCurrent: () =>
                                    invocationAuthorityCurrent,
                            }));
                        } finally {
                            await currentLease.release();
                        }
                    };
                    const currentGlobalExternalSessions:
                        RunnerDaemonCurrentGlobalExternalSessionsOwner =
                        Object.freeze({
                            async capabilities(options) {
                                return await withCurrentExternalSessions(
                                    async (service) =>
                                        await service.capabilities(options),
                                );
                            },
                            async list(query, options) {
                                return await withCurrentExternalSessions(
                                    async (service) =>
                                        await service.list(query, options),
                                );
                            },
                            async attach(ref, options) {
                                return await withCurrentExternalSessions(
                                    async (service) =>
                                        await service.attach(ref, options),
                                );
                            },
                            async readTranscript(ref, query, options) {
                                return await withCurrentExternalSessions(
                                    async (service) =>
                                        await service.readTranscript(
                                            ref,
                                            query,
                                            options,
                                        ),
                                );
                            },
                            async followTranscript(
                                ref,
                                options,
                                listener,
                            ) {
                                return await withCurrentExternalSessions(
                                    async (service) =>
                                        await service.followTranscript(
                                            ref,
                                            options,
                                            listener,
                                        ),
                                );
                            },
                            async takeover(ref, request, options) {
                                return await withCurrentExternalSessions(
                                    async (service) =>
                                        await service.takeover(
                                            ref,
                                            request,
                                            options,
                                        ),
                                );
                            },
                        });
                    return Object.freeze({
                        ...retained,
                        dispose() {},
                        authorizeOperation(witness, options) {
                            if (!invocationAuthorityCurrent) {
                                return false;
                            }
                            if (!witness) {
                                return options?.requireActiveTurn
                                    !== true;
                            }
                            return activeWitness
                                ? sameWitness(
                                    witness,
                                    activeWitness,
                                )
                                : false;
                        },
                        executeCurrentGlobalAction: async (
                            actionId,
                            actionInput,
                            options,
                        ) => {
                            const currentLease =
                                await reloadController!
                                    .acquireRuntimeRegistry();
                            try {
                                const createCurrent =
                                    currentLease.registry
                                        .createRetainedRunnerAgentCurrentGlobalActionsService;
                                if (!createCurrent) {
                                    throw new Error(
                                        'current Action service unavailable',
                                    );
                                }
                                const actions = await createCurrent({
                                    binding: input.retainedAgent,
                                    sessionId: input.sessionId,
                                    correlationId:
                                        input.invocationId,
                                    signal: input.signal,
                                    isGenerationCurrent: () =>
                                        invocationAuthorityCurrent,
                                });
                                const executeCurrentAction =
                                    actions.execute as (
                                        action: Parameters<
                                            RunnerDaemonCurrentGlobalActionExecutor
                                        >[0],
                                        actionInput: Parameters<
                                            RunnerDaemonCurrentGlobalActionExecutor
                                        >[1],
                                        actionOptions: Parameters<
                                            RunnerDaemonCurrentGlobalActionExecutor
                                        >[2],
                                    ) => Promise<unknown>;
                                return await executeCurrentAction(
                                    actionId,
                                    actionInput,
                                    options,
                                );
                            } finally {
                                await currentLease.release();
                            }
                        },
                        currentGlobalMcp,
                        currentGlobalExternalSessions,
                    });
                },
            });
            const daemonPluginDispatch: Parameters<
                typeof prepareRunnerDaemonPluginServices
            >[0]['dispatch'] = async (operation, options) => {
                daemonPluginOperations.push(operation);
                if (!pluginServicesHost) {
                    throw new Error('PluginServices host unavailable');
                }
                const hostedResult =
                    await pluginServicesHost.dispatch({
                        sessionId: SESSION_ID,
                        runner,
                        retainedAgent: binding,
                        operation,
                        ...(options?.signal
                            ? { signal: options.signal }
                            : {}),
                    });
                completedDaemonPluginOperations.push(operation);
                const result = RunnerDaemonPluginServiceResultV1Schema.parse(
                    JSON.parse(JSON.stringify(
                        hostedResult,
                    )),
                );
                const decoded =
                    decodeRunnerDaemonPluginServiceWireValueV1(
                        result.value,
                    );
                if (
                    operation.kind
                        === 'plugin_exec.launch.authorize_v1'
                    && decoded
                    && typeof decoded === 'object'
                    && !Array.isArray(decoded)
                    && !(decoded instanceof Uint8Array)
                ) {
                    const launch = Reflect.get(decoded, 'launch');
                    if (
                        launch
                        && typeof launch === 'object'
                        && typeof Reflect.get(launch, 'command')
                            === 'string'
                    ) {
                        authorizedLaunchCommands.push(
                            Reflect.get(launch, 'command'),
                        );
                    }
                }
                return decoded;
            };
            const unavailable = createUnavailablePluginServices();
            const runnerServices =
                await prepareRunnerDaemonPluginServices({
                    invocationId: 'retained-routing-invocation',
                    signal: pluginServicesLifetime.signal,
                    dispatch: daemonPluginDispatch,
                    readActiveTurnAdmissionWitness: () =>
                        activeWitness,
                    local: {
                        availability: unavailable.availability,
                        logger: unavailable.logger,
                        sessions: unavailable.sessions,
                        managedServices:
                            unavailable.managedServices,
                        exec: unavailable.exec,
                        interactions: unavailable.interactions,
                        targetedContributions: unavailable.targetedContributions,
                        composerContent: unavailable.composerContent,
                    },
                });

            await runnerServices.storage.daemonSession.set(
                'retained-before-h',
                { generation: 'G' },
            );
            await expect(runnerServices.storage.daemonSession.get(
                'retained-before-h',
            )).resolves.toEqual({ generation: 'G' });
            await expect(runnerServices.settings.forScope({ kind: 'daemon' }).get(
                'retained-generation',
            )).resolves.toBe('G');
            const idleSettingsWatch = runnerServices.settings.forScope({ kind: 'daemon' }).watch(
                () => {},
            );
            await vi.waitFor(() => expect(
                daemonPluginOperations.some((operation) =>
                    operation.kind
                        === 'plugin_settings.watch.open_v1'),
            ).toBe(true));
            await expect(
                runnerServices.connectedAccounts.getBinding(
                    'stable-account',
                ),
            ).resolves.toMatchObject({
                service: {
                    pluginId: PLUGIN_ID,
                    localId: 'account-g',
                },
            });

            await writePluginSource({
                pluginRoot,
                version: 'H',
                accountServiceId: 'account-h',
                toolName: hToolName,
            });
            await installCurrentSource({
                happyHomeDir,
                pluginRoot,
                version: '2.0.0',
            });
            const hGenerationAuthority =
                await readCurrentFixtureGenerationAuthority({
                    happyHomeDir,
                    expectedVersion: 'H',
                });
            const resolvedHRegistry =
                await resolveExecutablePluginRuntimeRegistry({
                happyHomeDir,
                generation: 1,
                generationAuthority: hGenerationAuthority,
                connectedAccounts: stableConnectedAccountsOwner,
                stableEventsBroker:
                    gRegistry.stableEventsBroker,
                externalSessionHostOperationOwner:
                    currentGlobalFollowOwner,
                currentGlobalExternalSessionsRouter:
                    reloadController.currentGlobalExternalSessions,
                resolveExternalSessionCurrentMachineId: () =>
                    'machine-current-global-routing',
            });
            await resolvedHRegistry.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID,
                family: 'agents',
                localId: AGENT_ID,
            }]);
            const createActualHCurrentExternalSessions =
                resolvedHRegistry
                    .createRetainedRunnerAgentCurrentGlobalExternalSessionsService;
            expect(createActualHCurrentExternalSessions).toBeDefined();
            if (!createActualHCurrentExternalSessions) return;
            const actualHCurrentExternalSessions =
                await createActualHCurrentExternalSessions({
                    binding,
                    sessionId: SESSION_ID,
                    correlationId: 'current-global-owner-preservation',
                    signal: new AbortController().signal,
                    isGenerationCurrent: () => true,
                });
            const firstCurrentPage = await actualHCurrentExternalSessions.list({
                agentId: AGENT_ID,
            });
            const firstCurrentRef = firstCurrentPage.items[0]?.ref;
            const firstCurrentCursor = firstCurrentPage.nextCursor;
            if (!firstCurrentRef || !firstCurrentCursor) {
                throw new Error('Expected the published current-G first page and cursor');
            }
            expect(firstCurrentRef.remoteSessionId).toBe('current-G');
            await expect(actualHCurrentExternalSessions.list({
                agentId: AGENT_ID,
                cursor: firstCurrentCursor,
            })).resolves.toMatchObject({
                items: [{
                    ref: {
                        agentId: AGENT_ID,
                        remoteSessionId: 'current-G-page-2',
                    },
                }],
                nextCursor: null,
            });
            const hFollowTranscript = vi.fn(async () => Object.freeze({
                status: 'unavailable' as const,
                code: 'plugin_external_follow_unavailable',
            }));
            const hExternalSessions = Object.freeze({
                    async capabilities() {
                        const available = Object.freeze({
                            status: 'available' as const,
                        });
                        return Object.freeze({
                            list: available,
                            attach: available,
                            transcript: available,
                            follow: available,
                            takeover: Object.freeze({
                                status: 'unavailable' as const,
                                code: 'plugin_external_takeover_unavailable',
                            }),
                        });
                    },
                    async list(query) {
                        if (query?.sourceId === 'unavailable') {
                            throw new PluginError({
                                code:
                                    'plugin_external_sources_unavailable',
                                message:
                                    'Current External Sessions source is unavailable',
                            });
                        }
                        return Object.freeze({
                            items: Object.freeze([Object.freeze({
                                ref: Object.freeze({
                                    agentId: AGENT_ID,
                                    sourceId: 'default',
                                    remoteSessionId: 'current-H',
                                }),
                                title: 'Current H',
                                capabilities: Object.freeze([
                                    'attach' as const,
                                    'transcript' as const,
                                    'follow' as const,
                                ]),
                                takeover: Object.freeze({
                                    status: 'unavailable' as const,
                                    code:
                                        'plugin_external_takeover_unavailable',
                                }),
                            })]),
                            nextCursor: null,
                        });
                    },
                    async attach() {
                        throw new PluginError({
                            code: 'plugin_external_attach_unavailable',
                            message: 'attach unavailable',
                        });
                    },
                    async readTranscript() {
                        throw new PluginError({
                            code:
                                'plugin_external_transcript_unavailable',
                            message: 'transcript unavailable',
                        });
                    },
                    followTranscript: hFollowTranscript,
                    async takeover() {
                        throw new PluginError({
                            code:
                                'plugin_external_takeover_unavailable',
                            message: 'takeover unavailable',
                        });
                    },
                } satisfies PluginServices['sessions']['external']);
            const createHCurrentExternalSessions = vi.fn(
                async () => hExternalSessions,
            );
            hRegistry = Object.freeze({
                ...resolvedHRegistry,
                createRetainedRunnerAgentCurrentGlobalExternalSessionsService:
                    createHCurrentExternalSessions,
            });
            expect(hRegistry.stableEventsBroker)
                .toBe(gRegistry.stableEventsBroker);
            await hRegistry.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID,
                family: 'agents',
                localId: AGENT_ID,
            }]);
            const hAgent =
                hRegistry.agentRuntimesByAgentId.get(AGENT_ID);
            expect(hRegistry.generation).toBe(1);
            expect(hAgent).toMatchObject({
                pluginVersion: '2.0.0',
                immutableGenerationId: expect.any(String),
            });
            if (!hAgent?.immutableGenerationId) {
                throw new Error(
                    'Current H immutable generation is unavailable',
                );
            }
            expect(hAgent?.immutableGenerationId)
                .not.toBe(binding.immutableGenerationId);
            const voiceProvider = Object.freeze({
                pluginId: PLUGIN_ID,
                localId: VOICE_PROVIDER_ID,
            });
            expect(hRegistry.contributes.voiceProviders).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        identity: voiceProvider,
                        definition: expect.objectContaining({
                            title: 'Routing realtime H',
                        }),
                    }),
                ]),
            );
            expect(
                hRegistry.resolveVoiceProviderRuntimeLifecycle?.(
                    voiceProvider,
                )?.generation,
            ).toBe(hAgent.immutableGenerationId);
            expect(JSON.parse(await readFile(join(
                resolvePluginStorePaths({ happyHomeDir })
                    .generationsDir,
                binding.immutableGenerationId,
                '.happier-plugin',
                'plugin.json',
            ), 'utf8')) as unknown).toMatchObject({
                version: '1.0.0',
                contributes: {
                    managedDependencies: [{
                        id: DEPENDENCY_ID,
                        sources: [{
                            kind: 'system',
                            executableNames: [gToolName],
                        }],
                    }],
                },
            });
            const reserveHManagedDependencyRetention =
                hRegistry.reserveManagedDependencyRetention;
            expect(reserveHManagedDependencyRetention).toBeTypeOf('function');
            if (!reserveHManagedDependencyRetention) return;
            const hReservation = await reserveHManagedDependencyRetention(
                hAgent.sessionRunnerFactoryBinding!,
            );
            expect(hReservation?.retention).toMatchObject({
                qualifiedDependencyIds: [
                    `${PLUGIN_ID}/${DEPENDENCY_ID}`,
                ],
                sourceGenerationIds: [
                    hAgent.immutableGenerationId,
                ],
            });
            expect(hReservation?.retention)
                .not.toEqual(managedDependencyRetention);
            hReservation?.release();

            await reloadController.adoptPreparedRuntimeRegistry({
                registry: hRegistry,
                changedPluginIds: [PLUGIN_ID],
                durableRevision: 1,
                runningSessionDisposition: 'retainRunningSessions',
            });
            expect(reloadController.getState().activeRegistry)
                .toBe(hRegistry);

            await hRegistry.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID,
                family: 'requestInterceptors',
                localId: 'deny-retained-http',
            }]);
            const retainedCurrentPolicyServices =
                await prepareRunnerDaemonPluginServices({
                    invocationId: 'retained-routing-current-http-policy',
                    signal: pluginServicesLifetime.signal,
                    dispatch: daemonPluginDispatch,
                    readActiveTurnAdmissionWitness: () =>
                        activeWitness,
                    local: {
                        availability: unavailable.availability,
                        logger: unavailable.logger,
                        sessions: unavailable.sessions,
                        managedServices:
                            unavailable.managedServices,
                        exec: unavailable.exec,
                        interactions: unavailable.interactions,
                        targetedContributions:
                            unavailable.targetedContributions,
                        composerContent: unavailable.composerContent,
                    },
                });
            const originalGlobalFetch = globalThis.fetch;
            const terminalFetch = vi.fn(async () => new Response('allowed'));
            vi.stubGlobal('fetch', terminalFetch);
            try {
                await expect(retainedCurrentPolicyServices.http.request({
                    url: 'https://policy.example.test/blocked',
                    method: 'GET',
                    redirect: 'error',
                })).rejects.toMatchObject({
                    code: 'plugin_fetch_interceptor_denied',
                });
                await expect(retainedCurrentPolicyServices.http.request({
                    url: 'https://policy.example.test/allowed',
                    method: 'GET',
                    headers: {
                        authorization: 'Bearer runner-caller-value',
                        'x-tenant-label': 'caller-visible',
                    },
                    redirect: 'error',
                })).resolves.toMatchObject({
                    status: 200,
                    body: new TextEncoder().encode('allowed'),
                });
            } finally {
                vi.stubGlobal('fetch', originalGlobalFetch);
            }
            expect(daemonPluginOperations).toContainEqual(
                expect.objectContaining({
                    kind: 'plugin_fetch.request_v1',
                    invocationId:
                        'retained-routing-current-http-policy',
                    request: expect.objectContaining({
                        url: 'https://policy.example.test/blocked',
                        method: 'GET',
                    }),
                }),
            );
            expect(terminalFetch).toHaveBeenCalledOnce();
            expect(terminalFetch).toHaveBeenCalledWith(
                'https://policy.example.test/allowed',
                expect.objectContaining({
                    headers: {
                        authorization: 'Bearer runner-caller-value',
                        'x-tenant-label': 'rewritten-by-current-policy',
                    },
                }),
            );

            await expect(
                runnerServices.sessions.external.capabilities(),
            ).resolves.toMatchObject({
                list: { status: 'available' },
                attach: { status: 'available' },
                transcript: { status: 'available' },
                follow: { status: 'available' },
                takeover: {
                    status: 'unavailable',
                    code: 'plugin_external_takeover_unavailable',
                },
            });
            await expect(runnerServices.sessions.external.list({
                agentId: AGENT_ID,
            })).resolves.toMatchObject({
                items: [{
                    ref: {
                        agentId: AGENT_ID,
                        remoteSessionId: 'current-H',
                    },
                    title: 'Current H',
                }],
            });
            expect(createHCurrentExternalSessions).toHaveBeenCalledWith(
                expect.objectContaining({
                    binding: expect.objectContaining({
                        immutableGenerationId:
                            binding.immutableGenerationId,
                    }),
                    sessionId: SESSION_ID,
                }),
            );
            await expect(runnerServices.sessions.external.list({
                agentId: AGENT_ID,
                sourceId: 'unavailable',
            })).rejects.toMatchObject({
                code: 'plugin_external_sources_unavailable',
            });

            await expect(runnerServices.storage.daemonSession.get(
                'retained-before-h',
            )).resolves.toEqual({ generation: 'G' });
            await expect(runnerServices.settings.forScope({ kind: 'daemon' }).get(
                'retained-generation',
            )).resolves.toBe('G');
            await idleSettingsWatch.dispose();
            await expect(
                runnerServices.connectedAccounts.getBinding(
                    'stable-account',
                ),
            ).resolves.toMatchObject({
                service: {
                    pluginId: PLUGIN_ID,
                    localId: 'account-g',
                },
            });
            activeWitness = FIRST_WITNESS;

            const deliveredHostEvents: unknown[] = [];
            const hostEventSubscription =
                runnerServices.events.host.subscribe({
                    eventId: '@happier/runtime/turn-complete',
                    scope: {
                        kind: 'session',
                        sessionId: SESSION_ID,
                    },
                }, async (event) => {
                    deliveredHostEvents.push(event);
                });
            await vi.waitFor(() => expect(
                daemonPluginOperations.some((operation) =>
                    operation.kind
                        === 'plugin_events.host.subscribe.open_v1'),
            ).toBe(true));
            const hostEvent = Object.freeze({
                sequence: 1,
                sessionId: SESSION_ID,
                emittedAtMs: 2,
                kind: 'turn-complete' as const,
                turnId: 'turn-host-event-g',
            });
            hRegistry.publishHostEvent?.(hostEvent);
            await vi.waitFor(() => expect(deliveredHostEvents)
                .toEqual([{
                    eventId: '@happier/runtime/turn-complete',
                    scope: {
                        kind: 'session',
                        sessionId: SESSION_ID,
                    },
                    payload: hostEvent,
                }]));
            await hostEventSubscription.dispose();
            hRegistry.publishHostEvent?.({
                ...hostEvent,
                sequence: 2,
            });
            await new Promise((resolve) => setTimeout(resolve, 25));
            expect(deliveredHostEvents).toHaveLength(1);

            await expect(
                runnerServices.connectedAccounts.getBinding(
                    'stable-account',
                ),
            ).resolves.toMatchObject({
                purpose: 'stable-account',
                service: {
                    pluginId: PLUGIN_ID,
                    localId: 'account-g',
                },
            });
            activeWitness = LATER_WITNESS;
            await expect(
                runnerServices.connectedAccounts.getBinding(
                    'stable-account',
                ),
            ).resolves.toMatchObject({
                service: {
                    pluginId: PLUGIN_ID,
                    localId: 'account-g',
                },
            });
            expect(connectedAccountGetBinding).toHaveBeenCalledTimes(4);
            expect(connectedAccountGetBinding.mock.calls.map(
                ([call]) => call.purpose,
            )).toEqual([
                {
                    consumer: {
                        pluginId: PLUGIN_ID,
                        localId: AGENT_ID,
                    },
                    purpose: 'stable-account',
                },
                {
                    consumer: {
                        pluginId: PLUGIN_ID,
                        localId: AGENT_ID,
                    },
                    purpose: 'stable-account',
                },
                {
                    consumer: {
                        pluginId: PLUGIN_ID,
                        localId: AGENT_ID,
                    },
                    purpose: 'stable-account',
                },
                {
                    consumer: {
                        pluginId: PLUGIN_ID,
                        localId: AGENT_ID,
                    },
                    purpose: 'stable-account',
                },
            ]);

            expect(runnerServices.availability('mcp')).toEqual({
                status: 'available',
            });
            await expect(runnerServices.mcp.list({
                sessionId: SESSION_ID,
            })).resolves.toEqual({
                items: [{
                    ref: {
                        pluginId: PLUGIN_ID,
                        localId: MCP_SERVER_ID,
                    },
                    title: 'Routing tools H',
                    state: 'available',
                }],
            });
            await expect(runnerServices.mcp.discover({
                pluginId: PLUGIN_ID,
                localId: MCP_DISCOVERY_SOURCE_ID,
            })).resolves.toEqual({
                items: [{
                    provider: {
                        pluginId: PLUGIN_ID,
                        localId: MCP_DISCOVERY_SOURCE_ID,
                    },
                    discoveryId: 'routing-H',
                    title: 'Routing discovery H',
                    metadata: { generation: 'H' },
                }],
            });
            const establishedHMcpClient =
                await runnerServices.mcp.connect({
                    pluginId: PLUGIN_ID,
                    localId: MCP_SERVER_ID,
                }, {
                    sessionId: SESSION_ID,
                    elicitation: {
                        mode: 'hostMediated',
                        sessionId: SESSION_ID,
                    },
                });
            await expect(establishedHMcpClient.listTools())
                .resolves.toMatchObject({
                    items: [{ name: `${MCP_SERVER_ID}-H` }],
                });
            await expect(runnerServices.mcp.connect({
                pluginId: PLUGIN_ID,
                localId: MCP_CURRENT_ONLY_SERVER_ID,
            }, {
                sessionId: SESSION_ID,
                elicitation: {
                    mode: 'hostMediated',
                    sessionId: SESSION_ID,
                },
            })).rejects.toMatchObject({
                code: 'plugin_mcp_access_denied',
            });

            const execResult = await runnerServices.exec.run({
                executable: {
                    kind: 'managedDependency',
                    id: DEPENDENCY_ID,
                },
                args: [
                    '-e',
                    'process.stdout.write(process.argv0)',
                ],
            });
            const execStderr = new TextDecoder().decode(
                execResult.stderr,
            );
            expect(
                execResult.termination.observed,
                execStderr,
            ).toEqual({
                kind: 'exit',
                exitCode: 0,
            });
            expect(execStderr).toBe('');
            expect(new TextDecoder().decode(execResult.stdout))
                .toBe(gToolPath);
            expect(authorizedLaunchCommands).toEqual([gToolPath]);
            expect(authorizedLaunchCommands).not.toContain(hToolPath);

            const positiveOwner =
                createExternalSessionHostOperationOwner();
            facetOwners.push(positiveOwner);
            const exactGSubscriptionDispose = vi.fn(async () => {});
            const exactGFollow = vi.fn<
                NonNullable<
                    ExternalSessionHostOperationSet['followOperation']
                >['execute']
            >(async (request) => Object.freeze({
                status: 'following' as const,
                startingCursor: request.options.cursor ?? null,
                subscription: Object.freeze({
                    dispose: exactGSubscriptionDispose,
                }),
            }));
            await positiveOwner.install({
                followOperation: { execute: exactGFollow },
                followTargetOperation: null,
            });
            const snapshotRetainedGVoice = (
                hRegistry as typeof hRegistry & Readonly<{
                    snapshotRetainedRunnerAgentSessionRealtimeVoiceAuthority?: (
                        retainedAgent: typeof binding,
                    ) => ReturnType<NonNullable<
                        Parameters<
                            typeof createRunnerAgentDaemonFacetService
                        >[0]['snapshotVoiceAuthority']
                    >>;
                }>
            ).snapshotRetainedRunnerAgentSessionRealtimeVoiceAuthority;
            const exactGVoiceLookup = vi.fn<
                NonNullable<
                    Parameters<
                        typeof createRunnerAgentDaemonFacetService
                    >[0]['snapshotVoiceAuthority']
                >
            >(async ({ retainedAgent }) =>
                await snapshotRetainedGVoice?.(retainedAgent) ?? null,
            );
            let retireExactGVoice!: () => void;
            const exactGVoiceRetirement = new Promise<void>((resolve) => {
                retireExactGVoice = resolve;
            });
            const waitExactGVoiceRetired = vi.fn<
                NonNullable<
                    Parameters<
                        typeof createRunnerAgentDaemonFacetService
                    >[0]['waitVoiceAuthorityRetired']
                >
            >(async () => {
                await exactGVoiceRetirement;
            });
            const positiveFacetService =
                createRunnerAgentDaemonFacetService({
                    externalSessionHostOperationOwner: positiveOwner,
                    machineId: 'machine-routing',
                    readAccountRevision: () =>
                        'account-revision-after-h',
                    authorizeCurrent: async () => true,
                    authorizeActiveTurn: async ({ witness }) =>
                        activeWitness
                            ? sameWitness(witness, activeWitness)
                            : false,
                    snapshotVoiceAuthority: exactGVoiceLookup,
                    waitVoiceAuthorityRetired: waitExactGVoiceRetired,
                });
            facetServices.push(positiveFacetService);
            const facetResponses: AgentRuntimeDaemonServiceResponseV1[] = [];
            const authority = {
                happyHomeDir,
                publicReleaseRing: 'stable' as const,
                path: join(happyHomeDir, 'authority.json'),
                sessionId: SESSION_ID,
                runner,
                retainedAgent: binding,
            };
            const positiveFacets = await createRunnerAgentDaemonFacets({
                authority,
                dispatch: facetLoopback(
                    positiveFacetService,
                    facetResponses,
                ),
                readActiveTurnAdmissionWitness: () =>
                    activeWitness,
            });
            const retainedVoiceAuthority =
                positiveFacets.agentSessionRealtimeVoiceAuthority;
            expect(retainedVoiceAuthority).not.toBeNull();
            expect(retainedVoiceAuthority?.generation)
                .toBe(binding.immutableGenerationId);
            expect(retainedVoiceAuthority?.resolveDeclaration(
                voiceProvider,
            )).toMatchObject({
                id: VOICE_PROVIDER_ID,
                title: 'Routing realtime G',
            });
            expect(retainedVoiceAuthority?.resolveProviderGeneration(
                voiceProvider,
            )).toBe(binding.immutableGenerationId);
            expect(retainedVoiceAuthority?.isCurrent(voiceProvider)).toBe(true);
            expect(facetResponses).toContainEqual(expect.objectContaining({
                ok: true,
                result: expect.objectContaining({
                    kind: 'voice.authority.snapshot',
                    agentGeneration: binding.immutableGenerationId,
                    providers: [expect.objectContaining({
                        provider: voiceProvider,
                        providerGeneration: binding.immutableGenerationId,
                        declaration: expect.objectContaining({
                            title: 'Routing realtime G',
                        }),
                    })],
                }),
            }));
            await vi.waitFor(() => expect(waitExactGVoiceRetired)
                .toHaveBeenCalledWith(expect.objectContaining({
                    retainedAgent: binding,
                    provider: voiceProvider,
                    providerGeneration: binding.immutableGenerationId,
                })));
            const retainedLeaf = await loadRetainedAgentRuntimeLeaf({
                paths: resolvePluginStorePaths({ happyHomeDir }),
                binding,
            });
            const retainedRuntime = await retainedLeaf.factory({
                plugin: {
                    id: binding.pluginId,
                    version: binding.pluginVersion,
                },
                agent: { id: binding.localAgentId },
                signal: new AbortController().signal,
            });
            if (!retainedRuntime.sessions) {
                throw new Error('Expected the retained G Agent session runtime');
            }
            const retainedSession = await retainedRuntime.sessions.open({
                kind: 'create',
                sessionId: `${SESSION_ID}-voice-g`,
                cwd: pluginRoot,
            }, {} as never);
            try {
                const retainedConversation =
                    retainedVoiceAuthority?.resolveConversation({
                        provider: voiceProvider,
                        runtime: retainedSession,
                    });
                expect(retainedConversation).not.toBeNull();
                await expect(
                    retainedConversation?.conversation.inspect(),
                ).resolves.toEqual({
                    status: 'available',
                    transport: 'webrtc',
                });
            } finally {
                await retainedSession.dispose();
            }
            retireExactGVoice();
            await vi.waitFor(() => expect(
                retainedVoiceAuthority?.isCurrent(voiceProvider),
            ).toBe(false));
            const positiveFollow = await positiveFacets
                .externalSessionHostOperations
                .bindSession(SESSION_ID)
                .executeFollow({
                    ref: {
                        agentId: AGENT_ID,
                        sourceId: 'default',
                        remoteSessionId: 'remote-g',
                    },
                    source: SOURCE,
                    options: { cursor: 'cursor-g' },
                    listener: async () => {},
                });
            expect(positiveFollow).toMatchObject({
                status: 'following',
                startingCursor: 'cursor-g',
            });
            expect(exactGFollow).toHaveBeenCalledOnce();
            expect(exactGFollow).toHaveBeenCalledWith(
                expect.objectContaining({
                    pluginId: PLUGIN_ID,
                    contributionId: AGENT_ID,
                    generationId:
                        binding.immutableGenerationId,
                    sessionId: SESSION_ID,
                }),
            );
            expect(hFollowTranscript).not.toHaveBeenCalled();
            expect(exactGSubscriptionDispose).not.toHaveBeenCalled();

            const missingOwner =
                createExternalSessionHostOperationOwner();
            facetOwners.push(missingOwner);
            await missingOwner.install({
                followOperation: null,
                followTargetOperation: null,
            });
            const missingFacetService =
                createRunnerAgentDaemonFacetService({
                    externalSessionHostOperationOwner: missingOwner,
                    machineId: 'machine-routing',
                    readAccountRevision: () =>
                        'account-revision-after-h',
                    authorizeCurrent: async () => true,
                    authorizeActiveTurn: async ({ witness }) =>
                        activeWitness
                            ? sameWitness(witness, activeWitness)
                            : false,
                    snapshotVoiceAuthority: exactGVoiceLookup,
                    waitVoiceAuthorityRetired: async () => {},
                });
            facetServices.push(missingFacetService);
            const missingFacets = await createRunnerAgentDaemonFacets({
                authority,
                dispatch: facetLoopback(missingFacetService, []),
                readActiveTurnAdmissionWitness: () =>
                    activeWitness,
            });
            await expect(missingFacets
                .externalSessionHostOperations
                .bindSession(SESSION_ID)
                .executeFollow({
                    ref: {
                        agentId: AGENT_ID,
                        sourceId: 'default',
                        remoteSessionId: 'remote-g-missing',
                    },
                    source: SOURCE,
                    options: {},
                    listener: async () => {},
                })).resolves.toEqual({
                    status: 'unavailable',
                    code: 'plugin_external_follow_unavailable',
                });
            expect(exactGVoiceLookup.mock.calls.every(
                ([calledAuthority]) => calledAuthority.retainedAgent
                    .immutableGenerationId
                    === binding.immutableGenerationId,
            )).toBe(true);

            const providerSupervise = vi.fn<
                ManagedServices['supervise']
            >(async (specification) =>
                managedServiceHandle(specification.id));
            const providerDependencies = Object.freeze({
                status: vi.fn<ManagedDependenciesService['status']>(),
                ensure: vi.fn<ManagedDependenciesService['ensure']>(),
                update: vi.fn<ManagedDependenciesService['update']>(),
                remove: vi.fn<ManagedDependenciesService['remove']>(),
            }) satisfies ManagedDependenciesService;
            const admittedProviderScopes:
                RunnerManagedProviderCustodyScopeV1[] = [];
            providerCustody = createRunnerManagedServicesCustodyPort({
                resolveAuthorizedServicesForSupervise(scope) {
                    admittedProviderScopes.push(scope);
                    return Object.freeze({
                        services: Object.freeze({
                            dependencies: providerDependencies,
                            supervise: providerSupervise,
                        }),
                        providerPluginHardRevocationRevisionAtAdmission: 0,
                    });
                },
                readCurrentProviderPluginHardRevocationRevision: () => 0,
                readCurrentProviderImmutableGenerationIntegrityCurrentness:
                    () => true,
            });
            const pScope = providerScope();
            const pClient = createRunnerManagedServicesClient({
                scope: pScope,
                dependencies: providerDependencies,
                dispatch: providerCustody.dispatch,
            });
            const providerSpec = Object.freeze({
                id: 'provider-wrapper',
                mode: Object.freeze({
                    kind: 'attach' as const,
                    baseUrl: 'http://127.0.0.1:4312',
                }),
                healthCheck: Object.freeze({ kind: 'none' as const }),
            }) satisfies ManagedServiceSpec;
            await pClient.services.supervise(providerSpec);
            const retainedPClient = createRunnerManagedServicesClient({
                claim: providerClaim(pScope),
                dependencies: providerDependencies,
                dispatch: providerCustody.dispatch,
            });
            await expect(retainedPClient.adopt(providerSpec.id))
                .resolves.toMatchObject({
                    snapshot: expect.any(Function),
                });
            expect(admittedProviderScopes).toEqual([
                expect.objectContaining({
                    pluginId: 'acme.provider-p',
                    immutableGenerationId:
                        'provider-p-generation',
                }),
            ]);
            expect(admittedProviderScopes[0]?.immutableGenerationId)
                .not.toBe(binding.immutableGenerationId);

            expect(createRetainedInvocation).toHaveBeenCalledOnce();
            expect(connectedAccountGetBinding).toHaveBeenCalledTimes(4);
            expect(exactGFollow).toHaveBeenCalledOnce();
            expect(providerSupervise).toHaveBeenCalledOnce();
            expect(authorizedLaunchCommands).toEqual([gToolPath]);

            await Promise.all([
                positiveFacets.dispose(),
                missingFacets.dispose(),
            ]);
            expect(exactGSubscriptionDispose).toHaveBeenCalledOnce();
            await positiveFacets.dispose();
            expect(exactGSubscriptionDispose).toHaveBeenCalledOnce();

            await writePluginSource({
                pluginRoot,
                version: 'I',
                accountServiceId: 'account-i',
                toolName: hToolName,
            });
            await installCurrentSource({
                happyHomeDir,
                pluginRoot,
                version: '3.0.0',
            });
            const iGenerationAuthority =
                await readCurrentFixtureGenerationAuthority({
                    happyHomeDir,
                    expectedVersion: 'I',
                });
            const successorRegistry =
                await resolveExecutablePluginRuntimeRegistry({
                    happyHomeDir,
                    generation: 2,
                    generationAuthority: iGenerationAuthority,
                    connectedAccounts:
                        stableConnectedAccountsOwner,
                    stableEventsBroker:
                        hRegistry.stableEventsBroker,
                    currentGlobalExternalSessionsRouter:
                        reloadController.currentGlobalExternalSessions,
                });
            await successorRegistry.activateContributionsOnDemand([{
                pluginId: PLUGIN_ID,
                family: 'agents',
                localId: AGENT_ID,
            }]);
            await reloadController.adoptPreparedRuntimeRegistry({
                registry: successorRegistry,
                changedPluginIds: [PLUGIN_ID],
                durableRevision: 2,
                runningSessionDisposition: 'retainRunningSessions',
            });
            expect(hRegistry.retirementSignal?.aborted).toBe(false);
            await expect(runnerServices.mcp.list({
                sessionId: SESSION_ID,
            })).resolves.toMatchObject({
                items: [{
                    ref: {
                        pluginId: PLUGIN_ID,
                        localId: MCP_SERVER_ID,
                    },
                    title: 'Routing tools I',
                    state: 'available',
                }],
            });
            await expect(runnerServices.mcp.discover({
                pluginId: PLUGIN_ID,
                localId: MCP_DISCOVERY_SOURCE_ID,
            })).resolves.toMatchObject({
                items: [{
                    discoveryId: 'routing-I',
                    metadata: { generation: 'I' },
                }],
            });
            const currentIMcpClient =
                await runnerServices.mcp.connect({
                    pluginId: PLUGIN_ID,
                    localId: MCP_SERVER_ID,
                }, {
                    sessionId: SESSION_ID,
                    elicitation: {
                        mode: 'hostMediated',
                        sessionId: SESSION_ID,
                    },
                });
            await expect(currentIMcpClient.listTools())
                .resolves.toMatchObject({
                    items: [{ name: `${MCP_SERVER_ID}-I` }],
                });
            await expect(establishedHMcpClient.listTools())
                .resolves.toMatchObject({
                    items: [{ name: `${MCP_SERVER_ID}-H` }],
                });
            await Promise.all([
                currentIMcpClient.dispose(),
                establishedHMcpClient.dispose(),
            ]);
            expect(hRegistry.retirementSignal?.aborted).toBe(true);
            await vi.waitFor(() => expect(
                currentGlobalFollowSubscriptionDispose,
            ).toHaveBeenCalledOnce());
            await expect(runnerServices.storage.daemonSession.get(
                'retained-before-h',
            )).resolves.toEqual({ generation: 'G' });
            await expect(runnerServices.settings.forScope({ kind: 'daemon' }).get(
                'retained-generation',
            )).resolves.toBe('G');
            const postHRetirementHostEvents: unknown[] = [];
            const hostEventSubscriptionOpenCount =
                daemonPluginOperations.filter((operation) =>
                    operation.kind
                        === 'plugin_events.host.subscribe.open_v1')
                    .length;
            const postHRetirementSubscription =
                runnerServices.events.host.subscribe({
                    eventId: '@happier/runtime/turn-complete',
                    scope: {
                        kind: 'session',
                        sessionId: SESSION_ID,
                    },
                }, async (event) => {
                    postHRetirementHostEvents.push(event);
                });
            await vi.waitFor(() => expect(
                daemonPluginOperations.filter((operation) =>
                    operation.kind
                        === 'plugin_events.host.subscribe.open_v1')
                    .length,
            ).toBe(hostEventSubscriptionOpenCount + 1));
            const postHRetirementHostEvent = Object.freeze({
                sequence: 3,
                sessionId: SESSION_ID,
                emittedAtMs: 4,
                kind: 'turn-complete' as const,
                turnId: 'turn-host-event-after-h-retirement',
            });
            successorRegistry.publishHostEvent?.(
                postHRetirementHostEvent,
            );
            await vi.waitFor(() => expect(
                postHRetirementHostEvents,
            ).toEqual([{
                eventId: '@happier/runtime/turn-complete',
                scope: {
                    kind: 'session',
                    sessionId: SESSION_ID,
                },
                payload: postHRetirementHostEvent,
            }]));
            await postHRetirementSubscription.dispose();

            invocationAuthorityCurrent = false;
            await expect(
                runnerServices.sessions.external.capabilities(),
            ).resolves.toEqual({
                list: {
                    status: 'unavailable',
                    code: 'plugin_generation_retired',
                },
                attach: {
                    status: 'unavailable',
                    code: 'plugin_generation_retired',
                },
                takeover: {
                    status: 'unavailable',
                    code: 'plugin_generation_retired',
                },
                transcript: {
                    status: 'unavailable',
                    code: 'plugin_generation_retired',
                },
                follow: {
                    status: 'unavailable',
                    code: 'plugin_generation_retired',
                },
            });
            await expect(runnerServices.storage.daemonSession.set(
                'after-hard-revoke',
                { shouldNotPersist: true },
            )).rejects.toMatchObject({
                code: 'plugin_services_turn_authority_unavailable',
            });
            await expect(runnerServices.sessions.external.list({
                agentId: AGENT_ID,
            })).rejects.toMatchObject({
                code: 'plugin_services_turn_authority_unavailable',
            });
            pluginServicesLifetime.abort();
            await vi.waitFor(() => expect(
                completedDaemonPluginOperations.some((operation) =>
                    operation.kind === 'plugin_services.close_v1'),
            ).toBe(true));
            await expect(pluginServicesHost.dispatch({
                sessionId: SESSION_ID,
                runner,
                retainedAgent: binding,
                operation: {
                    kind: 'plugin_storage.get_v1',
                    requestId: 'request-after-session-close',
                    invocationId: 'retained-routing-invocation',
                    scope: 'daemonSession',
                    key: 'retained-before-h',
                },
            })).rejects.toMatchObject({
                code: 'plugin_services_invocation_unavailable',
            });

            const retainedManifestPath = join(
                resolvePluginStorePaths({ happyHomeDir })
                    .generationsDir,
                binding.immutableGenerationId,
                '.happier-plugin',
                'plugin.json',
            );
            const originalRetainedManifest =
                await readFile(retainedManifestPath);
            await writeFile(
                retainedManifestPath,
                Buffer.concat([
                    originalRetainedManifest,
                    Buffer.from('\n'),
                ]),
            );
            const createRetainedAfterTamper =
                successorRegistry
                    .createRetainedRunnerAgentInvocationServices;
            expect(createRetainedAfterTamper).toBeDefined();
            if (!createRetainedAfterTamper) return;
            await expect(createRetainedAfterTamper({
                binding,
                sessionId: SESSION_ID,
                correlationId: 'retained-tampered',
                cwd: pluginRoot,
                environment: {},
                providerBindingActive: false,
                signal: new AbortController().signal,
                isGenerationCurrent: () => true,
                managedDependencyRetention,
            })).rejects.toMatchObject({
                code:
                    'plugin_services_retained_managed_dependency_unavailable',
            });
            expect(authorizedLaunchCommands).toEqual([gToolPath]);
            await writeFile(
                retainedManifestPath,
                originalRetainedManifest,
            );
            const retainedGenerationRoot = join(
                resolvePluginStorePaths({ happyHomeDir })
                    .generationsDir,
                binding.immutableGenerationId,
            );
            const temporarilyRemovedGenerationRoot =
                `${retainedGenerationRoot}.removed-for-test`;
            await rename(
                retainedGenerationRoot,
                temporarilyRemovedGenerationRoot,
            );
            try {
                await expect(createRetainedAfterTamper({
                    binding,
                    sessionId: SESSION_ID,
                    correlationId: 'retained-removed',
                    cwd: pluginRoot,
                    environment: {},
                    providerBindingActive: false,
                    signal: new AbortController().signal,
                    isGenerationCurrent: () => true,
                    managedDependencyRetention,
                })).rejects.toMatchObject({
                    code:
                        'plugin_services_retained_managed_dependency_unavailable',
                });
                expect(authorizedLaunchCommands).toEqual([gToolPath]);
            } finally {
                await rename(
                    temporarilyRemovedGenerationRoot,
                    retainedGenerationRoot,
                );
            }
        } finally {
            pluginServicesLifetime.abort();
            await currentGlobalFollowInstallation.dispose();
            await Promise.allSettled(
                facetServices.map((service) => service.dispose()),
            );
            await Promise.allSettled(
                facetOwners.map((owner) => owner.retire()),
            );
            await providerCustody?.dispose();
            await pluginServicesHost?.dispose();
            releaseGManagedDependencyRetention?.();
            await reloadController?.shutdown();
            if (originalPath === undefined) delete process.env.PATH;
            else process.env.PATH = originalPath;
            await Promise.all([
                rm(happyHomeDir, { recursive: true, force: true }),
                rm(pluginRoot, { recursive: true, force: true }),
                rm(toolRoot, { recursive: true, force: true }),
            ]);
        }
    }, 60_000);
});
