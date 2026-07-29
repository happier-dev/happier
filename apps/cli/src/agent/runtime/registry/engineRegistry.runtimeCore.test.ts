import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
    PluginSubagentsServiceV1,
} from '@happier-dev/agents';
import type {
    ExecClientHandleV1,
    JsonRpcClientV1,
} from '@/plugins/runtime/exec/privateContract';
import {
    type AgentExecutionRunEvent,
    type AgentRuntime,
    type AgentSessionHostServices,
} from '@happier-dev/plugin-sdk/agent-runtime';
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
import { setActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import type { HostSessionRuntimeFactoryParams } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import type { Metadata } from '@/api/types';
import type { RegisteredSessionStateFieldMutationV1 } from '../../../api/session/client/transport/mutations/sessionClientDurableMutationTypes';
import type { Credentials } from '@/persistence';
import type {
    ProviderAccountUsageAdoptionV1,
} from '@/daemon/connectedServices/accountUsage/adoption';
import {
    resolveBackendEngineAdapterResolution,
    resolveCliEngineRegistry,
} from './engineRegistry';
import type { ResolveEngineRegistryParams } from './engineRegistry/types';

const {
    resolveMergedContributionRegistryMock,
    getExecutionRunBackendDescriptorMock,
    resolveExecutablePluginRuntimeRegistryMock,
    resolvePluginBackendSurfaceHandlersMock,
    pluginReloadControllerStateMock,
    pluginReloadControllerTryAcquireRuntimeRegistryMock,
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
} = vi.hoisted(() => ({
    resolveMergedContributionRegistryMock: vi.fn<(...args: unknown[]) => unknown>(),
    getExecutionRunBackendDescriptorMock: vi.fn<(...args: unknown[]) => unknown>((..._args: unknown[]) => {
        throw new Error('legacy executionRunBackendRegistry must not be used when runtimeCore exist');
    }),
    resolveExecutablePluginRuntimeRegistryMock: vi.fn<(...args: unknown[]) => unknown>(),
    resolvePluginBackendSurfaceHandlersMock: vi.fn<(...args: unknown[]) => unknown>(),
    pluginReloadControllerStateMock: vi.fn<(...args: unknown[]) => unknown>(),
    pluginReloadControllerTryAcquireRuntimeRegistryMock: vi.fn<(...args: unknown[]) => unknown>(),
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
        tryAcquireRuntimeRegistry: pluginReloadControllerTryAcquireRuntimeRegistryMock,
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object';
}

function createLeaseRuntimeRegistry(contributes: unknown): Record<string, unknown> {
    return {
        contributes,
        hookHandlersByHookId: new Map(),
        agentRuntimesByAgentId: new Map(),
        scmHostingProvidersById: new Map(),
        pluginDiagnosticsByPluginId: {},
        activateContributionsOnDemand: vi.fn(async () => []),
        readHookEventEnvelopeV1: vi.fn(),
        dispose: vi.fn(async () => undefined),
    };
}

function normalizeAgentRuntimeRegistryFixture(value: unknown): ReadonlyMap<string, unknown> {
    if (!(value instanceof Map)) return new Map();
    return new Map([...value.entries()].map(([agentId, candidate]) => {
        if (!isRecord(candidate)) {
            return [agentId, candidate] as const;
        }
        if (typeof candidate.createRuntime === 'function') {
            return [agentId, {
                ...candidate,
                hasPrimaryRuntime: true as const,
                retirementSignal: candidate.retirementSignal instanceof AbortSignal
                    ? candidate.retirementSignal
                    : new AbortController().signal,
            }] as const;
        }
        return [agentId, candidate] as const;
    }));
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
        agentRuntimesByAgentId: normalizeAgentRuntimeRegistryFixture(
            overrides.agentRuntimesByAgentId,
        ),
    };
}

async function createInjectedRuntimeRegistryParams(): Promise<ResolveEngineRegistryParams> {
    const registryCandidate = await resolveExecutablePluginRuntimeRegistryMock() ?? null;
    const fallbackContributes = isRecord(registryCandidate) && registryCandidate.contributes
        ? registryCandidate.contributes
        : await resolveMergedContributionRegistryMock();
    return {
        runtimeRegistry: completeLeaseRuntimeRegistryFixture(
            registryCandidate,
            fallbackContributes,
        ) as unknown as NonNullable<ResolveEngineRegistryParams['runtimeRegistry']>,
    };
}

describe('resolveCliEngineRegistry runtimeCore', () => {
    beforeEach(() => {
        vi.resetModules();
        resolveMergedContributionRegistryMock.mockReset();
        resolveExecutablePluginRuntimeRegistryMock.mockReset();
        resolvePluginBackendSurfaceHandlersMock.mockReset();
        pluginReloadControllerStateMock.mockReset();
        pluginReloadControllerTryAcquireRuntimeRegistryMock.mockReset();
        readCredentialsMock.mockReset();
        readSettingsMock.mockReset();
        readOrCreateInstallationIdentityMock.mockReset();
        createCliApprovalsArtifactStoreMock.mockReset();
        getConnectedServiceRuntimeAuthAdapterMock.mockReset();
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
            result: { status: 'snapshot_advanced', recordId: 'paug_v1_placeholder', persisted: true },
        });
        getExecutionRunBackendDescriptorMock.mockClear();
        pluginReloadControllerStateMock.mockReturnValue({
            generation: 0,
            activeRegistry: null,
            lastResult: null,
        });
        pluginReloadControllerTryAcquireRuntimeRegistryMock.mockImplementation(() => {
            const state = pluginReloadControllerStateMock();
            const activeRegistry = isRecord(state) ? state.activeRegistry : null;
            return activeRegistry ? {
                registry: activeRegistry,
                source: 'active',
                release: vi.fn(async () => undefined),
            } : null;
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

    type ProviderAccountUsageAdoptionForTest = ProviderAccountUsageAdoptionV1;

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
                resolveSourceContext: AgentSessionHostServices['accountUsage']['resolveSourceContext'];
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
        createRuntime?: () => Promise<AgentRuntime> | AgentRuntime;
    }>): Record<string, unknown> {
        return {
            contributes: params.contributes,
            hookHandlersByHookId: new Map(),
            agentRuntimesByAgentId: params.createRuntime
                ? new Map([
                    [params.backendId, {
                        pluginId: params.pluginId,
                        pluginVersion: '0.0.0',
                        agentId: params.backendId,
                        generation: '1',
                        hasPrimaryRuntime: true,
                        isCurrent: () => true,
                        createRuntime: params.createRuntime,
                    }],
                ])
                : new Map(),
            pluginDiagnosticsByPluginId: {},
            activateContributionsOnDemand: vi.fn(async () => []),
            readHookEventEnvelopeV1: vi.fn(),
            dispose: vi.fn(async () => undefined),
        };
    }

    function seedFirstPartyOwnerRegistry(params: Readonly<{
        backendId?: string;
        agentId?: string;
        pluginId?: string;
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
        };
        const registry = {
            agents: [agent],
            agentRuntimes: [backend],
            actions: [],
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
                            title: {
                                key: 'plugins.acme.sample.title',
                                fallback: 'Acme Sample Provider',
                            },
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
                        actions: [],
                        catalogEntriesById: {},
            agentDefinitionsById: new Map(),
                        pluginDiagnosticsByPluginId: {},
        });

        await expect(resolveBackendEngineAdapterResolution(
            ['code', 'rabbit'].join(''),
            await createInjectedRuntimeRegistryParams(),
        ))
            .resolves
            .toBeNull();
        expect(getExecutionRunBackendDescriptorMock).not.toHaveBeenCalled();
    });

    it('adapts a native Agent execution-run factory through the canonical host runtime', async () => {
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

        let publish!: (event: AgentExecutionRunEvent) => void;
        const disposeWatch = vi.fn();
        const send = vi.fn(async () => ({ status: 'admitted' as const }));
        const stop = vi.fn(async () => ({ status: 'requested' as const }));
        const dispose = vi.fn(async () => undefined);
        const open = vi.fn(async () => ({
            send,
            stop,
            watch(listener: (event: AgentExecutionRunEvent) => void) {
                publish = listener;
                return { dispose: disposeWatch };
            },
            dispose,
        }));
        const nativeRuntime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({ open }),
        });
        const operationServices = Object.freeze({ availability: vi.fn() });
        const createAgentInvocationServices = vi.fn(() => operationServices);
        const contributes = await resolveMergedContributionRegistryMock();
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes,
            hookHandlersByHookId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    pluginVersion: '1.2.3',
                    agentId: 'acme.sample.backend',
                    generation: 'generation-1',
                    isCurrent: () => true,
                    createRuntime: vi.fn(async () => nativeRuntime),
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            createAgentInvocationServices,
            readHookEventEnvelopeV1: vi.fn(),
            activateContributionsOnDemand: vi.fn(async () => []),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution(
            'acme.sample.backend',
            await createInjectedRuntimeRegistryParams(),
        );
        const runtime = resolution!.engineAdapter.runtimeCore.createExecutionRunBackend({
            cwd: '/repo',
            runId: 'run-1',
            backendId: 'acme.sample.backend',
            permissionMode: 'read_only',
            start: {
                intent: 'review',
                profileId: 'review',
                intentInput: { scope: 'changed-files' },
            },
        });
        const messages: unknown[] = [];
        runtime.subscribeMessages((message) => messages.push(message));

        await expect(runtime.provisionSession()).resolves.toEqual({ sessionId: 'run-1' });
        expect(open).not.toHaveBeenCalled();
        await expect(runtime.sendPrompt('run-1', 'Review these changes')).resolves.toBeUndefined();
        expect(open).toHaveBeenCalledWith({
            kind: 'create',
            runId: 'run-1',
            cwd: '/repo',
            profile: { pluginId: 'acme.sample', localId: 'review' },
            input: {
                text: 'Review these changes',
                structuredInput: { scope: 'changed-files' },
            },
        }, expect.objectContaining({
            plugin: { id: 'acme.sample', version: '1.2.3' },
            contribution: {
                id: 'acme.sample.backend',
                qualifiedId: 'acme.sample/agents/acme.sample.backend',
            },
            surface: 'agent',
            agent: { id: 'acme.sample.backend' },
            services: operationServices,
            ui: expect.any(Object),
            protocols: expect.any(Object),
        }));
        expect(createAgentInvocationServices).toHaveBeenCalledWith({
            pluginId: 'acme.sample',
            pluginVersion: '1.2.3',
            agentId: 'acme.sample.backend',
            generation: 'generation-1',
            correlationId: 'run-1',
            cwd: '/repo',
            signal: expect.any(AbortSignal),
            isGenerationCurrent: expect.any(Function),
        });

        publish({ sequence: 1, runId: 'run-1', emittedAtMs: 10, kind: 'run-start' });
        publish({
            sequence: 2,
            runId: 'run-1',
            emittedAtMs: 11,
            kind: 'output-delta',
            channel: 'assistant',
            text: 'Looks good',
        });
        publish({
            sequence: 3,
            runId: 'run-1',
            emittedAtMs: 12,
            kind: 'checkpoint',
            checkpointId: 'checkpoint-1',
        });
        publish({ sequence: 4, runId: 'run-1', emittedAtMs: 13, kind: 'run-complete' });

        expect(messages).toEqual([
            { type: 'status', status: 'running' },
            { type: 'model-output', textDelta: 'Looks good' },
            { type: 'event', name: 'provider_session_id', payload: { sessionId: 'checkpoint-1' } },
            { type: 'status', status: 'stopped' },
        ]);
        await expect(runtime.cancel('run-1')).resolves.toBeUndefined();
        expect(stop).toHaveBeenCalledOnce();
        await expect(runtime.dispose()).resolves.toBeUndefined();
        expect(disposeWatch).toHaveBeenCalledOnce();
        expect(dispose).toHaveBeenCalledOnce();
        expect(send).not.toHaveBeenCalled();
        expect(getExecutionRunBackendDescriptorMock).not.toHaveBeenCalled();
    });

    it('projects a declared native Agent terminal launch plan without replacing its execution-run runtime', async () => {
        seedPluginRegistryWithoutRuntimeCore({ agentSurfaceCapabilities: ['terminal'] });
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

        const resolveLaunch = vi.fn(async () => ({
            argv: ['--terminal'],
            process: { stdio: 'inherit' as const, windowsHide: true },
        }));
        const nativeRuntime: AgentRuntime = Object.freeze({
            executionRuns: Object.freeze({
                open: vi.fn(async () => ({
                    send: vi.fn(async () => ({ status: 'admitted' as const })),
                    stop: vi.fn(async () => ({ status: 'requested' as const })),
                    watch: vi.fn(() => ({ dispose: vi.fn() })),
                    dispose: vi.fn(async () => undefined),
                })),
            }),
            surfaces: Object.freeze({
                terminal: Object.freeze({ resolveLaunch }),
            }),
        });
        const contributes = await resolveMergedContributionRegistryMock();
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue({
            contributes,
            hookHandlersByHookId: new Map(),
            agentRuntimesByAgentId: new Map([
                ['acme.sample.backend', {
                    pluginId: 'acme.sample',
                    pluginVersion: '1.2.3',
                    agentId: 'acme.sample.backend',
                    generation: 'generation-1',
                    isCurrent: () => true,
                    createRuntime: vi.fn(async () => nativeRuntime),
                }],
            ]),
            pluginDiagnosticsByPluginId: {},
            readHookEventEnvelopeV1: vi.fn(),
            activateContributionsOnDemand: vi.fn(async () => []),
            dispose: vi.fn(async () => undefined),
        });

        const resolution = await resolveBackendEngineAdapterResolution(
            'acme.sample.backend',
            await createInjectedRuntimeRegistryParams(),
        );

        expect(resolution?.diagnostics).toEqual([]);
        expect(resolution?.executionSurfaces.terminalRuntime?.launch).toEqual(expect.any(Function));
        expect(resolution?.engineAdapter.runtimeCore.createExecutionRunBackend).toEqual(expect.any(Function));
        expect(resolveLaunch).not.toHaveBeenCalled();
    });

    function seedPluginRegistryWithoutRuntimeCore(params?: Readonly<{
        surfaceHandlers?: readonly BackendSurfaceDeclarationV1[];
        agentSurfaceCapabilities?: readonly 'terminal'[];
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
                        title: {
                            key: 'plugins.acme.sample.title',
                            fallback: 'Acme Sample Provider',
                        },
                        ownedBackendIds: ['acme.sample.backend'],
                        catalogAgentId: 'claude',
                        runtime: { kind: 'custom' },
                        primary: 'executionRuns',
                        capabilities: {
                            executionRuns: { open: ['create'], checkpoint: true, stop: true },
                            ...(params?.agentSurfaceCapabilities
                                ? { surfaces: params.agentSurfaceCapabilities }
                                : {}),
                        },
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
                            title: {
                                key: 'plugins.acme.sample.title',
                                fallback: 'Acme Sample Provider',
                            },
                            ownedBackendIds: ['acme.sample.backend'],
                            catalogAgentId: 'claude',
                            runtime: { kind: 'custom' },
                            primary: 'executionRuns',
                            capabilities: {
                                executionRuns: { open: ['create'], checkpoint: true, stop: true },
                                ...(params?.agentSurfaceCapabilities
                                    ? { surfaces: params.agentSurfaceCapabilities }
                                    : {}),
                            },
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
                    executable: { kind: 'systemTool', id: 'acme-agent' },
                    args: ['acp'],
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
        const agentId = 'opencode';

        const registry = {
            agents: [{
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
                catalogEntry: {
                    id: agentId,
                    cliSubcommand: agentId,
                    vendorResumeSupport: 'unsupported',
                },
            }],
            agentRuntimes: [{
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
                runtimeKind: 'server',
                surfaceHandlers: [],
            }],
            actions: [],
                        catalogEntriesById: {
                [agentId]: {
                    id: agentId,
                    cliSubcommand: agentId,
                    vendorResumeSupport: 'unsupported',
                },
            },
            agentRuntimeDefinitionsById: new Map([
                [backendId, {
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
                    runtimeKind: 'server',
                    surfaceHandlers: [],
                }],
            ]),
            agentDefinitionsById: new Map([
                [agentId, {
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
                    catalogEntry: {
                        id: agentId,
                        cliSubcommand: agentId,
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
                agent: expect.objectContaining({
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

        const registry = await resolveCliEngineRegistry(
            await createInjectedRuntimeRegistryParams(),
        );
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

        const resolution = await resolveBackendEngineAdapterResolution(
            backendId,
            await createInjectedRuntimeRegistryParams(),
        );

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
        const createPluginRuntime = vi.fn(async (): Promise<AgentRuntime> => ({
            sessions: { open: async () => { throw new Error('not invoked'); } },
            executionRuns: { open: async () => { throw new Error('not invoked'); } },
        }));
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue(createRuntimeRegistry({
            contributes,
            backendId,
            pluginId,
            createRuntime: createPluginRuntime,
        }));

        const resolution = await resolveBackendEngineAdapterResolution(
            backendId,
            await createInjectedRuntimeRegistryParams(),
        );

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
            runId: 'run-plugin-owner',
            backendId,
            permissionMode: 'read_only',
            start: { intent: 'review' },
        })).toEqual(expect.objectContaining({
            provisionSession: expect.any(Function),
            sendPrompt: expect.any(Function),
        }));
        expect(createPluginRuntime).toHaveBeenCalledTimes(1);
    });

    it('fails closed before child activation when a daemon-spawned native backend has no carrier', async () => {
        const backendId = 'acme.firstparty.backend';
        const pluginId = 'happier.agent.acme';
        seedFirstPartyOwnerRegistry({
            backendId,
            pluginId,
        });

        const registry = await resolveCliEngineRegistry({
            requireDaemonAgentRuntimeCarrier: true,
        });

        await expect(registry.resolveForBackendId(backendId))
            .rejects
            .toMatchObject({ code: 'DAEMON_AGENT_RUNTIME_CARRIER_MISSING' });
        expect(resolveExecutablePluginRuntimeRegistryMock).not.toHaveBeenCalled();
        expect(resolveMergedContributionRegistryMock).toHaveBeenCalledTimes(1);
    });

    it('fails closed before child activation when the daemon carrier belongs to another backend', async () => {
        const backendId = 'acme.firstparty.backend';
        const pluginId = 'happier.agent.acme';
        seedFirstPartyOwnerRegistry({
            backendId,
            pluginId,
        });

        const registry = await resolveCliEngineRegistry({
            requireDaemonAgentRuntimeCarrier: true,
            nativeAgentRuntimeCarrier: {
                descriptor: {
                    v: 1,
                    pluginId,
                    pluginVersion: '0.0.0',
                    agentId: 'claude',
                    backendId: 'acme.other.backend',
                    generation: '1',
                    factoryControls: {
                        continuation: false,
                        goals: false,
                        catalog: false,
                        usageLimitRecovery: false,
                    },
                },
                runtime: {
                    sessions: {
                        open: async () => {
                            throw new Error('mismatched carrier must not be invoked');
                        },
                    },
                },
                externalSessionHostOperations: {
                    bindSession() {
                        throw new Error(
                            'mismatched carrier host operations must not be invoked',
                        );
                    },
                },
                isCurrent: () => true,
            },
        });

        await expect(registry.resolveForBackendId(backendId))
            .rejects
            .toMatchObject({ code: 'DAEMON_AGENT_RUNTIME_CARRIER_MISSING' });
        expect(resolveExecutablePluginRuntimeRegistryMock).not.toHaveBeenCalled();
    });

    it('uses the matching parent-owned carrier for a daemon-spawned native backend', async () => {
        const backendId = 'acme.firstparty.backend';
        const agentId = 'claude';
        const pluginId = 'happier.agent.acme';
        const contributes = seedFirstPartyOwnerRegistry({
            backendId,
            agentId,
            pluginId,
        });
        const carriedRuntime: AgentRuntime = {
            sessions: { open: async () => { throw new Error('not invoked'); } },
        };

        const registry = await resolveCliEngineRegistry({
            contributes:
                contributes as unknown as NonNullable<ResolveEngineRegistryParams['contributes']>,
            requireDaemonAgentRuntimeCarrier: true,
            nativeAgentRuntimeCarrier: {
                descriptor: {
                    v: 1,
                    pluginId,
                    pluginVersion: '0.0.0',
                    agentId,
                    backendId,
                    generation: '1',
                    factoryControls: {
                        continuation: false,
                        goals: false,
                        catalog: false,
                        usageLimitRecovery: false,
                    },
                },
                runtime: carriedRuntime,
                externalSessionHostOperations: {
                    bindSession() {
                        throw new Error(
                            'carrier host operations are not invoked during resolution',
                        );
                    },
                },
                isCurrent: () => true,
            },
        });

        await expect(registry.resolveForBackendId(backendId)).resolves.toMatchObject({
            selectedSource: 'plugin',
            runtimeOwner: {
                selected: {
                    kind: 'plugin_engine',
                    ownerId: pluginId,
                },
            },
        });
        expect(resolveExecutablePluginRuntimeRegistryMock).not.toHaveBeenCalled();
    });

    it('allows an explicit legacy host runtimeCore in a daemon-spawned child without a carrier', async () => {
        const backendId = 'acme.firstparty.backend';
        const pluginId = 'happier.agent.acme';
        const runtimeCoreFactory = vi.fn(async () => ({
            runtimeCore: {
                createSessionRuntime: vi.fn(async () => ({ owner: 'legacy-host-session' })),
                createExecutionRunBackend: vi.fn(() => ({ owner: 'legacy-host-execution' })),
            },
        }));
        const contributes = seedFirstPartyOwnerRegistry({
            backendId,
            pluginId,
            runtimeCoreFactory,
        });

        const registry = await resolveCliEngineRegistry({
            contributes:
                contributes as unknown as NonNullable<ResolveEngineRegistryParams['contributes']>,
            requireDaemonAgentRuntimeCarrier: true,
        });

        await expect(registry.resolveForBackendId(backendId)).resolves.toMatchObject({
            runtimeOwner: {
                selected: {
                    kind: 'legacy_host',
                    ownerId: backendId,
                },
            },
        });
        expect(resolveExecutablePluginRuntimeRegistryMock).not.toHaveBeenCalled();
    });

    it('fails closed when legacy host and plugin runtime owners both exist', async () => {
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
        const createPluginRuntime = vi.fn(async (): Promise<AgentRuntime> => ({
            sessions: { open: async () => { throw new Error('not invoked'); } },
        }));
        resolveExecutablePluginRuntimeRegistryMock.mockResolvedValue(createRuntimeRegistry({
            contributes,
            backendId,
            pluginId,
            createRuntime: createPluginRuntime,
        }));

        const resolution = await resolveBackendEngineAdapterResolution(
            backendId,
            await createInjectedRuntimeRegistryParams(),
        );

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
        expect(createPluginRuntime).not.toHaveBeenCalled();
        expect(hostRuntimeCore.createSessionRuntime).not.toHaveBeenCalled();
        expect(hostRuntimeCore.createExecutionRunBackend).not.toHaveBeenCalled();
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
        const { runtimeRegistry } = await createInjectedRuntimeRegistryParams();
        pluginReloadControllerStateMock.mockReturnValue({
            generation: 1,
            activeRegistry: runtimeRegistry,
            lastResult: null,
        });

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
            hookHandlersByHookId: new Map(),
            pluginDiagnosticsByPluginId: {},
            dispose: vi.fn(async () => undefined),
        });
        resolvePluginBackendSurfaceHandlersMock.mockResolvedValue({
            diagnostics: [],
        });
        const registry = await resolveCliEngineRegistry(
            await createInjectedRuntimeRegistryParams(),
        );
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
            agent: expect.objectContaining({
                id: 'acme.sample.provider',
                provenance: 'external',
                source: { kind: 'path' },
            }),
            executionSurfaces: expect.objectContaining({
                terminalRuntime: null,
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
                        actions: [],
                        catalogEntriesById: {},
            agentDefinitionsById: new Map(),
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

        const authoritativeRuntimeRegistry = completeLeaseRuntimeRegistryFixture({
            contributes: authoritativeContributions,
            hookHandlersByHookId: new Map(),
            pluginDiagnosticsByPluginId: {},
            dispose: vi.fn(async () => undefined),
        }, authoritativeContributions);
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
