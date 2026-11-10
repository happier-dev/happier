import { randomUUID } from 'node:crypto';

import { AgentToolExecuteAfterHookPayloadSchema, AgentToolExecuteBeforeHookPayloadSchema } from '@happier-dev/protocol/plugins/hooks';
import { isFeatureId } from '@happier-dev/protocol/features/catalog';
import type { PluginExecutionInterceptionCapability, AccountSettings, PluginExecutionScopeV1, PluginSourceCustodyV1, SessionCapabilitySelectionV1 } from '@happier-dev/protocol';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
    AgentExecutionRunHostServicesV1,
    AgentSessionHostServices,
    AgentToolExecutionBeforeRequest,
    AgentToolExecutionBeforeResult,
} from '@happier-dev/plugin-sdk/agents/runtime';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { Metadata } from '@/api/types';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { configuration } from '@/configuration';
import { verifySessionStructuredImageInput } from '@/session/attachments/resolveTrustedSessionAttachmentLocalImagePaths';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import type { ResolvedSessionMcpServer } from '@/mcp/runtimeTypes';
import { readDaemonPluginCatalog } from '@/daemon/controlClient';
import type { ProjectedPluginToolCatalogEntry } from '@/plugins/runtime/toolCatalog';
import { McpServerCatalogUnavailableError } from '@/mcp/servers/readMcpServersSettingsFromAccountSettings';
import type {
    McpSessionResolutionInput,
    PluginMcpSessionResolver,
} from '@/mcp/runtimeTypes';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createDefaultPluginTerminalHostService } from '@/plugins/runtime/context/terminalHost';
import { createPluginTranscriptFileFollowService } from '@/plugins/runtime/context/transcripts/fileFollow';
import { createTranscriptFileFollowPathGrantRegistry } from '@/plugins/runtime/context/transcripts/fileFollowGrants';
import {
    createSessionHooksService,
    type HostSessionHooksOwner,
} from '@/plugins/runtime/hooks/session/service';
import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import { createDaemonRuntimeAuthRefreshService, type RuntimeAuthRefreshViaDaemon } from '@/plugins/runtime/context/runtimeAuthRefresh';
import type {
    EngineResolutionAgent,
    EngineResolutionBackend,
} from '../engineRegistryTypes';

import {
    createNativeAgentAccountUsageService,
    type NativeAgentAccountUsageService,
} from './nativeAgentAccountUsage';

type AgentTerminalHostService = NonNullable<AgentSessionHostServices['terminalHost']>;
import {
    materializePluginRuntimeAuthority,
    snapshotActivatedPluginRuntimeAuthority,
    type PluginRuntimeAuthoritySnapshotV1,
} from '@/plugins/runtime/lifecycle/activation/runtimeAuthority';
import {
    interceptAgentToolExecutionThroughRuntimeRegistry,
    observeAgentToolExecutionThroughRuntimeRegistry,
} from '@/plugins/runtime/hooks/execution/dispatchExecutionInterceptionHooks';

type NativeAgentToolExecutionOwner = Readonly<{
    before(
        request: AgentToolExecutionBeforeRequest,
        options?: Readonly<{ signal?: AbortSignal }>,
    ): Promise<AgentToolExecutionBeforeResult>;
    observeAfter(request: Readonly<{
        capability: PluginExecutionInterceptionCapability;
        turnId: string;
        callId: string;
        name: string;
        input: JsonValue;
        outcome: Readonly<
            | { status: 'succeeded'; result?: JsonValue }
            | { status: 'failed'; code: string; message?: string }
            | { status: 'cancelled' }
            | { status: 'rejected'; code?: string; message?: string }
        >;
        timestampMs: number;
    }>): Promise<void>;
}>;

