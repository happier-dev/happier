import { initialMachineMetadata } from '@/daemon/startDaemon';
import { formatProviderPromptErrorMessage } from '@/agent/runtime/formatProviderPromptErrorMessage';
import { configuration } from '@/configuration';
import type {
    HostSessionRuntimeConfig,
} from '@/agent/runtime/sessionLoop/runHostSessionRuntime';
import {
    HOST_SESSION_RUNTIME_PLAN_KIND,
    type HostSessionRuntimePlan,
} from '@/agent/runtime/sessionLoop/lifecycle';
import { resolveSessionRollbackRuntimeFacet } from '@/agent/runtime/sessionLoop/sessionRollbackRpc';
import type { RuntimeTurnStartOrLoadOptions } from '@/agent/runtime/turns/runtimeTurnOperations';
import {
    resolveCodexSpawnExtrasForRuntime,
    resolveCodexSessionBackendMode,
    resolveVendorResumeIdFromSessionMetadata,
    type CodexBackendMode,
} from '@happier-dev/agents';

import { isExperimentalCodexAcpEnabled } from '../../experiments';
import { createCodexAcpRuntime } from '../../acp/runtime';
import { createCodexAppServerRuntime } from '../../appServer/runtime';
import { buildCodexAppServerConfigOverrides } from '../../appServer/buildCodexAppServerConfigOverrides';
import { seedCodexAppServerPendingSessionOverrides } from '../../appServer/seedPendingSessionOverrides';
import { CodexTerminalDisplay } from '../../ui/CodexTerminalDisplay';
import { publishInFlightSteerCapability } from '../../utils/publishInFlightSteerCapability';
import { resolveCodexBackendModeForRun } from '../../utils/resolveCodexBackendModeForRun';
import {
    createCodexDeferredStartupSession,
    shouldUseCodexDeferredStartup,
    type CodexDeferredStartupState,
} from '../startup/createDeferredStartupSession';
import { createCodexTerminalRuntime } from '../terminal/createTerminalRuntime';
import { createCodexMcpRuntime } from '../remote/createMcpRuntime';
import type {
    CodexNativeRuntime,
    CodexSessionRuntimeOptions,
} from './types';

function resolveCodexBackendMode(opts: CodexSessionRuntimeOptions): CodexBackendMode {
    if (opts.codexBackendMode === 'acp' || opts.codexBackendMode === 'mcp' || opts.codexBackendMode === 'appServer') {
        return opts.codexBackendMode;
    }
    const preferredBackendMode = resolveCodexSpawnExtrasForRuntime({
        settings: opts.accountSettingsContext?.settings ?? {},
        processEnv: process.env,
    }).codexBackendMode;
    return resolveCodexBackendModeForRun({
        codexBackendMode: preferredBackendMode,
        experimentalCodexAcpEnabledByDefault: isExperimentalCodexAcpEnabled(),
    });
}

function resolveAttachedCodexAppServerThreadId(metadata: unknown): string | null {
    if (resolveCodexSessionBackendMode({ metadata }) !== 'appServer') {
        return null;
    }
    return resolveVendorResumeIdFromSessionMetadata('codex', metadata);
}

