import { randomUUID } from 'node:crypto';

import {
    AgentToolExecuteAfterHookPayloadSchema,
    AgentToolExecuteBeforeHookPayloadSchema,
    isFeatureId,
    type PluginExecutionInterceptionCapability,
} from '@happier-dev/protocol';
import type { JsonValue } from '@happier-dev/plugin-sdk';
import type {
    AgentSessionHostServices,
    AgentToolExecutionBeforeRequest,
    AgentToolExecutionBeforeResult,
} from '@happier-dev/plugin-sdk/agents/runtime';

import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { ProviderEnforcedPermissionHandler } from '@/agent/permissions/providerEnforced/handler';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { resolvePluginMcpServersForSession } from '@/mcp/servers/resolvePluginMcpServersForSession';
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
import { readActivePluginAccountSettings } from '@/plugins/runtime/context/accountSettingsStorage';
import type {
    ResolvedAgentContribution,
    ResolvedAgentRuntimeContribution,
} from '@/plugins/projection/registry/types';

import {
    createNativeAgentAccountUsageService,
    type NativeAgentAccountUsageService,
} from './nativeAgentAccountUsage';

type AgentTerminalHostService = NonNullable<AgentSessionHostServices['terminalHost']>;
import {
    createNativeAgentCurrentSessionUiServices,
} from './nativeAgentSessionInteractions';
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
    terminalHost?: AgentTerminalHostService;
    sessionHooks: HostSessionHooksOwner;
    transcripts: Pick<AgentSessionHostServices['transcripts'], 'fileFollow'>;
    accountUsage: NativeAgentAccountUsageService;
    mcp: PluginMcpSessionResolver;
    toolExecution: NativeAgentToolExecutionOwner;
    dispose(): Promise<void>;
}>;

type Disposable = Readonly<{ dispose(): void | Promise<void> }>;

function declaresTerminalSurface(agent: ResolvedAgentContribution): boolean {
    return agent.richDefinition?.definition.capabilities.surfaces?.includes('terminal') === true;
}

