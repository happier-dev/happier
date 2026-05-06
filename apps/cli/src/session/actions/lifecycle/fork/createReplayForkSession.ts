import { randomUUID } from 'node:crypto';

import { getReplayForkContinuationHandler } from '@/backends/catalog';
import { configuration } from '@/configuration';
import {
    SPAWN_SESSION_ERROR_CODES,
    type SpawnSessionOptions,
} from '@/rpc/handlers/registerSessionHandlers';
import { createReplaySeededSession } from '@/session/replay/createReplaySeededSession';
import { resolveReplaySeedDraft } from '@/session/replay/resolveReplaySeedDraft';
import { logger } from '@/ui/logger';
import { isAuthenticationError } from '@/api/client/httpStatusError';

import { archiveSessionBestEffort } from './forkChildSessionRecovery';
import type {
    ForkBackendResolution,
    ForkInheritedOverrides,
    ForkLifecycleCredentials,
    ForkLifecycleMetadata,
    ForkLifecycleResult,
    ForkSpawnSession,
} from './forkLifecycleTypes';
import type { SessionLifecycleMachineDeps } from '../sessionLifecycleTypes';

type ReplaySummaryRunner = NonNullable<Parameters<typeof resolveReplaySeedDraft>[0]['summaryRunner']>;

export async function createReplayForkSession(params: Readonly<{
    credentials: ForkLifecycleCredentials;
    parentSessionId: string;
    parentMetadata: ForkLifecycleMetadata;
    directory: string;
    effectiveCutoffSeqInclusive: number;
    spawnNonce: string;
    forkPointType: 'seq' | 'latest';
    replaySummaryRunner: ReplaySummaryRunner | null | undefined;
    replayMaxSeedChars: number | undefined;
    maxTextChars: number | undefined;
    forkBackendResolution: ForkBackendResolution;
    inheritedForkOverrides: ForkInheritedOverrides;
    spawnSession: ForkSpawnSession;
    deps?: SessionLifecycleMachineDeps;
}>): Promise<ForkLifecycleResult> {
    const providerAgentId = params.forkBackendResolution.providerAgentId;
    const replayForkContinuation = providerAgentId
        ? await (async () => {
            const handler = await getReplayForkContinuationHandler(providerAgentId);
            return handler ? await handler({ parentMetadata: params.parentMetadata }) : null;
        })()
        : null;
    const resolvedSeed = await resolveReplaySeedDraft({
        credentials: params.credentials,
        cwd: params.directory,
        source: {
            kind: 'fork_chain',
            previousSessionId: params.parentSessionId,
            ...(params.forkPointType === 'seq' ? { upToSeqInclusive: params.effectiveCutoffSeqInclusive } : {}),
        },
        strategy: params.replaySummaryRunner ? 'summary_plus_recent' : 'recent_messages',
        recentMessagesCount: configuration.replaySeedCandidateLimit,
        maxSeedChars: typeof params.replayMaxSeedChars === 'number'
            ? params.replayMaxSeedChars
            : configuration.replaySeedMaxChars,
        candidateLimit: configuration.replaySeedCandidateLimit,
        maxTextChars: params.maxTextChars,
        summaryRunner: params.replaySummaryRunner ?? null,
        deps: params.deps?.runReplaySummaryForDialog
            ? { runReplaySummaryForDialog: params.deps.runReplaySummaryForDialog }
            : undefined,
    });
    if (!resolvedSeed) {
        return {
            ok: false,
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
            errorMessage: 'Unable to hydrate replay dialog from transcript.',
        };
    }
    const seedDraft = resolvedSeed.seedDraft;

    if (!seedDraft.trim()) {
        return {
            ok: false,
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
            errorMessage: 'Replay seed draft is empty',
        };
    }

    const nowMs = Date.now();
    const created = await (async () => {
        try {
            return await createReplaySeededSession({
                credentials: params.credentials,
                directory: params.directory,
                flavor: params.forkBackendResolution.replayFlavor,
                tag: `fork:${params.parentSessionId}:${params.effectiveCutoffSeqInclusive}:${randomUUID()}`,
                metadata: {
                    ...params.inheritedForkOverrides.metadata,
                    ...params.forkBackendResolution.metadataOverlay,
                    ...(replayForkContinuation?.metadata ?? {}),
                    forkV1: {
                        v: 1,
                        parentSessionId: params.parentSessionId,
                        parentCutoffSeqInclusive: params.effectiveCutoffSeqInclusive,
                        createdAtMs: nowMs,
                        strategy: 'replay',
                        providerHint: { providerId: params.forkBackendResolution.providerHintProviderId },
                    },
                    replaySeedV1: {
                        v: 1,
                        seedText: seedDraft,
                        sourceSessionId: params.parentSessionId,
                        sourceCutoffSeqInclusive: params.effectiveCutoffSeqInclusive,
                        createdAtMs: nowMs,
                    },
                },
            });
        } catch (error) {
            if (isAuthenticationError(error)) throw error;
            logger.debug('[API MACHINE] Failed to create fork session for replay', {
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    })();

    if (!created) {
        return {
            ok: false,
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: 'Failed to create fork session',
        };
    }

    const spawnResult = await params.spawnSession({
        directory: params.directory,
        backendTarget: params.forkBackendResolution.backendTargetV2,
        approvedNewDirectoryCreation: true,
        spawnNonce: params.spawnNonce,
        existingSessionId: created.sessionId,
        ...(replayForkContinuation?.spawn ?? {}),
        ...params.inheritedForkOverrides.spawn,
    } satisfies SpawnSessionOptions);

    if (spawnResult.type !== 'success') {
        await archiveSessionBestEffort(params.credentials.token, created.sessionId);
        return {
            ok: false,
            errorCode: (spawnResult as { errorCode?: string })?.errorCode ?? SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: (spawnResult as { errorMessage?: string })?.errorMessage ?? 'Failed to spawn fork session',
        };
    }

    if (created.sessionId === params.parentSessionId) {
        return { ok: false, errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED, errorMessage: 'Fork spawn returned parent session id' };
    }

    return { ok: true, childSessionId: created.sessionId };
}
