import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    AcpBackendSpecV1,
    AcpRuntimeHandleV1,
    CreateAcpRuntimeParamsV1,
    ExecClientHandleV1,
    JsonRpcClientV1,
    PluginContextV1,
    ProviderAccountUsageAdoptProvisionalRecordInputV1,
    SessionRuntimeV1,
    PluginSubagentsServiceV1,
} from '@happier-dev/plugin-sdk';
import {
    accountSettingsParse,
    BackendSurfaceOperationCatalogV1,
    buildProviderAccountUsageRecordId,
    type BackendSurfaceDeclarationV1,
    type ProviderAccountUsageRecordKeyV1,
    type ProviderAccountUsageSnapshotV1,
} from '@happier-dev/protocol';

import { configuration } from '@/configuration';
import { HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY } from '@/daemon/connectedServices/connectedServiceChildEnvironment';
import { createPluginApiHost } from '@/plugins/runtime/api/host';
import { publishRuntimePluginEvent } from '@/plugins/runtime/context/events';
import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { HostSessionRuntimeFactoryParams } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import type { Metadata } from '@/api/types';
import type { RegisteredSessionStateFieldMutationV1 } from '../../../api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import type { Credentials } from '@/persistence';
import {
    resolveBackendEngineAdapterResolution,
    resolveCliEngineRegistry,
} from './engineRegistry';

const {
    resolveMergedContributionRegistryMock,
    getExecutionRunBackendDescriptorMock,
    resolveExecutablePluginRuntimeRegistryMock,
    resolvePluginBackendSurfaceHandlersMock,
    pluginReloadControllerStateMock,
    pluginReloadControllerAcquireRuntimeRegistryMock,
    readCredentialsMock,
    readSettingsMock,
    readOrCreateInstallationIdentityMock,
    createCliApprovalsArtifactStoreMock,
    getConnectedServiceRuntimeAuthAdapterMock,
    axiosPostMock,
    axiosGetMock,
    axiosPatchMock,
    notifyDaemonProviderAccountUsageAdoptionMock,
    notifyDaemonProviderAccountUsageSnapshotMock,
    resolveExternalSessionRuntimeHostAdaptersMock,
} = vi.hoisted(() => ({
    resolveMergedContributionRegistryMock: vi.fn<(...args: unknown[]) => unknown>(),
    getExecutionRunBackendDescriptorMock: vi.fn<(...args: unknown[]) => unknown>((..._args: unknown[]) => {
        throw new Error('legacy executionRunBackendRegistry must not be used when runtimeCore exist');
    }),
    resolveExecutablePluginRuntimeRegistryMock: vi.fn<(...args: unknown[]) => unknown>(),
    resolvePluginBackendSurfaceHandlersMock: vi.fn<(...args: unknown[]) => unknown>(),
    pluginReloadControllerStateMock: vi.fn<(...args: unknown[]) => unknown>(),
    pluginReloadControllerAcquireRuntimeRegistryMock: vi.fn<(...args: unknown[]) => unknown>(),
    readCredentialsMock: vi.fn<(...args: unknown[]) => unknown>(),
    readSettingsMock: vi.fn<(...args: unknown[]) => unknown>(),
    readOrCreateInstallationIdentityMock: vi.fn<(...args: unknown[]) => unknown>(),
    createCliApprovalsArtifactStoreMock: vi.fn<(...args: unknown[]) => unknown>(),
    getConnectedServiceRuntimeAuthAdapterMock: vi.fn<(...args: unknown[]) => unknown>(),
    axiosPostMock: vi.fn<(...args: unknown[]) => unknown>(),
    axiosGetMock: vi.fn<(...args: unknown[]) => unknown>(),
    axiosPatchMock: vi.fn<(...args: unknown[]) => unknown>(),
    notifyDaemonProviderAccountUsageAdoptionMock: vi.fn<(...args: unknown[]) => unknown>(),
    notifyDaemonProviderAccountUsageSnapshotMock: vi.fn<(...args: unknown[]) => unknown>(),
    resolveExternalSessionRuntimeHostAdaptersMock: vi.fn<(...args: unknown[]) => unknown>(),
}));

vi.mock('../../../plugins/projection/registry/createResolvedContributionRegistry', () => ({
    resolveMergedContributionRegistry: resolveMergedContributionRegistryMock,
}));

vi.mock('../../../plugins/runtime/resolveExecutablePluginRuntimeRegistry', () => ({
    resolveExecutablePluginRuntimeRegistry: resolveExecutablePluginRuntimeRegistryMock,
}));

vi.mock('../../../plugins/runtime/reload/singleton', () => ({
    pluginReloadController: {
        getState: pluginReloadControllerStateMock,
        acquireRuntimeRegistry: pluginReloadControllerAcquireRuntimeRegistryMock,
    },
}));

vi.mock('./resolvePluginBackendSurfaceHandlers', () => ({
    resolvePluginBackendSurfaceHandlers: resolvePluginBackendSurfaceHandlersMock,
}));

vi.mock('@/persistence', () => ({
    readCredentials: readCredentialsMock,
    readSettings: readSettingsMock,
}));

vi.mock('@/daemon/identity/store', () => ({
    readOrCreateInstallationIdentity: readOrCreateInstallationIdentityMock,
}));

vi.mock('axios', () => ({
    default: {
        post: axiosPostMock,
        get: axiosGetMock,
        patch: axiosPatchMock,
    },
}));

vi.mock('@/daemon/controlClient', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/daemon/controlClient')>(),
    notifyDaemonProviderAccountUsageAdoption: notifyDaemonProviderAccountUsageAdoptionMock,
    notifyDaemonProviderAccountUsageSnapshot: notifyDaemonProviderAccountUsageSnapshotMock,
}));

vi.mock('@/session/actions/approvals/artifactStore', () => ({
    createCliApprovalsArtifactStore: createCliApprovalsArtifactStoreMock,
}));

vi.mock('@/agent/executionRuns/registry/executionRunBackendRegistry', () => ({
    getExecutionRunBackendDescriptor: getExecutionRunBackendDescriptorMock,
}));

vi.mock('@/daemon/connectedServices/catalogHooks', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/daemon/connectedServices/catalogHooks')>(),
    getConnectedServiceRuntimeAuthAdapter: (...args: unknown[]) =>
        getConnectedServiceRuntimeAuthAdapterMock(...args),
}));

vi.mock('@/session/external/hostAdapters', () => ({
    resolveExternalSessionRuntimeHostAdapters: (...args: unknown[]) =>
        resolveExternalSessionRuntimeHostAdaptersMock(...args),
}));

function createLeaseRuntimeRegistry(contributes: unknown): Record<string, unknown> {
    return {
        contributes,
        actionHandlersByActionId: new Map(),
        hookHandlersByHookId: new Map(),
        runtimeCoreHandlersByBackendId: new Map(),
        agentRuntimesByAgentId: new Map(),
        scmHostingProvidersById: new Map(),
        pluginDiagnosticsByPluginId: {},
        activatePluginsByEvent: vi.fn(async () => []),
        readHookEventEnvelopeV1: vi.fn(),
        dispose: vi.fn(async () => undefined),
    };
}

function completeLeaseRuntimeRegistryFixture(
    candidate: unknown,
    fallbackContributes: unknown,
): Record<string, unknown> {
    const overrides = candidate && typeof candidate === 'object'
        ? candidate as Record<string, unknown>
        : {};
    const contributes = overrides.contributes ?? fallbackContributes;
    return {
        ...createLeaseRuntimeRegistry(contributes),
        ...overrides,
        contributes,
    };
}

