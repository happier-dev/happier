import type { SessionModelSelection } from '@happier-dev/protocol/providers/selection/v2';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { isPermissionMode } from '@/api/types';
import { readStoredCredentials, type StoredCredentials } from '@/persistence';
import { buildReplaySeededSpawnRecipe } from '@/session/replay/buildReplaySeededSpawnRecipe';
import { readReplayTextLimitFromEnv } from '@/session/replay/readReplayTextLimitFromEnv';
import { getSessionHostBridge } from '@/agent/runtime/bridges/session/SessionHostBridge';
import { createSpawnedSession } from '@/session/services/createSpawnedSession';
import { SPAWN_SESSION_ERROR_CODES, type SpawnSessionOptions, type SpawnSessionResult } from '@/session/shared/spawnSessionContract';
import { SpawnSessionErrorCodeSchema } from '@happier-dev/protocol/spawnSession';
import type { BackendTargetRefV2Input } from '@happier-dev/protocol';
import type { LlmTaskRunnerChoiceV1 } from '@happier-dev/protocol/llm/tasks/llmTaskRunnerConfigV1';
import { isAuthenticationError } from '@/api/client/httpStatusError';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { tryDecryptSessionOwnerMetadataView } from '@/session/transport/encryption/sessionEncryptionContext';
import { readSessionStateFieldFromMetadata } from '@happier-dev/agents';
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
    summaryRunner?: LlmTaskRunnerChoiceV1;
}>;

export type ContinueSessionWithReplayParams = Readonly<{
    directory: string;
    backendTarget: BackendTargetRefV2Input;
    approvedNewDirectoryCreation?: boolean;
    permissionMode?: string;
    permissionModeUpdatedAt?: number;
    modelSelection?: SessionModelSelection;
    approvalProfileId?: string | null;
    spawnNonce?: string;
    replay: ContinueWithReplayReplayParams;
}>;

export type ContinueSessionWithReplayDeps = Readonly<{
    credentials?: StoredCredentials;
    isCurrent?: () => Promise<boolean>;
    spawnSession: (options: SpawnSessionOptions) => Promise<SpawnSessionResult>;
    runReplaySummaryForDialog?: RunReplaySummaryForDialogFn;
}>;

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

    const maxTextCharsEnv = readReplayTextLimitFromEnv();
    const maxTextChars = maxTextCharsEnv ?? undefined;

    if (deps.isCurrent && !await deps.isCurrent()) return { type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE, errorMessage: 'Requester Session authority is unavailable' };
    const credentials = deps.credentials ?? await readStoredCredentials().catch(() => null);
    if (!credentials) {
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
            errorMessage: 'Not authenticated',
        };
    }

    let approvalProfileId = params.approvalProfileId;
    if (approvalProfileId === undefined) {
        try {
            const [sourceSession, currentness] = await Promise.all([
                fetchSessionByIdCompat({ reason: 'session-replay', token: credentials.token, sessionId: replay.previousSessionId }),
                fetchAccountEncryptionCurrentness({ credentials, token: credentials.token }),
            ]);
            const metadata = sourceSession && tryDecryptSessionOwnerMetadataView({
                credentials, rawSession: sourceSession, accountEncryptionMode: currentness.mode,
            });
            if (!metadata) return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
                errorMessage: 'Unable to read source session metadata' };
            approvalProfileId = readSessionStateFieldFromMetadata(metadata, 'intent.approvalProfileId') ?? null;
        } catch (error) {
            if (isAuthenticationError(error)) throw error;
            return { type: 'error', errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
                errorMessage: error instanceof Error ? error.message : 'Failed to load source session' };
        }
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
    if (deps.isCurrent && !await deps.isCurrent()) return { type: 'error',
        errorCode: SPAWN_SESSION_ERROR_CODES.DAEMON_RPC_UNAVAILABLE, errorMessage: 'Requester Session authority is unavailable' };

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
            approvalProfileId,
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
