import { isAuthenticationError } from '@/api/client/httpStatusError';
import {
    SPAWN_SESSION_ERROR_CODES,
    type SpawnSessionOptions,
} from '@/session/shared/spawnSessionContract';
import { readCanonicalSpawnRuntimeSelection } from '@/rpc/handlers/spawnRuntimeSelection';
import { dispatchProviderNativeFork } from '@/session/fork/providerNativeForkDispatch';
import { createConnectedServiceForkLaunchContext } from '@/session/fork/connectedServiceForkLaunchContext';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import { isAmbiguousSpawnSessionFailure } from '@/session/shared/spawnNonce';
import { readRuntimeDescriptorV1FromMetadata } from '@happier-dev/protocol';
import { applyAgentAuthoredSessionStateUpdatesToMetadata } from '@/agent/runtime/state/agentAuthoredSessionStateUpdates';

import {
    archiveSessionBestEffort,
    cleanupForkChildBestEffort,
    fetchForkChildSessionOrThrow,
} from './forkChildSessionRecovery';
import { normalizeForkProviderSessionId } from './forkProviderSessionId';
import { resolveEstablishedForkLineageCutoff } from './resolveEstablishedForkLineageCutoff';
import type {
    ForkBackendResolution,
    ForkBridgeSurface,
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
    signal?: AbortSignal;
    requestId?: string | null;
    spawnNonce: string;
    forkBackendResolution: ForkBackendResolution;
    inheritedForkOverrides: ForkInheritedOverrides;
    forkSurface: ForkBridgeSurface;
    spawnSession: ForkSpawnSession;
    stopSession: ForkStopSession;
}>): Promise<ForkStrategyAttemptResult> {
    // `native` is the generic user intent the fork strategy modal sends: try
    // every native path this Session supports, in the existing order. It differs
    // from `auto` only at the tail, where it must not fall through to Replay.
    const shouldAttemptProviderNative =
        params.requestedStrategy === 'auto'
        || params.requestedStrategy === 'native'
        || params.requestedStrategy === 'provider_native';

    if (
        !shouldAttemptProviderNative
        || params.forkBackendResolution.configuredAcp !== null
        || !params.forkBackendResolution.catalogAgentId
    ) {
        return null;
    }

    try {
        const nativeFork = await dispatchProviderNativeFork({
            forkSurface: params.forkSurface,
            parentSessionId: params.parentSessionId,
            parentMetadata: params.parentMetadata,
            directory: params.directory,
            forkPoint: params.forkPoint.type === 'seq'
                ? { type: 'seq', upToSeqInclusive: params.targetSeqInclusive }
                : { type: 'latest' },
            ...(params.signal ? { signal: params.signal } : {}),
        });

        if (!nativeFork) return null;
        const nativeForkProviderSessionId = normalizeForkProviderSessionId(nativeFork.providerSessionId);
        if (!nativeForkProviderSessionId) {
            return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'Provider-native fork returned an empty providerSessionId',
            };
        }
        const launchMetadata = applyAgentAuthoredSessionStateUpdatesToMetadata(
            {},
            nativeFork.launch.sessionStateUpdates ?? [],
            'fork.launch.sessionStateUpdates',
        );
        const runtimeDescriptorV1 = readRuntimeDescriptorV1FromMetadata(launchMetadata) ?? undefined;
        const runtimeSelection = readCanonicalSpawnRuntimeSelection({ runtimeDescriptorV1 });
        const agentBackendMode = runtimeSelection.agentBackendMode;
        const codexBackendMode = runtimeSelection.codexBackendMode;
        const agentHint = {
            agentId: params.forkBackendResolution.agentHintAgentId,
            ...(agentBackendMode ? { backendMode: agentBackendMode } : {}),
            providerSessionId: nativeForkProviderSessionId,
        };
        const inheritedForkOverrides = createConnectedServiceForkLaunchContext({
            inherited: params.inheritedForkOverrides,
        }).inherited;

        const result = await params.spawnSession({
            directory: nativeFork.launch.directory ?? params.directory,
            backendTarget: params.forkBackendResolution.backendTargetV2,
            approvedNewDirectoryCreation: true,
            spawnNonce: params.spawnNonce,
            resume: nativeForkProviderSessionId,
            ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
            ...(codexBackendMode ? { codexBackendMode } : {}),
            ...(nativeFork.launch.environmentVariables ? { environmentVariables: { ...nativeFork.launch.environmentVariables } } : {}),
            ...inheritedForkOverrides.spawn,
        } satisfies SpawnSessionOptions);

        if (isAmbiguousSpawnSessionFailure(result)) {
            return {
                ok: false,
                errorCode: result.errorCode,
                errorMessage: result.errorMessage,
            };
        }

        if (result.type !== 'success' || !result.sessionId) {
            return {
                ok: false,
                errorCode: (result as { errorCode?: string })?.errorCode ?? SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: (result as { errorMessage?: string })?.errorMessage ?? 'Failed to spawn provider-native fork session',
            };
        }

        const childSessionId = result.sessionId;
        if (childSessionId === params.parentSessionId) {
            return { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Fork spawn returned parent session id' };
        }
        const requestId = typeof params.requestId === 'string'
            && params.requestId.trim().length > 0
            ? params.requestId.trim()
            : null;
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
                        parentCutoffSeqInclusive: resolveEstablishedForkLineageCutoff({
                            metadata,
                            parentSessionId: params.parentSessionId,
                            requestId,
                            fallbackCutoffSeqInclusive: params.effectiveCutoffSeqInclusive,
                        }),
                        createdAtMs: Date.now(),
                        strategy: 'provider_native',
                        ...(requestId ? { requestId } : {}),
                        agentHint,
                    },
                }),
                maxAttempts: 6,
            });
        } catch (error) {
            await cleanupForkChildBestEffort({
                credentials: params.credentials,
                fallbackStopSession: params.stopSession,
                sessionId: childSessionId,
            });
            if (isAuthenticationError(error)) throw error;
            try {
                await archiveSessionBestEffort(params.credentials.token, childSessionId);
            } catch {
                // Recovery must not replace the initiating finalization failure.
            }
            return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: error instanceof Error ? error.message : 'Failed to load forked child session metadata',
            };
        }
        return { ok: true, childSessionId };
    } catch (error) {
        if (
            params.signal?.aborted === true
            && error instanceof Error
            && error.name === 'AbortError'
        ) {
            throw error;
        }
        if (isAuthenticationError(error)) throw error;
        return {
            ok: false,
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: 'Provider-native fork outcome is unknown. Check the existing child session before retrying.',
        };
    }
}