describe('resolveCliEngineRegistry runtimeCore', () => {
    beforeEach(() => {
        vi.resetModules();
        resolveMergedContributionRegistryMock.mockReset();
        resolveExecutablePluginRuntimeRegistryMock.mockReset();
        resolvePluginBackendSurfaceHandlersMock.mockReset();
        pluginReloadControllerStateMock.mockReset();
        pluginReloadControllerAcquireRuntimeRegistryMock.mockReset();
        readCredentialsMock.mockReset();
        readSettingsMock.mockReset();
        readOrCreateInstallationIdentityMock.mockReset();
        createCliApprovalsArtifactStoreMock.mockReset();
        getConnectedServiceRuntimeAuthAdapterMock.mockReset();
        resolveExternalSessionRuntimeHostAdaptersMock.mockReset();
        resolveExternalSessionRuntimeHostAdaptersMock.mockResolvedValue({
            transcriptStores: [],
            candidateHosts: [],
        });
        axiosPostMock.mockReset();
        axiosGetMock.mockReset();
        axiosPatchMock.mockReset();
        notifyDaemonProviderAccountUsageAdoptionMock.mockReset();
        notifyDaemonProviderAccountUsageAdoptionMock.mockResolvedValue({
            ok: true,
            result: {
                status: 'adopted',
                fromRecordId: 'paug_v1_from',
                toRecordId: 'paug_v1_to',
                persisted: true,
            },
        });
        notifyDaemonProviderAccountUsageSnapshotMock.mockReset();
        notifyDaemonProviderAccountUsageSnapshotMock.mockResolvedValue({
            ok: true,
            result: { status: 'recorded', recordId: 'paug_v1_placeholder', persisted: true },
        });
        getExecutionRunBackendDescriptorMock.mockClear();
        pluginReloadControllerStateMock.mockReturnValue({
            generation: 0,
            activeRegistry: null,
            lastResult: null,
        });
        pluginReloadControllerAcquireRuntimeRegistryMock.mockImplementation(async (...args: unknown[]) => {
            const leaseParams = args[0];
            const resolveRuntimeRegistry = isRecord(leaseParams)
                && typeof leaseParams.resolveRuntimeRegistry === 'function'
                ? leaseParams.resolveRuntimeRegistry
                : null;
            const state = pluginReloadControllerStateMock();
            const activeRegistry = isRecord(state) ? state.activeRegistry : null;
            const registryCandidate = activeRegistry
                ?? await resolveRuntimeRegistry?.()
                ?? await resolveExecutablePluginRuntimeRegistryMock()
                ?? null;
            const fallbackContributes = isRecord(registryCandidate)
                && registryCandidate.contributes
                ? registryCandidate.contributes
                : await resolveMergedContributionRegistryMock();
            const registry = completeLeaseRuntimeRegistryFixture(
                registryCandidate,
                fallbackContributes,
            );
            return {
                registry,
                source: 'active',
                release: vi.fn(async () => undefined),
            };
        });
        readSettingsMock.mockResolvedValue({ machineId: 'machine-1' });
        setActiveAccountSettingsSnapshot({
            source: 'none',
            settings: accountSettingsParse({ schemaVersion: 6 }),
            settingsVersion: 0,
            loadedAtMs: 0,
            settingsSecretsReadKeys: [],
            scopeKey: 'test-scope',
        });
        readOrCreateInstallationIdentityMock.mockResolvedValue({
            installationId: 'installation-1',
            privateKey: Buffer.from(new Uint8Array(64).fill(7)).toString('base64url'),
        });
    });

    function isRecord(value: unknown): value is Record<string, unknown> {
        return Boolean(value) && typeof value === 'object';
    }

    function createReviewCommentFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            v: 1,
            id: 'comment-1',
            accountId: 'account-1',
            projectId: 'project-1',
            anchor: { kind: 'file', filePath: 'src/a.ts' },
            snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
            body: 'Fix this.',
            bodyVersion: 1,
            edits: [],
            author: { kind: 'plugin', pluginId: 'acme.sample' },
            state: 'proposed',
            flags: {},
            dispositions: {},
            threadId: 'comment-1',
            transitions: [{
                transitionId: 'transition-1',
                toState: 'proposed',
                transitionedAt: 1,
                transitionedBy: { kind: 'plugin', pluginId: 'acme.sample' },
                serverRevision: 1,
            }],
            createdAt: 1,
            updatedAt: 1,
            serverRevision: 1,
            ...overrides,
        };
    }

    function createTestCredentials(): Credentials {
        return {
            token: 'test-token',
            encryption: {
                type: 'legacy',
                secret: new Uint8Array(32).fill(1),
            },
        };
    }

    function createPluginSessionLaunchParams(
        overrides: Record<string, unknown> = {},
    ): Record<string, unknown> & Readonly<{ credentials: Credentials }> {
        return {
            credentials: createTestCredentials(),
            ...overrides,
        };
    }

    function createTestSessionRuntime(providerSessionId = 'plugin-session-1'): SessionRuntimeV1 {
        return {
            identity: {
                read: () => ({ providerSessionId }),
            },
            events: {
                subscribe: () => () => undefined,
            },
            send: async () => ({ status: 'accepted' }),
            dispose: async () => undefined,
        };
    }

    function createPluginSessionRuntimeFixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
        return {
            ...createTestSessionRuntime(),
            operations: {},
            ...overrides,
        };
    }

    function createProviderAccountUsageSnapshotForTest(accountSubjectId = 'acct_123'): ProviderAccountUsageSnapshotV1 {
        const recordKey: ProviderAccountUsageRecordKeyV1 = {
            providerId: 'openai-codex',
            accountSubjectId,
            subjectKind: 'account',
            quotaScope: 'account',
        };
        return {
            v: 1,
            recordId: buildProviderAccountUsageRecordId(recordKey),
            recordKey,
            providerId: 'openai-codex',
            accountSubject: { kind: 'providerSubject', id: accountSubjectId },
            observedAtMs: 1,
            fetchedAtMs: 1,
            staleAfterMs: 60_000,
            source: 'runtimeSignal',
            confidence: 'confirmed',
            state: 'loaded_data',
            accountLabel: null,
            planLabel: null,
            meters: [],
        };
    }

    type ProviderAccountUsageAdoptionForTest = ProviderAccountUsageAdoptProvisionalRecordInputV1['adoption'];

    function createProviderAccountUsageAdoptionForTest(): ProviderAccountUsageAdoptionForTest {
        const fromKey: ProviderAccountUsageRecordKeyV1 = {
            providerId: 'openai-codex',
            accountSubjectId: 'provisional:native',
            subjectKind: 'unknown',
            quotaScope: 'account',
        };
        const stableRecordKey: ProviderAccountUsageRecordKeyV1 = {
            providerId: 'openai-codex',
            accountSubjectId: 'acct_123',
            subjectKind: 'account',
            quotaScope: 'account',
        };
        return {
            providerId: 'openai-codex',
            fromRecordId: buildProviderAccountUsageRecordId(fromKey),
            toRecordId: buildProviderAccountUsageRecordId(stableRecordKey),
            stableRecordKey,
            proof: { kind: 'id_token_account_id', issuer: 'chatgpt' },
            observedAtMs: 1,
        };
    }

    function createSurfaceHandler(
        kind: BackendSurfaceDeclarationV1['kind'],
        operation: BackendSurfaceDeclarationV1['operation'],
    ): BackendSurfaceDeclarationV1 {
        return {
            surfaceApiVersion: 1,
            id: `${kind}.${operation}`,
            kind,
            operation,
            support: 'supported',
            handler: {
                target: 'daemon',
                exportName: operation,
            },
        };
    }

    type ObservedPluginRuntimeContext = Readonly<{
        fetch?: unknown;
        config?: Readonly<{
            values?: Readonly<{
                currentCliVersion?: string;
            }>;
        }>;
        logger?: Readonly<{
            debug?: unknown;
        }>;
        features?: Readonly<{
            isEnabled?: unknown;
        }>;
        permissions?: Readonly<{
            isGranted?: (permission: string) => boolean;
            list?: () => readonly string[];
        }>;
        acp?: Readonly<{
            defineAcpBackend?: unknown;
            createRuntime?: unknown;
        }>;
        sessions?: Readonly<{
            subagents?: unknown;
            external?: unknown;
        }>;
        notifications?: Readonly<{
            send?: unknown;
            listCategories?: unknown;
            listChannels?: unknown;
            getUserPreferences?: unknown;
        }>;
        projects?: Readonly<{
            listAll?: unknown;
            listForCurrentMachine?: unknown;
            listForMachine?: unknown;
            get?: unknown;
            getActive?: unknown;
            watch?: unknown;
        }>;
        account?: Readonly<{
            settings?: Readonly<{
                get?: unknown;
                set?: unknown;
                onChange?: unknown;
            }>;
        }>;
        abort?: Readonly<{
            signal?: unknown;
        }>;
        storage?: Readonly<{
            ephemeral?: unknown;
            session?: unknown;
            local?: unknown;
            synced?: unknown;
        }>;
        settings?: Readonly<{
            get?: unknown;
            set?: unknown;
            onChange?: unknown;
            describeFields?: unknown;
            projectForm?: unknown;
        }>;
        secrets?: Readonly<{
            get?: unknown;
            set?: unknown;
            delete?: unknown;
            list?: unknown;
        }>;
        events?: Readonly<{
            emit?: unknown;
            subscribe?: unknown;
        }>;
        auth?: Readonly<{
            getIdentity?: unknown;
            onChange?: unknown;
            services?: Readonly<{
                materialize?: unknown;
            }>;
        }>;
        mcp?: Readonly<{
            list?: unknown;
            resolveForSession?: unknown;
        }>;
        agentRuntime?: Readonly<{
            acp?: Readonly<{
                defineAcpBackend?: unknown;
                createRuntime?: unknown;
            }>;
            terminalHost?: Readonly<{
                resolve?: unknown;
                createOrAttachHost?: unknown;
                injectUserPrompt?: unknown;
            }>;
        }>;
        actions?: Readonly<{
            approvals?: Readonly<{
                request?: unknown;
                get?: unknown;
                list?: unknown;
            }>;
            scm?: Readonly<{
                diffSummary?: Readonly<{
                    generate?: unknown;
                }>;
            }>;
        }>;
        reviews?: Readonly<{
            comments?: Readonly<{
                create?: unknown;
            }>;
        }>;
    }>;

    type AcpDefinitionContextForTest = Readonly<{
        agentRuntime: Readonly<{
            acp: Readonly<{
                defineAcpBackend: (input: unknown) => unknown;
            }>;
        }>;
    }>;

    type AcpRuntimeContextForTest = ObservedPluginRuntimeContext & Readonly<{
        agentRuntime: Readonly<{
            acp: Readonly<{
                createRuntime: (
                    spec: AcpBackendSpecV1,
                    params: CreateAcpRuntimeParamsV1,
                ) => Promise<AcpRuntimeHandleV1>;
            }>;
        }>;
    }>;

    type PermissionContextForTest = Readonly<{
        sessions: Readonly<{
            current: Readonly<{
                permissions: Readonly<{
                    requestDecision: (
                        input: unknown,
                        options?: Readonly<{ signal?: AbortSignal }>,
                    ) => Promise<unknown>;
                }>;
            }>;
        }>;
    }>;

    type SessionScopedContextForTest = Readonly<{
        agentRuntime: Readonly<{
            sessionHooks: Readonly<{
                startServer: (input: unknown) => Promise<Readonly<{
                    port: number;
                    stop(): void;
                    dispose(): Promise<void>;
                }>>;
            }>;
            accountUsage: Readonly<{
                resolveSourceContext: PluginContextV1['agentRuntime']['accountUsage']['resolveSourceContext'];
                recordSnapshot: (input: unknown) => Promise<unknown>;
                adoptProvisionalRecord: (input: unknown) => Promise<unknown>;
            }>;
            transcripts: Readonly<{
                append: (input: unknown) => Promise<void> | void;
                fileFollow: Readonly<{
                    follow: (input: Readonly<{
                        path: string;
                        startAt: 'beginning' | 'end';
                        onLine: (line: Readonly<{ line: string }>) => void | Promise<void>;
                    }>) => Promise<Readonly<{
                        drainNow(): Promise<void>;
                        close(): Promise<void>;
                    }>>;
                }>;
            }>;
        }>;
        sessions: Readonly<{
            current: Readonly<{
                subscribe: (input: unknown, onEvent: (event: unknown) => void) => Readonly<{ unsubscribe: () => void }>;
                mcp: Readonly<{
                    elicit: (input: unknown, options?: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>;
                }>;
                auth: Readonly<{
                    services: Readonly<{
                        refreshRuntimeAuth: (
                            input: unknown,
                            options?: Readonly<{ signal?: AbortSignal }>,
                        ) => Promise<unknown>;
                    }>;
                }>;
                permissions: Readonly<{
                    requestDecision: (
                        input: unknown,
                        options?: Readonly<{ signal?: AbortSignal }>,
                    ) => Promise<unknown>;
                }>;
            }>;
            send: (input: unknown) => Promise<unknown>;
            writeMetadata: (input: unknown) => Promise<void>;
            writeAgentState: (input: unknown) => Promise<void>;
            writeStateField: (input: unknown) => Promise<void>;
        }>;
        experimental: Readonly<{
            telemetry: Readonly<{
                emit: (input: unknown) => void;
            }>;
            artifacts: Readonly<{
                write: (input: unknown) => Promise<void>;
            }>;
        }>;
    }>;

    type HostSessionRuntimePlanForTest = Readonly<{
        config: Readonly<{
            createSessionRuntime: (input: unknown) => Promise<unknown>;
        }>;
    }>;

    async function loadOpenCodeExtensionActivate(): Promise<(api: unknown) => unknown> {
        // Import extension source directly (not dist) so this test doesn't depend on build outputs.
        const moduleUrl = new URL(
            '../../../../../../packages/plugins/opencode/src/activate.ts',
            import.meta.url,
        );
        const namespace: unknown = await import(/* @vite-ignore */ moduleUrl.href);
        if (!isRecord(namespace) || typeof namespace.activate !== 'function') {
            throw new Error('Expected OpenCode extension module to export activate(api)');
        }
        return namespace.activate as (api: unknown) => unknown;
    }

    async function postSessionHook(params: Readonly<{
        port: number;
        body: unknown;
        sessionHookSecret?: string;
    }>): Promise<Readonly<{ status: number; text: string }>> {
        const res = await fetch(`http://127.0.0.1:${params.port}/hook/session-start`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(params.sessionHookSecret ? { 'x-happier-hook-secret': params.sessionHookSecret } : {}),
            },
            body: JSON.stringify(params.body),
        });
        return { status: res.status, text: await res.text() };
    }

    function seedCodexBuiltInRegistry(params: Readonly<{
        runtimeCoreFactory: (params: unknown) => unknown;
    }>): void {
        const catalogEntry = {
            id: 'codex',
            cliSubcommand: 'codex',
            getRuntimeCore: async () => params.runtimeCoreFactory,
        };

        resolveMergedContributionRegistryMock.mockResolvedValue({
            agents: [],
            agentRuntimes: [],
            hookRegistrations: [],
            surfaceHandlersByBackendId: new Map(),
            catalogEntriesById: {
                codex: catalogEntry,
            },
            agentDefinitionsById: new Map([
                ['codex', {
                    id: 'codex',
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                    definition: {
                        kindVersion: 1,
                        id: 'codex',
                        ownedBackendIds: ['codex'],
                    },
                    richDefinition: {
                        source: 'built_in',
                        definition: {
                            id: 'codex',
                        },
                    },
                    runtimeSpec: null,
                    catalogEntry,
                }],
            ]),
            agentRuntimeDefinitionsById: new Map([
                ['codex', {
                    id: 'codex',
                    agentId: 'codex',
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                    definition: {
                        kindVersion: 1,
                        id: 'codex',
                        agentId: 'codex',
                    },
                    richDefinition: {
                        source: 'built_in',
                        definition: {
                            id: 'codex',
                            agentId: 'codex',
                        },
                    },
                    getRuntimeCore: async () => params.runtimeCoreFactory,
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
        });
    }

    function createRuntimeRegistry(params: Readonly<{
        contributes: unknown;
        backendId: string;
        pluginId: string;
        createEngine?: (ctx: unknown) => Promise<unknown> | unknown;
    }>): Record<string, unknown> {
        return {
            contributes: params.contributes,
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: params.createEngine
                ? new Map([
                    [params.backendId, {
                        pluginId: params.pluginId,
                        registration: {
                            backendId: params.backendId,
                            create: params.createEngine,
                        },
                    }],
                ])
                : new Map(),
            pluginDiagnosticsByPluginId: {},
            activatePluginsByEvent: vi.fn(async () => []),
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        };
    }

    function seedFirstPartyOwnerRegistry(params: Readonly<{
        backendId?: string;
        agentId?: string;
        pluginId?: string;
        runtimeOwner?: Record<string, unknown>;
        runtimeCoreFactory?: (params: unknown) => unknown;
    }>): Record<string, unknown> {
        const backendId = params.backendId ?? 'acme.firstparty.backend';
        const agentId = params.agentId ?? 'claude';
        const pluginId = params.pluginId ?? 'happier.agent.acme';
        const runtimeCoreFactory = params.runtimeCoreFactory;
        const agent = {
            id: agentId,
            provenance: 'first_party',
            source: { kind: 'bundled' },
            definition: {
                kindVersion: 1,
                id: agentId,
                ownedBackendIds: [backendId],
            },
            richDefinition: undefined,
            runtimeSpec: null,
            pluginId,
            manifestPath: `bundled:${pluginId}`,
            manifestDigest: `bundled:@happier-dev/plugins-acme@0.0.0`,
            daemonEntryPath: '@happier-dev/plugins-acme',
        };
        const backend = {
            id: backendId,
            agentId,
            provenance: 'first_party',
            source: { kind: 'bundled' },
            definition: {
                kindVersion: 1,
                id: backendId,
                agentId,
            },
            richDefinition: undefined,
            runtimeKind: 'custom',
            surfaceHandlers: [],
            pluginId,
            manifestPath: `bundled:${pluginId}`,
            manifestDigest: `bundled:@happier-dev/plugins-acme@0.0.0`,
            daemonEntryPath: '@happier-dev/plugins-acme',
            ...(runtimeCoreFactory ? { getRuntimeCore: async () => runtimeCoreFactory } : {}),
            ...(params.runtimeOwner ? { runtimeOwner: params.runtimeOwner } : {}),
        };
        const registry = {
            agents: [agent],
            agentRuntimes: [backend],
            actions: [],
            hookRegistrations: [],
            surfaceHandlersByBackendId: new Map(),
            catalogEntriesById: {},
            agentRuntimeDefinitionsById: new Map([[backendId, backend]]),
            agentDefinitionsById: new Map([[agentId, agent]]),
            pluginDiagnosticsByPluginId: {},
        };
        resolveMergedContributionRegistryMock.mockResolvedValue(registry);
        return registry;
    }

    function seedPluginRegistry(params: Readonly<{
        runtimeCoreFactory: (params: unknown) => unknown;
    }>) {
	        const registry = {
	            agents: [{
	                id: 'acme.sample.provider',
	                provenance: 'external',
	                source: { kind: 'path' },
	                definition: {
	                    kindVersion: 1,
	                    id: 'acme.sample.provider',
	                    ownedBackendIds: ['acme.sample.backend'],
                },
                richDefinition: {
                    source: 'plugin',
                    definition: {
                        kindVersion: 1,
                        id: 'acme.sample.provider',
                        ownedBackendIds: ['acme.sample.backend'],
                        display: {
                            name: 'Acme Sample Provider',
                            tags: ['plugin'],
                        },
                    },
                },
                runtimeSpec: {
                    kindVersion: 1,
                    id: 'acme.sample.provider',
                    title: 'Acme Sample CLI',
                    binaryName: 'acme-sample',
                    sourcePreferenceDefault: 'system-first',
                    managedInstall: {
                        kind: 'managed_package',
                        packageName: '@acme/sample-cli',
                        binaryName: 'acme-sample',
                    },
                    manualInstallKind: 'command',
                    manualInstallRecipes: null,
                    acceptsJavaScriptFileOverride: false,
                },
                pluginId: 'acme.sample',
                daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
            }],
	            agentRuntimes: [{
	                id: 'acme.sample.backend',
	                agentId: 'acme.sample.provider',
	                provenance: 'external',
	                source: { kind: 'path' },
	                definition: {
	                    kindVersion: 1,
	                    id: 'acme.sample.backend',
	                    agentId: 'acme.sample.provider',
                },
                richDefinition: {
                    source: 'plugin',
                    definition: {
                        kindVersion: 1,
                        id: 'acme.sample.backend',
                        agentId: 'acme.sample.provider',
                        runtimeKind: 'native',
                        capabilities: {},
                        surfaceHandlers: [],
                    },
                },
                runtimeKind: 'native',
                surfaceHandlers: [],
                pluginId: 'acme.sample',
                daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
            }],
            actions: [],
            hookRegistrations: [],
            surfaceHandlersByBackendId: new Map(),
            catalogEntriesById: {},
	            agentRuntimeDefinitionsById: new Map([
	                ['acme.sample.backend', {
	                    id: 'acme.sample.backend',
	                    agentId: 'acme.sample.provider',
	                    provenance: 'external',
	                    source: { kind: 'path' },
	                    definition: {
	                        kindVersion: 1,
	                        id: 'acme.sample.backend',
	                        agentId: 'acme.sample.provider',
                    },
                    richDefinition: {
                        source: 'plugin',
                        definition: {
                            kindVersion: 1,
                            id: 'acme.sample.backend',
                            agentId: 'acme.sample.provider',
                            runtimeKind: 'native',
                            capabilities: {},
                            surfaceHandlers: [],
                        },
                    },
                    runtimeKind: 'native',
                    surfaceHandlers: [],
                    pluginId: 'acme.sample',
                    daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
                    getRuntimeCore: async () => params.runtimeCoreFactory,
                }],
            ]),
	            agentDefinitionsById: new Map([
	                ['acme.sample.provider', {
	                    id: 'acme.sample.provider',
	                    provenance: 'external',
	                    source: { kind: 'path' },
	                    definition: {
	                        kindVersion: 1,
	                        id: 'acme.sample.provider',
	                        ownedBackendIds: ['acme.sample.backend'],
                    },
                    richDefinition: {
                        source: 'plugin',
                        definition: {
                            kindVersion: 1,
                            id: 'acme.sample.provider',
                            ownedBackendIds: ['acme.sample.backend'],
                            display: {
                                name: 'Acme Sample Provider',
                                tags: ['plugin'],
                            },
                        },
                    },
                    runtimeSpec: {
                        kindVersion: 1,
                        id: 'acme.sample.provider',
                        title: 'Acme Sample CLI',
                        binaryName: 'acme-sample',
                        sourcePreferenceDefault: 'system-first',
                        managedInstall: {
                            kind: 'managed_package',
                            packageName: '@acme/sample-cli',
                            binaryName: 'acme-sample',
                        },
                        manualInstallKind: 'command',
                        manualInstallRecipes: null,
                        acceptsJavaScriptFileOverride: false,
                    },
                    pluginId: 'acme.sample',
                    daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
        };
        resolveMergedContributionRegistryMock.mockResolvedValue(registry);
        return registry;
    }

    it('does not resolve unknown execution-run backends through legacy descriptor fallback', async () => {
        resolveMergedContributionRegistryMock.mockResolvedValue({
            agents: [],
            agentRuntimes: [],
            actions: [],
            hookRegistrations: [],
            surfaceHandlersByBackendId: new Map(),
            catalogEntriesById: {},
            agentDefinitionsById: new Map(),
            agentRuntimeDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: {},
        });

        await expect(resolveBackendEngineAdapterResolution(['code', 'rabbit'].join('')))
            .resolves
            .toBeNull();
        expect(getExecutionRunBackendDescriptorMock).not.toHaveBeenCalled();
    });

    function seedPluginRegistryWithoutRuntimeCore(params?: Readonly<{
        surfaceHandlers?: readonly BackendSurfaceDeclarationV1[];
    }>): void {
        const surfaceHandlers = params?.surfaceHandlers ?? [];
        const registry = {
            agents: [{
                id: 'acme.sample.provider',
                provenance: 'external',
                source: { kind: 'path' },
                definition: {
                    kindVersion: 1,
                    id: 'acme.sample.provider',
                    ownedBackendIds: ['acme.sample.backend'],
                    catalogAgentId: 'claude',
                },
                richDefinition: {
                    provenance: 'external',
                    source: 'plugin',
                    definition: {
                        kindVersion: 1,
                        id: 'acme.sample.provider',
                        ownedBackendIds: ['acme.sample.backend'],
                        catalogAgentId: 'claude',
                        display: {
                            name: 'Acme Sample Provider',
                            tags: ['plugin'],
                        },
                    },
                },
                runtimeSpec: null,
                pluginId: 'acme.sample',
                daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
            }],
            agentRuntimes: [{
                id: 'acme.sample.backend',
                agentId: 'acme.sample.provider',
                provenance: 'external',
                source: { kind: 'path' },
                definition: {
                    kindVersion: 1,
                    id: 'acme.sample.backend',
                    agentId: 'acme.sample.provider',
                    catalogAgentId: 'claude',
                },
                richDefinition: {
                    provenance: 'external',
                    source: 'plugin',
                    definition: {
                        kindVersion: 1,
                        id: 'acme.sample.backend',
                        agentId: 'acme.sample.provider',
                        catalogAgentId: 'claude',
                        runtimeKind: 'native',
                        capabilities: {},
                        surfaceHandlers,
                    },
                },
                runtimeKind: 'native',
                surfaceHandlers,
                pluginId: 'acme.sample',
                daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
            }],
            actions: [],
            hookRegistrations: [],
            surfaceHandlersByBackendId: new Map(),
            catalogEntriesById: {},
            agentRuntimeDefinitionsById: new Map([
                ['acme.sample.backend', {
                    id: 'acme.sample.backend',
                    agentId: 'acme.sample.provider',
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: {
                        kindVersion: 1,
                        id: 'acme.sample.backend',
                        agentId: 'acme.sample.provider',
                        catalogAgentId: 'claude',
                    },
                    richDefinition: {
                        provenance: 'external',
                        source: 'plugin',
                        definition: {
                            kindVersion: 1,
                            id: 'acme.sample.backend',
                            agentId: 'acme.sample.provider',
                            catalogAgentId: 'claude',
                            runtimeKind: 'native',
                            capabilities: {},
                            surfaceHandlers,
                        },
                    },
                    runtimeKind: 'native',
                    surfaceHandlers,
                    pluginId: 'acme.sample',
                    daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
                }],
            ]),
            agentDefinitionsById: new Map([
                ['acme.sample.provider', {
                    id: 'acme.sample.provider',
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: {
                        kindVersion: 1,
                        id: 'acme.sample.provider',
                        ownedBackendIds: ['acme.sample.backend'],
                        catalogAgentId: 'claude',
                    },
                    richDefinition: {
                        provenance: 'external',
                        source: 'plugin',
                        definition: {
                            kindVersion: 1,
                            id: 'acme.sample.provider',
                            ownedBackendIds: ['acme.sample.backend'],
                            catalogAgentId: 'claude',
                            display: {
                                name: 'Acme Sample Provider',
                                tags: ['plugin'],
                            },
                        },
                    },
                    runtimeSpec: null,
                    pluginId: 'acme.sample',
                    daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
        };
        resolveMergedContributionRegistryMock.mockResolvedValue(registry);
    }

    function seedManifestOnlyAcpPluginRegistry(params?: Readonly<{
        backendDefinition?: Record<string, unknown>;
    }>) {
        const backendDefinition = params?.backendDefinition ?? {
            kindVersion: 1,
            id: 'acme.manifest.acp',
            agentId: 'acme.manifest.provider',
            runtime: {
                kind: 'acp',
                transport: {
                    kind: 'stdio',
                    launch: {
                        kind: 'executable',
                        command: 'acme-agent',
                        args: ['acp'],
                    },
                },
                ux: {
                    title: 'Manifest ACP Agent',
                },
                mcp: {
                    policy: 'drop',
                },
            },
            capabilities: {},
            surfaceHandlers: [],
        };
        const registry = {
            agents: [{
                id: 'acme.manifest.provider',
                provenance: 'external',
                source: { kind: 'path' },
                definition: {
                    kindVersion: 1,
                    id: 'acme.manifest.provider',
                    ownedBackendIds: ['acme.manifest.acp'],
                },
                richDefinition: {
                    provenance: 'external',
                    definition: {
                        kindVersion: 1,
                        id: 'acme.manifest.provider',
                        ownedBackendIds: ['acme.manifest.acp'],
                    },
                },
                runtimeSpec: null,
                pluginId: 'acme.manifest',
                daemonEntryPath: null,
            }],
            agentRuntimes: [{
                id: 'acme.manifest.acp',
                agentId: 'acme.manifest.provider',
                provenance: 'external',
                source: { kind: 'path' },
                definition: {
                    kindVersion: 1,
                    id: 'acme.manifest.acp',
                    agentId: 'acme.manifest.provider',
                },
                richDefinition: {
                    provenance: 'external',
                    definition: backendDefinition,
                },
                runtimeKind: 'acp',
                surfaceHandlers: [],
                pluginId: 'acme.manifest',
                daemonEntryPath: null,
            }],
            actions: [],
            hookRegistrations: [],
            surfaceHandlersByBackendId: new Map(),
            catalogEntriesById: {},
            agentRuntimeDefinitionsById: new Map([
                ['acme.manifest.acp', {
                    id: 'acme.manifest.acp',
                    agentId: 'acme.manifest.provider',
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: {
                        kindVersion: 1,
                        id: 'acme.manifest.acp',
                        agentId: 'acme.manifest.provider',
                    },
                    richDefinition: {
                        provenance: 'external',
                        definition: backendDefinition,
                    },
                    runtimeKind: 'acp',
                    surfaceHandlers: [],
                    pluginId: 'acme.manifest',
                    daemonEntryPath: null,
                }],
            ]),
            agentDefinitionsById: new Map([
                ['acme.manifest.provider', {
                    id: 'acme.manifest.provider',
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: {
                        kindVersion: 1,
                        id: 'acme.manifest.provider',
                        ownedBackendIds: ['acme.manifest.acp'],
                    },
                    richDefinition: {
                        provenance: 'external',
                        definition: {
                            kindVersion: 1,
                            id: 'acme.manifest.provider',
                            ownedBackendIds: ['acme.manifest.acp'],
                        },
                    },
                    runtimeSpec: null,
                    pluginId: 'acme.manifest',
                    daemonEntryPath: null,
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
        };
        resolveMergedContributionRegistryMock.mockResolvedValue(registry);
        return registry;
    }

    function seedFirstPartyOpenCodeRegistryWithoutRuntimeCore(): void {
        const backendId = 'opencode';
        const providerId = 'opencode';

        const registry = {
            agents: [{
                id: providerId,
                provenance: 'first_party',
                source: { kind: 'bundled' },
                definition: {
                    kindVersion: 1,
                    id: providerId,
                    ownedBackendIds: [backendId],
                },
                richDefinition: undefined,
                runtimeSpec: null,
                catalogEntry: {
                    id: providerId,
                    cliSubcommand: providerId,
                    vendorResumeSupport: 'unsupported',
                },
            }],
            agentRuntimes: [{
                id: backendId,
                providerId,
                provenance: 'first_party',
                source: { kind: 'bundled' },
                definition: {
                    kindVersion: 1,
                    id: backendId,
                    providerId,
                },
                richDefinition: undefined,
                runtimeKind: 'server',
                surfaceHandlers: [],
            }],
            actions: [],
            hookRegistrations: [],
            surfaceHandlersByBackendId: new Map(),
            catalogEntriesById: {
                [providerId]: {
                    id: providerId,
                    cliSubcommand: providerId,
                    vendorResumeSupport: 'unsupported',
                },
            },
            agentRuntimeDefinitionsById: new Map([
                [backendId, {
                    id: backendId,
                    providerId,
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                    definition: {
                        kindVersion: 1,
                        id: backendId,
                        providerId,
                    },
                    richDefinition: undefined,
                    runtimeKind: 'server',
                    surfaceHandlers: [],
                }],
            ]),
            agentDefinitionsById: new Map([
                [providerId, {
                    id: providerId,
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                    definition: {
                        kindVersion: 1,
                        id: providerId,
                        ownedBackendIds: [backendId],
                    },
                    richDefinition: undefined,
                    runtimeSpec: null,
                    catalogEntry: {
                        id: providerId,
                        cliSubcommand: providerId,
                        vendorResumeSupport: 'unsupported',
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
        };
        resolveMergedContributionRegistryMock.mockResolvedValue(registry);
    }

    it('prefers a built-in catalog runtimeCore factory over the legacy fallback runtimeCore path', async () => {
        const customRuntimeCore = {
            createSessionRuntime: vi.fn(async (params: unknown) => ({
                source: 'custom-runtimeCore',
                params,
            })),
            createExecutionRunBackend: vi.fn((params: unknown) => ({
                source: 'custom-runtimeCore',
                provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                readResumeSupport: vi.fn(async () => false),
                sendPrompt: vi.fn(async () => undefined),
                cancel: vi.fn(async () => undefined),
                subscribeMessages: vi.fn(() => () => undefined),
                dispose: vi.fn(async () => undefined),
                params,
            })),
        };
        const runtimeCoreFactory = vi.fn(async (params: unknown) => {
            expect(params).toEqual(expect.objectContaining({
                backend: expect.objectContaining({
                    id: 'codex',
                    agentId: 'codex',
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                }),
                provider: expect.objectContaining({
                    id: 'codex',
                    provenance: 'first_party',
                    source: { kind: 'bundled' },
                }),
                executionSurfaces: expect.objectContaining({
                    terminalRuntime: expect.any(Object),
                    externalSession: expect.any(Object),
                    attach: null,
                    handoff: expect.any(Object),
                    fork: expect.any(Object),
                    checkpoint: null,
                }),
            }));
            return {
                runtimeCore: customRuntimeCore,
            };
        });
        seedCodexBuiltInRegistry({ runtimeCoreFactory });

        const registry = await resolveCliEngineRegistry();
        const resolution = await registry.resolveForBackendId('codex');

        expect(runtimeCoreFactory).toHaveBeenCalledTimes(1);
        await expect(
            resolution?.engineAdapter.runtimeCore.createSessionRuntime({ cwd: '/tmp/codex' }),
        ).resolves.toEqual({
            source: 'custom-runtimeCore',
            params: { cwd: '/tmp/codex' },
        });
        expect(
            resolution?.engineAdapter.runtimeCore.createExecutionRunBackend({
                cwd: '/tmp/codex',
                backendId: 'codex',
                permissionMode: 'read_only',
            }),
        ).toEqual(expect.objectContaining({
            source: 'custom-runtimeCore',
            provisionSession: expect.any(Function),
            readResumeSupport: expect.any(Function),
            sendPrompt: expect.any(Function),
            cancel: expect.any(Function),
            subscribeMessages: expect.any(Function),
            dispose: expect.any(Function),
            params: {
                cwd: '/tmp/codex',
                backendId: 'codex',
                permissionMode: 'read_only',
            },
        }));
        expect(customRuntimeCore.createSessionRuntime).toHaveBeenCalledWith({ cwd: '/tmp/codex' });
        expect(customRuntimeCore.createExecutionRunBackend).toHaveBeenCalledWith({
            cwd: '/tmp/codex',
            backendId: 'codex',
            permissionMode: 'read_only',
        });
    });

    it('selects the legacy host runtime owner when no plugin engine is registered', async () => {
        const backendId = 'acme.firstparty.backend';
        const pluginId = 'happier.agent.acme';
        const hostRuntimeCore = {
            createSessionRuntime: vi.fn(async () => ({ owner: 'legacy-host-session' })),
            createExecutionRunBackend: vi.fn(() => ({
                owner: 'legacy-host-execution',
                provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                readResumeSupport: vi.fn(async () => false),
                sendPrompt: vi.fn(async () => undefined),
                cancel: vi.fn(async () => undefined),
                subscribeMessages: vi.fn(() => () => undefined),
                dispose: vi.fn(async () => undefined),
            })),
        };
        const runtimeCoreFactory = vi.fn(async () => ({ runtimeCore: hostRuntimeCore }));
        const contributes = seedFirstPartyOwnerRegistry({
            backendId,
            pluginId,
            runtimeCoreFactory,
        });
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue(createRuntimeRegistry({
            contributes,
            backendId,
            pluginId,
        }));

        const resolution = await resolveBackendEngineAdapterResolution(backendId);

        expect(resolution?.runtimeOwner).toEqual({
            backendId,
            selected: {
                kind: 'legacy_host',
                ownerId: backendId,
                provenance: 'first_party',
            },
            candidates: [{
                kind: 'legacy_host',
                ownerId: backendId,
                provenance: 'first_party',
            }],
        });
        expect(resolution?.selectedSource).toBeUndefined();
        await expect(resolution?.engineAdapter.runtimeCore.createSessionRuntime({ cwd: '/repo' }))
            .resolves
            .toEqual({ owner: 'legacy-host-session' });
        expect(resolution?.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: '/repo',
            backendId,
            permissionMode: 'read_only',
        })).toEqual(expect.objectContaining({ owner: 'legacy-host-execution' }));
        expect(runtimeCoreFactory).toHaveBeenCalledTimes(1);
        expect(hostRuntimeCore.createSessionRuntime).toHaveBeenCalledTimes(1);
        expect(hostRuntimeCore.createExecutionRunBackend).toHaveBeenCalledTimes(1);
    });

    it('selects a bundled plugin engine for a first-party backend after the legacy host owner is removed', async () => {
        const backendId = 'acme.firstparty.backend';
        const pluginId = 'happier.agent.acme';
        const contributes = seedFirstPartyOwnerRegistry({
            backendId,
            pluginId,
        });
        const pluginRuntimeCore = {
            createSessionRuntime: vi.fn(async () => ({ owner: 'plugin-session' })),
            createExecutionRunBackend: vi.fn(() => ({
                owner: 'plugin-execution',
                provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                readResumeSupport: vi.fn(async () => false),
                sendPrompt: vi.fn(async () => undefined),
                cancel: vi.fn(async () => undefined),
                subscribeMessages: vi.fn(() => () => undefined),
                dispose: vi.fn(async () => undefined),
            })),
        };
        const createPluginEngine = vi.fn(async () => ({
            runtimeCore: pluginRuntimeCore,
        }));
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue(createRuntimeRegistry({
            contributes,
            backendId,
            pluginId,
            createEngine: createPluginEngine,
        }));

        const resolution = await resolveBackendEngineAdapterResolution(backendId);

        expect(resolution?.runtimeOwner).toEqual({
            backendId,
            selected: {
                kind: 'plugin_engine',
                ownerId: pluginId,
                provenance: 'first_party',
                pluginId,
            },
            candidates: [{
                kind: 'plugin_engine',
                ownerId: pluginId,
                provenance: 'first_party',
                pluginId,
            }],
        });
        expect(resolution?.selectedSource).toBe('plugin');
        await expect(resolution?.engineAdapter.runtimeCore.createSessionRuntime(createPluginSessionLaunchParams({ cwd: '/repo' })))
            .resolves
            .toMatchObject({
                kind: 'hostSessionRuntimePlan',
                agentId: backendId,
                config: {
                    createSessionRuntime: expect.any(Function),
                    policyAgentId: 'claude',
                },
            });
        expect(resolution?.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: '/repo',
            backendId,
            permissionMode: 'read_only',
        })).toEqual(expect.objectContaining({ owner: 'plugin-execution' }));
        expect(createPluginEngine).toHaveBeenCalledTimes(1);
        expect(pluginRuntimeCore.createSessionRuntime).not.toHaveBeenCalled();
        expect(pluginRuntimeCore.createExecutionRunBackend).toHaveBeenCalledTimes(1);
    });

    it('fails closed when legacy host and plugin runtime owners both exist without takeover acceptance', async () => {
        const backendId = 'acme.firstparty.backend';
        const pluginId = 'happier.agent.acme';
        const hostRuntimeCore = {
            createSessionRuntime: vi.fn(async () => ({ owner: 'legacy-host-session' })),
            createExecutionRunBackend: vi.fn(() => ({ owner: 'legacy-host-execution' })),
        };
        const runtimeCoreFactory = vi.fn(async () => ({ runtimeCore: hostRuntimeCore }));
        const contributes = seedFirstPartyOwnerRegistry({
            backendId,
            pluginId,
            runtimeCoreFactory,
        });
        const createPluginEngine = vi.fn(async () => ({
            runtimeCore: {
                createSessionRuntime: vi.fn(async () => ({ owner: 'plugin-session' })),
                createExecutionRunBackend: vi.fn(() => ({ owner: 'plugin-execution' })),
            },
        }));
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue(createRuntimeRegistry({
            contributes,
            backendId,
            pluginId,
            createEngine: createPluginEngine,
        }));

        const resolution = await resolveBackendEngineAdapterResolution(backendId);

        expect(resolution?.runtimeOwner).toEqual({
            backendId,
            selected: null,
            candidates: [
                {
                    kind: 'legacy_host',
                    ownerId: backendId,
                    provenance: 'first_party',
                },
                {
                    kind: 'plugin_engine',
                    ownerId: pluginId,
                    provenance: 'first_party',
                    pluginId,
                },
            ],
            conflictDiagnostic: expect.objectContaining({
                code: 'engine_runtime_owner_conflict',
                backendId,
                pluginId,
            }),
        });
        expect(resolution?.diagnostics).toEqual([
            expect.objectContaining({
                code: 'engine_runtime_owner_conflict',
                backendId,
                pluginId,
            }),
        ]);
        await expect(resolution?.engineAdapter.runtimeCore.createSessionRuntime({ cwd: '/repo' }))
            .rejects
            .toThrow(/bound host runtimeCore/i);
        expect(() => resolution?.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: '/repo',
            backendId,
            permissionMode: 'read_only',
        })).toThrow(/bound host runtimeCore/i);
        expect(runtimeCoreFactory).not.toHaveBeenCalled();
        expect(createPluginEngine).not.toHaveBeenCalled();
        expect(hostRuntimeCore.createSessionRuntime).not.toHaveBeenCalled();
        expect(hostRuntimeCore.createExecutionRunBackend).not.toHaveBeenCalled();
    });

    it('uses the accepted plugin takeover owner for both session and execution-run runtime', async () => {
        const backendId = 'acme.firstparty.backend';
        const pluginId = 'happier.agent.acme';
        const hostRuntimeCore = {
            createSessionRuntime: vi.fn(async () => ({ owner: 'legacy-host-session' })),
            createExecutionRunBackend: vi.fn(() => ({ owner: 'legacy-host-execution' })),
        };
        const runtimeCoreFactory = vi.fn(async () => ({ runtimeCore: hostRuntimeCore }));
        const contributes = seedFirstPartyOwnerRegistry({
            backendId,
            pluginId,
            runtimeCoreFactory,
            runtimeOwner: {
                selectedOwner: 'plugin_engine',
                acceptedBy: 'A.13q.2-test',
            },
        });
        const pluginRuntimeCore = {
            createSessionRuntime: vi.fn(async () => ({ owner: 'plugin-session' })),
            createExecutionRunBackend: vi.fn(() => ({
                owner: 'plugin-execution',
                provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                readResumeSupport: vi.fn(async () => false),
                sendPrompt: vi.fn(async () => undefined),
                cancel: vi.fn(async () => undefined),
                subscribeMessages: vi.fn(() => () => undefined),
                dispose: vi.fn(async () => undefined),
            })),
        };
        const createPluginEngine = vi.fn(async () => ({
            runtimeCore: pluginRuntimeCore,
        }));
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue(createRuntimeRegistry({
            contributes,
            backendId,
            pluginId,
            createEngine: createPluginEngine,
        }));

        const resolution = await resolveBackendEngineAdapterResolution(backendId);

        expect(resolution?.runtimeOwner).toEqual({
            backendId,
            selected: {
                kind: 'plugin_engine',
                ownerId: pluginId,
                provenance: 'first_party',
                pluginId,
            },
            candidates: [
                {
                    kind: 'legacy_host',
                    ownerId: backendId,
                    provenance: 'first_party',
                },
                {
                    kind: 'plugin_engine',
                    ownerId: pluginId,
                    provenance: 'first_party',
                    pluginId,
                },
            ],
            takeover: {
                selectedOwner: 'plugin_engine',
                acceptedBy: 'A.13q.2-test',
            },
        });
        expect(resolution?.selectedSource).toBe('plugin');
        await expect(resolution?.engineAdapter.runtimeCore.createSessionRuntime(createPluginSessionLaunchParams({ cwd: '/repo' })))
            .resolves
            .toMatchObject({
                kind: 'hostSessionRuntimePlan',
                agentId: backendId,
                config: {
                    createSessionRuntime: expect.any(Function),
                    policyAgentId: 'claude',
                },
            });
        expect(resolution?.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: '/repo',
            backendId,
            permissionMode: 'read_only',
        })).toEqual(expect.objectContaining({ owner: 'plugin-execution' }));
        expect(createPluginEngine).toHaveBeenCalledTimes(1);
        expect(runtimeCoreFactory).not.toHaveBeenCalled();
        expect(hostRuntimeCore.createSessionRuntime).not.toHaveBeenCalled();
        expect(hostRuntimeCore.createExecutionRunBackend).not.toHaveBeenCalled();
        expect(pluginRuntimeCore.createSessionRuntime).not.toHaveBeenCalled();
        expect(pluginRuntimeCore.createExecutionRunBackend).toHaveBeenCalledTimes(1);
    });

    it('fails closed when accepted plugin takeover has no registered plugin engine', async () => {
        const backendId = 'acme.firstparty.backend';
        const pluginId = 'happier.agent.acme';
        const hostRuntimeCore = {
            createSessionRuntime: vi.fn(async () => ({ owner: 'legacy-host-session' })),
            createExecutionRunBackend: vi.fn(() => ({ owner: 'legacy-host-execution' })),
        };
        const runtimeCoreFactory = vi.fn(async () => ({ runtimeCore: hostRuntimeCore }));
        const contributes = seedFirstPartyOwnerRegistry({
            backendId,
            pluginId,
            runtimeCoreFactory,
            runtimeOwner: {
                selectedOwner: 'plugin_engine',
                acceptedBy: 'A.13q.2-test',
            },
        });
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue(createRuntimeRegistry({
            contributes,
            backendId,
            pluginId,
        }));

        const resolution = await resolveBackendEngineAdapterResolution(backendId);

        expect(resolution?.runtimeOwner).toEqual({
            backendId,
            selected: null,
            candidates: [{
                kind: 'legacy_host',
                ownerId: backendId,
                provenance: 'first_party',
            }],
            takeover: {
                selectedOwner: 'plugin_engine',
                acceptedBy: 'A.13q.2-test',
            },
            conflictDiagnostic: expect.objectContaining({
                code: 'engine_runtime_owner_takeover_missing',
                backendId,
                pluginId,
            }),
        });
        expect(resolution?.diagnostics).toEqual([
            expect.objectContaining({
                code: 'engine_runtime_owner_takeover_missing',
                backendId,
                pluginId,
            }),
        ]);
        await expect(resolution?.engineAdapter.runtimeCore.createSessionRuntime({ cwd: '/repo' }))
            .rejects
            .toThrow(/bound host runtimeCore/i);
        expect(() => resolution?.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: '/repo',
            backendId,
            permissionMode: 'read_only',
        })).toThrow(/bound host runtimeCore/i);
        expect(runtimeCoreFactory).not.toHaveBeenCalled();
        expect(hostRuntimeCore.createSessionRuntime).not.toHaveBeenCalled();
        expect(hostRuntimeCore.createExecutionRunBackend).not.toHaveBeenCalled();
    });

    it('resolves plugin backends through a registered backend engine when no getRuntimeCore is declared on the backend', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        const createExecutionRunBackend = vi.fn(() => ({
            provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
            readResumeSupport: vi.fn(async () => false),
            sendPrompt: vi.fn(async () => undefined),
            cancel: vi.fn(async () => undefined),
            subscribeMessages: vi.fn(() => () => undefined),
            dispose: vi.fn(async () => undefined),
        }));
        let observedContext: unknown = null;

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: unknown) => {
                            observedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend,
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            activatedPluginIds: new Set(['acme.sample']),
            activatePluginsByEvent: vi.fn(async () => []),
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        expect(resolution?.backendId).toBe('acme.sample.backend');

        const runtime = resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
        });

        expect(observedContext).toEqual(expect.any(Object));
        const context = observedContext as unknown as ObservedPluginRuntimeContext;
        expect(context.config?.values?.currentCliVersion).toBe(configuration.currentCliVersion);
        expect(context.logger?.debug).toEqual(expect.any(Function));
        expect(context.features?.isEnabled).toEqual(expect.any(Function));
        expect(context.agentRuntime?.acp?.defineAcpBackend).toEqual(expect.any(Function));
        expect(context.agentRuntime?.acp?.createRuntime).toEqual(expect.any(Function));
        const acpRuntimeContext = context as AcpRuntimeContextForTest;
        const acpClientDispose = vi.fn(async () => undefined);
        const acpClient: JsonRpcClientV1 = {
            async request<TParams = unknown, TResult = unknown>(): Promise<TResult> {
                return {} as TResult;
            },
            async notify() {
                return undefined;
            },
            registerRequestHandler: () => () => undefined,
            registerNotificationHandler: () => () => undefined,
        };
        const acpRuntimeClientHandle: ExecClientHandleV1<JsonRpcClientV1> = {
            client: acpClient,
            process: {
                pid: 123,
                exit: Promise.resolve({ exitCode: 0, signal: null, stdout: '', stderr: '' }),
                writeStdin: async () => undefined,
                kill: () => undefined,
                dispose: async () => undefined,
            },
            status: 'running',
            onExit: () => () => undefined,
            dispose: acpClientDispose,
        };
        const acpRuntimeHandle = await acpRuntimeContext.agentRuntime.acp.createRuntime({
            backendId: 'acme.sample.backend',
            transport: {
                kind: 'stdio',
                launch: {
                    kind: 'executable',
                    command: '/bin/fixture-agent',
                },
            },
        }, {
            sessionId: 'session-1',
            cwd: process.cwd(),
            client: acpRuntimeClientHandle,
            extensions: {
                requests: {
                    'fixture/contextPing': async () => ({ ok: true }),
                },
            },
        });
        expect(acpRuntimeHandle.runtime.agentId).toBe('acme.sample.backend');
        await acpRuntimeHandle.dispose('test');
        await acpRuntimeHandle.dispose('test-again');
        expect(acpClientDispose).toHaveBeenCalledTimes(1);
        expect(context.fetch).toEqual(expect.any(Function));
        await expect((context.fetch as (request: unknown) => Promise<unknown>)({
            url: 'https://example.test/blocked',
        })).rejects.toThrow(/network/i);
        expect(context.sessions?.subagents).toEqual(expect.objectContaining({
            list: expect.any(Function),
            upsert: expect.any(Function),
            updateStatus: expect.any(Function),
            complete: expect.any(Function),
        }));
        const subagents = context.sessions?.subagents as PluginSubagentsServiceV1;
        await expect(subagents.upsert({
            id: 'plugin-subagent-1',
            parentSessionId: 'session-1',
            origin: 'agent',
            kind: 'native',
            agentRef: { agentId: 'acme.sample' },
        })).rejects.toThrow(/unavailable/);
        await expect(subagents.list({ parentSessionId: 'session-1' }))
            .resolves
            .toEqual([]);
        await expect(subagents.complete({
            id: 'plugin-subagent-1',
            parentSessionId: 'session-1',
            status: 'completed',
        })).rejects.toThrow(/unavailable/);
        expect(context.sessions?.external).toEqual(expect.objectContaining({
            listCandidates: expect.any(Function),
            attach: expect.any(Function),
            takeover: expect.any(Function),
            pageTranscript: expect.any(Function),
            readAfterTranscript: expect.any(Function),
            followTranscript: expect.any(Function),
        }));
        const externalSessions = context.sessions?.external as Readonly<{
            attach: (input: unknown) => Promise<unknown>;
            takeover: (input: unknown) => Promise<unknown>;
            followTranscript: (input: unknown, onEvent: (event: unknown) => void) => { unsubscribe: () => void };
        }>;
        await expect(externalSessions.attach({})).resolves.toMatchObject({ ok: false });
        await expect(externalSessions.takeover({})).resolves.toMatchObject({
            ok: false,
            errorCode: 'capability_unsupported',
        });
        expect(() => externalSessions.followTranscript({}, vi.fn()).unsubscribe()).not.toThrow();
        expect(context.notifications?.send).toEqual(expect.any(Function));
        expect(context.notifications?.listCategories).toEqual(expect.any(Function));
        expect(context.notifications?.listChannels).toEqual(expect.any(Function));
        expect(context.notifications?.getUserPreferences).toEqual(expect.any(Function));
        expect(context.projects?.listAll).toEqual(expect.any(Function));
        expect(context.projects?.listForCurrentMachine).toEqual(expect.any(Function));
        expect(context.projects?.listForMachine).toEqual(expect.any(Function));
        expect(context.projects?.get).toEqual(expect.any(Function));
        expect(context.projects?.getActive).toEqual(expect.any(Function));
        expect(context.projects?.watch).toEqual(expect.any(Function));
        expect(context.account?.settings?.get).toEqual(expect.any(Function));
        expect(context.account?.settings?.set).toEqual(expect.any(Function));
        expect(context.account?.settings?.onChange).toEqual(expect.any(Function));
        expect(context.reviews?.comments?.create).toEqual(expect.any(Function));
        expect(context.abort?.signal).toEqual(expect.any(AbortSignal));

        expect(runtime).toMatchObject({
            provisionSession: expect.any(Function),
            readResumeSupport: expect.any(Function),
            sendPrompt: expect.any(Function),
            cancel: expect.any(Function),
            subscribeMessages: expect.any(Function),
            dispose: expect.any(Function),
        });
        expect(createExecutionRunBackend).toHaveBeenCalledTimes(1);
        expect(getExecutionRunBackendDescriptorMock).not.toHaveBeenCalled();
    });

    it('rejects plugin execution-run backends that do not implement the host runtime contract', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        const createExecutionRunBackend = vi.fn(() => ({
            run: vi.fn(async () => undefined),
        }));

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async () => ({
                            runtimeCore: {
                                createSessionRuntime: async () => null,
                                createExecutionRunBackend,
                            },
                        }),
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            activatePluginsByEvent: vi.fn(async () => []),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');

        expect(() => resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
        })).toThrow(/Execution-run plugin backend 'acme\.sample\.backend'.*plugin 'acme\.sample'.*ExecutionRunHostRuntime/i);
        expect(createExecutionRunBackend).toHaveBeenCalledTimes(1);
        expect(getExecutionRunBackendDescriptorMock).not.toHaveBeenCalled();
    });

    it('resolves providerless review plugin backends through their registered backend engine', async () => {
        const backendId = 'review.providerless';
        const pluginId = 'happier.review.providerless';
        const executionBackend = {
            provisionSession: vi.fn(async () => ({ sessionId: 'review-run-session-1' })),
            readResumeSupport: vi.fn(async () => false),
            sendPrompt: vi.fn(async () => undefined),
            cancel: vi.fn(async () => undefined),
            subscribeMessages: vi.fn(() => () => undefined),
            dispose: vi.fn(async () => undefined),
        };
        const createExecutionRunBackend = vi.fn(() => executionBackend);
        const backend = {
            id: backendId,
            agentId: backendId,
            provenance: 'external',
            source: { kind: 'bundled' },
            definition: {
                kindVersion: 1,
                id: backendId,
                agentId: backendId,
                catalogAgentId: 'claude',
                engine: { kind: 'custom' },
            },
            richDefinition: {
                provenance: 'external',
                source: 'plugin',
                definition: {
                    kindVersion: 1,
                    id: backendId,
                    agentId: backendId,
                    catalogAgentId: 'claude',
                    engine: { kind: 'custom' },
                    capabilities: {},
                    surfaceHandlers: [],
                },
            },
            runtimeKind: 'custom',
            surfaceHandlers: [],
            pluginId,
            daemonEntryPath: '@happier-dev/plugins-review-providerless',
        };
        const contributes = {
            agents: [],
            agentRuntimes: [backend],
            actions: [],
            hookRegistrations: [],
            surfaceHandlersByBackendId: new Map(),
            catalogEntriesById: {},
            agentRuntimeDefinitionsById: new Map([[backendId, backend]]),
            agentDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: {},
        };
        resolveMergedContributionRegistryMock.mockResolvedValue(contributes);
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes,
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                [backendId, {
                    pluginId,
                    registration: {
                        backendId,
                        create: async () => ({
                            runtimeCore: {
                                createSessionRuntime: async () => {
                                    throw new Error('providerless review engines are execution-run only');
                                },
                                createExecutionRunBackend,
                            },
                        }),
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            activatePluginsByEvent: vi.fn(async () => []),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution(backendId);
        expect(resolution?.diagnostics).toContainEqual(expect.objectContaining({
            code: 'engine_provider_missing',
            backendId,
            agentId: backendId,
            pluginId,
        }));

        const runtime = resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: '/repo',
            backendId,
            permissionMode: 'read_only',
        });
        expect(createExecutionRunBackend).toHaveBeenCalledWith({
            cwd: '/repo',
            backendId,
            permissionMode: 'read_only',
        });
        await expect(runtime.provisionSession({ initialPrompt: 'review this' }))
            .resolves
            .toEqual({ sessionId: 'review-run-session-1' });
        const sessionPlan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime(createPluginSessionLaunchParams({ cwd: '/repo' })) as HostSessionRuntimePlanForTest;
        await expect(sessionPlan.config.createSessionRuntime({
            directory: '/repo',
            metadata: {},
            machineId: 'm1',
            session: { sessionId: 'review-session-1' },
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'read_only',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        }))
            .rejects
            .toThrow(/execution-run only/i);
    });

    it('delivers execution-run state field writes to the parent session target', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        const parentDurableMutationOutbox = {
            enqueueRegisteredSessionStateFieldMutation: vi.fn(async (_mutation: RegisteredSessionStateFieldMutationV1) => undefined),
        };
        const parentSessionStateTarget = {
            sessionId: 'parent-session-1',
            durableMutationOutbox: parentDurableMutationOutbox,
            enqueueRegisteredSessionStateFieldMutation: async function (
                this: { durableMutationOutbox: typeof parentDurableMutationOutbox },
                mutation: RegisteredSessionStateFieldMutationV1,
            ) {
                await this.durableMutationOutbox.enqueueRegisteredSessionStateFieldMutation(mutation);
            },
        };
        let capturedContext: SessionScopedContextForTest | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            capturedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend: vi.fn(() => ({
                                        provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                                        readResumeSupport: vi.fn(async () => false),
                                        sendPrompt: vi.fn(async () => undefined),
                                        cancel: vi.fn(async () => undefined),
                                        subscribeMessages: vi.fn(() => () => undefined),
                                        dispose: vi.fn(async () => undefined),
                                    })),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            activatePluginsByEvent: vi.fn(async () => []),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            runId: 'run-1',
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
            parentSessionStateTarget,
        });

        await capturedContext!.sessions.writeStateField({
            fieldId: 'identity.providerSessionId',
            value: 'provider-session-1',
            reason: 'execution-run-provider-session',
        });
        await capturedContext!.sessions.writeStateField({
            fieldId: 'runtime.activity',
            value: {
                v: 1,
                activeCount: 1,
                observedAtMs: 1_000,
                expiresAtMs: 2_000,
                sourceClass: 'provider_detached_task',
            },
            reason: 'execution-run-runtime-activity',
        });

        expect(parentDurableMutationOutbox.enqueueRegisteredSessionStateFieldMutation).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'parent-session-1',
            fieldId: 'identity.providerSessionId',
            deliveryClass: 'durable_best_effort',
            source: 'runtime',
            op: {
                kind: 'set',
                value: 'provider-session-1',
            },
        }));
        expect(parentDurableMutationOutbox.enqueueRegisteredSessionStateFieldMutation).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'parent-session-1',
            fieldId: 'runtime.activity',
            deliveryClass: 'durable_best_effort',
            source: 'runtime',
            op: {
                kind: 'set',
                value: {
                    v: 1,
                    activeCount: 1,
                    observedAtMs: 1_000,
                    expiresAtMs: 2_000,
                    sourceClass: 'provider_detached_task',
                },
            },
        }));
    });

    it('records execution-run provider account usage against the parent session target', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let capturedContext: SessionScopedContextForTest | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            capturedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend: vi.fn(() => ({
                                        provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                                        readResumeSupport: vi.fn(async () => false),
                                        sendPrompt: vi.fn(async () => undefined),
                                        cancel: vi.fn(async () => undefined),
                                        subscribeMessages: vi.fn(() => () => undefined),
                                        dispose: vi.fn(async () => undefined),
                                    })),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            activatePluginsByEvent: vi.fn(async () => []),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            runId: 'run-1',
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
            parentSessionStateTarget: {
                sessionId: 'parent-session-1',
            },
        });

        const result = await capturedContext!.agentRuntime.accountUsage.recordSnapshot({
            snapshot: createProviderAccountUsageSnapshotForTest(),
        });

        expect(result).toMatchObject({
            status: 'recorded',
            recordId: expect.any(String),
        });
        expect(notifyDaemonProviderAccountUsageSnapshotMock).toHaveBeenCalledWith({
            sessionId: 'parent-session-1',
            snapshot: expect.objectContaining({
                providerId: 'openai-codex',
                accountSubject: { kind: 'providerSubject', id: 'acct_123' },
            }),
        });

        const invalidResult = await capturedContext!.agentRuntime.accountUsage.recordSnapshot(null);

        expect(invalidResult).toEqual({ status: 'rejected', reason: 'invalid_snapshot' });
        expect(notifyDaemonProviderAccountUsageSnapshotMock).toHaveBeenCalledTimes(1);

        const mismatchResult = await capturedContext!.agentRuntime.accountUsage.recordSnapshot({
            sessionId: 'other-session',
            snapshot: createProviderAccountUsageSnapshotForTest('acct_456'),
        });

        expect(mismatchResult).toEqual({ status: 'rejected', reason: 'session_mismatch' });
        expect(notifyDaemonProviderAccountUsageSnapshotMock).toHaveBeenCalledTimes(1);

        const { resolveSourceContext } = capturedContext!.agentRuntime.accountUsage;
        await expect(resolveSourceContext({
            serviceId: 'openai-codex',
            env: {
                [HAPPIER_CONNECTED_SERVICE_SELECTIONS_ENV_KEY]: JSON.stringify([{
                    kind: 'group',
                    serviceId: 'openai-codex',
                    groupId: 'main',
                    activeProfileId: 'backup',
                    fallbackProfileId: 'primary',
                    generation: 2,
                }]),
            },
        })).resolves.toEqual({
            serviceId: 'openai-codex',
            profileId: 'backup',
            bindingKind: 'group_member',
            groupId: 'main',
            groupGeneration: 2,
        });

        const adoption = createProviderAccountUsageAdoptionForTest();
        notifyDaemonProviderAccountUsageAdoptionMock.mockResolvedValueOnce({
            ok: true,
            result: {
                status: 'adopted',
                fromRecordId: adoption.fromRecordId,
                toRecordId: adoption.toRecordId,
                persisted: true,
            },
        });

        const adoptionResult = await capturedContext!.agentRuntime.accountUsage.adoptProvisionalRecord({
            adoption,
        });

        expect(adoptionResult).toEqual({
            status: 'adopted',
            fromRecordId: adoption.fromRecordId,
            toRecordId: adoption.toRecordId,
            persisted: true,
        });
        expect(notifyDaemonProviderAccountUsageAdoptionMock).toHaveBeenCalledWith({
            sessionId: 'parent-session-1',
            adoption,
        });

        const invalidAdoptionResult = await capturedContext!.agentRuntime.accountUsage.adoptProvisionalRecord(null);

        expect(invalidAdoptionResult).toEqual({ status: 'rejected', reason: 'invalid_adoption' });
        expect(notifyDaemonProviderAccountUsageAdoptionMock).toHaveBeenCalledTimes(1);

        const adoptionMismatchResult = await capturedContext!.agentRuntime.accountUsage.adoptProvisionalRecord({
            sessionId: 'other-session',
            adoption,
        });

        expect(adoptionMismatchResult).toEqual({ status: 'rejected', reason: 'session_mismatch' });
        expect(notifyDaemonProviderAccountUsageAdoptionMock).toHaveBeenCalledTimes(1);
    });

    it('replays daemon-unavailable provider account usage snapshots on the next successful notification', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let capturedContext: SessionScopedContextForTest | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            capturedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend: vi.fn(() => ({
                                        provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                                        readResumeSupport: vi.fn(async () => false),
                                        sendPrompt: vi.fn(async () => undefined),
                                        cancel: vi.fn(async () => undefined),
                                        subscribeMessages: vi.fn(() => () => undefined),
                                        dispose: vi.fn(async () => undefined),
                                    })),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            activatePluginsByEvent: vi.fn(async () => []),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            runId: 'run-1',
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
            parentSessionStateTarget: {
                sessionId: 'parent-session-1',
            },
        });

        const olderQueuedSnapshot = {
            ...createProviderAccountUsageSnapshotForTest('acct_replay'),
            observedAtMs: 1,
            fetchedAtMs: 1,
            staleAfterMs: 60_000,
        };
        const latestQueuedSnapshot = {
            ...olderQueuedSnapshot,
            observedAtMs: 2,
            fetchedAtMs: 2,
            staleAfterMs: 120_000,
        };
        const liveSnapshot = createProviderAccountUsageSnapshotForTest('acct_live');
        notifyDaemonProviderAccountUsageSnapshotMock
            .mockResolvedValueOnce({ error: { code: 'ECONNREFUSED' } })
            .mockRejectedValueOnce(new Error('daemon unavailable'))
            .mockResolvedValue({
                ok: true,
                result: { status: 'recorded', recordId: 'paug_v1_placeholder', persisted: true },
            });

        await expect(capturedContext!.agentRuntime.accountUsage.recordSnapshot({
            snapshot: olderQueuedSnapshot,
        })).resolves.toEqual({ status: 'unavailable', reason: 'daemon_unavailable' });
        await expect(capturedContext!.agentRuntime.accountUsage.recordSnapshot({
            snapshot: latestQueuedSnapshot,
        })).resolves.toEqual({ status: 'unavailable', reason: 'daemon_unavailable' });
        await expect(capturedContext!.agentRuntime.accountUsage.recordSnapshot({
            snapshot: liveSnapshot,
        })).resolves.toMatchObject({
            status: 'recorded',
            recordId: expect.any(String),
            persisted: true,
        });

        const daemonCalls = notifyDaemonProviderAccountUsageSnapshotMock.mock.calls.map(([input]) =>
            input as Readonly<{ sessionId: string; snapshot: ProviderAccountUsageSnapshotV1 }>,
        );
        expect(daemonCalls).toHaveLength(4);
        expect(daemonCalls.every((call) => call.sessionId === 'parent-session-1')).toBe(true);
        expect(daemonCalls.filter((call) => call.snapshot.recordId === olderQueuedSnapshot.recordId)
            .map((call) => call.snapshot.observedAtMs))
            .toEqual([1, 2, 2]);
        expect(daemonCalls.slice(2)).toEqual(expect.arrayContaining([
            expect.objectContaining({
                snapshot: expect.objectContaining({
                    recordId: latestQueuedSnapshot.recordId,
                    observedAtMs: 2,
                    staleAfterMs: 120_000,
                }),
            }),
            expect.objectContaining({
                snapshot: expect.objectContaining({
                    recordId: liveSnapshot.recordId,
                }),
            }),
        ]));
    });

    it('retries provider account usage snapshots when the daemon has not reattached the session yet', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let capturedContext: SessionScopedContextForTest | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            capturedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend: vi.fn(() => ({
                                        provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                                        readResumeSupport: vi.fn(async () => false),
                                        sendPrompt: vi.fn(async () => undefined),
                                        cancel: vi.fn(async () => undefined),
                                        subscribeMessages: vi.fn(() => () => undefined),
                                        dispose: vi.fn(async () => undefined),
                                    })),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            activatePluginsByEvent: vi.fn(async () => []),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            runId: 'run-1',
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
            parentSessionStateTarget: {
                sessionId: 'parent-session-1',
            },
        });

        const queuedSnapshot = createProviderAccountUsageSnapshotForTest('acct_pending_session');
        const liveSnapshot = createProviderAccountUsageSnapshotForTest('acct_live_after_session');
        notifyDaemonProviderAccountUsageSnapshotMock
            .mockResolvedValueOnce({ ok: true, result: { status: 'session_not_found' } })
            .mockResolvedValue({
                ok: true,
                result: { status: 'recorded', recordId: 'paug_v1_placeholder', persisted: true },
            });

        await expect(capturedContext!.agentRuntime.accountUsage.recordSnapshot({
            snapshot: queuedSnapshot,
        })).resolves.toEqual({ status: 'unavailable', reason: 'daemon_unavailable' });

        await expect(capturedContext!.agentRuntime.accountUsage.recordSnapshot({
            snapshot: liveSnapshot,
        })).resolves.toMatchObject({
            status: 'recorded',
            recordId: expect.any(String),
            persisted: true,
        });

        const daemonCalls = notifyDaemonProviderAccountUsageSnapshotMock.mock.calls.map(([input]) =>
            input as Readonly<{ sessionId: string; snapshot: ProviderAccountUsageSnapshotV1 }>,
        );
        expect(daemonCalls).toHaveLength(3);
        expect(daemonCalls.map((call) => call.snapshot.recordId)).toEqual([
            queuedSnapshot.recordId,
            queuedSnapshot.recordId,
            liveSnapshot.recordId,
        ]);
    });

    it('delivers execution-run metadata registered fields to the parent session target', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        const enqueueRegisteredSessionStateFieldMutation = vi.fn(async () => undefined);
        let capturedContext: SessionScopedContextForTest | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            capturedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend: vi.fn(() => ({
                                        provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                                        readResumeSupport: vi.fn(async () => false),
                                        sendPrompt: vi.fn(async () => undefined),
                                        cancel: vi.fn(async () => undefined),
                                        subscribeMessages: vi.fn(() => () => undefined),
                                        dispose: vi.fn(async () => undefined),
                                    })),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            runId: 'run-1',
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
            parentSessionStateTarget: {
                sessionId: 'parent-session-1',
                enqueueRegisteredSessionStateFieldMutation,
            },
        });

        await capturedContext!.sessions.writeMetadata({
            kind: 'set',
            metadata: {
                sessionWorkStateV1: {
                    v: 1,
                    backendId: 'acme.sample.backend',
                    updatedAt: 123,
                    items: [],
                },
            },
        });

        expect(enqueueRegisteredSessionStateFieldMutation).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'parent-session-1',
            fieldId: 'runtime.workState',
            deliveryClass: 'durable_required',
            source: 'runtime',
            op: expect.objectContaining({
                kind: 'set',
                value: expect.objectContaining({
                    backendId: 'acme.sample.backend',
                    updatedAt: 123,
                }),
            }),
        }));
    });

    it('rejects execution-run metadata update handlers even when a parent session target exists', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        const enqueueRegisteredSessionStateFieldMutation = vi.fn(async () => undefined);
        let capturedContext: SessionScopedContextForTest | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            capturedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend: vi.fn(() => ({
                                        provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                                        readResumeSupport: vi.fn(async () => false),
                                        sendPrompt: vi.fn(async () => undefined),
                                        cancel: vi.fn(async () => undefined),
                                        subscribeMessages: vi.fn(() => () => undefined),
                                        dispose: vi.fn(async () => undefined),
                                    })),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            runId: 'run-1',
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
            parentSessionStateTarget: {
                sessionId: 'parent-session-1',
                enqueueRegisteredSessionStateFieldMutation,
            },
        });

        const handler = vi.fn(() => ({
            sessionWorkStateV1: {
                v: 1,
                backendId: 'acme.sample.backend',
                updatedAt: 123,
                items: [],
            },
        }));

        await expect(capturedContext!.sessions.writeMetadata({
            kind: 'update',
            handler,
        })).rejects.toMatchObject({
            code: 'execution_run_session_state_unsupported',
            result: {
                status: 'unsupported',
                fieldId: null,
                reason: 'scope_not_supported',
            },
        });
        expect(handler).not.toHaveBeenCalled();
        expect(enqueueRegisteredSessionStateFieldMutation).not.toHaveBeenCalled();
    });

    it('keeps overlapping execution-run session writes bound to the creating parent target', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        const firstParentEnqueue = vi.fn(async () => undefined);
        const secondParentEnqueue = vi.fn(async () => undefined);
        const createExecutionRunBackend = vi.fn((params: Readonly<{ runId?: string }>) => ({
            provisionSession: vi.fn(async () => ({ sessionId: `run-session-${params.runId ?? 'unknown'}` })),
            readResumeSupport: vi.fn(async () => false),
            sendPrompt: vi.fn(async () => {
                await capturedContext!.sessions.writeStateField({
                    fieldId: 'identity.providerSessionId',
                    value: `provider-${params.runId ?? 'unknown'}`,
                    reason: 'execution-run-provider-session',
                });
            }),
            cancel: vi.fn(async () => undefined),
            subscribeMessages: vi.fn(() => () => undefined),
            dispose: vi.fn(async () => undefined),
        }));
        let capturedContext: SessionScopedContextForTest | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            capturedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend,
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        const firstRuntime = resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            runId: 'run-1',
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
            parentSessionStateTarget: {
                sessionId: 'parent-session-1',
                enqueueRegisteredSessionStateFieldMutation: firstParentEnqueue,
            },
        });
        const secondRuntime = resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            runId: 'run-2',
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
            parentSessionStateTarget: {
                sessionId: 'parent-session-2',
                enqueueRegisteredSessionStateFieldMutation: secondParentEnqueue,
            },
        });

        await firstRuntime.sendPrompt('run-session-1', 'first');
        await secondRuntime.sendPrompt('run-session-2', 'second');

        expect(firstParentEnqueue).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'parent-session-1',
            fieldId: 'identity.providerSessionId',
            op: { kind: 'set', value: 'provider-run-1' },
        }));
        expect(secondParentEnqueue).toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'parent-session-2',
            fieldId: 'identity.providerSessionId',
            op: { kind: 'set', value: 'provider-run-2' },
        }));
        expect(secondParentEnqueue).not.toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'parent-session-2',
            op: { kind: 'set', value: 'provider-run-1' },
        }));
        expect(firstParentEnqueue).not.toHaveBeenCalledWith(expect.objectContaining({
            sessionId: 'parent-session-1',
            op: { kind: 'set', value: 'provider-run-2' },
        }));
        expect(createExecutionRunBackend).toHaveBeenNthCalledWith(1, expect.not.objectContaining({
            parentSessionStateTarget: expect.anything(),
        }));
        expect(createExecutionRunBackend).toHaveBeenNthCalledWith(2, expect.not.objectContaining({
            parentSessionStateTarget: expect.anything(),
        }));
    });

    it('rejects execution-run state field writes without a parent session target', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let capturedContext: SessionScopedContextForTest | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            capturedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend: vi.fn(() => ({
                                        provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                                        readResumeSupport: vi.fn(async () => false),
                                        sendPrompt: vi.fn(async () => undefined),
                                        cancel: vi.fn(async () => undefined),
                                        subscribeMessages: vi.fn(() => () => undefined),
                                        dispose: vi.fn(async () => undefined),
                                    })),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            runId: 'run-1',
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
        });

        await expect(capturedContext!.sessions.writeStateField({
            fieldId: 'runtime.workState',
            value: {
                v: 1,
                backendId: 'acme.sample.backend',
                updatedAt: 456,
                items: [],
            },
            reason: 'execution-run-work-state',
        })).rejects.toMatchObject({
            code: 'execution_run_session_state_unsupported',
            result: {
                status: 'unsupported',
                fieldId: 'runtime.workState',
                reason: 'no_session_target',
            },
        });
    });

    it('rejects no-target execution-run metadata updates before invoking the update handler', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let capturedContext: SessionScopedContextForTest | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            capturedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend: vi.fn(() => ({
                                        provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                                        readResumeSupport: vi.fn(async () => false),
                                        sendPrompt: vi.fn(async () => undefined),
                                        cancel: vi.fn(async () => undefined),
                                        subscribeMessages: vi.fn(() => () => undefined),
                                        dispose: vi.fn(async () => undefined),
                                    })),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            runId: 'run-1',
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
        });

        const handler = vi.fn(() => {
            throw new Error('metadata handler should not run without a parent target');
        });

        await expect(capturedContext!.sessions.writeMetadata({
            kind: 'update',
            handler,
        })).rejects.toMatchObject({
            code: 'execution_run_session_state_unsupported',
            result: {
                status: 'unsupported',
                fieldId: null,
                reason: 'no_session_target',
            },
        });
        expect(handler).not.toHaveBeenCalled();
    });

    it('binds ctx.reviews.comments to production review-comment actions in normal runtime', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let observedContext: unknown = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: unknown) => {
                            observedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend: vi.fn(() => ({
                                        provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                                        readResumeSupport: vi.fn(async () => false),
                                        sendPrompt: vi.fn(async () => undefined),
                                        cancel: vi.fn(async () => undefined),
                                        subscribeMessages: vi.fn(() => () => undefined),
                                        dispose: vi.fn(async () => undefined),
                                    })),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });
        readCredentialsMock.mockResolvedValue({
            token: 'review-token',
            encryption: { type: 'legacy', secret: new Uint8Array(32) },
        });
        axiosPostMock.mockResolvedValue({
            status: 200,
            data: { comment: createReviewCommentFixture() },
        });

        await resolveBackendEngineAdapterResolution('acme.sample.backend');

        const context = observedContext as ObservedPluginRuntimeContext;
        expect(context.permissions?.isGranted?.('reviews.comments.write.direct')).toBe(false);
        expect(context.permissions?.list?.()).not.toContain('reviews.comments.write.direct');
        await expect((context.reviews?.comments?.create as (request: unknown) => Promise<unknown>)({
            projectId: 'project-1',
            anchor: { kind: 'file', filePath: 'src/a.ts' },
            snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
            body: 'Fix this.',
            authorIntent: 'propose',
            clientMutationId: 'mutation-1',
        })).resolves.toMatchObject({ comment: { id: 'comment-1' } });

        expect(readCredentialsMock).toHaveBeenCalled();
        expect(axiosPostMock).toHaveBeenCalledWith(
            expect.stringContaining('/v1/reviews/comments'),
            expect.objectContaining({ projectId: 'project-1', body: 'Fix this.' }),
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer review-token',
                    'x-happier-review-comment-principal': expect.any(String),
                }),
                validateStatus: expect.any(Function),
            }),
        );
    });

    it('binds ctx.reviews.comments to the host review-comment action adapter when provided', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let observedContext: unknown = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: unknown) => {
                            observedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend: vi.fn(() => ({
                                        provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                                        readResumeSupport: vi.fn(async () => false),
                                        sendPrompt: vi.fn(async () => undefined),
                                        cancel: vi.fn(async () => undefined),
                                        subscribeMessages: vi.fn(() => () => undefined),
                                        dispose: vi.fn(async () => undefined),
                                    })),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const executeReviewCommentAction = vi.fn(async (actionId: string, input: unknown) => ({
            comment: {
                v: 1,
                id: 'comment-1',
                accountId: 'account-1',
                projectId: 'project-1',
                anchor: { kind: 'file', filePath: 'src/a.ts' },
                snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
                body: 'Fix this.',
                bodyVersion: 1,
                edits: [],
                author: { kind: 'plugin', pluginId: 'acme.sample' },
                state: 'proposed',
                flags: {},
                dispositions: {},
                threadId: 'comment-1',
                transitions: [{
                    transitionId: 'transition-1',
                    toState: 'proposed',
                    transitionedAt: 1,
                    transitionedBy: { kind: 'plugin', pluginId: 'acme.sample' },
                    serverRevision: 1,
                }],
                createdAt: 1,
                updatedAt: 1,
                serverRevision: 1,
            },
        }));

        await resolveBackendEngineAdapterResolution('acme.sample.backend', {
            reviewCommentActionExecutor: executeReviewCommentAction,
        });

        const context = observedContext as ObservedPluginRuntimeContext;
        await expect((context.reviews?.comments?.create as (request: unknown) => Promise<unknown>)({
            projectId: 'project-1',
            anchor: { kind: 'file', filePath: 'src/a.ts' },
            snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
            body: 'Fix this.',
            authorIntent: 'propose',
            clientMutationId: 'mutation-1',
        })).resolves.toMatchObject({ comment: { id: 'comment-1' } });

        expect(executeReviewCommentAction).toHaveBeenCalledWith(
            'reviews.comments.create',
            expect.objectContaining({ projectId: 'project-1', body: 'Fix this.' }),
            expect.objectContaining({
                principal: {
                    actor: { kind: 'plugin', pluginId: 'acme.sample' },
                    grants: [],
                },
            }),
        );
    });

    it('does not resolve review snapshots from plugin supplied roots without a bound runtime scope', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        const unscopedRoot = await mkdtemp(join(tmpdir(), 'happier-review-unscoped-'));
        await mkdir(join(unscopedRoot, 'src'), { recursive: true });
        await writeFile(join(unscopedRoot, 'src', 'leak.ts'), 'secret\n', 'utf8');

        let observedContext: unknown = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: unknown) => {
                            observedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend: vi.fn(() => ({
                                        provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                                        readResumeSupport: vi.fn(async () => false),
                                        sendPrompt: vi.fn(async () => undefined),
                                        cancel: vi.fn(async () => undefined),
                                        subscribeMessages: vi.fn(() => () => undefined),
                                        dispose: vi.fn(async () => undefined),
                                    })),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        await resolveBackendEngineAdapterResolution('acme.sample.backend');

        const context = observedContext as ObservedPluginRuntimeContext & Readonly<{
            reviews?: Readonly<{
                comments?: Readonly<{
                    resolveSnapshot?: (request: unknown) => Promise<unknown>;
                }>;
            }>;
        }>;
        await expect(context.reviews?.comments?.resolveSnapshot?.({
            cwd: unscopedRoot,
            anchor: { kind: 'line', filePath: 'src/leak.ts', line: 1 },
        })).resolves.toBeNull();
    });

    it('resolves review snapshots from the bound execution-run root instead of a plugin supplied root', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        const boundRoot = await mkdtemp(join(tmpdir(), 'happier-review-bound-'));
        const requestedRoot = await mkdtemp(join(tmpdir(), 'happier-review-requested-'));
        await mkdir(join(boundRoot, 'src'), { recursive: true });
        await mkdir(join(requestedRoot, 'src'), { recursive: true });
        await writeFile(join(boundRoot, 'src', 'review.ts'), 'in scope\n', 'utf8');
        await writeFile(join(requestedRoot, 'src', 'review.ts'), 'out of scope\n', 'utf8');

        let observedContext: unknown = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: unknown) => {
                            observedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend: vi.fn(() => ({
                                        provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                                        readResumeSupport: vi.fn(async () => false),
                                        sendPrompt: vi.fn(async () => undefined),
                                        cancel: vi.fn(async () => undefined),
                                        subscribeMessages: vi.fn(() => () => undefined),
                                        dispose: vi.fn(async () => undefined),
                                    })),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: boundRoot,
            backendId: 'acme.sample.backend',
            permissionMode: 'default',
        });

        const context = observedContext as ObservedPluginRuntimeContext & Readonly<{
            reviews?: Readonly<{
                comments?: Readonly<{
                    resolveSnapshot?: (request: unknown) => Promise<unknown>;
                }>;
            }>;
        }>;
        await expect(context.reviews?.comments?.resolveSnapshot?.({
            cwd: requestedRoot,
            anchor: { kind: 'line', filePath: 'src/review.ts', line: 1 },
        })).resolves.toMatchObject({
            kind: 'text',
            selectedLines: ['in scope'],
        });
    });

    it('exposes trusted runtime grants as capabilities without sending review-comment grant claims', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let observedContext: unknown = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: unknown) => {
                            observedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend: vi.fn(() => ({
                                        provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                                        readResumeSupport: vi.fn(async () => false),
                                        sendPrompt: vi.fn(async () => undefined),
                                        cancel: vi.fn(async () => undefined),
                                        subscribeMessages: vi.fn(() => () => undefined),
                                        dispose: vi.fn(async () => undefined),
                                    })),
                                },
                            };
                        },
                    },
                }],
            ]),
            optionalPermissionDeclarationsByPluginId: new Map([
                ['acme.sample', [
                    { capability: 'reviews.comments.write.direct' },
                    { capability: 'secrets.write' },
                ]],
            ]),
            trustedOptionalPermissionsByPluginId: new Map([
                ['acme.sample', new Set(['reviews.comments.write.direct'])],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const executeReviewCommentAction = vi.fn(async () => ({
            comment: createReviewCommentFixture(),
        }));

        await resolveBackendEngineAdapterResolution('acme.sample.backend', {
            reviewCommentActionExecutor: executeReviewCommentAction,
        });

        const context = observedContext as ObservedPluginRuntimeContext;
        expect(context.permissions?.isGranted?.('reviews.comments.write.direct')).toBe(true);
        expect(context.permissions?.list?.()).toContain('reviews.comments.write.direct');
        await expect((context.reviews?.comments?.create as (request: unknown) => Promise<unknown>)({
            projectId: 'project-1',
            anchor: { kind: 'file', filePath: 'src/a.ts' },
            snapshot: { kind: 'too_large', filePath: 'src/a.ts', sizeBytes: 2, capBytes: 1, capturedAt: 1 },
            body: 'Fix this directly.',
            authorIntent: 'open',
            clientMutationId: 'mutation-direct-1',
        })).resolves.toMatchObject({ comment: { id: 'comment-1' } });

        expect(executeReviewCommentAction).toHaveBeenCalledWith(
            'reviews.comments.create',
            expect.objectContaining({ projectId: 'project-1', body: 'Fix this directly.' }),
            expect.objectContaining({
                principal: {
                    actor: { kind: 'plugin', pluginId: 'acme.sample' },
                    grants: [],
                },
            }),
        );
    });

    it('binds backend-engine ctx.events subscriptions to plugin runtime disposal', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        const runtimeDisposables: unknown[] = [];
        let observedContext: unknown = null;

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: unknown) => {
                            observedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend: vi.fn(() => ({
                                        provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                                        readResumeSupport: vi.fn(async () => false),
                                        sendPrompt: vi.fn(async () => undefined),
                                        cancel: vi.fn(async () => undefined),
                                        subscribeMessages: vi.fn(() => () => undefined),
                                        dispose: vi.fn(async () => undefined),
                                    })),
                                },
                            };
                        },
                    },
                }],
            ]),
            eventDeclarationsByPluginId: new Map([
                ['acme.sample', []],
            ]),
            eventSubscriptionPermissionsByPluginId: new Map([
                ['acme.sample', new Set(['events.runtime.subscribe'])],
            ]),
            permissionDeclarationsByPluginId: new Map(),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            addRuntimeDisposable: vi.fn((_pluginId: string, disposable: unknown) => {
                runtimeDisposables.push(disposable);
                return disposable;
            }),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        resolution?.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
        });

        const context = observedContext as ObservedPluginRuntimeContext;
        const listener = vi.fn();
        const subscribeRuntimeEvent = context.events?.subscribe as
            | ((eventName: string, listener: (event: unknown) => void) => Readonly<{ unsubscribe: () => void }>)
            | undefined;
        const subscription = subscribeRuntimeEvent?.('@happier/runtime/turn-start', listener);
        const eventSubscriptionDisposable = runtimeDisposables.find(
            (disposable): disposable is () => void => typeof disposable === 'function',
        );

        expect(subscription).toEqual(expect.objectContaining({ unsubscribe: expect.any(Function) }));
        expect(eventSubscriptionDisposable).toEqual(expect.any(Function));
        if (!eventSubscriptionDisposable) {
            throw new Error('Expected runtime event subscription disposable');
        }

        await publishRuntimePluginEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            turnId: 'turn-1',
            emittedAtMs: 1,
        });
        await vi.waitFor(() => {
            expect(listener).toHaveBeenCalledTimes(1);
        });

        eventSubscriptionDisposable();
        await publishRuntimePluginEvent({
            kind: 'turn-start',
            sessionId: 'session-1',
            turnId: 'turn-2',
            emittedAtMs: 2,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(listener).toHaveBeenCalledTimes(1);
        subscription?.unsubscribe();
    });

    it('passes schema-bearing event declarations into backend-engine ctx.events', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let observedContext: unknown = null;

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: unknown) => {
                            observedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend: vi.fn(() => ({
                                        provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                                        readResumeSupport: vi.fn(async () => false),
                                        sendPrompt: vi.fn(async () => undefined),
                                        cancel: vi.fn(async () => undefined),
                                        subscribeMessages: vi.fn(() => () => undefined),
                                        dispose: vi.fn(async () => undefined),
                                    })),
                                },
                            };
                        },
                    },
                }],
            ]),
            eventDeclarationsByPluginId: new Map([
                ['acme.sample', [
                    {
                        id: 'task-complete',
                        payloadSchema: {
                            type: 'object',
                            required: ['checkpointId'],
                            properties: {
                                checkpointId: { type: 'string' },
                            },
                        },
                    },
                ]],
            ]),
            eventSubscriptionPermissionsByPluginId: new Map(),
            permissionDeclarationsByPluginId: new Map(),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            addRuntimeDisposable: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        resolution?.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
        });

        const context = observedContext as ObservedPluginRuntimeContext;
        const emitEvent = context.events?.emit as
            | ((event: Readonly<{ id: string; payload: unknown }>) => Promise<void>)
            | undefined;

        await expect(emitEvent?.({
            id: 'task-complete',
            payload: { checkpointId: 'checkpoint-1' },
        })).resolves.toBeUndefined();
        await expect(emitEvent?.({
            id: 'task-complete',
            payload: {},
        })).rejects.toMatchObject({
            code: 'PLUGIN_EVENTS_INVALID_PAYLOAD',
        });
    });

    it('keeps plugin subagent access typed-unavailable in A.13 host session scope', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let observedContext: unknown = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: unknown) => {
                            observedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => createPluginSessionRuntimeFixture({ ok: true }),
                                    createExecutionRunBackend: vi.fn(),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime(createPluginSessionLaunchParams({ cwd: '/tmp/plugin' })) as Readonly<{
            config: Readonly<{
                createSessionRuntime: (params: unknown) => Promise<unknown>;
            }>;
        }>;
        await plan.config.createSessionRuntime({
            directory: '/tmp/plugin',
            metadata: {},
            machineId: 'machine-1',
            session: { sessionId: 'session-1' },
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        });

        const context = observedContext as ObservedPluginRuntimeContext;
        const subagents = context.sessions?.subagents as PluginSubagentsServiceV1;
        await expect(subagents.upsert({
            id: 'plugin-subagent-1',
            parentSessionId: 'session-1',
            origin: 'agent',
            kind: 'native',
            agentRef: { agentId: 'acme.sample' },
        })).rejects.toThrow(/unavailable/);

        await expect(subagents.list({ parentSessionId: 'session-2' })).resolves.toEqual([]);
        await expect(subagents.upsert({
            id: 'plugin-subagent-2',
            parentSessionId: 'session-2',
            origin: 'agent',
            kind: 'native',
            agentRef: { agentId: 'acme.sample' },
        })).rejects.toThrow(/unavailable/);
        expect(() => subagents.watch({ parentSessionId: 'session-2' }, vi.fn()).unsubscribe()).not.toThrow();
        await expect(subagents.complete({
            id: 'plugin-subagent-2',
            parentSessionId: 'session-2',
            status: 'completed',
        })).rejects.toThrow(/unavailable/);
    });

    it('hydrates plugin notification contributions into the plugin runtime context', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        const createExecutionRunBackend = vi.fn(() => ({
            provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
            readResumeSupport: vi.fn(async () => false),
            sendPrompt: vi.fn(async () => undefined),
            cancel: vi.fn(async () => undefined),
            subscribeMessages: vi.fn(() => () => undefined),
            dispose: vi.fn(async () => undefined),
        }));
        let observedContext: unknown = null;
        const baseContributes = await resolveMergedContributionRegistryMock();
        if (!isRecord(baseContributes)) {
            throw new Error('Expected mocked contribution registry to be an object');
        }
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: {
                ...baseContributes,
                notifications: [
                    {
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'acme.sample',
                        definition: {
                            id: 'acme.notifications.reviewReady',
                            kind: 'activity',
                            title: 'Review ready',
                            eventIds: ['ready'],
                            defaultChannelIds: ['acme.notifications.memory'],
                        },
                    },
                    {
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'acme.foreign',
                        definition: {
                            id: 'acme.foreign.reviewReady',
                            kind: 'activity',
                            title: 'Foreign review ready',
                            eventIds: ['ready'],
                            defaultChannelIds: ['acme.foreign.memory'],
                        },
                    },
                ],
                notificationChannels: [
                    {
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'acme.sample',
                        definition: {
                            id: 'acme.notifications.memory',
                            kind: 'plugin',
                            title: 'Memory channel',
                        },
                    },
                    {
                        provenance: 'external',
                        source: { kind: 'path' },
                        pluginId: 'acme.foreign',
                        definition: {
                            id: 'acme.foreign.memory',
                            kind: 'plugin',
                            title: 'Foreign memory channel',
                        },
                    },
                ],
            },
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: unknown) => {
                            observedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => null,
                                    createExecutionRunBackend,
                                },
                            };
                        },
                    },
                }],
            ]),
            notificationCategoriesById: new Map(),
            notificationChannelsById: new Map([
                ['acme.notifications.memory', {
                    pluginId: 'acme.sample',
                    registration: {
                        id: 'acme.notifications.memory',
                        kind: 'plugin',
                        title: 'Memory channel',
                        send: async () => ({ delivered: true }),
                    },
                }],
                ['acme.foreign.memory', {
                    pluginId: 'acme.foreign',
                    registration: {
                        id: 'acme.foreign.memory',
                        kind: 'plugin',
                        title: 'Foreign memory channel',
                        send: async () => ({ delivered: true }),
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
        });

        const context = observedContext as ObservedPluginRuntimeContext;
        const notifications = context.notifications as Readonly<{
            listCategories: () => Promise<readonly Readonly<{ id: string }>[]>;
            listChannels: () => Promise<readonly Readonly<{ id: string }>[]>;
        }>;

        const categories = await notifications.listCategories();
        const channels = await notifications.listChannels();

        expect(categories).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'acme.notifications.reviewReady' }),
        ]));
        expect(categories).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'acme.foreign.reviewReady' }),
        ]));
        expect(channels).toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'acme.notifications.memory' }),
        ]));
        expect(channels).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ id: 'acme.foreign.memory' }),
        ]));
    });

    it('publishes declared executable surfaces returned by plugin backend engines', async () => {
        const launch = vi.fn(async () => ({ ok: true }));
        seedPluginRegistryWithoutRuntimeCore({
            surfaceHandlers: [{
                surfaceApiVersion: 1,
                id: 'terminal-launch',
                kind: 'terminalRuntime',
                operation: 'launch',
                support: 'supported',
                handler: {
                    target: 'daemon',
                    exportName: 'launchTerminal',
                },
            }],
        });
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async () => ({
                            runtimeCore: {
                                createSessionRuntime: async () => null,
                                createExecutionRunBackend: vi.fn(),
                            },
                            terminalRuntimeSurface: {
                                launch,
                            },
                        }),
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');

        expect(resolution?.diagnostics).toEqual([]);
        const resolvedLaunch = resolution?.executionSurfaces.terminalRuntime?.launch;
        expect(resolvedLaunch).toEqual(expect.any(Function));
        expect(resolvedLaunch).not.toBe(launch);
        await expect(resolvedLaunch?.({
            sessionId: '',
            metadata: {},
            directory: '/tmp/plugin',
        })).resolves.toEqual({ ok: true });
        expect(launch).toHaveBeenCalledWith(expect.objectContaining({
            directory: '/tmp/plugin',
        }));
    });

    it('fails closed when plugin backend engines return undeclared executable surface operations', async () => {
        const launch = vi.fn(async () => ({ ok: true }));
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async () => ({
                            runtimeCore: {
                                createSessionRuntime: async () => null,
                                createExecutionRunBackend: vi.fn(),
                            },
                            terminalRuntimeSurface: {
                                launch,
                            },
                        }),
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');

        expect(resolution?.executionSurfaces.terminalRuntime).toBeNull();
        expect(resolution?.diagnostics).toEqual([
            expect.objectContaining({
                code: 'engine_plugin_backend_surface_static_mismatch',
                message: expect.stringMatching(/terminalRuntime:launch.*not declared/i),
            }),
        ]);
    });

    it('normalizes ACP-marked plugin backend engines through the host ACP runtime definition substrate', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: AcpDefinitionContextForTest) => ctx.agentRuntime.acp.defineAcpBackend({
                            backendId: 'acme.sample.backend',
                            transport: {
                                kind: 'stdio',
                                launch: {
                                    kind: 'executable',
                                    command: 'acme-agent',
                                    args: ['acp'],
                                },
                            },
                            ux: {
                                title: 'Acme Agent',
                            },
                            mcp: {
                                policy: 'drop',
                            },
                        }),
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            activatePluginsByEvent: vi.fn(async () => []),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        expect(resolution?.backendId).toBe('acme.sample.backend');

        const runtime = resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
        });

        expect(runtime).toMatchObject({
            provisionSession: expect.any(Function),
            readResumeSupport: expect.any(Function),
            sendPrompt: expect.any(Function),
            cancel: expect.any(Function),
            subscribeMessages: expect.any(Function),
            dispose: expect.any(Function),
        });
        expect(getExecutionRunBackendDescriptorMock).not.toHaveBeenCalled();
    });

    it('resolves manifest-only ACP backend engines without activation registration', async () => {
        const registry = seedManifestOnlyAcpPluginRegistry();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue(createLeaseRuntimeRegistry(registry));

        const resolution = await resolveBackendEngineAdapterResolution('acme.manifest.acp');
        expect(resolution?.backendId).toBe('acme.manifest.acp');

        expect(() => resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            backendId: 'acme.manifest.acp',
            permissionMode: 'read_only',
        })).not.toThrow();
        expect(getExecutionRunBackendDescriptorMock).not.toHaveBeenCalled();
    });

    it('reports invalid manifest-only ACP backend definitions instead of hiding them as missing runtimeCore', async () => {
        const invalidBackendDefinition = {
            kindVersion: 1,
            id: 'acme.manifest.acp',
            agentId: 'acme.manifest.provider',
            runtimeKind: 'acp',
            acp: {
                command: 'legacy-acp-agent',
            },
            capabilities: {},
            surfaceHandlers: [],
        };
        const registry = seedManifestOnlyAcpPluginRegistry({
            backendDefinition: invalidBackendDefinition,
        });

        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue(createLeaseRuntimeRegistry(registry));

        await expect(resolveBackendEngineAdapterResolution('acme.manifest.acp'))
            .rejects
            .toThrow(/Invalid manifest-only ACP backend 'acme\.manifest\.acp'/);
        expect(getExecutionRunBackendDescriptorMock).not.toHaveBeenCalled();
    });

    it('fails closed for execution-run permission requests that would require an interactive response', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let permissionDecisionPromise: Promise<unknown> | null = null;

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: PermissionContextForTest) => ({
                            runtimeCore: {
                                createSessionRuntime: async () => null,
                                createExecutionRunBackend: () => {
                                    permissionDecisionPromise = ctx.sessions.current.permissions.requestDecision({
                                        toolCallId: 'tool-1',
                                        toolName: 'write_file',
                                        input: { path: '/tmp/a', content: 'hello' },
                                    });
                                    return {
                                        provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
                                        readResumeSupport: vi.fn(async () => false),
                                        sendPrompt: vi.fn(async () => undefined),
                                        cancel: vi.fn(async () => undefined),
                                        subscribeMessages: vi.fn(() => () => undefined),
                                        dispose: vi.fn(async () => undefined),
                                    };
                                },
                            },
                        }),
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            activatePluginsByEvent: vi.fn(async () => []),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        expect(resolution?.backendId).toBe('acme.sample.backend');

        resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            backendId: 'acme.sample.backend',
            permissionMode: 'safe-yolo',
        });

        expect(permissionDecisionPromise).not.toBeNull();
        await expect(permissionDecisionPromise).resolves.toMatchObject({ decision: 'denied' });
    });

    it('resolves OpenCode backend runtimeCore and execution-run backend through the extracted plugin engine', async () => {
        seedFirstPartyOpenCodeRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        const activate = await loadOpenCodeExtensionActivate();
        const host = createPluginApiHost({ runtimeCapabilities: ['agents'] });
        await activate(host.api);
        const registrations = host.registrations();
        expect(registrations.agentRuntimes.map((engine) => engine.agentId)).toEqual(['opencode']);

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['opencode', {
                    pluginId: '@happier-dev/plugins-opencode',
                    registration: registrations.agentRuntimes[0],
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            activatePluginsByEvent: vi.fn(async () => []),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('opencode');
        expect(resolution?.backendId).toBe('opencode');

        const executionRunBackend = resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: process.cwd(),
            backendId: 'opencode',
            permissionMode: 'read_only',
        });
        expect(executionRunBackend).toMatchObject({
            provisionSession: expect.any(Function),
            readResumeSupport: expect.any(Function),
            sendPrompt: expect.any(Function),
            cancel: expect.any(Function),
            dispose: expect.any(Function),
        });
        expect(getExecutionRunBackendDescriptorMock).not.toHaveBeenCalled();
    });

    it('binds PluginContextV1 session-scoped services when plugin engine createSessionRuntime plan is executed', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');

        const artifactsRoot = mkdtempSync(join(tmpdir(), 'happier-extension-artifacts-'));
        const prevDebugArtifactsDir = process.env.HAPPIER_DEBUG_ARTIFACTS_DIR;
        const prevExtensionArtifactsEnabled = process.env.HAPPIER_EXTENSION_ARTIFACTS_ENABLED;
        const prevExtensionTelemetryEnabled = process.env.HAPPIER_EXTENSION_TELEMETRY_ENABLED;
        process.env.HAPPIER_DEBUG_ARTIFACTS_DIR = artifactsRoot;
        process.env.HAPPIER_EXTENSION_ARTIFACTS_ENABLED = '1';
        process.env.HAPPIER_EXTENSION_TELEMETRY_ENABLED = '1';

        const metadataUpdates: unknown[] = [];
        const enqueuedRegisteredSessionStateFieldMutations: unknown[] = [];
        const fakeDurableMutationOutbox = {
            enqueueRegisteredSessionStateFieldMutation: vi.fn(async (mutation: unknown) => {
                enqueuedRegisteredSessionStateFieldMutations.push(mutation);
            }),
        };
        const fakeSession = {
            sessionId: 'session-1',
            sendUserTextMessage: vi.fn(),
            sendProviderMessage: vi.fn(),
            updateRuntimeActivityProjection: vi.fn(async () => undefined),
            enqueueRegisteredSessionStateFieldMutation: async function (
                this: { durableMutationOutbox: typeof fakeDurableMutationOutbox },
                mutation: unknown,
            ) {
                await this.durableMutationOutbox.enqueueRegisteredSessionStateFieldMutation(mutation);
            },
            durableMutationOutbox: fakeDurableMutationOutbox,
            updateMetadata: vi.fn(async (handler: (metadata: Record<string, unknown>) => unknown) => {
                metadataUpdates.push(handler({
                    existing: true,
                    summary: { text: 'keep title', updatedAt: 1 },
                    permissionMode: 'ask',
                    permissionModeUpdatedAt: 2,
                }));
            }),
            updateAgentState: vi.fn(async (handler: (agentState: Record<string, unknown>) => unknown) => {
                handler({ existing: true });
            }),
        };

        const fakeTranscriptSession = {
            sendAgentMessageCommitted: vi.fn(async () => undefined),
            enqueueAgentMessageCommitted: vi.fn(async () => ({ persisted: true as const, delivered: false })),
            sendAgentMessageEphemeral: vi.fn(async () => undefined),
            sendAgentMessage: vi.fn(() => undefined),
        };

        const fakePermissionHandler = {
            handleToolCall: vi.fn(async () => ({ decision: 'approved' })),
        };

        const createExecutionRunBackend = vi.fn(() => ({
            provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
            readResumeSupport: vi.fn(async () => false),
            sendPrompt: vi.fn(async () => undefined),
            cancel: vi.fn(async () => undefined),
            subscribeMessages: vi.fn(() => () => undefined),
            dispose: vi.fn(async () => undefined),
        }));

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => ({
                            runtimeCore: {
                                createSessionRuntime: async () => {
                                    await ctx.sessions.writeMetadata({
                                        kind: 'set',
                                        metadata: { hello: 'world' },
                                    });
                                    await ctx.sessions.writeMetadata({
                                        kind: 'update',
                                        handler: (metadata: unknown) => ({
                                            ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata)
                                                ? metadata as Record<string, unknown>
                                                : {}),
                                            sessionWorkStateV1: {
                                                v: 1,
                                                backendId: 'acme.sample.backend',
                                                updatedAt: 123,
                                                items: [],
                                            },
                                        }),
                                    });
                                    await ctx.sessions.writeStateField({
                                        fieldId: 'runtime.workState',
                                        value: {
                                            v: 1,
                                            backendId: 'acme.sample.backend',
                                            updatedAt: 456,
                                            items: [],
                                        },
                                        reason: 'test-runtime-work-state',
                                    });
                                    await ctx.sessions.writeStateField({
                                        fieldId: 'identity.providerSessionId',
                                        value: {
                                            metadataKey: 'opencodeSessionId',
                                            value: 'provider-session-1',
                                        },
                                        reason: 'test-provider-session-id',
                                    });
                                    await ctx.sessions.writeStateField({
                                        fieldId: 'runtime.activity',
                                        value: {
                                            v: 1,
                                            activeCount: 1,
                                            observedAtMs: 100,
                                            expiresAtMs: 200,
                                            sourceClass: 'provider_detached_task',
                                        },
                                        reason: 'test-runtime-activity',
                                    });
                                    await ctx.sessions.writeAgentState({
                                        kind: 'set',
                                        agentState: { hello: 'world' },
                                    });
                                    ctx.experimental.telemetry.emit({ kind: 'test_usage', n: 1 });
                                    await ctx.experimental.artifacts.write({ kind: 'test_artifact', text: 'hello' });
                                    await ctx.sessions.current.permissions.requestDecision({
                                        toolCallId: 'tool-1',
                                        toolName: 'read_file',
                                        input: { path: '/tmp/a' },
                                    });
                                    await ctx.agentRuntime.transcripts.append({
                                        kind: 'agentMessageCommitted',
                                        provider: 'acme',
                                        body: { type: 'assistant', text: 'hi' },
                                        localId: 'local-1',
                                    });
                                    await ctx.sessions.send({
                                        kind: 'providerDispatch',
                                        body: {
                                            type: 'tool-call',
                                            callId: 'tool-1',
                                            name: 'read_file',
                                            input: { path: 'README.md' },
                                        },
                                        meta: { source: 'test' },
                                    });
                                    await ctx.agentRuntime.accountUsage.recordSnapshot({
                                        snapshot: createProviderAccountUsageSnapshotForTest(),
                                    });
                                    return createTestSessionRuntime('s1');
                                },
                                createExecutionRunBackend,
                            },
                        }),
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        expect(resolution?.backendId).toBe('acme.sample.backend');

        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime(createPluginSessionLaunchParams({ cwd: '/tmp/plugin' })) as HostSessionRuntimePlanForTest;
        try {
            await expect(plan.config.createSessionRuntime({
                directory: '/tmp/plugin',
                metadata: {},
                machineId: 'm1',
                session: fakeSession,
                transcriptSession: fakeTranscriptSession,
                messageBuffer: {},
                mcpServers: {},
                permissionHandler: fakePermissionHandler,
                getPermissionMode: () => 'read_only',
                setThinking: () => undefined,
                memoryRecallGuidanceEnabled: false,
            })).resolves.toEqual(expect.any(Object));

            expect(fakeSession.updateMetadata).toHaveBeenCalledTimes(2);
            expect(metadataUpdates[0]).toEqual({
                hello: 'world',
                summary: { text: 'keep title', updatedAt: 1 },
                permissionMode: 'ask',
                permissionModeUpdatedAt: 2,
            });
            expect(metadataUpdates[1]).toEqual({
                existing: true,
                summary: { text: 'keep title', updatedAt: 1 },
                permissionMode: 'ask',
                permissionModeUpdatedAt: 2,
            });
            expect(fakeDurableMutationOutbox.enqueueRegisteredSessionStateFieldMutation).toHaveBeenCalledWith(expect.objectContaining({
                fieldId: 'runtime.workState',
                deliveryClass: 'durable_required',
                source: 'runtime',
                op: expect.objectContaining({
                    kind: 'set',
                    value: expect.objectContaining({
                        backendId: 'acme.sample.backend',
                    }),
                }),
            }));
            expect(fakeDurableMutationOutbox.enqueueRegisteredSessionStateFieldMutation).toHaveBeenCalledWith(expect.objectContaining({
                fieldId: 'runtime.workState',
                deliveryClass: 'durable_required',
                source: 'runtime',
                op: expect.objectContaining({
                    kind: 'set',
                    value: expect.objectContaining({
                        backendId: 'acme.sample.backend',
                        updatedAt: 456,
                    }),
                }),
            }));
            expect(fakeDurableMutationOutbox.enqueueRegisteredSessionStateFieldMutation).toHaveBeenCalledWith(expect.objectContaining({
                fieldId: 'identity.providerSessionId',
                deliveryClass: 'durable_best_effort',
                source: 'runtime',
                op: {
                    kind: 'set',
                    value: {
                        metadataKey: 'opencodeSessionId',
                        value: 'provider-session-1',
                    },
                },
            }));
            expect(fakeDurableMutationOutbox.enqueueRegisteredSessionStateFieldMutation).toHaveBeenCalledWith(expect.objectContaining({
                fieldId: 'runtime.activity',
                deliveryClass: 'durable_best_effort',
                source: 'runtime',
                op: {
                    kind: 'set',
                    value: {
                        v: 1,
                        activeCount: 1,
                        observedAtMs: 100,
                        expiresAtMs: 200,
                        sourceClass: 'provider_detached_task',
                    },
                },
            }));
            expect(enqueuedRegisteredSessionStateFieldMutations).toHaveLength(4);
            expect(fakeSession.updateRuntimeActivityProjection).not.toHaveBeenCalled();
            expect(fakeSession.updateAgentState).toHaveBeenCalledTimes(1);
            expect(fakePermissionHandler.handleToolCall).toHaveBeenCalledTimes(1);
            expect(fakeTranscriptSession.sendAgentMessageCommitted).not.toHaveBeenCalled();
            expect(fakeTranscriptSession.enqueueAgentMessageCommitted).toHaveBeenCalledTimes(1);
            expect(fakeSession.sendProviderMessage).toHaveBeenCalledWith({
                body: {
                    type: 'tool-call',
                    callId: 'tool-1',
                    name: 'read_file',
                    input: { path: 'README.md' },
                },
                meta: { source: 'test' },
            });
            expect(notifyDaemonProviderAccountUsageSnapshotMock).toHaveBeenCalledWith({
                sessionId: 'session-1',
                snapshot: expect.objectContaining({
                    providerId: 'openai-codex',
                    accountSubject: { kind: 'providerSubject', id: 'acct_123' },
                }),
            });

            const artifactsPath = join(artifactsRoot, 'plugins', 'acme.sample.backend', 'extension-artifacts.jsonl');
            const telemetryPath = join(artifactsRoot, 'plugins', 'acme.sample.backend', 'extension-telemetry.jsonl');
            expect(readFileSync(artifactsPath, 'utf8')).toContain('test_artifact');
            expect(readFileSync(telemetryPath, 'utf8')).toContain('test_usage');
        } finally {
            if (prevDebugArtifactsDir === undefined) {
                delete process.env.HAPPIER_DEBUG_ARTIFACTS_DIR;
            } else {
                process.env.HAPPIER_DEBUG_ARTIFACTS_DIR = prevDebugArtifactsDir;
            }
            if (prevExtensionArtifactsEnabled === undefined) {
                delete process.env.HAPPIER_EXTENSION_ARTIFACTS_ENABLED;
            } else {
                process.env.HAPPIER_EXTENSION_ARTIFACTS_ENABLED = prevExtensionArtifactsEnabled;
            }
            if (prevExtensionTelemetryEnabled === undefined) {
                delete process.env.HAPPIER_EXTENSION_TELEMETRY_ENABLED;
            } else {
                process.env.HAPPIER_EXTENSION_TELEMETRY_ENABLED = prevExtensionTelemetryEnabled;
            }
            rmSync(artifactsRoot, { recursive: true, force: true });
        }
    });

    it('requires plugin-authored userText session sends to provide stable localIds', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        const sessionSendResults: unknown[] = [];
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => ({
                            runtimeCore: {
                                createSessionRuntime: async () => {
                                    sessionSendResults.push(await ctx.sessions.send({
                                        kind: 'userText',
                                        text: 'missing local id',
                                    }));
                                    sessionSendResults.push(await ctx.sessions.send({
                                        kind: 'userText',
                                        text: 'blank local id',
                                        opts: { localId: '   ' },
                                    }));
                                    await ctx.agentRuntime.transcripts.append({
                                        kind: 'userText',
                                        text: 'append missing local id',
                                    });
                                    await ctx.agentRuntime.transcripts.append({
                                        kind: 'userText',
                                        text: 'append blank local id',
                                        opts: { localId: '   ' },
                                    });
                                    sessionSendResults.push(await ctx.sessions.send({
                                        kind: 'userText',
                                        text: 'stable send',
                                        opts: {
                                            localId: 'plugin-user-1',
                                            meta: { source: 'provider-transcript' },
                                        },
                                    }));
                                    await ctx.agentRuntime.transcripts.append({
                                        kind: 'userText',
                                        text: 'stable append',
                                        opts: {
                                            localId: 'plugin-user-2',
                                        },
                                    });
                                    return createTestSessionRuntime('s1');
                                },
                                createExecutionRunBackend: vi.fn(),
                            },
                        }),
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const fakeSession = {
            sessionId: 'session-1',
            sendUserTextMessage: vi.fn(),
            updateMetadata: vi.fn(async () => undefined),
            updateAgentState: vi.fn(async () => undefined),
        };

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime(
            createPluginSessionLaunchParams({ cwd: '/tmp/plugin' }),
        ) as HostSessionRuntimePlanForTest;

        await expect(plan.config.createSessionRuntime({
            directory: '/tmp/plugin',
            metadata: {},
            machineId: 'm1',
            session: fakeSession,
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'read_only',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        })).resolves.toEqual(expect.any(Object));

        expect(sessionSendResults).toEqual([
            { ok: false, error: 'invalid_request' },
            { ok: false, error: 'invalid_request' },
            { ok: true },
        ]);
        expect(fakeSession.sendUserTextMessage).toHaveBeenCalledTimes(2);
        expect(fakeSession.sendUserTextMessage).toHaveBeenNthCalledWith(1, 'stable send', {
            localId: 'plugin-user-1',
            meta: { source: 'provider-transcript' },
        });
        expect(fakeSession.sendUserTextMessage).toHaveBeenNthCalledWith(2, 'stable append', {
            localId: 'plugin-user-2',
        });
    });

    it('falls back to metadata for durable best-effort plugin session fields when the host session has no registered-field outbox', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let capturedMetadata: unknown = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => ({
                            runtimeCore: {
                                createSessionRuntime: async () => {
                                    await ctx.sessions.writeStateField({
                                        fieldId: 'identity.providerSessionId',
                                        value: {
                                            metadataKey: 'opencodeSessionId',
                                            value: 'provider-session-1',
                                        },
                                        reason: 'test-provider-session-id',
                                    });
                                    return createTestSessionRuntime('s1');
                                },
                                createExecutionRunBackend: vi.fn(),
                            },
                        }),
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const fakeSession = {
            sessionId: 'session-1',
            updateMetadata: vi.fn(async (handler: (metadata: Record<string, unknown>) => unknown) => {
                capturedMetadata = handler({});
            }),
        };

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime(createPluginSessionLaunchParams({ cwd: '/tmp/plugin' })) as HostSessionRuntimePlanForTest;

        await expect(plan.config.createSessionRuntime({
            directory: '/tmp/plugin',
            metadata: {},
            machineId: 'm1',
            session: fakeSession,
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'read_only',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        })).resolves.toEqual(expect.any(Object));

        expect(fakeSession.updateMetadata).toHaveBeenCalledTimes(1);
        expect(capturedMetadata).toEqual({
            opencodeSessionId: 'provider-session-1',
        });
    });

    it('passes a daemon local-services bridge into plugin session runtime contexts when available', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        const declaration = {
            id: 'web',
            launch: { kind: 'binary', executablePath: '/bin/sh', args: ['-lc', 'npm run dev'] },
            launchMode: { kind: 'detectAfterLaunch', minimumConfidence: 'medium' },
            hostPolicy: { kind: 'loopback' },
            name: { strategy: 'derived', base: 'web' },
            healthCheck: { kind: 'none' },
            restart: { kind: 'never' },
            cleanup: { staleAfterMs: 30_000 },
        } as const;
        const createPluginLocalServicesBridge = vi.fn((_context: Readonly<{
            pluginId: string;
            contributionId: string;
            sessionId: string;
            title: string;
        }>) => ({
            declare: vi.fn(async (serviceDeclaration: typeof declaration) => ({
                id: serviceDeclaration.id,
                phase: 'stopped' as const,
                diagnostics: [],
            })),
            start: vi.fn(async (serviceDeclaration: typeof declaration) => ({
                id: serviceDeclaration.id,
                phase: 'running' as const,
                inventoryId: 'machine-a:tcp:loopback:127.0.0.1:5173:pid-400',
                port: 5173,
                url: 'https://preview.happier.test/v1/local-services/preview/plugin-managed%3Aacme.sample%3Aacme.sample.backend%3Aweb/',
                diagnostics: [],
            })),
        }));
        const localServicesRuntime = {
            createPluginLocalServicesBridge,
        };
        let observedSnapshot: unknown = null;

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: PluginContextV1) => ({
                            runtimeCore: {
                                createSessionRuntime: async () => {
                                    await ctx.localServices.declare(declaration);
                                    const handle = await ctx.localServices.start('web');
                                    observedSnapshot = handle.snapshot();
                                    return createTestSessionRuntime('s-local-services');
                                },
                                createExecutionRunBackend: vi.fn(),
                            },
                        }),
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend', {
            localServicesRuntime,
        });
        expect(resolution?.backendId).toBe('acme.sample.backend');

        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime(
            createPluginSessionLaunchParams({ cwd: '/tmp/plugin' }),
        ) as HostSessionRuntimePlanForTest;
        await plan.config.createSessionRuntime({
            directory: '/tmp/plugin',
            metadata: {},
            machineId: 'machine-a',
            session: {
                sessionId: 'session-local-services',
                getMetadataSnapshot: () => ({
                    title: 'Preview Session',
                }),
                getAgentStateSnapshot: () => ({}),
            },
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        });

        expect(createPluginLocalServicesBridge).toHaveBeenCalledWith({
            pluginId: 'acme.sample',
            contributionId: 'acme.sample.backend',
            sessionId: 'session-local-services',
            title: 'Preview Session',
        });
        expect(observedSnapshot).toEqual({
            id: 'web',
            phase: 'running',
            inventoryId: 'machine-a:tcp:loopback:127.0.0.1:5173:pid-400',
            port: 5173,
            url: 'https://preview.happier.test/v1/local-services/preview/plugin-managed%3Aacme.sample%3Aacme.sample.backend%3Aweb/',
            diagnostics: [],
        });
    });

    it('grants trusted session hook transcript paths to plugin file-follow at session runtime scope', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        const transcriptDir = await mkdtemp(join(tmpdir(), 'happier-plugin-context-transcript-'));
        const transcriptPath = join(transcriptDir, 'provider-session.jsonl');
        await writeFile(transcriptPath, '{"kind":"ready"}\n', 'utf8');

        let hookServer: Awaited<ReturnType<SessionScopedContextForTest['agentRuntime']['sessionHooks']['startServer']>> | null = null;
        const cleanupFns: Array<() => void> = [];
        let followError: unknown = null;
        const followedLines: string[] = [];
        let capturedContext: SessionScopedContextForTest | null = null;

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            runtimeCapabilitiesByPluginId: new Map([
                ['acme.sample', new Set(['sessionHooks'])],
            ]),
            requiredPermissionsByPluginId: new Map([
                ['acme.sample', new Set(['session.hooks.control'])],
            ]),
            permissionsByPluginId: new Map([
                ['acme.sample', new Set(['session.hooks.control'])],
            ]),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            capturedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => {
                                        hookServer = await ctx.agentRuntime.sessionHooks.startServer({
                                            providerId: 'claude',
                                            sessionId: 'happy-session-grant',
                                            sessionHookSecret: 'trusted-session-hook-secret',
                                            onSessionHook: async (_providerSessionId: string, data: Record<string, unknown>) => {
                                                try {
                                                    const handle = await ctx.agentRuntime.transcripts.fileFollow.follow({
                                                        path: String(data.transcript_path),
                                                        startAt: 'beginning',
                                                        onLine: (line) => {
                                                            followedLines.push(line.line);
                                                        },
                                                    });
                                                    await handle.drainNow();
                                                    await handle.close();
                                                } catch (error) {
                                                    followError = error;
                                                }
                                            },
                                        });
                                        const serverToStop = hookServer;
                                        cleanupFns.push(() => serverToStop.stop());
                                        return {
                                            ...createTestSessionRuntime('provider-session-1'),
                                            resetOrDisposeRuntime: async () => {
                                                for (const cleanup of cleanupFns.splice(0)) {
                                                    cleanup();
                                                }
                                            },
                                        };
                                    },
                                    createExecutionRunBackend: vi.fn(),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime(createPluginSessionLaunchParams({ cwd: '/tmp/plugin' })) as HostSessionRuntimePlanForTest;
        try {
            const runtime = await plan.config.createSessionRuntime({
                directory: '/tmp/plugin',
                metadata: {},
                machineId: 'm1',
                session: { sessionId: 'happy-session-grant' },
                transcriptSession: {},
                messageBuffer: {},
                mcpServers: {},
                permissionHandler: { handleToolCall: vi.fn(async () => ({ decision: 'approved' })) },
                getPermissionMode: () => 'read_only',
                setThinking: () => undefined,
                memoryRecallGuidanceEnabled: false,
            });

            expect(hookServer).not.toBeNull();
            await expect(postSessionHook({
                port: hookServer!.port,
                body: {
                    hook_event_name: 'SessionStart',
                    session_id: 'provider-session-1',
                    transcript_path: transcriptPath,
                },
                sessionHookSecret: 'trusted-session-hook-secret',
            })).resolves.toEqual({ status: 200, text: 'ok' });

            expect(followError).toBeNull();
            expect(followedLines).toEqual(['{"kind":"ready"}']);
            await (runtime as Readonly<{
                operations: Readonly<{ resetOrDisposeRuntime(): Promise<void> }>;
            }>).operations.resetOrDisposeRuntime();
            await expect(capturedContext!.agentRuntime.transcripts.fileFollow.follow({
                path: transcriptPath,
                startAt: 'beginning',
                onLine: () => undefined,
            })).rejects.toMatchObject({
                code: 'PLUGIN_TRANSCRIPTS_FILE_FOLLOW_PATH_DENIED',
            });
        } finally {
            for (const cleanup of cleanupFns.splice(0)) {
                cleanup();
            }
        }
    });

    it('injects plugin transcript file-follow and catalog-provided external-session host services into runtime context', async () => {
        const listViaChildHost = vi.fn(async () => ({
            candidates: [{ remoteSessionId: 'remote-from-catalog-adapter', title: 'Remote', updatedAtMs: 10 }],
            nextCursor: null,
        }));
        const pageOlder = vi.fn(async () => ({
            items: [{ id: 'msg-from-catalog-adapter', createdAtMs: 11, raw: { text: 'hello' } }],
            nextCursor: null,
            tailCursor: 'tail-from-catalog-adapter',
            hasMore: false,
            truncated: false,
        }));
        resolveExternalSessionRuntimeHostAdaptersMock.mockResolvedValue({
            candidateHosts: [{
                agentId: 'claude',
                listViaChildHost,
            }],
            transcriptStores: [{
                agentId: 'claude',
                withStore: async (_input: unknown, handler: (store: unknown) => Promise<unknown>) => await handler({
                    pageOlder,
                }),
                acquireStore: vi.fn(),
            }],
        });
        seedPluginRegistryWithoutRuntimeCore({
            surfaceHandlers: [
                createSurfaceHandler('externalSession', BackendSurfaceOperationCatalogV1.externalSession.listCandidates),
            ],
        });
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        const captured: {
            runtime?: unknown;
            context?: SessionScopedContextForTest;
        } = {};
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            captured.context = ctx;
                            return {
                                externalSessionSurface: {
                                    listCandidates: async (request: Readonly<{ runtime?: unknown }>) => {
                                        captured.runtime = request.runtime;
                                        const runtime = request.runtime as Readonly<{
                                            external?: Readonly<{
                                                candidates?: Readonly<{
                                                    listViaChildHost(input: Readonly<{
                                                        agentId: 'claude';
                                                        source: Readonly<{ kind: 'claudeConfig'; configDir: string }>;
                                                        limit: number;
                                                    }>): Promise<Readonly<{
                                                        candidates: readonly Readonly<{ remoteSessionId: string; title: string; updatedAtMs: number }>[];
                                                        nextCursor: string | null;
                                                    }>>;
                                                }>;
                                                transcripts?: Readonly<{
                                                    page(input: Readonly<{
                                                        agentId: 'claude';
                                                        source: Readonly<{ kind: 'claudeConfig'; configDir: string }>;
                                                        providerSessionId: string;
                                                        direction: 'older';
                                                        maxBytes: number;
                                                        maxItems: number;
                                                    }>): Promise<Readonly<{
                                                        items: readonly Readonly<{ id: string; createdAtMs: number; raw: Record<string, unknown> }>[];
                                                        nextCursor: string | null;
                                                        tailCursor: string | null;
                                                        hasMore: boolean;
                                                        truncated: boolean;
                                                    }>>;
                                                }>;
                                            }>;
                                        }>;
                                        const source = { kind: 'claudeConfig' as const, configDir: '/tmp/.claude' };
                                        const candidatePage = await runtime.external?.candidates?.listViaChildHost({
                                            agentId: 'claude',
                                            source,
                                            limit: 5,
                                        });
                                        const transcriptPage = await runtime.external?.transcripts?.page({
                                            agentId: 'claude',
                                            source,
                                            providerSessionId: 'remote-1',
                                            direction: 'older',
                                            maxBytes: 512,
                                            maxItems: 10,
                                        });
                                        return {
                                            ok: true as const,
                                            value: {
                                                candidates: candidatePage?.candidates ?? [],
                                                nextCursor: null,
                                                searchIncomplete: transcriptPage?.items[0]?.id !== 'msg-from-catalog-adapter',
                                            },
                                        };
                                    },
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');

        await expect(resolution?.executionSurfaces.externalSession?.listCandidates?.({
            source: { kind: 'codexHome', home: 'user' },
            limit: 5,
        })).resolves.toEqual({
            candidates: [{ remoteSessionId: 'remote-from-catalog-adapter', title: 'Remote', updatedAtMs: 10 }],
            nextCursor: null,
        });
        expect(resolveExternalSessionRuntimeHostAdaptersMock).toHaveBeenCalledWith({
            activeServerDir: configuration.activeServerDir,
            env: process.env,
        });
        expect(listViaChildHost).toHaveBeenCalledWith({
            agentId: 'claude',
            source: { kind: 'claudeConfig', configDir: '/tmp/.claude' },
            limit: 5,
        });
        expect(pageOlder).toHaveBeenCalledWith({
            direction: 'older',
            maxBytes: 512,
            maxItems: 10,
            allowProviderFallback: true,
        });
        expect(captured.context?.agentRuntime.transcripts.fileFollow).toEqual(expect.objectContaining({
            follow: expect.any(Function),
        }));
        expect(captured.runtime).toEqual(expect.objectContaining({
            transcripts: {
                fileFollow: captured.context!.agentRuntime.transcripts.fileFollow,
            },
            external: expect.objectContaining({
                candidates: expect.any(Object),
                transcripts: expect.any(Object),
            }),
        }));
    });

    it('routes session child host requests through MCP and runtime-auth services', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        const refreshActiveProfile = vi.fn(async () => ({ accessToken: 'fresh-access-token' }));
        getConnectedServiceRuntimeAuthAdapterMock.mockResolvedValue({
            classifyRuntimeAuthFailure: vi.fn(() => null),
            materializeActiveProfile: vi.fn(async () => ({ supported: true })),
            canHotApply: vi.fn(() => ({ supported: true })),
            hotApply: vi.fn(async () => ({ applied: true })),
            recoverAfterRuntimeAuthSwitch: vi.fn(async () => ({ recovered: true })),
            probeQuota: vi.fn(async () => ({ status: 'unsupported' })),
            refreshActiveProfile,
        });

        let capturedContext: SessionScopedContextForTest | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            capturedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => createPluginSessionRuntimeFixture(),
                                    createExecutionRunBackend: vi.fn(),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const fakeSession = {
            sessionId: 'session-1',
            sendUserTextMessage: vi.fn(),
            updateMetadata: vi.fn(),
            updateAgentState: vi.fn(),
        };
        const fakeTranscriptSession = {
            sendAgentMessageCommitted: vi.fn(),
            sendAgentMessageEphemeral: vi.fn(),
            sendAgentMessage: vi.fn(),
        };
        const fakePermissionHandler = {
            handleToolCall: vi.fn(async () => ({
                decision: 'approved',
                answers: { confirmation: 'yes' },
            })),
        };

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime(createPluginSessionLaunchParams({ cwd: '/tmp/plugin' })) as HostSessionRuntimePlanForTest;
        await plan.config.createSessionRuntime({
            directory: '/tmp/plugin',
            metadata: {},
            machineId: 'm1',
            session: fakeSession,
            transcriptSession: fakeTranscriptSession,
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: fakePermissionHandler,
            getPermissionMode: () => 'read_only',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        });

        await expect(capturedContext!.sessions.current.mcp.elicit({
            requestId: 'mcp-request-1',
            toolCallId: 'tool-call-1',
            serverName: 'happier',
            toolName: 'change_title',
            input: { title: 'New Title' },
        })).resolves.toEqual({
            status: 'accepted',
            decision: 'approved',
            content: { confirmation: 'yes' },
        });
        expect(fakePermissionHandler.handleToolCall).toHaveBeenCalledWith(
            'tool-call-1',
            'mcp__happier__change_title',
            { title: 'New Title' },
            {
                owner: {
                    kind: 'plugin',
                    pluginId: 'acme.sample',
                    runtimeId: expect.stringMatching(/^plugin-runtime:acme\.sample:/),
                },
            },
        );

        await expect(capturedContext!.sessions.current.auth.services.refreshRuntimeAuth({
            agentId: 'codex',
            serviceId: 'openai-codex',
            selection: { kind: 'profile', serviceId: 'openai-codex', profileId: 'work' },
            planType: 'plus',
            env: { CODEX_HOME: '/tmp/codex-home' },
        })).resolves.toEqual({
            status: 'refreshed',
            result: { accessToken: 'fresh-access-token' },
        });
        expect(getConnectedServiceRuntimeAuthAdapterMock).toHaveBeenCalledWith('codex');
        expect(refreshActiveProfile).toHaveBeenCalledWith({
            target: { agentId: 'codex' },
            selection: {
                kind: 'profile',
                serviceId: 'openai-codex',
                profileId: 'work',
                planType: 'plus',
            },
            env: { CODEX_HOME: '/tmp/codex-home' },
        });
    });

    it('returns typed unavailable auth refresh results when child requests lack a selection', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let capturedContext: SessionScopedContextForTest | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            capturedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => createPluginSessionRuntimeFixture(),
                                    createExecutionRunBackend: vi.fn(),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime(createPluginSessionLaunchParams({ cwd: '/tmp/plugin' })) as HostSessionRuntimePlanForTest;
        await plan.config.createSessionRuntime({
            directory: '/tmp/plugin',
            metadata: {},
            machineId: 'm1',
            session: {
                sessionId: 'session-1',
                sendUserTextMessage: vi.fn(),
                updateMetadata: vi.fn(),
                updateAgentState: vi.fn(),
            },
            transcriptSession: {
                sendAgentMessageCommitted: vi.fn(),
                sendAgentMessageEphemeral: vi.fn(),
                sendAgentMessage: vi.fn(),
            },
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: { handleToolCall: vi.fn() },
            getPermissionMode: () => 'read_only',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        });

        await expect(capturedContext!.sessions.current.auth.services.refreshRuntimeAuth({
            agentId: 'codex',
            serviceId: 'openai-codex',
        })).resolves.toEqual({
            status: 'unavailable',
            reason: 'runtime_auth_selection_unavailable',
        });
        expect(getConnectedServiceRuntimeAuthAdapterMock).not.toHaveBeenCalled();
    });

    it('injects A.11 persistence, event, and narrow auth services into plugin runtime context', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        setActiveAccountSettingsSnapshot({
            source: 'none',
            settings: accountSettingsParse({
                schemaVersion: 6,
                mcpServersSettingsV1: {
                    v: 1,
                    strictMode: false,
                    servers: [
                        {
                            id: 'docs-server',
                            name: 'docs',
                            title: 'Docs',
                            description: 'Docs server',
                            transport: 'http',
                            remote: {
                                url: 'https://mcp.example.test/http',
                                headers: {
                                    Authorization: { t: 'literal', v: 'Bearer secret-token' },
                                },
                            },
                            env: {
                                API_TOKEN: { t: 'literal', v: 'secret-env-value' },
                            },
                            createdAt: 1,
                            updatedAt: 1,
                        },
                        {
                            id: 'local-stdio-server',
                            name: 'local_stdio',
                            title: 'Local Stdio',
                            description: 'Local stdio server',
                            transport: 'stdio',
                            stdio: {
                                command: 'secret-managed-command',
                                args: ['--token', 'secret-managed-arg'],
                            },
                            env: {
                                STDIO_TOKEN: { t: 'literal', v: 'secret-stdio-env-value' },
                            },
                            createdAt: 1,
                            updatedAt: 1,
                        },
                    ],
                    bindings: [
                        {
                            id: 'binding-docs',
                            serverId: 'docs-server',
                            enabled: true,
                            target: {
                                t: 'workspace',
                                machineId: 'machine-1',
                                workspaceRoot: '/tmp/project',
                            },
                            createdAt: 1,
                            updatedAt: 1,
                        },
                        {
                            id: 'binding-local-stdio',
                            serverId: 'local-stdio-server',
                            enabled: true,
                            target: {
                                t: 'workspace',
                                machineId: 'machine-1',
                                workspaceRoot: '/tmp/project',
                            },
                            createdAt: 1,
                            updatedAt: 1,
                        },
                    ],
                },
            }),
            settingsVersion: 1,
            loadedAtMs: 1,
            settingsSecretsReadKeys: [],
            scopeKey: 'test-scope',
        });
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let observedContext: ObservedPluginRuntimeContext | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: ObservedPluginRuntimeContext) => {
                            observedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => createPluginSessionRuntimeFixture(),
                                    createExecutionRunBackend: vi.fn(),
                                },
                            };
                        },
                    },
                }],
            ]),
            runtimeOwnersByBackendId: new Map([
                ['acme.sample.backend', {
                    backendId: 'acme.sample.backend',
                    selected: {
                        kind: 'plugin_engine',
                        ownerId: 'acme.sample',
                        pluginId: 'acme.sample',
                        provenance: 'external',
                    },
                    candidates: [],
                }],
            ]),
            mcpServers: [
                {
                    pluginId: 'acme.sample',
                    registration: {
                        id: 'acme.sample.mcp',
                        name: 'sample-mcp',
                        title: 'Sample MCP',
                        transport: { kind: 'hosted' },
                    },
                },
                {
                    pluginId: 'acme.other',
                    registration: {
                        id: 'acme.other.mcp',
                        name: 'other-mcp',
                        transport: { kind: 'hosted' },
                    },
                },
            ],
            eventSubscriptionPermissionsByPluginId: new Map([
                ['acme.sample', new Set(['events.session.subscribe'])],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });
        getExecutionRunBackendDescriptorMock.mockReturnValueOnce(null);
        const authMaterializeAdapter = vi.fn(async () => ({
            env: { TOKEN: 'value' },
        }));

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend', {
            authMaterializeAdapter,
        });
        expect(resolution).toMatchObject({
            backendId: 'acme.sample.backend',
        });
        if (!resolution) {
            throw new Error('Expected plugin backend resolution');
        }
        const plan = await resolution.engineAdapter.runtimeCore.createSessionRuntime(createPluginSessionLaunchParams());
        const createSessionRuntime = plan.config.createSessionRuntime;
        if (!createSessionRuntime) {
            throw new Error('Expected plugin session runtime factory');
        }
        const sessionMetadata = {
            path: '/tmp/project',
            host: 'test-host',
            homeDir: '/tmp',
            happyHomeDir: '/tmp/.happier',
            happyLibDir: '/tmp/.happier/lib',
            happyToolsDir: '/tmp/.happier/tools',
        } satisfies Metadata;
        // The production binder only reads the ApiSessionClient snapshot methods used below.
        const runtimeParams = {
            directory: '/tmp/project',
            metadata: sessionMetadata,
            machineId: 'machine-1',
            session: {
                sessionId: 'session-1',
                getMetadataSnapshot: () => ({
                    mcpSelectionV1: {
                        v: 1,
                        managedServersEnabled: true,
                        forceIncludeServerIds: [],
                        forceExcludeServerIds: [],
                    },
                }),
                getAgentStateSnapshot: () => ({}),
            },
            transcriptSession: {},
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: {},
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        } as unknown as HostSessionRuntimeFactoryParams;
        await createSessionRuntime(runtimeParams);

        expect(observedContext).toMatchObject({
            storage: {
                ephemeral: expect.any(Object),
                session: expect.any(Object),
                local: expect.any(Object),
                synced: expect.any(Object),
            },
            settings: {
                get: expect.any(Function),
                set: expect.any(Function),
                onChange: expect.any(Function),
                describeFields: expect.any(Function),
                projectForm: expect.any(Function),
            },
            secrets: {
                get: expect.any(Function),
                set: expect.any(Function),
                delete: expect.any(Function),
                list: expect.any(Function),
            },
            events: {
                emit: expect.any(Function),
                subscribe: expect.any(Function),
            },
            auth: {
                getIdentity: expect.any(Function),
                onChange: expect.any(Function),
                services: {
                    materialize: expect.any(Function),
                },
            },
            actions: {
                scm: {
                    diffSummary: {
                        generate: expect.any(Function),
                    },
                },
            },
            agentRuntime: {
                terminalHost: {
                    resolve: expect.any(Function),
                    createOrAttachHost: expect.any(Function),
                    injectUserPrompt: expect.any(Function),
                },
            },
        });
        const context = observedContext as unknown as ObservedPluginRuntimeContext;
        expect('getConnectedServices' in (context.auth ?? {})).toBe(false);
        expect('startConnect' in (context.auth ?? {})).toBe(false);
        expect('disconnect' in (context.auth ?? {})).toBe(false);

        const sessionListener = vi.fn();
        expect(() => (
            context.events?.subscribe as (eventName: string, listener: (event: unknown) => void) => { unsubscribe: () => void }
        )('@happier/session/ready', sessionListener)).not.toThrow();

        await expect((context.auth?.services?.materialize as (request: unknown) => Promise<unknown>)({
            serviceId: 'openai-codex',
            profileId: 'default',
        })).resolves.toEqual({ env: { TOKEN: 'value' } });
        expect(authMaterializeAdapter).toHaveBeenCalledWith({
            serviceId: 'openai-codex',
            profileId: 'default',
        });

        const listMcpServers = context.mcp?.list as
            | (() => Promise<readonly unknown[]>)
            | undefined;
        await expect(listMcpServers?.()).resolves.toEqual([
            {
                id: 'acme.sample.mcp',
                name: 'sample-mcp',
                title: 'Sample MCP',
                transport: { kind: 'hosted' },
            },
        ]);

        const resolveMcpForSession = context.mcp?.resolveForSession as
            | ((input: Readonly<{
                sessionId: string;
                accountId?: string;
                workspaceId?: string;
                directory: string;
            }>) => Promise<readonly unknown[]>)
            | undefined;
        const resolvedMcp = await resolveMcpForSession?.({
            sessionId: 'session-1',
            accountId: 'spoofed-account',
            workspaceId: 'spoofed-workspace',
            directory: '/tmp/project',
        });
        expect(resolvedMcp).toEqual(expect.arrayContaining([
            {
                id: 'docs-server',
                name: 'docs',
                title: 'Docs',
                description: 'Docs server',
                transport: {
                    kind: 'http',
                    url: 'https://mcp.example.test/http',
                },
                scope: {
                    sessionId: 'session-1',
                    directory: '/tmp/project',
                },
            },
            {
                id: 'local-stdio-server',
                name: 'local_stdio',
                title: 'Local Stdio',
                description: 'Local stdio server',
                transport: {
                    kind: 'stdio',
                },
                scope: {
                    sessionId: 'session-1',
                    directory: '/tmp/project',
                },
            },
            {
                id: 'acme.sample.mcp',
                name: 'sample-mcp',
                title: 'Sample MCP',
                transport: { kind: 'hosted' },
                scope: {
                    sessionId: 'session-1',
                    directory: '/tmp/project',
                },
            },
        ]));
        expect(JSON.stringify(resolvedMcp)).not.toContain('spoofed-account');
        expect(JSON.stringify(resolvedMcp)).not.toContain('spoofed-workspace');
        expect(JSON.stringify(resolvedMcp)).not.toContain('Bearer secret-token');
        expect(JSON.stringify(resolvedMcp)).not.toContain('secret-env-value');
        expect(JSON.stringify(resolvedMcp)).not.toContain('Authorization');
        expect(JSON.stringify(resolvedMcp)).not.toContain('API_TOKEN');
        expect(JSON.stringify(resolvedMcp)).not.toContain('secret-managed-command');
        expect(JSON.stringify(resolvedMcp)).not.toContain('secret-managed-arg');
        expect(JSON.stringify(resolvedMcp)).not.toContain('STDIO_TOKEN');
        expect(JSON.stringify(resolvedMcp)).not.toContain('secret-stdio-env-value');
    });

    it('routes ctx.actions.approvals through the approval artifact store instead of an unavailable stub', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        const approvalsCreate = vi.fn(async () => ({ artifactId: 'approval-1' }));
        const approvalsGet = vi.fn(async () => ({
            v: 1,
            status: 'open',
            createdAtMs: 1,
            updatedAtMs: 1,
            createdBy: { surface: 'system', agentId: 'acme.sample' },
            actionId: 'session.title.set',
            actionArgs: { sessionId: 's1', title: 'New title' },
            summary: 'Rename the session',
        }));
        const approvalsList = vi.fn(async () => ({
            items: [],
            queryPlan: { kind: 'approval_artifact_header_scan', hydratedTranscripts: false },
        }));

        readCredentialsMock.mockResolvedValue({ token: 'token-for-approvals' });
        createCliApprovalsArtifactStoreMock.mockReturnValue({
            approvalsCreate,
            approvalsGet,
            approvalsList,
            approvalsUpdate: vi.fn(async () => ({ ok: true })),
        });

        let observedContext: ObservedPluginRuntimeContext | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: ObservedPluginRuntimeContext) => {
                            observedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => createPluginSessionRuntimeFixture(),
                                    createExecutionRunBackend: vi.fn(),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        await expect(resolveBackendEngineAdapterResolution('acme.sample.backend'))
            .resolves
            .toMatchObject({ backendId: 'acme.sample.backend' });

        expect(observedContext).not.toBeNull();
        const observed = observedContext as unknown as ObservedPluginRuntimeContext;
        const approvals = (observed.actions?.approvals ?? {}) as Readonly<{
            request?: (input: unknown) => Promise<unknown>;
            get?: (input: unknown) => Promise<unknown>;
            list?: (input: unknown) => Promise<unknown>;
        }>;

        await expect(approvals.request?.({
            actionId: 'session.title.set',
            args: { sessionId: 's1', title: 'New title' },
            summary: 'Rename the session',
        })).resolves.toEqual({ approvalRequestId: 'approval-1' });
        await expect(approvals.get?.('approval-1')).resolves.toMatchObject({
            actionId: 'session.title.set',
        });
        await expect(approvals.list?.({ status: 'open', limit: 10 })).resolves.toMatchObject({
            items: [],
        });

        expect(approvalsCreate).toHaveBeenCalledWith(expect.objectContaining({
            request: expect.objectContaining({
                createdBy: expect.objectContaining({ surface: 'system', agentId: 'acme.sample' }),
                actionId: 'session.title.set',
                actionArgs: { sessionId: 's1', title: 'New title' },
                summary: 'Rename the session',
            }),
        }));
        expect(approvalsGet).toHaveBeenCalledWith({ artifactId: 'approval-1', serverId: null });
        expect(approvalsList).toHaveBeenCalledWith({ status: 'open', limit: 10, serverId: null });
    });

    it('delivers typed ctx.session.subscribe events instead of raw host payloads', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let capturedContext: SessionScopedContextForTest | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            capturedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => createPluginSessionRuntimeFixture(),
                                    createExecutionRunBackend: vi.fn(),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const metadataListenerRef: { current: ((payload: unknown) => void) | null } = {
            current: null,
        };
        const fakeSession = {
            sessionId: 'session-1',
            sendUserTextMessage: vi.fn(),
            updateMetadata: vi.fn(),
            updateAgentState: vi.fn(),
            on: vi.fn((eventName: string, listener: (payload: unknown) => void) => {
                if (eventName === 'metadata-updated') {
                    metadataListenerRef.current = listener;
                }
            }),
            off: vi.fn(),
        };
        const fakeTranscriptSession = {
            sendAgentMessageCommitted: vi.fn(),
            sendAgentMessageEphemeral: vi.fn(),
            sendAgentMessage: vi.fn(),
        };
        const fakePermissionHandler = {
            handleToolCall: vi.fn(async () => ({ decision: 'approved' })),
        };

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime(createPluginSessionLaunchParams({ cwd: '/tmp/plugin' })) as HostSessionRuntimePlanForTest;
        await plan.config.createSessionRuntime({
            directory: '/tmp/plugin',
            metadata: {},
            machineId: 'm1',
            session: fakeSession,
            transcriptSession: fakeTranscriptSession,
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: fakePermissionHandler,
            getPermissionMode: () => 'read_only',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        });

        const listener = vi.fn();
        const subscription = capturedContext!.sessions.current.subscribe({ eventName: 'metadata-updated' }, listener);
        await vi.waitFor(() => {
            expect(metadataListenerRef.current).toEqual(expect.any(Function));
        });
        const emitMetadataUpdated = metadataListenerRef.current;
        if (!emitMetadataUpdated) {
            throw new Error('Expected session metadata listener to be registered');
        }
        emitMetadataUpdated({ revision: 2 });

        expect(listener).toHaveBeenCalledWith({
            kind: 'metadata-updated',
            payload: { revision: 2 },
        });

        subscription.unsubscribe();
        expect(fakeSession.off).toHaveBeenCalledWith('metadata-updated', expect.any(Function));
    });

    it('honors caller-scoped cancellation for ctx.session.permissions.requestDecision without mutating the request record', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let capturedContext: SessionScopedContextForTest | null = null;
        const runtimeDisposables: unknown[] = [];
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            capturedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => createPluginSessionRuntimeFixture(),
                                    createExecutionRunBackend: vi.fn(),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            addRuntimeDisposable: vi.fn((_pluginId: string, disposable: unknown) => {
                runtimeDisposables.push(disposable);
                return disposable;
            }),
            dispose: vi.fn(async () => undefined),
        });

        const fakeSession = {
            sendUserTextMessage: vi.fn(),
            updateMetadata: vi.fn(),
            updateAgentState: vi.fn(),
        };
        const fakeTranscriptSession = {
            sendAgentMessageCommitted: vi.fn(),
            sendAgentMessageEphemeral: vi.fn(),
            sendAgentMessage: vi.fn(),
        };
        const handledRequests: unknown[] = [];
        const fakePermissionHandler = {
            handleToolCall: vi.fn((toolCallId: string, toolName: string, input: unknown, options?: unknown) => {
                handledRequests.push({ toolCallId, toolName, input, options });
                return new Promise(() => undefined);
            }),
            cancelByPlugin: vi.fn(),
        };

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime(createPluginSessionLaunchParams({ cwd: '/tmp/plugin' })) as HostSessionRuntimePlanForTest;
        await plan.config.createSessionRuntime({
            directory: '/tmp/plugin',
            metadata: {},
            machineId: 'm1',
            session: fakeSession,
            transcriptSession: fakeTranscriptSession,
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: fakePermissionHandler,
            getPermissionMode: () => 'read_only',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        });

        const controller = new AbortController();
        const permissionRequest = {
            toolCallId: 'tool-1',
            toolName: 'write_file',
            input: { path: '/tmp/a' },
        };
        const pendingDecision = capturedContext!.sessions.current.permissions.requestDecision(permissionRequest, {
            signal: controller.signal,
        });

        controller.abort(new Error('plugin permission request canceled'));

        await expect(pendingDecision).rejects.toThrow('plugin permission request canceled');
        expect(handledRequests).toEqual([{
            ...permissionRequest,
            options: {
                owner: {
                    kind: 'plugin',
                    pluginId: 'acme.sample',
                    runtimeId: expect.stringMatching(/^plugin-runtime:acme\.sample:/),
                },
            },
        }]);
        expect(Object.keys(permissionRequest)).toEqual(['toolCallId', 'toolName', 'input']);

        for (const disposable of [...runtimeDisposables].reverse()) {
            if (typeof disposable === 'function') {
                await disposable();
                continue;
            }
            if (disposable && typeof disposable === 'object' && typeof (disposable as { dispose?: unknown }).dispose === 'function') {
                await (disposable as { dispose: () => void | Promise<void> }).dispose();
            }
        }
        expect(fakePermissionHandler.cancelByPlugin).toHaveBeenCalledWith('acme.sample', 'plugin_deactivated');
    });

    it('routes a requestId+toolName permission ask through the host permission handler', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let capturedContext: SessionScopedContextForTest | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            capturedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => createPluginSessionRuntimeFixture(),
                                    createExecutionRunBackend: vi.fn(),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const handleToolCall = vi.fn(async () => ({ decision: 'denied' as const, rationale: 'blocked' }));
        const fakePermissionHandler = {
            handleToolCall,
            respondToPendingPermission: vi.fn(),
        };

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime(createPluginSessionLaunchParams({ cwd: '/tmp/plugin' })) as HostSessionRuntimePlanForTest;
        await plan.config.createSessionRuntime({
            directory: '/tmp/plugin',
            metadata: {},
            machineId: 'm1',
            session: { sendUserTextMessage: vi.fn(), updateMetadata: vi.fn(), updateAgentState: vi.fn() },
            transcriptSession: { sendAgentMessageCommitted: vi.fn(), sendAgentMessageEphemeral: vi.fn(), sendAgentMessage: vi.fn() },
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: fakePermissionHandler,
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        });

        await expect(capturedContext!.sessions.current.permissions.requestDecision({
            requestId: 'provider-permission-1',
            toolName: 'bash',
            input: { command: 'touch file.txt' },
        })).resolves.toMatchObject({
            decision: 'denied',
            rationale: 'blocked',
        });

        expect(handleToolCall).toHaveBeenCalledWith(
            'provider-permission-1',
            'bash',
            { command: 'touch file.txt' },
            {
                owner: {
                    kind: 'plugin',
                    pluginId: 'acme.sample',
                    runtimeId: expect.stringMatching(/^plugin-runtime:acme\.sample:/),
                },
            },
        );
        expect(fakePermissionHandler.respondToPendingPermission).not.toHaveBeenCalled();
    });

    it('routes a requestId+approved response to the pending coordinator instead of fabricating an approval', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let capturedContext: SessionScopedContextForTest | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            capturedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => createPluginSessionRuntimeFixture(),
                                    createExecutionRunBackend: vi.fn(),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const respondToPendingPermission = vi.fn(() => ({ status: 'resolved' as const }));
        const fakePermissionHandler = {
            handleToolCall: vi.fn(),
            respondToPendingPermission,
        };

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime(createPluginSessionLaunchParams({ cwd: '/tmp/plugin' })) as HostSessionRuntimePlanForTest;
        await plan.config.createSessionRuntime({
            directory: '/tmp/plugin',
            metadata: {},
            machineId: 'm1',
            session: { sendUserTextMessage: vi.fn(), updateMetadata: vi.fn(), updateAgentState: vi.fn() },
            transcriptSession: { sendAgentMessageCommitted: vi.fn(), sendAgentMessageEphemeral: vi.fn(), sendAgentMessage: vi.fn() },
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: fakePermissionHandler,
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        });

        await expect(capturedContext!.sessions.current.permissions.requestDecision({ requestId: 'req-1', approved: true }))
            .resolves.toMatchObject({ decision: 'approved' });
        expect(respondToPendingPermission).toHaveBeenCalledWith({ id: 'req-1', approved: true });
        expect(fakePermissionHandler.handleToolCall).not.toHaveBeenCalled();
    });

    it('returns a typed permission_request_not_found when a response targets an unknown request id', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let capturedContext: SessionScopedContextForTest | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            capturedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => createPluginSessionRuntimeFixture(),
                                    createExecutionRunBackend: vi.fn(),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const fakePermissionHandler = {
            handleToolCall: vi.fn(),
            respondToPendingPermission: vi.fn(() => ({ status: 'not_found' as const })),
        };

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime(createPluginSessionLaunchParams({ cwd: '/tmp/plugin' })) as HostSessionRuntimePlanForTest;
        await plan.config.createSessionRuntime({
            directory: '/tmp/plugin',
            metadata: {},
            machineId: 'm1',
            session: { sendUserTextMessage: vi.fn(), updateMetadata: vi.fn(), updateAgentState: vi.fn() },
            transcriptSession: { sendAgentMessageCommitted: vi.fn(), sendAgentMessageEphemeral: vi.fn(), sendAgentMessage: vi.fn() },
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: fakePermissionHandler,
            getPermissionMode: () => 'default',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        });

        await expect(capturedContext!.sessions.current.permissions.requestDecision({ requestId: 'ghost-request', approved: true }))
            .rejects.toMatchObject({ errorCode: 'permission_request_not_found', requestId: 'ghost-request' });
    });

    it('preserves structured permission answers on ctx.session.permissions.requestDecision results', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let capturedContext: SessionScopedContextForTest | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            capturedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => createPluginSessionRuntimeFixture(),
                                    createExecutionRunBackend: vi.fn(),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const fakeSession = {
            sendUserTextMessage: vi.fn(),
            updateMetadata: vi.fn(),
            updateAgentState: vi.fn(),
        };
        const fakeTranscriptSession = {
            sendAgentMessageCommitted: vi.fn(),
            sendAgentMessageEphemeral: vi.fn(),
            sendAgentMessage: vi.fn(),
        };
        const fakePermissionHandler = {
            handleToolCall: vi.fn(async () => ({
                decision: 'approved',
                answers: { 'Continue?': 'Yes' },
            })),
        };

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime(createPluginSessionLaunchParams({ cwd: '/tmp/plugin' })) as HostSessionRuntimePlanForTest;
        await plan.config.createSessionRuntime({
            directory: '/tmp/plugin',
            metadata: {},
            machineId: 'm1',
            session: fakeSession,
            transcriptSession: fakeTranscriptSession,
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: fakePermissionHandler,
            getPermissionMode: () => 'read_only',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        });

        await expect(capturedContext!.sessions.current.permissions.requestDecision({
            toolCallId: 'tool-ask-1',
            toolName: 'AskUserQuestion',
            input: { questions: [{ question: 'Continue?' }] },
        })).resolves.toEqual({
            decision: 'approved',
            answers: { 'Continue?': 'Yes' },
        });
    });

    it('preserves host-updated permission input on ctx.session.permissions.requestDecision results', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let capturedContext: SessionScopedContextForTest | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            capturedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => createPluginSessionRuntimeFixture(),
                                    createExecutionRunBackend: vi.fn(),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const fakeSession = {
            sendUserTextMessage: vi.fn(),
            updateMetadata: vi.fn(),
            updateAgentState: vi.fn(),
        };
        const fakeTranscriptSession = {
            sendAgentMessageCommitted: vi.fn(),
            sendAgentMessageEphemeral: vi.fn(),
            sendAgentMessage: vi.fn(),
        };
        const fakePermissionHandler = {
            handleToolCall: vi.fn(async () => ({
                decision: 'approved',
                updatedInput: { command: 'echo safe' },
            })),
        };

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime(createPluginSessionLaunchParams({ cwd: '/tmp/plugin' })) as HostSessionRuntimePlanForTest;
        await plan.config.createSessionRuntime({
            directory: '/tmp/plugin',
            metadata: {},
            machineId: 'm1',
            session: fakeSession,
            transcriptSession: fakeTranscriptSession,
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: fakePermissionHandler,
            getPermissionMode: () => 'read_only',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        });

        await expect(capturedContext!.sessions.current.permissions.requestDecision({
            toolCallId: 'tool-bash-1',
            toolName: 'Bash',
            input: { command: 'echo unsafe' },
        })).resolves.toEqual({
            decision: 'approved',
            updatedInput: { command: 'echo safe' },
        });
    });

    it('preserves typed permission follow-up and persistence fields on ctx.session.permissions.requestDecision results', async () => {
        seedPluginRegistryWithoutRuntimeCore();
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        });

        let capturedContext: SessionScopedContextForTest | null = null;
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: await resolveMergedContributionRegistryMock(),
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    registration: {
                        backendId: 'acme.sample.backend',
                        create: async (ctx: SessionScopedContextForTest) => {
                            capturedContext = ctx;
                            return {
                                runtimeCore: {
                                    createSessionRuntime: async () => createPluginSessionRuntimeFixture(),
                                    createExecutionRunBackend: vi.fn(),
                                },
                            };
                        },
                    },
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        });

        const fakePermissionHandler = {
            handleToolCall: vi.fn(async () => ({
                decision: 'approved',
                followUpPrompt: {
                    prompt: 'Continue with the approved edit.',
                    delivery: 'followUp',
                },
                persistAllowRule: {
                    scope: 'session',
                    toolName: 'Bash',
                },
            })),
        };

        const resolution = await resolveBackendEngineAdapterResolution('acme.sample.backend');
        const plan = await resolution!.engineAdapter.runtimeCore.createSessionRuntime(createPluginSessionLaunchParams({ cwd: '/tmp/plugin' })) as HostSessionRuntimePlanForTest;
        await plan.config.createSessionRuntime({
            directory: '/tmp/plugin',
            metadata: {},
            machineId: 'm1',
            session: { sendUserTextMessage: vi.fn(), updateMetadata: vi.fn(), updateAgentState: vi.fn() },
            transcriptSession: { sendAgentMessageCommitted: vi.fn(), sendAgentMessageEphemeral: vi.fn(), sendAgentMessage: vi.fn() },
            messageBuffer: {},
            mcpServers: {},
            permissionHandler: fakePermissionHandler,
            getPermissionMode: () => 'read_only',
            setThinking: () => undefined,
            memoryRecallGuidanceEnabled: false,
        });

        await expect(capturedContext!.sessions.current.permissions.requestDecision({
            toolCallId: 'tool-bash-2',
            toolName: 'Bash',
            input: { command: 'echo ok' },
        })).resolves.toEqual({
            decision: 'approved',
            followUpPrompt: {
                prompt: 'Continue with the approved edit.',
                delivery: 'followUp',
            },
            persistAllowRule: {
                scope: 'session',
                toolName: 'Bash',
            },
        });
    });

    it('proves built-in parity: SessionHostBridge and createExecutionRunBackend both route through EngineRegistry runtimeCore for codex', async () => {
        const createdPlan = {
            kind: 'hostSessionRuntimePlan',
            agentId: 'codex',
            opts: { cwd: '/tmp/codex', resume: 'resume-1' },
            config: {},
        };
        const createSessionRuntime = vi.fn(async (_params: unknown) => createdPlan);
        const executionBackend = {
            provisionSession: vi.fn(async () => ({ sessionId: 'run-session-1' })),
            readResumeSupport: vi.fn(async () => false),
            sendPrompt: vi.fn(async () => undefined),
            cancel: vi.fn(async () => undefined),
            subscribeMessages: vi.fn(() => () => undefined),
            dispose: vi.fn(async () => undefined),
        };
        const createExecutionRunBackend = vi.fn(() => executionBackend);
        const runtimeCore = {
            createSessionRuntime,
            createExecutionRunBackend,
        };
        const runtimeCoreFactory = vi.fn(async () => ({ runtimeCore }));
        seedCodexBuiltInRegistry({ runtimeCoreFactory });

        const { SessionHostBridge } = await import('@/agent/runtime/bridges/session/SessionHostBridge');
        const bridge = new SessionHostBridge();

        await expect(bridge.createSessionRuntime('codex', { cwd: '/tmp/codex', resume: 'resume-1' })).resolves.toEqual(createdPlan);

        const runtime = (await import('@/agent/runtime/bridges/executionRun/runtime/create')).createExecutionRunRuntime({
            cwd: '/tmp/codex',
            backendId: 'codex',
            permissionMode: 'read_only',
            accountSettings: {},
            start: {
                intent: 'plan',
                retentionPolicy: 'ephemeral',
            },
        });
        await expect(runtime.provisionSession({ initialPrompt: 'boot' })).resolves.toEqual({ sessionId: 'run-session-1' });

        expect(runtimeCoreFactory).toHaveBeenCalled();
        expect(createSessionRuntime).toHaveBeenCalledWith({ cwd: '/tmp/codex', resume: 'resume-1' });
        expect(createExecutionRunBackend).toHaveBeenCalledWith(expect.objectContaining({
            cwd: '/tmp/codex',
            backendId: 'codex',
            permissionMode: 'read_only',
            start: expect.objectContaining({
                intent: 'plan',
                retentionPolicy: 'ephemeral',
            }),
        }));
        expect(getExecutionRunBackendDescriptorMock).not.toHaveBeenCalled();
    });

    it('preserves a first-class plugin backend runtimeCore factory instead of rebuilding a plugin-only fallback core', async () => {
        const createdPlan = {
            kind: 'hostSessionRuntimePlan',
            agentId: 'acme.sample.backend',
            opts: { cwd: '/tmp/plugin', resume: 'resume-1' },
            config: {},
        };
        const executionBackend = {
            provisionSession: vi.fn(async () => ({ sessionId: 'plugin-run-session-1' })),
            readResumeSupport: vi.fn(async () => false),
            sendPrompt: vi.fn(async () => undefined),
            cancel: vi.fn(async () => undefined),
            subscribeMessages: vi.fn(() => () => undefined),
            dispose: vi.fn(async () => undefined),
        };
        const runtimeCore = {
            createSessionRuntime: vi.fn(async () => createdPlan),
            createExecutionRunBackend: vi.fn(() => executionBackend),
        };
        const runtimeCoreEnvelope = {
            runtimeCore,
            facets: {
                transcriptSource: {
                    supported: true,
                },
            },
        };
        const runtimeCoreFactory = vi.fn(async () => runtimeCoreEnvelope);
        const seededRegistry = seedPluginRegistry({ runtimeCoreFactory });

        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes: seededRegistry,
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            pluginDiagnosticsByPluginId: {},
            dispose: vi.fn(async () => undefined),
        });
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: { launch: vi.fn(async () => ({ marker: 'should-not-be-used' })) },
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        } as unknown);

        const registry = await resolveCliEngineRegistry();
        const resolution = await registry.resolveForBackendId('acme.sample.backend');

        await expect(
            resolution?.engineAdapter.runtimeCore.createSessionRuntime({ cwd: '/tmp/plugin', resume: 'resume-1' }),
        ).resolves.toEqual(createdPlan);
        expect(
            resolution?.engineAdapter.runtimeCore.createExecutionRunBackend({
                cwd: '/tmp/plugin',
                backendId: 'acme.sample.backend',
                permissionMode: 'read_only',
            }),
        ).toBe(executionBackend);
        expect(runtimeCore.createSessionRuntime).toHaveBeenCalledWith({ cwd: '/tmp/plugin', resume: 'resume-1' });
        expect(runtimeCore.createExecutionRunBackend).toHaveBeenCalledWith({
            cwd: '/tmp/plugin',
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
        });
        expect(resolution?.engineAdapter.facets).toEqual({
            transcriptSource: {
                supported: true,
            },
        });
        expect(runtimeCoreFactory).toHaveBeenCalledWith(expect.objectContaining({
            backend: expect.objectContaining({
                id: 'acme.sample.backend',
                provenance: 'external',
                source: { kind: 'path' },
            }),
            provider: expect.objectContaining({
                id: 'acme.sample.provider',
                provenance: 'external',
                source: { kind: 'path' },
            }),
            executionSurfaces: expect.objectContaining({
                terminalRuntime: expect.objectContaining({
                    launch: expect.any(Function),
                }),
            }),
        }));
    });

    it('resolves plugin backends from the authoritative active runtime registry when merged contributions are stale', async () => {
        const createdPlan = {
            kind: 'hostSessionRuntimePlan',
            agentId: 'acme.sample.backend',
            opts: { cwd: '/tmp/plugin', resume: 'resume-1' },
            config: {},
        };
        const runtimeCore = {
            createSessionRuntime: vi.fn(async () => createdPlan),
            createExecutionRunBackend: vi.fn(() => ({
                provisionSession: vi.fn(async () => ({ sessionId: 'plugin-run-session-2' })),
                readResumeSupport: vi.fn(async () => false),
                sendPrompt: vi.fn(async () => undefined),
                cancel: vi.fn(async () => undefined),
                subscribeMessages: vi.fn(() => () => undefined),
                dispose: vi.fn(async () => undefined),
            })),
        };
        const runtimeCoreFactory = vi.fn(async () => ({ runtimeCore }));

        resolveMergedContributionRegistryMock.mockResolvedValue({
            agents: [],
            agentRuntimes: [],
            actions: [],
            hookRegistrations: [],
            surfaceHandlersByBackendId: new Map(),
            catalogEntriesById: {},
            agentDefinitionsById: new Map(),
            agentRuntimeDefinitionsById: new Map(),
            pluginDiagnosticsByPluginId: {},
        });

        const authoritativeContributions = {
            agents: [{
                id: 'acme.sample.provider',
                provenance: 'external',
                source: { kind: 'path' },
                definition: {
                    kindVersion: 1,
                    id: 'acme.sample.provider',
                    ownedBackendIds: ['acme.sample.backend'],
                },
                richDefinition: {
                    source: 'plugin',
                    definition: {
                        kindVersion: 1,
                        id: 'acme.sample.provider',
                        ownedBackendIds: ['acme.sample.backend'],
                        display: {
                            name: 'Acme Sample Provider',
                            tags: ['plugin'],
                        },
                    },
                },
                runtimeSpec: null,
                pluginId: 'acme.sample',
                daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
            }],
            agentRuntimes: [{
                id: 'acme.sample.backend',
                agentId: 'acme.sample.provider',
                provenance: 'external',
                source: { kind: 'path' },
                definition: {
                    kindVersion: 1,
                    id: 'acme.sample.backend',
                    agentId: 'acme.sample.provider',
                },
                richDefinition: {
                    source: 'plugin',
                    definition: {
                        kindVersion: 1,
                        id: 'acme.sample.backend',
                        agentId: 'acme.sample.provider',
                        runtimeKind: 'native',
                        capabilities: {},
                        surfaceHandlers: [],
                    },
                },
                runtimeKind: 'native',
                surfaceHandlers: [],
                pluginId: 'acme.sample',
                daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
                getRuntimeCore: async () => runtimeCoreFactory,
            }],
            actions: [],
            hookRegistrations: [],
            surfaceHandlersByBackendId: new Map(),
            catalogEntriesById: {},
            agentRuntimeDefinitionsById: new Map([
                ['acme.sample.backend', {
                    id: 'acme.sample.backend',
                    agentId: 'acme.sample.provider',
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: {
                        kindVersion: 1,
                        id: 'acme.sample.backend',
                        agentId: 'acme.sample.provider',
                    },
                    richDefinition: {
                        source: 'plugin',
                        definition: {
                            kindVersion: 1,
                            id: 'acme.sample.backend',
                            agentId: 'acme.sample.provider',
                            runtimeKind: 'native',
                            capabilities: {},
                            surfaceHandlers: [],
                        },
                    },
                    runtimeKind: 'native',
                    surfaceHandlers: [],
                    pluginId: 'acme.sample',
                    daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
                    getRuntimeCore: async () => runtimeCoreFactory,
                }],
            ]),
            agentDefinitionsById: new Map([
                ['acme.sample.provider', {
                    id: 'acme.sample.provider',
                    provenance: 'external',
                    source: { kind: 'path' },
                    definition: {
                        kindVersion: 1,
                        id: 'acme.sample.provider',
                        ownedBackendIds: ['acme.sample.backend'],
                    },
                    richDefinition: {
                        source: 'plugin',
                        definition: {
                            kindVersion: 1,
                            id: 'acme.sample.provider',
                            ownedBackendIds: ['acme.sample.backend'],
                            display: {
                                name: 'Acme Sample Provider',
                                tags: ['plugin'],
                            },
                        },
                    },
                    runtimeSpec: null,
                    pluginId: 'acme.sample',
                    daemonEntryPath: '/tmp/acme.sample/daemon.mjs',
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
        };

        const authoritativeRuntimeRegistry = {
            contributes: authoritativeContributions,
            actionHandlersByActionId: new Map(),
            hookHandlersByHookId: new Map(),
            runtimeCoreHandlersByBackendId: new Map(),
            pluginDiagnosticsByPluginId: {},
            dispose: vi.fn(async () => undefined),
        };
        pluginReloadControllerStateMock.mockReturnValue({
            generation: 2,
            activeRegistry: authoritativeRuntimeRegistry,
            lastResult: null,
        });
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            surfaces: {
                terminalRuntime: null,
                externalSession: null,
                attach: null,
                handoff: null,
                fork: null,
                checkpoint: null,
            },
            diagnostics: [],
        } as unknown);

        const registry = await resolveCliEngineRegistry();
        const resolution = await registry.resolveForBackendId('acme.sample.backend');

        expect(resolution?.backend.id).toBe('acme.sample.backend');
        await expect(
            resolution?.engineAdapter.runtimeCore.createSessionRuntime({ cwd: '/tmp/plugin', resume: 'resume-1' }),
        ).resolves.toEqual(createdPlan);
        expect(resolveExecutablePluginRuntimeRegistryMock).not.toHaveBeenCalled();
    });
});