export type NativeAgentSessionHostServiceOwners = Readonly<{
    features: Readonly<{ isEnabled(featureId: string): boolean }>;
    happierTools: Readonly<{
        readPluginToolCatalog(signal?: AbortSignal): Promise<readonly ProjectedPluginToolCatalogEntry[]>;
    }>;
    terminalHost?: AgentTerminalHostService;
    sessionHooks: HostSessionHooksOwner;
    transcripts: Pick<AgentSessionHostServices['transcripts'], 'fileFollow'>;
    accountUsage: NativeAgentAccountUsageService;
    mcp: PluginMcpSessionResolver;
    toolExecution: NativeAgentToolExecutionOwner;
    dispose(): Promise<void>;
}>;

type Disposable = Readonly<{ dispose(): void | Promise<void> }>;

/** One verified-image boundary for Session and detached Run lifetimes. */
export function createNativeAgentInputFilesService(params: Readonly<{
    signal: AbortSignal;
    directory: string;
    sessionId?: string;
    assertAvailable(): void;
}>): NonNullable<AgentSessionHostServices['inputFiles']> {
    return Object.freeze({
        async readVerifiedImage(input, options) {
            params.assertAvailable();
            const signal = options?.signal ? AbortSignal.any([params.signal, options.signal]) : params.signal;
            signal.throwIfAborted();
            const verification = await verifySessionStructuredImageInput({
                cwd: params.directory,
                ...(params.sessionId ? { sessionId: params.sessionId } : {}),
                image: input,
                maxBytes: configuration.filesUploadMaxFileBytes,
            });
            params.assertAvailable();
            signal.throwIfAborted();
            if (verification.status !== 'verified') return null;
            return Object.freeze({
                url: `data:${verification.mimeType};base64,${verification.bytes.toString('base64')}`,
                mimeType: verification.mimeType,
                filename: verification.filename,
            });
        },
    });
}

export function createNativeAgentFeatureService(
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null,
): AgentSessionHostServices['features'] {
    return Object.freeze({
        // Decided at every read through the canonical CLI feature-decision owner.
        // An unknown id is permanently unsupported, but a known id's decision is a
        // property of the current environment and policy, not of one Session or Run.
        isEnabled: (featureId: string): boolean => {
            if (!isFeatureId(featureId)) return false;
            const serverSnapshot = runtimeRegistry?.resolveServerFeaturesSnapshot?.();
            return resolveCliFeatureDecision({
                featureId,
                env: process.env,
                ...(serverSnapshot ? { serverSnapshot } : {}),
            }).state === 'enabled';
        },
    });
}

function createNativeAgentToolExecutionOwner(params: Readonly<{
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    pluginId: string;
    agentId: string;
    sessionId?: string;
    signal?: AbortSignal;
}>): NativeAgentToolExecutionOwner {
    return Object.freeze({
        async before(request, options) {
            params.signal?.throwIfAborted();
            options?.signal?.throwIfAborted();
            const payload = AgentToolExecuteBeforeHookPayloadSchema.parse({
                agentId: params.agentId,
                runtimeFamily: 'hostSession',
                capability: 'interceptable',
                ...(params.sessionId ? { sessionId: params.sessionId } : {}),
                ...(request.turnId ? { turnId: request.turnId } : {}),
                tool: {
                    callId: request.callId,
                    name: request.name,
                    input: request.input,
                },
                timestampMs: Date.now(),
            });
            if (!params.runtimeRegistry) {
                return { status: 'continue', input: payload.tool.input };
            }
            const result = await interceptAgentToolExecutionThroughRuntimeRegistry({
                runtimeRegistry: params.runtimeRegistry,
                payload,
                ...(options?.signal ? { signal: options.signal } : {}),
            });
            if (result.status !== 'continue') return result;
            const transformed = AgentToolExecuteBeforeHookPayloadSchema.parse({
                ...payload,
                tool: { ...payload.tool, input: result.input },
            });
            return { status: 'continue', input: transformed.tool.input };
        },
        async observeAfter(request) {
            params.signal?.throwIfAborted();
            if (!params.runtimeRegistry) return;
            const payload = AgentToolExecuteAfterHookPayloadSchema.parse({
                agentId: params.agentId,
                runtimeFamily: 'hostSession',
                capability: request.capability,
                caller: { kind: 'plugin', pluginId: params.pluginId },
                ...(params.sessionId ? { sessionId: params.sessionId } : {}),
                turnId: request.turnId,
                tool: {
                    callId: request.callId,
                    name: request.name,
                    input: request.input,
                },
                outcome: request.outcome,
                timestampMs: request.timestampMs,
            });
            await observeAgentToolExecutionThroughRuntimeRegistry({
                runtimeRegistry: params.runtimeRegistry,
                payload,
            });
        },
    });
}

