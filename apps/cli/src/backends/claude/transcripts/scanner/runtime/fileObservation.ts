import { readFile } from 'node:fs/promises';

import { startFileWatcher } from '@/integrations/watcher/startFileWatcher';
import { logger } from '@/ui/logger';

export function createFileObservationRuntime(params: Readonly<{
    onInvalidate: () => void;
    onTranscriptMissing?: ((info: { sessionId: string; filePath: string }) => void) | undefined;
    transcriptMissingWarningMs: number;
}>) {
    const watchers = new Map<string, { filePath: string; stop: () => void }>();
    const warnedMissingTranscripts = new Set<string>();
    const missingTranscriptTimers = new Map<string, NodeJS.Timeout>();

    function scheduleTranscriptMissingWarning(sessionId: string, filePath: string): void {
        if (!params.onTranscriptMissing) return;
        if (!Number.isFinite(params.transcriptMissingWarningMs) || params.transcriptMissingWarningMs <= 0) return;
        if (warnedMissingTranscripts.has(sessionId)) return;
        if (missingTranscriptTimers.has(sessionId)) return;

        const timeoutId = setTimeout(async () => {
            missingTranscriptTimers.delete(sessionId);
            if (warnedMissingTranscripts.has(sessionId)) return;

            try {
                await readFile(filePath, 'utf-8');
                return;
            } catch {
                // still missing or unreadable
            }

            warnedMissingTranscripts.add(sessionId);
            try {
                params.onTranscriptMissing?.({ sessionId, filePath });
            } catch (err) {
                logger.debug('[SESSION_SCANNER] onTranscriptMissing callback threw:', err);
            }
        }, params.transcriptMissingWarningMs);

        missingTranscriptTimers.set(sessionId, timeoutId);
    }

    function ensureWatching(sessionId: string, filePath: string): void {
        const existing = watchers.get(sessionId);
        if (!existing) {
            logger.debug(`[SESSION_SCANNER] Starting watcher for session: ${sessionId}`);
            watchers.set(sessionId, {
                filePath,
                stop: startFileWatcher(filePath, () => {
                    params.onInvalidate();
                }),
            });
            return;
        }

        if (existing.filePath === filePath) {
            return;
        }

        logger.debug(`[SESSION_SCANNER] Restarting watcher for session: ${sessionId} (${existing.filePath} -> ${filePath})`);
        existing.stop();
        watchers.set(sessionId, {
            filePath,
            stop: startFileWatcher(filePath, () => {
                params.onInvalidate();
            }),
        });
    }

    function syncWatchers(paramsForSync: Readonly<{
        sessionIds: readonly string[];
        hasStoreLease: (sessionId: string) => boolean;
        resolveFilePath: (sessionId: string) => string;
    }>): void {
        for (const sessionId of paramsForSync.sessionIds) {
            const desiredPath = paramsForSync.resolveFilePath(sessionId);
            if (paramsForSync.hasStoreLease(sessionId)) {
                const existing = watchers.get(sessionId);
                if (existing) {
                    existing.stop();
                    watchers.delete(sessionId);
                }
                continue;
            }

            const existing = watchers.get(sessionId);
            if (!existing || existing.filePath !== desiredPath) {
                ensureWatching(sessionId, desiredPath);
            }
        }
    }

    function cleanup(): void {
        for (const watcher of watchers.values()) {
            watcher.stop();
        }
        watchers.clear();
        for (const timeoutId of missingTranscriptTimers.values()) {
            clearTimeout(timeoutId);
        }
        missingTranscriptTimers.clear();
    }

    return {
        cleanup,
        ensureWatching,
        getWatchedSessionIds(): string[] {
            return Array.from(watchers.keys());
        },
        scheduleTranscriptMissingWarning,
        syncWatchers,
    };
}
