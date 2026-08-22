import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { isPermissionMode } from '@/api/types';
import { readStoredCredentials } from '@/persistence';
import { buildReplaySeededSpawnRecipe } from '@/session/replay/buildReplaySeededSpawnRecipe';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { createSpawnedSession } from '@/session/services/createSpawnedSession';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import {
    SpawnSessionErrorCodeSchema,
    type BackendTargetRefV2Input,
    type LlmTaskRunnerConfigV1,
    type SessionModelSelectionV1,
} from '@happier-dev/protocol';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import {
    createStableSpawnNonce,
    normalizeSpawnNonce,
} from '@/session/shared/spawnNonce';

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
    backendTarget: BackendTargetRefV2Input;
    approvedNewDirectoryCreation?: boolean;
    permissionMode?: string;
    permissionModeUpdatedAt?: number;
    modelSelection?: SessionModelSelectionV1;
    spawnNonce?: string;
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
        backendTarget,
        approvedNewDirectoryCreation,
        permissionMode,
        permissionModeUpdatedAt,
        modelSelection,
        spawnNonce,
        replay,
  } = params;

    const resolvedBackend = getSessionHostBridge().resolveContinueWithReplayBackendTarget({ backendTarget });
    if (!resolvedBackend.ok) {
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
            errorMessage: resolvedBackend.errorMessage,
        };
    }

    const maxTextCharsEnv = parseEnvBoundedInt('HAPPIER_REPLAY_MAX_TEXT_CHARS', { min: 1, max: 50_000 }, null);
    const maxTextChars = maxTextCharsEnv ?? undefined;

    const credentials = await readStoredCredentials().catch(() => null);
    if (!credentials) {
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
            errorMessage: 'Not authenticated',
        };
    }

    const replayStrategy =
        (replay.strategy ?? 'recent_messages') === 'summary_plus_recent' ? 'summary_plus_recent' : 'recent_messages';

    const recipeResult = await buildReplaySeededSpawnRecipe({
        credentials,
        cwd: directory,
        source: {
            sourceSessionId: replay.previousSessionId,
            forkPoint: { type: 'latest' },
        },
        agentHintAgentId: resolvedBackend.agentHintAgentId,
        strategy: replayStrategy,
        recentMessagesCount: replay.recentMessagesCount ?? 250,
        maxSeedChars: typeof replay.maxSeedChars === 'number' ? replay.maxSeedChars : configuration.replaySeedMaxChars,
        candidateLimit: configuration.replaySeedCandidateLimit,
        ...(typeof maxTextChars === 'number' ? { maxTextChars } : {}),
        summaryRunner: replay.summaryRunner ?? null,
        ...(deps.runReplaySummaryForDialog
            ? { deps: { runReplaySummaryForDialog: deps.runReplaySummaryForDialog } }
            : {}),
    });
    if (!recipeResult.ok) {
        return {
            type: 'error',
            errorCode: recipeResult.errorCode,
            errorMessage: recipeResult.errorMessage,
        };
    }
    const recipe = recipeResult.recipe;

    const replaySpawnNonce = normalizeSpawnNonce(spawnNonce) ?? createStableSpawnNonce('session.continue_with_replay', {
        directory,
        backendTarget: resolvedBackend.backendTargetV2,
        previousSessionId: replay.previousSessionId,
        sourceCutoffSeqInclusive: recipe.cutoffSeqInclusive,
        strategy: replayStrategy,
        recentMessagesCount: replay.recentMessagesCount ?? 250,
        maxSeedChars: typeof replay.maxSeedChars === 'number' ? replay.maxSeedChars : configuration.replaySeedMaxChars,
        seedMode: replay.seedMode ?? null,
        summaryRunner: replay.summaryRunner ?? null,
        permissionMode: typeof permissionMode === 'string' ? permissionMode : null,
        modelSelection: modelSelection ?? null,
    });

    logger.debug('[SESSION REPLAY] Continuing session with replay', {
        directory,
        backendTargetV2: resolvedBackend.backendTargetV2,
        approvedNewDirectoryCreation,
        previousSessionId: replay.previousSessionId,
        sourceCutoffSeqInclusive: recipe.cutoffSeqInclusive,
        strategy: replay.strategy ?? 'recent_messages',
        recentMessagesCount: replay.recentMessagesCount ?? 250,
    });

    const normalizedPermissionMode =
        typeof permissionMode === 'string' && isPermissionMode(permissionMode) ? permissionMode : undefined;
    const normalizedPermissionModeUpdatedAt =
        normalizedPermissionMode && typeof permissionModeUpdatedAt === 'number' ? permissionModeUpdatedAt : undefined;

    try {
        // Row creation, create-or-rejoin settlement and orphan cleanup all
        // belong to the canonical creator. This ingress contributes only its
        // own durable retry identity and its legacy result shape.
        const created = await createSpawnedSession({
            credentials,
            directory,
            backendTarget: resolvedBackend.backendTargetV2,
            spawnNonce: replaySpawnNonce,
            ...(typeof approvedNewDirectoryCreation === 'boolean' ? { approvedNewDirectoryCreation } : {}),
            ...(normalizedPermissionMode ? { permissionMode: normalizedPermissionMode } : {}),
            ...(typeof normalizedPermissionModeUpdatedAt === 'number'
                ? { permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt }
                : {}),
            ...(modelSelection ? { modelSelection } : {}),
            replaySeededCreation: {
                tag: replaySpawnNonce,
                flavor: resolvedBackend.replayFlavor,
                metadata: recipe.metadata,
                sourceRecipe: {
                    sourceSessionId: replay.previousSessionId,
                    cutoffSeqInclusive: recipe.cutoffSeqInclusive,
                },
            },
            directTransport: {
                spawn: async (request) => await deps.spawnSession({
                    ...request,
                    backendTarget: resolvedBackend.backendTargetV2,
                } satisfies SpawnSessionOptions),
                resolveSpawnSessionByNonce: async () => ({ status: 'unsupported' as const }),
            },
        });
        return { type: 'success', sessionId: created.sessionId };
    } catch (error) {
        if (isAuthenticationError(error)) throw error;
        const candidateErrorCode = error && typeof error === 'object'
            && typeof (error as { code?: unknown }).code === 'string'
            && (error as { code: string }).code.trim().length > 0
            ? (error as { code: string }).code
            : null;
        const parsedErrorCode = SpawnSessionErrorCodeSchema.safeParse(candidateErrorCode);
        const errorCode = parsedErrorCode.success
            ? parsedErrorCode.data
            : SPAWN_SESSION_ERROR_CODES.UNEXPECTED;
        const errorMessage = error instanceof Error && error.message.trim().length > 0
            ? error.message
            : 'Failed to create a new session for replay';
        logger.debug('[SESSION REPLAY] Replay-seeded session creation failed', { errorCode, errorMessage });
        return { type: 'error', errorCode, errorMessage };
    }
}
