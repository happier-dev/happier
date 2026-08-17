import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import { isPermissionMode } from '@/api/types';
import { readCredentials } from '@/persistence';
import { buildReplaySeededSpawnRecipe } from '@/session/replay/buildReplaySeededSpawnRecipe';
import { createSpawnedSession } from '@/session/services/createSpawnedSession';
import { readReplaySeededCreationFailure } from '@/session/replay/replaySeededCreationFailure';
import type { CatalogAgentId } from '@/backends/types';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions, type SpawnSessionResult } from '@/rpc/handlers/registerSessionHandlers';
import type { LlmTaskRunnerConfigV1 } from '@happier-dev/protocol';

export type RunReplaySummaryForDialogFn = typeof import('@/session/replay/summary/runReplaySummaryForDialog').runReplaySummaryForDialog;

type ContinueWithReplayReplayParams = Readonly<{
    previousSessionId: string;
    strategy?: 'recent_messages' | 'summary_plus_recent' | string;
    recentMessagesCount?: number;
    maxSeedChars?: number;
    seedMode?: 'draft' | 'daemon_initial_prompt' | string;
    summaryRunner?: LlmTaskRunnerConfigV1;
}>;

export type ContinueSessionWithReplayParams = Readonly<{
    directory: string;
    agentId: CatalogAgentId;
    approvedNewDirectoryCreation?: boolean;
    permissionMode?: string;
    permissionModeUpdatedAt?: number;
    modelId?: string;
    modelUpdatedAt?: number;
    replay: ContinueWithReplayReplayParams;
}>;

export type ContinueSessionWithReplayDeps = Readonly<{
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    runReplaySummaryForDialog?: RunReplaySummaryForDialogFn;
}>;

function parseEnvBoundedInt(
    name: string,
    bounds: Readonly<{ min: number; max: number }>,
    fallback: number | null,
): number | null {
    const rawValue = process.env[name];
    if (typeof rawValue !== 'string' || rawValue.trim().length === 0) return fallback;
    const parsedValue = Number.parseInt(rawValue, 10);
    if (!Number.isFinite(parsedValue)) return fallback;
    return Math.min(bounds.max, Math.max(bounds.min, parsedValue));
}

export async function continueSessionWithReplay(
    params: ContinueSessionWithReplayParams,
    deps: ContinueSessionWithReplayDeps,
): Promise<SpawnSessionResult> {
    const {
        directory,
        agentId,
        approvedNewDirectoryCreation,
        permissionMode,
        permissionModeUpdatedAt,
        modelId,
        modelUpdatedAt,
        replay,
  } = params;

    const maxTextCharsEnv = parseEnvBoundedInt('HAPPIER_REPLAY_MAX_TEXT_CHARS', { min: 1, max: 50_000 }, null);
    const maxTextChars = maxTextCharsEnv ?? undefined;

    const credentials = await readCredentials().catch(() => null);
    if (!credentials) {
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.RESUME_MISSING_ENCRYPTION_KEY,
            errorMessage: 'This daemon is not provisioned with dataKey credentials and cannot decrypt transcripts for replay.',
        };
    }

    const replayStrategy =
        (replay.strategy ?? 'recent_messages') === 'summary_plus_recent' ? 'summary_plus_recent' : 'recent_messages';

    const recipe = await buildReplaySeededSpawnRecipe({
        credentials,
        cwd: directory,
        source: {
            sourceSessionId: replay.previousSessionId,
            forkPoint: { type: 'latest' },
        },
        providerHintAgentId: agentId,
        strategy: replayStrategy,
        recentMessagesCount: replay.recentMessagesCount ?? 250,
        ...(typeof replay.maxSeedChars === 'number' ? { maxSeedChars: replay.maxSeedChars } : {}),
        candidateLimit: configuration.replaySeedCandidateLimit,
        ...(typeof maxTextChars === 'number' ? { maxTextChars } : {}),
        summaryRunner: replay.summaryRunner ?? null,
        ...(deps.runReplaySummaryForDialog
            ? { deps: { runReplaySummaryForDialog: deps.runReplaySummaryForDialog } }
            : {}),
    });
    if (!recipe.ok) {
        return {
            type: 'error',
            errorCode: recipe.errorCode,
            errorMessage: recipe.errorMessage,
        };
    }

    logger.debug('[SESSION REPLAY] Continuing session with replay', {
        directory,
        agentId,
        approvedNewDirectoryCreation,
        previousSessionId: replay.previousSessionId,
        cutoffSeqInclusive: recipe.recipe.cutoffSeqInclusive,
        strategy: replay.strategy ?? 'recent_messages',
        recentMessagesCount: replay.recentMessagesCount ?? 250,
    });

    const normalizedModelId = typeof modelId === 'string' && modelId.trim().length > 0 ? modelId : undefined;
    const normalizedPermissionMode =
        typeof permissionMode === 'string' && isPermissionMode(permissionMode) ? permissionMode : undefined;
    const normalizedPermissionModeUpdatedAt =
        normalizedPermissionMode && typeof permissionModeUpdatedAt === 'number' ? permissionModeUpdatedAt : undefined;

    // The retry identity for this legacy ingress stays its existing per-attempt tag.
    const creationTag = `replay:${replay.previousSessionId}:${recipe.recipe.cutoffSeqInclusive}:${randomUUID()}`;

    try {
        const created = await createSpawnedSession({
            credentials,
            directory,
            backendTarget: { kind: 'builtInAgent', agentId },
            ...(typeof approvedNewDirectoryCreation === 'boolean'
                ? { approvedNewDirectoryCreation }
                : {}),
            ...(normalizedPermissionMode ? { permissionMode: normalizedPermissionMode } : {}),
            ...(typeof normalizedPermissionModeUpdatedAt === 'number'
                ? { permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt }
                : {}),
            ...(normalizedModelId ? { modelId: normalizedModelId } : {}),
            ...(typeof modelUpdatedAt === 'number' ? { modelUpdatedAt } : {}),
            replaySeededCreation: {
                tag: creationTag,
                agentId,
                metadata: recipe.recipe.metadata,
                sourceRecipe: {
                    sourceSessionId: replay.previousSessionId,
                    cutoffSeqInclusive: recipe.recipe.cutoffSeqInclusive,
                },
            },
            // This ingress runs inside the daemon; route the launch through its
            // in-process handler instead of self-calling the control server.
            directTransport: {
                spawn: async (request) => await deps.spawnSession({
                    directory,
                    backendTarget: { kind: 'builtInAgent', agentId },
                    approvedNewDirectoryCreation,
                    existingSessionId: request.existingSessionId,
                    permissionMode: normalizedPermissionMode,
                    permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
                    modelId: normalizedModelId,
                    modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
                } satisfies SpawnSessionOptions),
            },
        });
        return { type: 'success', sessionId: created.sessionId };
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        const failure = readReplaySeededCreationFailure(error);
        if (failure.stage === 'spawn') {
            // The canonical creator already settled the orphaned row; surface the
            // launch envelope exactly as this ingress always has.
            return failure.spawnResult as SpawnSessionResult;
        }
        logger.debug('[SESSION REPLAY] Failed to create replay-seeded session', {
            error: failure.errorMessage,
        });
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: 'Failed to create a new session for replay',
        };
    }
}
