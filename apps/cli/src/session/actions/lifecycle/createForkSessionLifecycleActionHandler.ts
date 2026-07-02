import { randomUUID } from 'node:crypto';

import type { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { isAcpForkEligibleForProvider } from '@/agent/acp/acpForkEligibility';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import { readCredentials } from '@/persistence';
import { SPAWN_SESSION_ERROR_CODES } from '@/rpc/handlers/registerSessionHandlers';
import { resolveForkCutoffSeqInclusive } from '@/session/fork/resolveForkCutoffSeqInclusive';
import { resolveForkInheritedOverridesFromMetadata } from '@/session/fork/resolveForkInheritedOverridesFromMetadata';
import { tryDecryptSessionMetadata } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { SessionForkRpcParamsSchema } from '@happier-dev/protocol';

import { attemptAcpLatestFork } from './fork/attemptAcpLatestFork';
import { attemptProviderNativeFork } from './fork/attemptProviderNativeFork';
import { createReplayForkSession } from './fork/createReplayForkSession';
import type { ForkLifecycleResult } from './fork/forkLifecycleTypes';
import { readReplayTextLimitFromEnv } from './fork/readReplayTextLimitFromEnv';
import type {
    SessionLifecycleActionHandler,
    SessionLifecycleMachineDeps,
    SessionLifecycleMachineHandlers,
} from './sessionLifecycleTypes';

export function createForkSessionLifecycleActionHandler(params: Readonly<{
    sessionHostBridge: ReturnType<typeof getSessionHostBridge>;
    handlers: SessionLifecycleMachineHandlers;
    deps?: SessionLifecycleMachineDeps;
}>): SessionLifecycleActionHandler {
    const inFlightForks = new Map<string, Promise<ForkLifecycleResult>>();

    return async (raw: unknown) => {
        const parsed = SessionForkRpcParamsSchema.safeParse(raw);
        if (!parsed.success) {
            return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Invalid params',
            };
        }

        const { parentSessionId, forkPoint } = parsed.data;
        const requestedStrategy = typeof parsed.data.strategy === 'string' ? parsed.data.strategy : 'auto';

        if (forkPoint.type === 'seq') {
            const seq = typeof forkPoint.upToSeqInclusive === 'number' && Number.isFinite(forkPoint.upToSeqInclusive)
                ? Math.trunc(forkPoint.upToSeqInclusive)
                : NaN;
            if (!Number.isFinite(seq) || seq <= 0) {
                return {
                    ok: false,
                    errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                    errorMessage: 'Cannot fork from an uncommitted message (missing seq).',
                };
            }
        }

        const credentials = await readCredentials().catch(() => null);
        if (!credentials) {
            return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Not authenticated',
            };
        }

        let parentSession: Awaited<ReturnType<typeof fetchSessionByIdCompat>> | null = null;
        try {
            parentSession = await fetchSessionByIdCompat({ token: credentials.token, sessionId: parentSessionId });
        } catch (error) {
            if (isAuthenticationError(error)) throw error;
            return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: error instanceof Error ? error.message : 'Failed to load parent session',
            };
        }
        if (!parentSession) {
            return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Session not found',
            };
        }

        const parentMetadata = tryDecryptSessionMetadata({
            credentials,
            rawSession: parentSession,
        });
        if (!parentMetadata) {
            return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Unable to decrypt session metadata',
            };
        }

        const directory = typeof parentMetadata.path === 'string' && parentMetadata.path.trim().length > 0
            ? parentMetadata.path.trim()
            : '';
        if (!directory) {
            return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Session metadata missing path',
            };
        }

        const forkBackendResolution = await params.sessionHostBridge.resolveSessionForkBackendTarget({
            parentMetadata,
            credentials,
        });
        if (!forkBackendResolution.ok) {
            return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: forkBackendResolution.errorMessage,
            };
        }

        const forkIsConfiguredAcp = forkBackendResolution.configuredAcp !== null;
        const forkProviderAgentId = forkBackendResolution.providerAgentId;
        const inheritedForkOverrides = resolveForkInheritedOverridesFromMetadata(parentMetadata, forkProviderAgentId);

        const targetSeqInclusive = forkPoint.type === 'seq'
            ? forkPoint.upToSeqInclusive
            : (typeof (parentSession as { seq?: unknown })?.seq === 'number' && Number.isFinite((parentSession as { seq?: number }).seq)
                ? Math.max(0, Math.floor((parentSession as { seq: number }).seq))
                : 0);

        const cutoffSeqInclusive = forkPoint.type === 'seq'
            ? (() => targetSeqInclusive)()
            : targetSeqInclusive;

        const resolvedCutoff = forkPoint.type === 'seq'
            ? await resolveForkCutoffSeqInclusive({
                credentials,
                parentSessionId,
                parentRawSession: parentSession,
                targetSeqInclusive,
            }).catch((error) => {
                if (isAuthenticationError(error)) throw error;
                return null;
            })
            : null;

        const effectiveCutoffSeqInclusive =
            forkPoint.type === 'seq' && resolvedCutoff
                ? resolvedCutoff.cutoffSeqInclusive
                : cutoffSeqInclusive;

        const forkSingleFlightKey = `${parentSessionId}:${forkPoint.type}:${effectiveCutoffSeqInclusive}`;
        const existingFork = inFlightForks.get(forkSingleFlightKey);
        if (existingFork) {
            return await existingFork;
        }

        const forkPromise = (async (): Promise<ForkLifecycleResult> => {
            const spawnNonce = `fork:${parentSessionId}:${effectiveCutoffSeqInclusive}:${randomUUID()}`;
            const maxTextChars = readReplayTextLimitFromEnv();
            const forkSurface = (await params.sessionHostBridge.resolveExecutionSurfaces(
                forkBackendResolution.backendTargetV2.backendId,
            )).fork;

            const providerNativeFork = await attemptProviderNativeFork({
                requestedStrategy,
                credentials,
                parentSessionId,
                parentSession,
                parentMetadata,
                directory,
                forkPoint,
                targetSeqInclusive,
                effectiveCutoffSeqInclusive,
                spawnNonce,
                forkBackendResolution,
                inheritedForkOverrides,
                forkSurface,
                spawnSession: params.handlers.spawnSession,
                stopSession: params.handlers.stopSession,
            });
            if (providerNativeFork) return providerNativeFork;

            const shouldAttemptAcpForkLatest =
                (requestedStrategy === 'auto' || requestedStrategy === 'acp_fork_latest') &&
                forkPoint.type === 'latest' &&
                (
                    forkIsConfiguredAcp ||
                    (forkProviderAgentId !== null && isAcpForkEligibleForProvider({
                        providerId: forkProviderAgentId,
                        metadata: parentMetadata,
                    }))
                );

            if (shouldAttemptAcpForkLatest) {
                const acpLatestFork = await attemptAcpLatestFork({
                    requestedStrategy,
                    credentials,
                    parentSessionId,
                    parentMetadata,
                    directory,
                    effectiveCutoffSeqInclusive,
                    forkIsConfiguredAcp,
                    forkProviderAgentId,
                    forkBackendResolution,
                    inheritedForkOverrides,
                    forkSurface,
                    spawnSession: params.handlers.spawnSession,
                    stopSession: params.handlers.stopSession,
                });
                if (acpLatestFork) return acpLatestFork;
            }

            if (requestedStrategy !== 'auto' && requestedStrategy !== 'replay') {
                return {
                    ok: false,
                    errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                    errorMessage: 'Requested fork strategy is not supported',
                };
            }

            return await createReplayForkSession({
                credentials,
                parentSessionId,
                parentMetadata,
                directory,
                effectiveCutoffSeqInclusive,
                spawnNonce,
                forkPointType: forkPoint.type,
                replaySummaryRunner: parsed.data.replaySummaryRunner,
                replayMaxSeedChars: parsed.data.replayMaxSeedChars,
                maxTextChars: maxTextChars ?? undefined,
                forkBackendResolution,
                inheritedForkOverrides,
                forkSurface,
                spawnSession: params.handlers.spawnSession,
                deps: params.deps,
            });
        })();
        inFlightForks.set(forkSingleFlightKey, forkPromise);
        try {
            return await forkPromise;
        } finally {
            if (inFlightForks.get(forkSingleFlightKey) === forkPromise) {
                inFlightForks.delete(forkSingleFlightKey);
            }
        }
    };
}
