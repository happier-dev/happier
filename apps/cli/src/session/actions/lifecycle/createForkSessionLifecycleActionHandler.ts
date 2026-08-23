import type { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { isAcpForkEligibleForAgent } from '@/agent/acp/acpForkEligibility';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import { readStoredCredentials } from '@/persistence';
import { SPAWN_SESSION_ERROR_CODES } from '@/session/shared/spawnSessionContract';
import { resolveForkCutoffSeqInclusive } from '@/session/fork/resolveForkCutoffSeqInclusive';
import { resolveForkInheritedOverridesFromMetadata } from '@/session/fork/resolveForkInheritedOverridesFromMetadata';
import { createStableSpawnNonce } from '@/session/shared/spawnNonce';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { SessionForkRpcParamsSchema } from '@happier-dev/protocol';
import {
    evaluateAgentSessionCapabilitySupport,
    isBundledAgentId,
    isProviderBoundSessionMetadata,
} from '@happier-dev/agents';
import { readAgentCatalogSnapshot } from '@/agent/catalog/snapshot';
import { readAgentSessionCapabilities } from '@/plugins/projection/registry/agentContributionDefinition';

import { attemptAcpLatestFork } from './fork/attemptAcpLatestFork';
import { attemptNativeForkOpen } from './fork/attemptNativeForkOpen';
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
    resolveExecutionSurfaces?: NonNullable<SessionLifecycleMachineDeps['resolveExecutionSurfaces']>;
    handlers: SessionLifecycleMachineHandlers;
    deps?: SessionLifecycleMachineDeps;
}>): SessionLifecycleActionHandler {
    const inFlightForks = new Map<string, Promise<ForkLifecycleResult>>();

    const cancelled = () => ({
        ok: false as const,
        errorCode: 'cancelled',
        errorMessage: 'cancelled',
    });

    return async (raw: unknown, context) => {
        if (context?.signal.aborted) return cancelled();
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

        const credentials = await readStoredCredentials().catch(() => null);
        if (!credentials) {
            return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Not authenticated',
            };
        }

        let parentSession: Awaited<ReturnType<typeof fetchSessionByIdCompat>> | null = null;
        let accountEncryptionCurrentness: Awaited<ReturnType<typeof fetchAccountEncryptionCurrentness>>;
        try {
            [parentSession, accountEncryptionCurrentness] = await Promise.all([
                fetchSessionByIdCompat({ token: credentials.token, sessionId: parentSessionId }),
                fetchAccountEncryptionCurrentness({ token: credentials.token }),
            ]);
        } catch (error) {
            if (isAuthenticationError(error)) throw error;
            return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: error instanceof Error ? error.message : 'Failed to load parent session',
            };
        }
        if (context?.signal.aborted) return cancelled();
        if (!parentSession) {
            return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Session not found',
            };
        }

        const parentMetadata = tryDecryptSessionOwnerMetadataView({
            credentials,
            rawSession: parentSession,
            accountEncryptionMode: accountEncryptionCurrentness.mode,
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
        const forkAgentId = forkBackendResolution.catalogAgentId;
        const nativeForkOpenDeclared = forkAgentId !== null
            && readAgentSessionCapabilities(
                readAgentCatalogSnapshot().agentDefinitionsById
                    .get(forkAgentId)
                    ?.richDefinition
                    ?.definition,
            )?.open.includes('fork') === true;
        const nativeForkOpenSupported = forkAgentId !== null
            && nativeForkOpenDeclared
            && (
                // Only a bundled Agent carries a bundled session-capability
                // policy; a contributed Agent's declaration is the whole fact.
                !isBundledAgentId(forkAgentId)
                || evaluateAgentSessionCapabilitySupport({
                    agentId: forkAgentId,
                    capability: forkPoint.type === 'seq'
                        ? 'sessionFork.fromMessage'
                        : 'sessionFork.conversation',
                    metadata: parentMetadata,
                }) === 'supported'
            );
        const inheritedForkOverrides = resolveForkInheritedOverridesFromMetadata(
            parentMetadata,
            forkBackendResolution.backendTargetV2,
        );
        // One shared fact, read by this gate and by the UI's fork-card
        // availability owner, so the modal can never offer a Native card this
        // handler will refuse. Equivalent to the previous local derivation from
        // the inherited overrides: a Provider-bound canonical intent always wins
        // the effective-source rule, and a mismatched or absent agent target
        // already threw above.
        const providerBoundFork = isProviderBoundSessionMetadata(parentMetadata);
        if (
            providerBoundFork
            && requestedStrategy !== 'auto'
            && requestedStrategy !== 'replay'
        ) {
            return {
                ok: false,
                errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Provider-bound sessions require replay fork so authorization completes before any vendor fork side effect',
            };
        }

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

        // `requestId` is the caller's identity for ONE fork attempt (section 3.5,
        // ported from the predecessor). When it is present it — not the request
        // content — decides both coalescing and spawn identity: retries of one
        // attempt join the in-flight fork and reuse its spawn nonce, while two
        // deliberate attempts stay distinct even when their payloads are byte
        // identical. Callers that have no attempt identity (non-UI Action/voice)
        // keep the content-derived behaviour unchanged.
        const forkRequestId = typeof parsed.data.requestId === 'string' && parsed.data.requestId.trim().length > 0
            ? parsed.data.requestId.trim()
            : null;
        const forkAttemptIdentity = forkRequestId
            ? { parentSessionId, requestId: forkRequestId }
            : {
                parentSessionId,
                forkPointType: forkPoint.type,
                effectiveCutoffSeqInclusive,
                requestedStrategy,
                replayMaxSeedChars: parsed.data.replayMaxSeedChars ?? null,
                replaySummaryRunner: parsed.data.replaySummaryRunner ?? null,
            };
        const forkSingleFlightKey = JSON.stringify(forkAttemptIdentity);
        const existingFork = inFlightForks.get(forkSingleFlightKey);
        if (existingFork) {
            return await existingFork;
        }
        if (context?.signal.aborted) return cancelled();

        const forkPromise = (async (): Promise<ForkLifecycleResult> => {
            const spawnNonce = createStableSpawnNonce('session.fork', forkAttemptIdentity);
            // `native` is the generic user intent the fork strategy modal sends.
            // It enables exactly the native attempts `auto` enables, in the same
            // order; the tail check below is what keeps it from ever falling
            // through to Replay, which the user did not choose.
            const genericNativeIntent = requestedStrategy === 'auto' || requestedStrategy === 'native';
            const shouldAttemptAcpForkLatest =
                !providerBoundFork &&
                (genericNativeIntent || requestedStrategy === 'acp_fork_latest') &&
                forkPoint.type === 'latest' &&
                (
                    forkIsConfiguredAcp ||
                    (forkAgentId !== null && isAcpForkEligibleForAgent({
                        agentId: forkAgentId,
                        metadata: parentMetadata,
                    }))
                );

            if (
                !providerBoundFork
                && nativeForkOpenSupported
                && (genericNativeIntent || requestedStrategy === 'provider_native')
            ) {
                const nativeForkOpen = await attemptNativeForkOpen({
                    credentials,
                    parentSessionId,
                    parentMetadata,
                    directory,
                    forkPoint,
                    targetSeqInclusive,
                    effectiveCutoffSeqInclusive,
                    ...(context?.signal ? { signal: context.signal } : {}),
                    requestId: forkRequestId,
                    spawnNonce: `${spawnNonce}:native-open`,
                    forkBackendResolution,
                    inheritedForkOverrides,
                    spawnSession: params.handlers.spawnSession,
                    stopSession: params.handlers.stopSession,
                    ...(params.deps?.awaitAgentSessionOpen
                        ? { awaitAgentSessionOpen: params.deps.awaitAgentSessionOpen }
                        : {}),
                });
                if (nativeForkOpen) return nativeForkOpen;
                if (context?.signal.aborted) return cancelled();
            }

            const maxTextChars = readReplayTextLimitFromEnv();
            const resolveExecutionSurfaces = params.resolveExecutionSurfaces
                ?? params.sessionHostBridge.resolveExecutionSurfaces.bind(params.sessionHostBridge);
            const forkSurface = (await resolveExecutionSurfaces(
                forkBackendResolution.backendTargetV2.backendId,
            )).fork;

            // An agent-owned fork surface can implement both native and ACP
            // modes. Route ACP-backed sessions directly to the ACP lifecycle so
            // one surface invocation has one authoritative persisted strategy.
            if (!providerBoundFork && !(genericNativeIntent && shouldAttemptAcpForkLatest)) {
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
                    ...(context?.signal ? { signal: context.signal } : {}),
                    requestId: forkRequestId,
                    spawnNonce: `${spawnNonce}:native`,
                    forkBackendResolution,
                    inheritedForkOverrides,
                    forkSurface,
                    spawnSession: params.handlers.spawnSession,
                    stopSession: params.handlers.stopSession,
                });
                if (providerNativeFork) return providerNativeFork;
                if (context?.signal.aborted) return cancelled();
            }

            if (shouldAttemptAcpForkLatest) {
                const acpLatestFork = await attemptAcpLatestFork({
                    requestedStrategy,
                    credentials,
                    parentSessionId,
                    parentMetadata,
                    directory,
                    effectiveCutoffSeqInclusive,
                    requestId: forkRequestId,
                    forkIsConfiguredAcp,
                    spawnNonce: `${spawnNonce}:acp_fork_latest`,
                    forkBackendResolution,
                    inheritedForkOverrides,
                    forkSurface,
                    spawnSession: params.handlers.spawnSession,
                    stopSession: params.handlers.stopSession,
                });
                if (acpLatestFork) return acpLatestFork;
                if (context?.signal.aborted) return cancelled();
            }

            if (requestedStrategy !== 'auto' && requestedStrategy !== 'replay') {
                return {
                    ok: false,
                    errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                    errorMessage: 'Requested fork strategy is not supported',
                };
            }

            if (context?.signal.aborted) return cancelled();

            return await createReplayForkSession({
                credentials,
                parentSessionId,
                parentMetadata,
                directory,
                effectiveCutoffSeqInclusive,
                requestId: forkRequestId,
                spawnNonce: `${spawnNonce}:replay`,
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
        })().catch((error: unknown): ForkLifecycleResult => {
            if (
                context?.signal.aborted === true
                && error instanceof Error
                && error.name === 'AbortError'
            ) {
                return cancelled();
            }
            throw error;
        });
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