/**
 * Supplies the host-owned services that are meaningful for a detached Agent Run.
 * Session-persistent projections stay explicitly unavailable: a Run id is not a
 * Happier Session id and must never be used to manufacture Session custody.
 */
export function createNativeAgentExecutionRunHostServices(params: Readonly<{
    permissions?: AgentExecutionRunHostServicesV1['permissions'];
    signal: AbortSignal;
    executionRunId: string;
    directory: string;
    machineId: string;
    accountSettings: AccountSettings | null;
    resolveAccountSettingsSnapshot?: (input?: Readonly<{ mcpServerCatalog?: boolean; savedSecretReferences?: readonly import('@/settings/secrets/hydrateSavedSecretCatalog').SavedSecretOperationReferenceV1[]; signal?: AbortSignal }>) => Promise<ActiveAccountSettingsSnapshot | null>;
    capabilitySelection?: SessionCapabilitySelectionV1;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    runtimeAuthority?: PluginRuntimeAuthoritySnapshotV1;
    pluginId: string;
    agentId: string;
    happyHomeDir?: string;
    nativeHome?: AgentExecutionRunHostServicesV1['nativeHome'];
    refreshRuntimeAuthViaDaemon?: RuntimeAuthRefreshViaDaemon;
    readResolvedMcpServers?: () => readonly ResolvedSessionMcpServer[];
}>): AgentExecutionRunHostServicesV1 & Disposable {
    const assertActive = (): void => {
        params.signal.throwIfAborted();
        if (disposePromise) throw new Error('Execution Run host services are disposed');
    };
    const runtimeId = `native-agent-run:${params.pluginId}:${params.agentId}:${randomUUID()}`;
    const storePaths = resolvePluginStorePaths({ happyHomeDir: params.happyHomeDir });
    const authority = materializePluginRuntimeAuthority(
        params.runtimeAuthority
        ?? snapshotActivatedPluginRuntimeAuthority(params.runtimeRegistry, params.pluginId),
    );
    const disposables = new Set<Disposable>();
    let disposePromise: Promise<void> | null = null;
    const addDisposable = (candidate: Disposable): Disposable => {
        disposables.add(candidate);
        return candidate;
    };
    const scope: PluginExecutionScopeV1 = Object.freeze({
        kind: 'execution_run',
        executionRunId: params.executionRunId,
    });
    const fileFollowPathGrants = createTranscriptFileFollowPathGrantRegistry();
    addDisposable({
        dispose: () => fileFollowPathGrants.revokeScope({
            pluginId: params.pluginId,
            runtimeId,
            scope,
        }),
    });
    const sessionHooksOwner = createSessionHooksService({
        happyHomeDir: storePaths.happyHomeDir,
        hasCapability: (capability) => authority.capabilities.has(capability),
        addDisposable,
        grantTranscriptFileFollowPath: async (request) => {
            await fileFollowPathGrants.grant({
                pluginId: params.pluginId,
                runtimeId,
                scope,
                path: request.transcriptPath,
                reason: 'providerTranscriptSource',
                evidence: request.evidence,
            });
        },
    });
    const fileFollow = createPluginTranscriptFileFollowService({
        addDisposable,
        pluginId: params.pluginId,
        runtimeId,
        readScope: () => scope,
        fileFollowPathGrants,
    });
    const featureOwner = createNativeAgentFeatureService(params.runtimeRegistry);
    const toolExecutionOwner = createNativeAgentToolExecutionOwner({
        runtimeRegistry: params.runtimeRegistry,
        pluginId: params.pluginId,
        agentId: params.agentId,
        signal: params.signal,
    });
    const dispose = (): Promise<void> => {
        disposePromise ??= (async () => {
            const results = await Promise.allSettled(
                [...disposables].reverse().map(async (candidate) => {
                    await candidate.dispose();
                }),
            );
            disposables.clear();
            const failure = results.find(
                (result): result is PromiseRejectedResult => result.status === 'rejected',
            );
            if (failure) throw failure.reason;
        })();
        return disposePromise;
    };
    const disposeOnAbort = () => {
        void dispose().catch(() => undefined);
    };
    if (params.signal.aborted) disposeOnAbort();
    else params.signal.addEventListener('abort', disposeOnAbort, { once: true });
    const authServices = params.refreshRuntimeAuthViaDaemon
        ? createDaemonRuntimeAuthRefreshService({ refreshViaDaemon: params.refreshRuntimeAuthViaDaemon })
        : null;
    return Object.freeze({
        ...(params.permissions ? { permissions: params.permissions } : {}),
        ...(params.nativeHome ? { nativeHome: Object.freeze({
            async readFiles(fileIds: readonly string[]) {
                assertActive();
                const files = await params.nativeHome!.readFiles(fileIds);
                assertActive();
                return files;
            },
        }) } : {}),
        inputFiles: createNativeAgentInputFilesService({
            signal: params.signal,
            directory: params.directory,
            assertAvailable: assertActive,
        }),
        ...(authServices ? { auth: Object.freeze({ services: Object.freeze({
            async refreshRuntimeAuth(...args: Parameters<typeof authServices.refreshRuntimeAuth>) {
                assertActive();
                const [request, options] = args;
                return await authServices.refreshRuntimeAuth(request, {
                    signal: options?.signal ? AbortSignal.any([params.signal, options.signal]) : params.signal,
                });
            },
        }) }) } : {}),
        features: Object.freeze({
            isEnabled: (featureId: string) => (
                !params.signal.aborted && featureOwner.isEnabled(featureId)
            ),
        }),
        hooks: Object.freeze({
            async observeSessionHook(request: Parameters<AgentExecutionRunHostServicesV1['hooks']['observeSessionHook']>[0]) {
                assertActive();
                await sessionHooksOwner.observeSessionHook({ ...request, providerId: params.agentId, scope });
            },
            async startServer(request: Parameters<AgentExecutionRunHostServicesV1['hooks']['startServer']>[0]) {
                assertActive();
                return await sessionHooksOwner.startServer({
                    ...request,
                    providerId: params.agentId,
                    scope,
                });
            },
            async resolveForwarderAssets() {
                assertActive();
                return await sessionHooksOwner.resolveForwarderAssets();
            },
            async createPluginDir(request: Parameters<AgentExecutionRunHostServicesV1['hooks']['createPluginDir']>[0]) {
                assertActive();
                return await sessionHooksOwner.createPluginDir({
                    ...request,
                    providerId: params.agentId,
                    scope,
                });
            },
            async disposePluginDir(pluginDir: Parameters<HostSessionHooksOwner['disposePluginDir']>[0]) {
                return await sessionHooksOwner.disposePluginDir(pluginDir);
            },
        }),
        fileFollow: Object.freeze({
            async follow(input: Parameters<typeof fileFollow.follow>[0]) {
                assertActive();
                return await fileFollow.follow(input);
            },
        }),
        mcp: Object.freeze({
            async resolveServers(options: Parameters<AgentSessionHostServices['mcp']['resolveServers']>[0]) {
                assertActive();
                options?.signal?.throwIfAborted();
                if (params.resolveAccountSettingsSnapshot) {
                    const snapshot = await params.resolveAccountSettingsSnapshot({ mcpServerCatalog: true, signal: params.signal });
                    if (!snapshot) throw new McpServerCatalogUnavailableError('scope-retired');
                }
                assertActive();
                options?.signal?.throwIfAborted();
                const servers = params.readResolvedMcpServers?.() ?? [];
                return Object.freeze(servers.map((server) => Object.freeze({
                    id: server.id,
                    name: server.name,
                    transport: server.transport.kind === 'http' || server.transport.kind === 'sse'
                        ? Object.freeze({ kind: server.transport.kind, url: server.transport.url })
                        : Object.freeze({ kind: server.transport.kind }),
                })));
            },
        }),
        toolExecution: Object.freeze({
            before: toolExecutionOwner.before,
        }),
        dispose,
    });
}

