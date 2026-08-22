import { isDeepStrictEqual } from 'node:util';

import { readProviderSessionIdSessionState } from '@happier-dev/agents';
import {
    readRuntimeDescriptorV1FromMetadata,
    SessionTurnProviderCheckpointV1Schema,
} from '@happier-dev/protocol';
import type { AgentSessionOpenRequest } from '@happier-dev/plugin-sdk/agents/runtime';

import { isAuthenticationError } from '@/api/client/httpStatusError';
import { readCanonicalSpawnRuntimeSelection } from '@/rpc/handlers/spawnRuntimeSelection';
import { resolveProviderCheckpointForFork } from '@/session/fork/resolveProviderCheckpointForFork';
import { createConnectedServiceForkLaunchContext } from '@/session/fork/connectedServiceForkLaunchContext';
import {
    SPAWN_SESSION_ERROR_CODES,
    type NativeForkSource,
    type SpawnSessionOptions,
} from '@/session/shared/spawnSessionContract';
import { isAmbiguousSpawnSessionFailure } from '@/session/shared/spawnNonce';
import { fetchSessionTurnsProjection } from '@/session/transport/http/sessionsHttp';

import {
    archiveSessionBestEffort,
    cleanupForkChildBestEffort,
    fetchForkChildSessionOrThrow,
} from './forkChildSessionRecovery';
import { updateSessionMetadataWithRetry } from '@/session/metadata/updateSessionMetadataWithRetry';
import type {
    ForkBackendResolution,
    ForkInheritedOverrides,
    ForkLifecycleCredentials,
    ForkLifecycleMetadata,
    ForkPoint,
    ForkSpawnSession,
    ForkStopSession,
    ForkStrategyAttemptResult,
} from './forkLifecycleTypes';
import type { SessionLifecycleMachineDeps } from '../sessionLifecycleTypes';

function areNativeForkTargetsEquivalent(
    attested: Extract<
        AgentSessionOpenRequest,
        { kind: 'fork' }
    >['source']['target'],
    expected: NativeForkSource['target'],
): boolean {
    if (!attested || !expected) return attested === expected;
    if (attested.turnId !== expected.turnId) return false;
    const attestedCheckpoint =
        SessionTurnProviderCheckpointV1Schema.safeParse(attested.providerCheckpoint);
    const expectedCheckpoint =
        SessionTurnProviderCheckpointV1Schema.safeParse(expected.providerCheckpoint);
    return (
        attestedCheckpoint.success
        && expectedCheckpoint.success
        && isDeepStrictEqual(attestedCheckpoint.data, expectedCheckpoint.data)
    );
}

function describeNativeForkOpenMismatch(
    attestation: Readonly<{ status: 'opened'; request: AgentSessionOpenRequest }>,
    childSessionId: string,
    source: NativeForkSource,
): string | null {
    if (attestation.request.kind !== 'fork') {
        return 'Child runtime did not open a native fork request';
    }
    if (attestation.request.sessionId !== childSessionId) {
        return 'Child runtime opened with a different child session identity';
    }
    if (attestation.request.source.sessionId !== source.sessionId) {
        return 'Child runtime opened with a different parent session identity';
    }
    if (attestation.request.source.providerSessionId !== source.providerSessionId) {
        return 'Child runtime opened with a different parent provider session identity';
    }
    if (attestation.request.source.cwd !== source.cwd) {
        return 'Child runtime opened with a different parent working directory';
    }
    if (!areNativeForkTargetsEquivalent(attestation.request.source.target, source.target)) {
        return 'Child runtime opened with a different native fork target';
    }
    return null;
}