export function createNativeAgentSessionHostServiceOwners(params: Readonly<{
    runtimeRegistry: ResolvedExecutablePluginRuntimeRegistry | null;
    runtimeAuthority?: PluginRuntimeAuthoritySnapshotV1;
    identity: Readonly<{
        pluginId: string;
        agentId: string;
        pluginVersion?: string;
        generation?: string;
        isCurrent?(): boolean;
    }>;
    backend: ResolvedAgentRuntimeContribution;
    agent: ResolvedAgentContribution;
    hostSession: Readonly<{
        session: Pick<ApiSessionClient, 'getMetadataSnapshot'>;
        machineId: string;
        accountSettings?: Readonly<Record<string, unknown>> | null;
        permissionHandler: Pick<ProviderEnforcedPermissionHandler, 'handleToolCall'>;
    }>;
    sessionId: string;
    directory: string;
    signal: AbortSignal;
    happyHomeDir?: string;
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
            sessionId: params.sessionId,
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
                sessionId: params.sessionId,
                path: request.transcriptPath,
                reason: 'providerTranscriptSource',
                evidence: {
                    kind: 'sessionStartTranscriptPath',
                    providerSessionId: request.providerSessionId,
                },
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
    const features = Object.freeze({
        // Decided at every read through the canonical CLI feature-decision owner.
        // An unknown id is permanently unsupported, but a known id's decision is a
        // property of the current environment and policy, not of this session
        // runtime: caching the first answer would report a decision that was
        // merely unavailable at open time as unavailable for the whole session.
        isEnabled: (featureId: string): boolean => {
            if (!isFeatureId(featureId)) return false;
            // A server-represented feature is undecidable without the daemon's retained
            // snapshot, so omitting it would report every such feature as permanently
            // disabled to plugins. The resolved runtime carries the one daemon snapshot
            // resolver; this reads it fresh so a later refresh is observed.
            const serverSnapshot = params.runtimeRegistry?.resolveServerFeaturesSnapshot?.();
            return resolveCliFeatureDecision({
                featureId,
                env: process.env,
                ...(serverSnapshot ? { serverSnapshot } : {}),
            }).state === 'enabled';
        },
    });
    const catalogEntry = params.runtimeRegistry?.contributes.catalogEntriesById[
        params.agent.id
    ];
    const terminalHost = declaresTerminalSurface(params.agent)
        && authority.capabilities.has('terminalHost')
        ? createDefaultPluginTerminalHostService({
            happyHomeDir: storePaths.happyHomeDir,
            hasCapability,
            readSessionId: () => params.sessionId,
            ...(catalogEntry?.getTerminalPromptSubmitVerificationPolicy
                ? {
                    resolvePromptSubmitVerification:
                        catalogEntry.getTerminalPromptSubmitVerificationPolicy,
                }
                : {}),
        })
        : undefined;
    const resolveBaseMcpServers = (
        input: McpSessionResolutionInput,
    ) => {
        params.signal.throwIfAborted();
        if (input.sessionId.trim() !== params.sessionId) return Object.freeze([]);
        return resolvePluginMcpServersForSession({
            input,
            accountSettings:
                params.hostSession.accountSettings
                ?? readActivePluginAccountSettings(),
            machineId: params.hostSession.machineId,
            directory: params.directory,
            sessionMetadata: params.hostSession.session.getMetadataSnapshot(),
        });
    };
    const target = params.runtimeRegistry?.contributes.activationTargets.find((candidate) => (
        candidate.pluginId === params.identity.pluginId
    ));
    const pluginVersion = params.identity.pluginVersion ?? target?.manifest.version;
    const pluginMcp = pluginVersion && (target?.manifest.contributes.mcp.servers.length ?? 0) > 0
        ? (() => {
            const currentSession = createNativeAgentCurrentSessionUiServices({
                permissionHandler: params.hostSession.permissionHandler,
                pluginId: params.identity.pluginId,
                contributionId: params.agent.identity?.localId ?? params.identity.agentId,
                runtimeId,
                sessionId: params.sessionId,
                generationId: params.identity.generation ?? String(params.runtimeRegistry?.generation ?? 'unavailable'),
                isCurrent: params.identity.isCurrent ?? (() => !params.signal.aborted),
                signal: params.signal,
            });
            return params.runtimeRegistry?.createPluginMcpSessionResolver?.({
                pluginId: params.identity.pluginId,
                pluginVersion,
                signal: params.signal,
                addDisposable,
                resolveHostSession: async (input) => {
                    if (params.signal.aborted || input.sessionId.trim() !== params.sessionId) return null;
                    return Object.freeze({
                        bindingId: runtimeId,
                        sessionId: params.sessionId,
                        directory: params.directory,
                        servers: resolveBaseMcpServers(input),
                        currentSession,
                    });
                },
            }) ?? null;
        })()
        : null;
    const mcp: PluginMcpSessionResolver = Object.freeze({
        resolveForSession: pluginMcp?.resolveForSession ?? (async (input) => resolveBaseMcpServers(input)),
    });
    const toolExecution: NativeAgentToolExecutionOwner = Object.freeze({
        async before(request, options) {
            const payload = AgentToolExecuteBeforeHookPayloadSchema.parse({
                agentId: params.identity.agentId,
                runtimeFamily: 'hostSession',
                capability: 'interceptable',
                sessionId: params.sessionId,
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
            if (!params.runtimeRegistry) return;
            const payload = AgentToolExecuteAfterHookPayloadSchema.parse({
                agentId: params.identity.agentId,
                runtimeFamily: 'hostSession',
                capability: request.capability,
                caller: { kind: 'plugin', pluginId: params.identity.pluginId },
                sessionId: params.sessionId,
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
    const accountUsage = createNativeAgentAccountUsageService({
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
        ...(terminalHost ? { terminalHost } : {}),
        sessionHooks,
        transcripts: Object.freeze({ fileFollow }),
        accountUsage,
        mcp,
        toolExecution,
        dispose,
    });
}