export function createCodexSessionRuntime(sessionParams: unknown): HostSessionRuntimePlan {
    const opts = sessionParams as CodexSessionRuntimeOptions;
    const backendMode = resolveCodexBackendMode(opts);
    const startupRef: CodexDeferredStartupState = {
        backgroundStartPromise: null,
        terminalLaunchPromise: null,
        startupState: null,
        markVendorSpawnInvoked: null,
    };
    const useDeferredStartup = shouldUseCodexDeferredStartup(opts, backendMode);

    return {
        kind: HOST_SESSION_RUNTIME_PLAN_KIND,
        providerId: 'codex',
        opts,
        config: {
            flavor: 'codex',
            policyAgentId: 'codex',
            backendDisplayName: 'Codex',
            uiLogPrefix: '[Codex]',
            providerName: 'Codex',
            waitingForCommandLabel: 'Codex',
            agentMessageType: 'codex',
            machineMetadata: initialMachineMetadata,
            terminalDisplay: CodexTerminalDisplay as HostSessionRuntimeConfig['terminalDisplay'],
            startRuntimeBeforeFirstPrompt: useDeferredStartup,
            startupBootstrap: {
                shouldCreate: () => useDeferredStartup,
                create: async ({ opts }) =>
                    await createCodexDeferredStartupSession({
                        opts: opts as CodexSessionRuntimeOptions,
                        backendMode,
                        startupRef,
                    }),
            },
            resolveInitialResumeId: ({ metadata }) => backendMode === 'appServer'
                ? resolveAttachedCodexAppServerThreadId(metadata)
                : null,
            resolveRunnerMcpServersAccountSettings: ({ opts }) =>
                typeof opts.resume === 'string' && opts.resume.trim().length > 0
                    ? null
                    : opts.accountSettingsContext?.settings ?? null,
            createSessionRuntime: async (params) => {
                const createRemoteRuntime = async (): Promise<CodexNativeRuntime> => {
                    if (backendMode === 'acp') {
                        return createCodexAcpRuntime({
                            directory: params.directory,
                            session: params.session,
                            transcriptSession: params.transcriptSession,
                            messageBuffer: params.messageBuffer,
                            mcpServers: params.mcpServers,
                            permissionHandler: params.permissionHandler,
                            permissionMode: params.getPermissionMode?.() ?? 'default',
                            getPermissionMode: params.getPermissionMode,
                            onThinkingChange: params.setThinking,
                        });
                    }

                    if (backendMode === 'appServer') {
                        const nativeRuntime = createCodexAppServerRuntime({
                            directory: params.directory,
                            activeServerDir: configuration.activeServerDir,
                            processEnv: process.env,
                            configOverrides: buildCodexAppServerConfigOverrides(params.mcpServers),
                            session: params.session,
                            transcriptSession: params.transcriptSession,
                            onThinkingChange: params.setThinking,
                            permissionHandler: params.permissionHandler,
                            getPermissionMode: () => params.getPermissionMode?.() ?? 'default',
                        });
                        let didSeedPendingOverrides = false;
                        const startOrLoadNative = nativeRuntime.startOrLoad.bind(nativeRuntime);
                        type CodexAppServerRuntimeWithStartupSeed = CodexNativeRuntime & Pick<
                            typeof nativeRuntime,
                            'startOrLoad'
                        >;
                        const startOrLoadWithStartupOverrideSeed = async (
                            options: Parameters<typeof nativeRuntime.startOrLoad>[0],
                        ) => {
                            if (!didSeedPendingOverrides) {
                                didSeedPendingOverrides = true;
                                await seedCodexAppServerPendingSessionOverrides({
                                    metadata: params.session.getMetadataSnapshot?.() ?? params.metadata ?? null,
                                    runtime: nativeRuntime,
                                });
                            }
                            const explicitResumeId =
                                typeof options.resumeId === 'string' ? options.resumeId.trim() : '';
                            const explicitExistingSessionId =
                                typeof options.existingSessionId === 'string'
                                    ? options.existingSessionId.trim()
                                    : '';
                            const metadataExistingSessionId =
                                explicitResumeId || explicitExistingSessionId
                                    ? null
                                    : resolveAttachedCodexAppServerThreadId(
                                        params.session.getMetadataSnapshot?.() ?? params.metadata ?? null,
                                    );
                            await startOrLoadNative(
                                metadataExistingSessionId
                                    ? { ...options, existingSessionId: metadataExistingSessionId }
                                    : options,
                            );
                        };
                        const runtimeWithStartupSeed: CodexAppServerRuntimeWithStartupSeed = {
                            ...nativeRuntime,
                            startOrLoad: async (
                                options: Parameters<typeof nativeRuntime.startOrLoad>[0],
                            ) => {
                                await startOrLoadWithStartupOverrideSeed(options);
                            },
                            startOrLoadSession: async (
                                options?: RuntimeTurnStartOrLoadOptions,
                            ) => {
                                await startOrLoadWithStartupOverrideSeed({
                                    ...(typeof options?.resumeId === 'string'
                                        ? { resumeId: options.resumeId }
                                        : {}),
                                    ...(typeof options?.importHistory === 'boolean'
                                        ? { importHistory: options.importHistory }
                                        : {}),
                                });
                            },
                        };
                        return runtimeWithStartupSeed;
                    }

                    return await createCodexMcpRuntime(params);
                };

                const startupState = startupRef.startupState;
                if (startupState?.runtimeMode === 'terminal') {
                    const nativeRuntime = createCodexTerminalRuntime({
                        runtimeParams: params,
                        startupRef,
                        startupState,
                        createRemoteRuntime,
                    });
                    return {
                        operations: nativeRuntime,
                        nativeRuntime,
                    };
                }

                const nativeRuntime = await createRemoteRuntime();
                return {
                    operations: nativeRuntime,
                    nativeRuntime,
                };
            },
            lifecycleHooks: {
                onRuntimeCreated: ({ session, runtime }) => {
                    publishInFlightSteerCapability({
                        session,
                        runtime: {
                            supportsInFlightSteer: () => runtime.supportsInFlightSteer?.() === true,
                        },
                    });
                },
            },
            sessionRollbackRpc: {
                resolveRuntimeFacet: (runtime) => backendMode === 'appServer'
                    ? resolveSessionRollbackRuntimeFacet(runtime)
                    : null,
            },
            formatPromptErrorMessage: (error) => formatProviderPromptErrorMessage(error, {
                authHint: 'If this is an auth error, verify your Codex CLI login and Codex app-server/ACP configuration.',
            }),
        },
    };
}