function declaresTerminalSurface(agent: EngineResolutionAgent): boolean {
    return agent.richDefinition?.definition.capabilities.surfaces?.includes('terminal') === true;
}

export function createNativeAgentSessionHostServiceOwners(params: Readonly<{
    executionRunId?: string;
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    runtimeAuthority?: PluginRuntimeAuthoritySnapshotV1;
    identity: Readonly<{
        pluginId: string;
        agentId: string;
        pluginVersion?: string;
        occurrenceId: string;
        sourceCustody?: PluginSourceCustodyV1;
        isCurrent?(): boolean;
    }>;
    backend: EngineResolutionBackend;
    agent: EngineResolutionAgent;
    hostSession: Readonly<{
        session: Pick<ApiSessionClient, 'getMetadataSnapshot'>;
        machineId: string;
        accountSettings?: AccountSettings | null;
        resolveAccountSettingsSnapshot?: (input?: Readonly<{ mcpServerCatalog?: boolean; savedSecretReferences?: readonly import('@/settings/secrets/hydrateSavedSecretCatalog').SavedSecretOperationReferenceV1[]; signal?: AbortSignal }>) => Promise<ActiveAccountSettingsSnapshot | null>;
        accountSettingsAuthority?: 'account' | 'session';
        readResolvedMcpServers?: () => readonly ResolvedSessionMcpServer[];
        resolveMcpToolNaming?: import('@happier-dev/plugin-sdk/agents/runtime').AgentSessionMcpService['resolveToolNaming'];
        permissionHandler: Pick<ProviderEnforcedPermissionHandler, 'handleToolCall'>;
    }>;
    sessionId: string;
    directory: string;
    signal: AbortSignal;
    happyHomeDir?: string;
    currentTerminalMetadata?: Readonly<Pick<Metadata, 'terminal' | 'startedBy'>>;
}>): NativeAgentSessionHostServiceOwners {
    const runtimeId = `native-agent-session:${params.identity.pluginId}:${params.identity.agentId}:${randomUUID()}`;
    const storePaths = resolvePluginStorePaths({ happyHomeDir: params.happyHomeDir });
    const authority = materializePluginRuntimeAuthority(
        params.runtimeAuthority
        ?? snapshotActivatedPluginRuntimeAuthority(
            params.runtimeRegistry,
            params.identity.pluginId,
        ),
    );
    const hasCapability = (capability: string): boolean => (
        authority.capabilities.has(capability)
    );
    const disposables = new Set<Disposable>();
    let disposePromise: Promise<void> | null = null;
    const addDisposable = (disposable: Disposable): Disposable => {
        disposables.add(disposable);
        return disposable;
    };
    const fileFollowPathGrants = createTranscriptFileFollowPathGrantRegistry();
    addDisposable({
        dispose: () => fileFollowPathGrants.revokeScope({
            pluginId: params.identity.pluginId,
            runtimeId,
            scope: { kind: 'session', sessionId: params.sessionId },
        }),
    });
    const sessionHooks = createSessionHooksService({
        happyHomeDir: storePaths.happyHomeDir,
        hasCapability,
        addDisposable,
        grantTranscriptFileFollowPath: async (request) => {
            await fileFollowPathGrants.grant({
                pluginId: params.identity.pluginId,
                runtimeId,
                scope: { kind: 'session', sessionId: params.sessionId },
                path: request.transcriptPath,
                reason: 'providerTranscriptSource',
                evidence: request.evidence,
            });
        },
    });
    const fileFollow = createPluginTranscriptFileFollowService({
        addDisposable,
        pluginId: params.identity.pluginId,
        runtimeId,
        readSessionId: () => params.sessionId,
        fileFollowPathGrants,
    });
    const features = createNativeAgentFeatureService(params.runtimeRegistry);
    const happierTools = Object.freeze({
        async readPluginToolCatalog(signal?: AbortSignal): Promise<readonly ProjectedPluginToolCatalogEntry[]> {
            signal?.throwIfAborted();
            const catalog = await readDaemonPluginCatalog({
                selection: 'tools',
                ...(signal ? { signal } : {}),
            }).catch(() => ({ kind: 'unavailable' as const }));
            signal?.throwIfAborted();
            return catalog.kind === 'available' ? catalog.tools : Object.freeze([]);
        },
    });
    const catalogEntry = params.runtimeRegistry?.contributes.catalogEntriesById[
        params.agent.id
    ];
    const terminalHost = declaresTerminalSurface(params.agent)
        && authority.capabilities.has('terminalHost')
        ? createDefaultPluginTerminalHostService({
            happyHomeDir: storePaths.happyHomeDir,
            ...(params.executionRunId ? { executionRunId: params.executionRunId } : {}),
            hasCapability,
            readSessionId: () => params.sessionId,
            readSessionMetadata: () => params.hostSession.session.getMetadataSnapshot(),
            ...(params.currentTerminalMetadata ? { currentTerminalMetadata: params.currentTerminalMetadata } : {}),
            ...(catalogEntry?.getTerminalPromptSubmitVerificationPolicy
                ? {
                    resolvePromptSubmitVerification:
                        catalogEntry.getTerminalPromptSubmitVerificationPolicy,
                }
                : {}),
        })
        : undefined;
    const resolveBaseMcpServers = async (
        input: McpSessionResolutionInput,
    ) => {
        params.signal.throwIfAborted();
        if (input.sessionId?.trim() !== params.sessionId) return Object.freeze([]);
        if (params.hostSession.accountSettingsAuthority === 'session') return Object.freeze([]);
        const accountSettingsSnapshot = params.hostSession.resolveAccountSettingsSnapshot
            ? await params.hostSession.resolveAccountSettingsSnapshot({ mcpServerCatalog: true, signal: params.signal })
            : null;
        params.signal.throwIfAborted();
        if (!accountSettingsSnapshot && params.hostSession.accountSettingsAuthority === 'account') {
            throw new McpServerCatalogUnavailableError('scope-retired');
        }
        return params.hostSession.readResolvedMcpServers?.() ?? Object.freeze([]);
    };
    const mcp: PluginMcpSessionResolver = Object.freeze({
        resolveForSession: resolveBaseMcpServers,
        ...(params.hostSession.resolveMcpToolNaming ? { resolveToolNaming: params.hostSession.resolveMcpToolNaming } : {}),
    });
    const toolExecution = createNativeAgentToolExecutionOwner({
        runtimeRegistry: params.runtimeRegistry,
        pluginId: params.identity.pluginId,
        agentId: params.identity.agentId,
        sessionId: params.sessionId,
    });
    const accountUsage = createNativeAgentAccountUsageService({
        pluginId: params.identity.pluginId,
        sessionId: params.sessionId,
        session: params.hostSession.session,
        signal: params.signal,
    });
    const dispose = (): Promise<void> => {
        disposePromise ??= (async () => {
            const results = await Promise.allSettled(
                [...disposables].reverse().map(async (disposable) => {
                    await disposable.dispose();
                }),
            );
            disposables.clear();
            const failure = results.find(
                (result): result is PromiseRejectedResult => result.status === 'rejected',
            );
            if (failure) throw failure.reason;
        })();
        return disposePromise;
    };
    const disposeOnAbort = () => {
        void dispose().catch(() => undefined);
    };
    if (params.signal.aborted) disposeOnAbort();
    else params.signal.addEventListener('abort', disposeOnAbort, { once: true });

    return Object.freeze({
        features,
        happierTools,
        ...(terminalHost ? { terminalHost } : {}),
        sessionHooks,
        transcripts: Object.freeze({ fileFollow }),
        accountUsage,
        mcp,
        toolExecution,
        dispose,
    });
}
