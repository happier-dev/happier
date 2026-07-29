import { randomUUID } from 'node:crypto';

import {
    isFeatureId,
} from '@happier-dev/protocol';
import type { AgentSessionHostServices } from '@happier-dev/plugin-sdk/agent-runtime';

import type { HostSessionRuntimeFactoryParams } from '@/agent/runtime/session/loop/runHostSessionRuntime';
import { resolveCliFeatureDecision } from '@/features/featureDecisionService';
import { resolvePluginMcpServersForSession } from '@/mcp/servers/resolvePluginMcpServersForSession';
import type {
    McpSessionResolutionInput,
    PluginMcpSessionResolver,
} from '@/mcp/runtimeTypes';
import { resolvePluginStorePaths } from '@/plugins/store/paths';
import type { ResolvedExecutablePluginRuntimeRegistry } from '@/plugins/runtime/resolveExecutablePluginRuntimeRegistry';
import { createSessionScopedAuthServices } from '@/plugins/runtime/context/session/services/auth';
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

export type NativeAgentSessionHostServiceOwners = Readonly<{
    features: Readonly<{ isEnabled(featureId: string): boolean }>;
    terminalHost?: AgentTerminalHostService;
    sessionHooks: HostSessionHooksOwner;
    transcripts: AgentSessionHostServices['transcripts'];
    accountUsage: NativeAgentAccountUsageService;
    auth: ReturnType<typeof createSessionScopedAuthServices>;
    mcp: PluginMcpSessionResolver;
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
    hostRuntimeParams: HostSessionRuntimeFactoryParams;
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
    const featureEnabledMemo = new Map<string, boolean>();
    const features = Object.freeze({
        isEnabled(featureId: string): boolean {
            const cached = featureEnabledMemo.get(featureId);
            if (cached !== undefined) return cached;
            const enabled = isFeatureId(featureId)
                && resolveCliFeatureDecision({
                    featureId,
                    env: process.env,
                }).state === 'enabled';
            featureEnabledMemo.set(featureId, enabled);
            return enabled;
        },
    });
    const catalogEntry = params.runtimeRegistry?.contributes.catalogEntriesById[
        params.agent.id
    ];
    const terminalHost = declaresTerminalSurface(params.agent)
        && authority.permissions.has('terminal.host.control')
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
    const auth = createSessionScopedAuthServices({
        readSessionId: async (signal) => {
            signal?.throwIfAborted();
            params.signal.throwIfAborted();
            return params.sessionId;
        },
    });
    const resolveBaseMcpServers = (
        input: McpSessionResolutionInput,
    ) => {
        params.signal.throwIfAborted();
        if (input.sessionId.trim() !== params.sessionId) return Object.freeze([]);
        return resolvePluginMcpServersForSession({
            input,
            accountSettings:
                params.hostRuntimeParams.accountSettings
                ?? readActivePluginAccountSettings(),
            machineId: params.hostRuntimeParams.machineId,
            directory: params.directory,
            sessionMetadata: params.hostRuntimeParams.session.getMetadataSnapshot(),
        });
    };
    const target = params.runtimeRegistry?.contributes.activationTargets.find((candidate) => (
        candidate.pluginId === params.identity.pluginId
    ));
    const pluginVersion = params.identity.pluginVersion ?? target?.manifest.version;
    const pluginMcp = pluginVersion && (target?.manifest.contributes.mcp.servers.length ?? 0) > 0
        ? (() => {
            const currentSession = createNativeAgentCurrentSessionUiServices({
                permissionHandler: params.hostRuntimeParams.permissionHandler,
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
    const accountUsage = createNativeAgentAccountUsageService({
        sessionId: params.sessionId,
        session: params.hostRuntimeParams.session,
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
        auth,
        mcp,
        dispose,
    });
}
