import { isAuthenticationError } from '@/api/client/httpStatusError';
import {
    SPAWN_SESSION_ERROR_CODES,
    type SpawnSessionOptions,
} from '@/rpc/handlers/registerSessionHandlers';
import { dispatchProviderNativeFork } from '@/session/fork/providerNativeForkDispatch';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';

import {
    archiveSessionBestEffort,
    cleanupForkChildBestEffort,
    fetchForkChildSessionOrThrow,
} from './forkChildSessionRecovery';
import type {
    ForkBackendResolution,
    ForkInheritedOverrides,
    ForkLifecycleCredentials,
    ForkLifecycleMetadata,
    ForkLifecycleRawSession,
    ForkPoint,
    ForkSpawnSession,
    ForkStopSession,
    ForkStrategyAttemptResult,
} from './forkLifecycleTypes';

export async function attemptProviderNativeFork(params: Readonly<{
    requestedStrategy: string;
    credentials: ForkLifecycleCredentials;
    parentSessionId: string;
    parentSession: ForkLifecycleRawSession;
    parentMetadata: ForkLifecycleMetadata;
    directory: string;
    forkPoint: ForkPoint;
    targetSeqInclusive: number;
    effectiveCutoffSeqInclusive: number;
    spawnNonce: string;
    forkBackendResolution: ForkBackendResolution;
    inheritedForkOverrides: ForkInheritedOverrides;
    spawnSession: ForkSpawnSession;
    stopSession: ForkStopSession;
}>): Promise<ForkStrategyAttemptResult> {
    const shouldAttemptProviderNative =
        params.requestedStrategy === 'auto' || params.requestedStrategy === 'provider_native';

    if (
        !shouldAttemptProviderNative
        || params.forkBackendResolution.configuredAcp !== null
        || !params.forkBackendResolution.providerAgentId
    ) {
        return null;
    }

    try {
        const nativeFork = await dispatchProviderNativeFork({
            credentials: params.credentials,
            agentId: params.forkBackendResolution.providerAgentId,
            parentSessionId: params.parentSessionId,
            parentRawSession: params.parentSession,
            parentMetadata: params.parentMetadata,
            directory: params.directory,
            forkPoint: params.forkPoint.type === 'seq'
                ? { type: 'seq', upToSeqInclusive: params.targetSeqInclusive }
                : { type: 'latest' },
            targetSeqInclusive: params.targetSeqInclusive,
        });

        if (!nativeFork) return null;

        const result = await params.spawnSession({
            directory: params.directory,
            backendTarget: params.forkBackendResolution.backendTargetV2,
            approvedNewDirectoryCreation: true,
            spawnNonce: params.spawnNonce,
            ...nativeFork.spawn,
            ...params.inheritedForkOverrides.spawn,
        } satisfies SpawnSessionOptions);

        if (params.requestedStrategy === 'provider_native' && result.type !== 'success') {
            return {
                ok: false,
                errorCode: (result as { errorCode?: string })?.errorCode ?? SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: (result as { errorMessage?: string })?.errorMessage ?? 'Failed to spawn provider-native fork session',
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
                    ...params.inheritedForkOverrides.metadata,
                    ...params.forkBackendResolution.metadataOverlay,
                    ...nativeFork.metadata,
                    forkV1: {
                        v: 1,
                        parentSessionId: params.parentSessionId,
                        parentCutoffSeqInclusive: params.effectiveCutoffSeqInclusive,
                        createdAtMs: Date.now(),
                        strategy: 'provider_native',
                        providerHint: nativeFork.providerHint,
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
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        if (params.requestedStrategy === 'provider_native') {
            return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: error instanceof Error ? error.message : 'Provider-native fork failed',
            };
        }
        return null;
    }
}
