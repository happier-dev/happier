import { InvalidateSync } from "@/utils/sync";
import {
    createMessageRouter,
    createClaudeTeamInboxCollector,
    resolveClaudeSubagentJsonlPath,
    type RawJSONLines,
} from "@happier-dev/plugins-claude/agent";
import { logger } from "@/ui/logger";
import { startFileWatcher } from "@/integrations/watcher/startFileWatcher";
import { ClaudeRemoteSubagentFileCollector } from '../remote/sidechains/claudeRemoteSubagentFileCollector';
import { createEventShapeLoggerForLog } from '@/diagnostics/eventShapeForLog';
import { createSessionCoordinator } from '../transcripts/scanner/coordination/sessionCoordinator';
import { createSessionPathResolver } from '../transcripts/scanner/paths/sessionPathResolver';
import { createFileObservationRuntime } from '../transcripts/scanner/runtime/fileObservation';
import { createMainTranscriptStore } from '../transcripts/scanner/stores/mainTranscriptStore';

export type SessionScannerSessionInfo = {
    sessionId: string;
    transcriptPath?: string | null;
};

export async function createSessionScanner(opts: {
    sessionId: string | null,
    /**
     * Optional absolute transcript file path for the initial sessionId (from Claude's SessionStart hook).
     * When provided, it is used instead of the `getProjectPath()` heuristic.
     */
    transcriptPath?: string | null,
    /**
     * Optional Claude config dir override (e.g., when the child process runs with CLAUDE_CONFIG_DIR set).
     * Used only for the heuristic project-dir fallback when transcriptPath is not available.
     */
    claudeConfigDir?: string | null,
    workingDirectory: string
    onMessage: (message: RawJSONLines) => void
    onTranscriptMissing?: (info: { sessionId: string; filePath: string }) => void
    /** How long to wait (ms) before warning that the transcript file is missing. Set <= 0 to disable. */
    transcriptMissingWarningMs?: number
}) {
    const shapeLogger = createEventShapeLoggerForLog({ logger, scope: 'claude-jsonl' });
    const messageRouter = createMessageRouter({
        onMessage: (message) => {
            try {
                opts.onMessage(message);
            } catch (err) {
                logger.debug('[SESSION_SCANNER] onMessage callback threw:', err);
            }
        },
        logEvent: (event, message) => {
            shapeLogger.log(event, message);
        },
    });

    const sessionPathResolver = createSessionPathResolver({
        sessionId: opts.sessionId,
        transcriptPath: opts.transcriptPath ?? null,
        workingDirectory: opts.workingDirectory,
        claudeConfigDir: opts.claudeConfigDir ?? null,
    });
    const sessionCoordinator = createSessionCoordinator({
        sessionId: opts.sessionId,
    });

    const transcriptMissingWarningMs = opts.transcriptMissingWarningMs ?? 5000;
    const mainTranscriptStoreLifecycle = createMainTranscriptStore({
        workingDirectory: opts.workingDirectory,
        claudeConfigDir: opts.claudeConfigDir ?? null,
        invalidate: () => invalidate?.(),
    });
    const fileObservationRuntime = createFileObservationRuntime({
        onInvalidate: () => invalidate?.(),
        onTranscriptMissing: opts.onTranscriptMissing,
        transcriptMissingWarningMs,
    });

    let invalidate: (() => void) | null = null;
    let shuttingDown = false;

    const subagentCollector = new ClaudeRemoteSubagentFileCollector({
        emitImported: (body) => {
            try {
                messageRouter.emitImportedSidechainMessage(body);
            } catch {
                // If router emission fails unexpectedly, keep behavior best-effort and continue.
            }
        },
        resolveJsonlPathForAgentId: ({ agentId, sidechainId, claudeSessionId }) => {
            if (!claudeSessionId) return null;
            const sanitized = String(agentId ?? '').trim();
            const sanitizedSidechainId = String(sidechainId ?? '').trim();
            if (!sanitized && !sanitizedSidechainId) return null;
            return resolveClaudeSubagentJsonlPath({
                projectDir: sessionPathResolver.getProjectDirForSession(sessionCoordinator.getCurrentSessionId()),
                claudeSessionId,
                agentId: sanitized,
                sidechainId: sanitizedSidechainId,
            });
        },
    });

    const teamInboxCollector = createClaudeTeamInboxCollector({
        claudeConfigDir: typeof opts.claudeConfigDir === 'string' && opts.claudeConfigDir.trim().length > 0 ? opts.claudeConfigDir.trim() : null,
        onInvalidate: () => invalidate?.(),
        emit: (body) => {
            try {
                messageRouter.emitImportedTeamInboxMessage(body);
            } catch {
                // ignore
            }
        },
        watchFile: (filePath, onChange) => startFileWatcher(filePath, () => onChange()),
        logDebug: (message, metadata) => logger.debug(message, metadata),
    });

    if (opts.sessionId) {
        fileObservationRuntime.scheduleTranscriptMissingWarning(opts.sessionId, sessionPathResolver.getSessionFilePath(opts.sessionId));
    }

    // Main sync function
    const sync = new InvalidateSync(async () => {
        if (shuttingDown) {
            return;
        }
        // logger.debug(`[SESSION_SCANNER] Syncing...`);

        // Collect session ids - include ALL sessions that have watchers
        // This ensures we continue processing sessions that Claude Code may still write to
        const sessions = sessionCoordinator.collectSessionsToSync(fileObservationRuntime.getWatchedSessionIds());
        const currentSessionId = sessionCoordinator.getCurrentSessionId();

        // Process sessions
        for (let session of sessions) {
            if (shuttingDown) {
                return;
            }
            const sessionFilePath = sessionPathResolver.getSessionFilePath(session);
            await mainTranscriptStoreLifecycle.sync(session, sessionFilePath);
            if (shuttingDown) {
                return;
            }
            const sessionRead = await mainTranscriptStoreLifecycle.readNext(session, sessionFilePath);
            if (!sessionRead.initialized) {
                continue;
            }
            const previousCursor = sessionRead.previousCursor;
            const shouldEmitMessages = sessionCoordinator.resolveInitialReplayEmission(session, previousCursor);
            const sessionMessages = sessionRead.items;
            let skipped = 0;
            let sent = 0;
            for (let file of sessionMessages) {
                try {
                    messageRouter.observeSessionMessage(file);
                    subagentCollector.observe(file as any);
                    teamInboxCollector.observe(file as any);
                } catch (err) {
                    logger.debug('[SESSION_SCANNER] Failed observing message:', err);
                }
                logger.debug(`[SESSION_SCANNER] Sending new message: type=${file.type}, uuid=${file.type === 'summary' ? file.leafUuid : file.uuid}`);
                if (!shouldEmitMessages && session === currentSessionId) {
                    skipped++;
                    continue;
                }
                if (shuttingDown) {
                    return;
                }
                try {
                    messageRouter.emitSessionMessage(file, shouldEmitMessages || session !== currentSessionId);
                    sent++; // count only emitted messages
                } catch (err) {
                    logger.debug('[SESSION_SCANNER] onMessage callback threw:', err);
                }
            }
            if (sessionMessages.length > 0) {
                logger.debug(`[SESSION_SCANNER] Session ${session}: found=${sessionMessages.length}, skipped=${skipped}, sent=${sent}`);
            }
        }

        if (shuttingDown) {
            return;
        }
        await subagentCollector.syncAll();
        await teamInboxCollector.syncAll();

        sessionCoordinator.markSessionsSynced(sessions);

        if (shuttingDown) {
            return;
        }
        fileObservationRuntime.syncWatchers({
            sessionIds: sessions,
            hasStoreLease: (sessionId) => mainTranscriptStoreLifecycle.hasStoreLease(sessionId),
            resolveFilePath: (sessionId) => sessionPathResolver.getSessionFilePath(sessionId),
        });
    });
    invalidate = () => sync.invalidate();
    await sync.invalidateAndAwait();

    // Periodic sync
    const intervalId = setInterval(() => { sync.invalidate(); }, 3000);

    // Public interface
    return {
        cleanup: async () => {
            shuttingDown = true;
            clearInterval(intervalId);
            sessionCoordinator.shutdown();
            fileObservationRuntime.cleanup();
            await mainTranscriptStoreLifecycle.cleanup();
            messageRouter.reset();
            subagentCollector.cleanup();
            teamInboxCollector.cleanup();
            await sync.invalidateAndAwait();
            sync.stop();
        },
        onNewSession: (arg: string | SessionScannerSessionInfo) => {
            if (shuttingDown) {
                return;
            }
            const sessionId = typeof arg === 'string' ? arg : arg.sessionId;
            const transcriptPathRaw = typeof arg === 'string' ? null : arg.transcriptPath;
            const transcriptPath = typeof transcriptPathRaw === 'string' && transcriptPathRaw.trim() ? transcriptPathRaw : null;

            const didUpdatePaths = sessionPathResolver.applyTranscriptPathOverride(sessionId, transcriptPath);
            if (didUpdatePaths) {
                mainTranscriptStoreLifecycle.resetSession(sessionId);
            }

            const transition = sessionCoordinator.onNewSession(sessionId);

            if (!transition.shouldWarmSession) {
                if (didUpdatePaths) {
                    sync.invalidate();
                } else {
                    logger.debug(`[SESSION_SCANNER] New session: ${sessionId} is already tracked, skipping`);
                }
                return;
            }

            logger.debug(`[SESSION_SCANNER] New session: ${sessionId}`)
            const sessionFilePath = transcriptPath ?? sessionPathResolver.getSessionFilePath(sessionId);
            // Prime observation immediately so the first append cannot land before the initial sync finishes.
            fileObservationRuntime.ensureWatching(sessionId, sessionFilePath);
            void mainTranscriptStoreLifecycle.sync(sessionId, sessionFilePath);
            fileObservationRuntime.scheduleTranscriptMissingWarning(sessionId, sessionPathResolver.getSessionFilePath(sessionId));
            if (transition.shouldInvalidate || didUpdatePaths) {
                sync.invalidate();
            }
        },
    }
}

export type SessionScanner = ReturnType<typeof createSessionScanner>;
