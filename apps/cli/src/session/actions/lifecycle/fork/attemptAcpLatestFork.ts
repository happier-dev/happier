import { isAuthenticationError } from '@/api/client/httpStatusError';
import {
    SPAWN_SESSION_ERROR_CODES,
    type SpawnSessionOptions,
} from '@/rpc/handlers/registerSessionHandlers';
import { readCanonicalSpawnRuntimeSelection } from '@/rpc/handlers/spawnRuntimeSelection';
import { createConnectedServiceForkLaunchContext } from '@/session/fork/connectedServiceForkLaunchContext';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { isAmbiguousSpawnSessionFailure } from '@/session/shared/spawnNonce';
import type { ForkResultV1 } from '@happier-dev/agents';
import { applySessionStateUpdatesToMetadata } from '@happier-dev/agents/session/state/metadataWriters';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol';

import {
    archiveSessionBestEffort,
    cleanupForkChildBestEffort,
    fetchForkChildSessionOrThrow,
} from './forkChildSessionRecovery';
import { normalizeForkProviderSessionId } from './forkProviderSessionId';
import type {
    ForkBackendResolution,
    ForkBridgeSurface,
    ForkInheritedOverrides,
    ForkLifecycleCredentials,
    ForkLifecycleMetadata,
    ForkSpawnSession,
    ForkStopSession,
    ForkStrategyAttemptResult,
} from './forkLifecycleTypes';

export async function attemptAcpLatestFork(params: Readonly<{
    requestedStrategy: string;
    credentials: ForkLifecycleCredentials;
    parentSessionId: string;
    parentMetadata: ForkLifecycleMetadata;
    directory: string;
    effectiveCutoffSeqInclusive: number;
    forkIsConfiguredAcp: boolean;
    spawnNonce: string;
    forkBackendResolution: ForkBackendResolution;
    inheritedForkOverrides: ForkInheritedOverrides;
    forkSurface: ForkBridgeSurface;
    spawnSession: ForkSpawnSession;
    stopSession: ForkStopSession;
}>): Promise<ForkStrategyAttemptResult> {
    try {
        const spawnFinalForkResult = async (forked: ForkResultV1): Promise<ForkStrategyAttemptResult> => {
            const forkedProviderSessionId = normalizeForkProviderSessionId(forked.providerSessionId);
            if (!forkedProviderSessionId) {
                return {
                    ok: false,
                    errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                    errorMessage: 'ACP fork returned an empty providerSessionId',
                };
            }
            const launchMetadata = applySessionStateUpdatesToMetadata(
                {},
                forked.launch.sessionStateUpdates ?? [],
            );
            const runtimeDescriptorV1 = readRuntimeDescriptorV1FromMetadata(launchMetadata) ?? undefined;
            const runtimeSelection = readCanonicalSpawnRuntimeSelection({ runtimeDescriptorV1 });
            const providerBackendMode = runtimeSelection.providerBackendMode;
            const codexBackendMode = runtimeSelection.codexBackendMode;
            const inheritedForkOverrides = createConnectedServiceForkLaunchContext({
                inherited: params.inheritedForkOverrides,
            }).inherited;
            const result = await params.spawnSession({
                directory: forked.launch.directory ?? params.directory,
                backendTarget: params.forkBackendResolution.backendTargetV2,
                approvedNewDirectoryCreation: true,
                spawnNonce: params.spawnNonce,
                resume: forkedProviderSessionId,
                ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
                ...(codexBackendMode ? { codexBackendMode } : {}),
                ...(forked.launch.environmentVariables ? { environmentVariables: { ...forked.launch.environmentVariables } } : {}),
                ...inheritedForkOverrides.spawn,
            } satisfies SpawnSessionOptions);

            if (isAmbiguousSpawnSessionFailure(result)) {
                return {
                    ok: false,
                    errorCode: result.errorCode,
                    errorMessage: result.errorMessage,
                };
            }

            if (params.requestedStrategy === 'acp_fork_latest' && result.type !== 'success') {
                return {
                    ok: false,
                    errorCode: (result as { errorCode?: string })?.errorCode ?? SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                    errorMessage: (result as { errorMessage?: string })?.errorMessage ?? 'Failed to spawn ACP fork session',
                };
            }

            if (result.type !== 'success' || !result.sessionId) return null;

            const childSessionId = result.sessionId;
            if (childSessionId === params.parentSessionId) {
                return { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Fork spawn returned parent session id' };
            }

            try {
                const childRaw = await fetchForkChildSessionOrThrow({ token: params.credentials.token, sessionId: childSessionId });
                await updateSessionMetadataWithRetry({
                    token: params.credentials.token,
                    credentials: params.credentials,
                    sessionId: childSessionId,
                    rawSession: childRaw,
                    updater: (metadata) => ({
                        ...metadata,
                        ...inheritedForkOverrides.metadata,
                        ...params.forkBackendResolution.metadataOverlay,
                        ...launchMetadata,
                        forkV1: {
                            v: 1,
                            parentSessionId: params.parentSessionId,
                            parentCutoffSeqInclusive: params.effectiveCutoffSeqInclusive,
                            createdAtMs: Date.now(),
                            strategy: 'acp_fork_latest',
                            agentHint: {
                                agentId: params.forkBackendResolution.agentHintAgentId,
                                ...(providerBackendMode ? { backendMode: providerBackendMode } : {}),
                                providerSessionId: forkedProviderSessionId,
                            },
                        },
                    }),
                    maxAttempts: 6,
                });
            } catch (error) {
                if (isAuthenticationError(error)) throw error;
                await cleanupForkChildBestEffort(params.stopSession, childSessionId);
                await archiveSessionBestEffort(params.credentials.token, childSessionId);
                return {
                    ok: false,
                    errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                    errorMessage: error instanceof Error ? error.message : 'Failed to load forked child session metadata',
                };
            }
            return { ok: true, childSessionId };
        };

        const forked = await params.forkSurface?.fork?.({
            parentSessionId: params.parentSessionId,
            parentMetadata: params.parentMetadata,
            directory: params.directory,
            forkPoint: { kind: 'latest' },
        });
        if (forked) {
            return await spawnFinalForkResult(forked);
        }
        return null;
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        return null;
    }
}