export async function attemptNativeForkOpen(params: Readonly<{
    credentials: ForkLifecycleCredentials;
    parentSessionId: string;
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
    awaitAgentSessionOpen?: SessionLifecycleMachineDeps['awaitAgentSessionOpen'];
}>): Promise<ForkStrategyAttemptResult> {
    const providerSessionId = readProviderSessionIdSessionState(params.parentMetadata).value;
    if (!providerSessionId) {
        return {
            ok: false,
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
            errorMessage: 'Native fork requires an exact parent provider session identity',
        };
    }

    let target: NativeForkSource['target'];
    if (params.forkPoint.type === 'seq') {
        let projection;
        try {
            projection = await fetchSessionTurnsProjection({
                token: params.credentials.token,
                sessionId: params.parentSessionId,
            });
        } catch (error) {
            if (isAuthenticationError(error)) throw error;
            return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: error instanceof Error
                    ? error.message
                    : 'Unable to load canonical parent turns for native fork',
            };
        }
        const resolved = projection
            ? resolveProviderCheckpointForFork({
                targetSeqInclusive: params.targetSeqInclusive,
                turns: projection.turns,
            })
            : null;
        if (!resolved) {
            return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Native point fork requires one exact persisted provider checkpoint',
            };
        }
        target = Object.freeze(resolved);
    }

    const nativeForkSource: NativeForkSource = Object.freeze({
        sessionId: params.parentSessionId,
        providerSessionId,
        cwd: params.directory,
        ...(target ? { target } : {}),
    });
    const inheritedForkOverrides = createConnectedServiceForkLaunchContext({
        inherited: params.inheritedForkOverrides,
    }).inherited;
    const runtimeDescriptorV1 =
        readRuntimeDescriptorV1FromMetadata(params.parentMetadata) ?? undefined;
    const runtimeSelection = readCanonicalSpawnRuntimeSelection({ runtimeDescriptorV1 });
    const result = await params.spawnSession({
        directory: params.directory,
        backendTarget: params.forkBackendResolution.backendTargetV2,
        approvedNewDirectoryCreation: true,
        spawnNonce: params.spawnNonce,
        nativeForkSource,
        ...(runtimeSelection.providerBackendMode
            ? { backendMode: runtimeSelection.providerBackendMode }
            : {}),
        ...(runtimeSelection.codexBackendMode
            ? { codexBackendMode: runtimeSelection.codexBackendMode }
            : {}),
        ...(runtimeDescriptorV1 ? { runtimeDescriptorV1 } : {}),
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
            errorCode: (result as { errorCode?: string }).errorCode ?? SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: (result as { errorMessage?: string }).errorMessage
                ?? 'Failed to spawn native fork session',
        };
    }
    if (result.sessionId === params.parentSessionId) {
        return {
            ok: false,
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: 'Fork spawn returned parent session id',
        };
    }

    const childSessionId = result.sessionId;
    try {
        if (!params.awaitAgentSessionOpen) {
            throw new Error('Native fork runtime-open attestation is unavailable');
        }
        const openAttestation = await params.awaitAgentSessionOpen({
            sessionId: childSessionId,
        });
        if (openAttestation.status === 'timeout') {
            return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: 'Native fork outcome is unknown. Check the existing child session before retrying.',
            };
        }
        const openMismatch = describeNativeForkOpenMismatch(
            openAttestation,
            childSessionId,
            nativeForkSource,
        );
        if (openMismatch) {
            throw new Error(openMismatch);
        }
        const childRaw = await fetchForkChildSessionOrThrow({
            token: params.credentials.token,
            sessionId: childSessionId,
        });
        await updateSessionMetadataWithRetry({
            token: params.credentials.token,
            credentials: params.credentials,
            sessionId: childSessionId,
            rawSession: childRaw,
            updater: (metadata) => ({
                ...metadata,
                ...inheritedForkOverrides.metadata,
                ...params.forkBackendResolution.metadataOverlay,
                forkV1: {
                    v: 1,
                    parentSessionId: params.parentSessionId,
                    parentCutoffSeqInclusive: params.effectiveCutoffSeqInclusive,
                    createdAtMs: Date.now(),
                    strategy: 'provider_native',
                    agentHint: {
                        agentId: params.forkBackendResolution.agentHintAgentId,
                    },
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
            await archiveSessionBestEffort(
                params.credentials.token,
                childSessionId,
            );
        } catch {
            // Preserve the initiating fork failure. Archival is recovery and
            // must not replace the error that caused recovery to start.
        }
        return {
            ok: false,
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: error instanceof Error
                ? error.message
                : 'Failed to load native fork child session metadata',
        };
    }
    return { ok: true, childSessionId };
}
