import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { isPermissionMode } from '@/api/types';
import { readCredentials } from '@/persistence';
import { createReplaySeededSession } from '@/session/replay/createReplaySeededSession';
import { resolveReplaySeedDraft } from '@/session/replay/resolveReplaySeedDraft';
import { archiveSessionByIdBestEffort } from '@/session/services/setSessionArchivedState';
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

async function archiveSessionBestEffort(token: string, sessionId: string): Promise<void> {
    await archiveSessionByIdBestEffort({ token, sessionId });
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

    const resolvedSeed = await resolveReplaySeedDraft({
        credentials,
        cwd: directory,
        source: {
            kind: 'fork_chain',
            previousSessionId: replay.previousSessionId,
        },
        strategy: replayStrategy,
        recentMessagesCount: replay.recentMessagesCount ?? 250,
        maxSeedChars: typeof replay.maxSeedChars === 'number' ? replay.maxSeedChars : configuration.replaySeedMaxChars,
        candidateLimit: configuration.replaySeedCandidateLimit,
        maxTextChars,
        summaryRunner: replay.summaryRunner ?? null,
        deps: deps.runReplaySummaryForDialog ? { runReplaySummaryForDialog: deps.runReplaySummaryForDialog } : undefined,
    });
    if (!resolvedSeed) {
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
            errorMessage: 'Unable to hydrate replay dialog from transcript.',
        };
    }

    const seedDraft = resolvedSeed.seedDraft;
    if (!seedDraft.trim()) {
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.INVALID_REQUEST,
            errorMessage: 'Replay seed draft is empty',
        };
    }

    logger.debug('[SESSION REPLAY] Continuing session with replay', {
        directory,
        agentId,
        approvedNewDirectoryCreation,
        previousSessionId: replay.previousSessionId,
        dialogCount: resolvedSeed.dialog.length,
        strategy: replay.strategy ?? 'recent_messages',
        recentMessagesCount: replay.recentMessagesCount ?? 250,
    });

    const nowMs = Date.now();
    const created = await (async () => {
        try {
            return await createReplaySeededSession({
                credentials,
                directory,
                agentId,
                tag: `replay:${replay.previousSessionId}:${resolvedSeed.sourceCutoffSeqInclusive}:${randomUUID()}`,
                metadata: {
                    forkV1: {
                        v: 1,
                        parentSessionId: replay.previousSessionId,
                        parentCutoffSeqInclusive: resolvedSeed.sourceCutoffSeqInclusive,
                        createdAtMs: nowMs,
                        strategy: 'replay',
                        providerHint: { providerId: agentId },
                    },
                    replaySeedV1: {
                        v: 1,
                        seedText: seedDraft,
                        sourceSessionId: replay.previousSessionId,
                        sourceCutoffSeqInclusive: resolvedSeed.sourceCutoffSeqInclusive,
                        createdAtMs: nowMs,
                    },
                },
            });
        } catch (error) {
            logger.debug('[SESSION REPLAY] Failed to create replay-seeded session', {
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    })();

    if (!created) {
        return {
            type: 'error',
            errorCode: SPAWN_SESSION_ERROR_CODES.UNEXPECTED,
            errorMessage: 'Failed to create a new session for replay',
        };
    }

    const normalizedModelId = typeof modelId === 'string' && modelId.trim().length > 0 ? modelId : undefined;
    const normalizedPermissionMode =
        typeof permissionMode === 'string' && isPermissionMode(permissionMode) ? permissionMode : undefined;
    const normalizedPermissionModeUpdatedAt =
        normalizedPermissionMode && typeof permissionModeUpdatedAt === 'number' ? permissionModeUpdatedAt : undefined;

    const result = await deps.spawnSession({
        directory,
        backendTarget: { kind: 'builtInAgent', agentId },
        approvedNewDirectoryCreation,
        existingSessionId: created.sessionId,
        permissionMode: normalizedPermissionMode,
        permissionModeUpdatedAt: normalizedPermissionModeUpdatedAt,
        modelId: normalizedModelId,
        modelUpdatedAt: typeof modelUpdatedAt === 'number' ? modelUpdatedAt : undefined,
    } satisfies SpawnSessionOptions);

    if (result.type === 'success') {
        return { type: 'success', sessionId: created.sessionId };
    }

    await archiveSessionBestEffort(credentials.token, created.sessionId);
    return result;
}
