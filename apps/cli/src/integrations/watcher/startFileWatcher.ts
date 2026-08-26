import { logger } from "@/ui/logger";
import { delayUnrefAbortable } from "@/utils/time";
import { stat, watch } from "node:fs/promises";
import { basename, dirname } from "node:path";

const DEFAULT_MISSING_PARENT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MISSING_PARENT_TIMEOUT_MS = 30_000;
const DEFAULT_WATCH_RESTART_DELAY_MS = 1_000;

interface StartFileWatcherPolicy {
    missingParentRetryDelayMs: number;
    missingParentTimeoutMs: number;
    watchRestartDelayMs: number;
}

const DEFAULT_WATCHER_POLICY: StartFileWatcherPolicy = {
    missingParentRetryDelayMs: DEFAULT_MISSING_PARENT_RETRY_DELAY_MS,
    missingParentTimeoutMs: DEFAULT_MISSING_PARENT_TIMEOUT_MS,
    watchRestartDelayMs: DEFAULT_WATCH_RESTART_DELAY_MS,
};

function hasErrorCode(error: unknown, code: string): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && (error as NodeJS.ErrnoException).code === code;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch (error) {
        if (hasErrorCode(error, 'ENOENT')) {
            return false;
        }
        throw error;
    }
}

async function waitForParentDirectory(
    opts: {
        file: string;
        parentDir: string;
        abortSignal: AbortSignal;
        watcherPolicy: StartFileWatcherPolicy;
    }
): Promise<boolean> {
    const { file, parentDir, abortSignal, watcherPolicy } = opts;
    let elapsedMs = 0;
    let attempts = 0;
    let loggedMissingParent = false;

    while (!abortSignal.aborted) {
        if (await pathExists(parentDir)) {
            return true;
        }

        attempts += 1;
        if (elapsedMs >= watcherPolicy.missingParentTimeoutMs) {
            logger.debug(
                `[FILE_WATCHER] Parent directory still missing after ${attempts} attempts over ${elapsedMs}ms; stopping watcher for ${file}`
            );
            return false;
        }

        if (!loggedMissingParent) {
            loggedMissingParent = true;
            logger.debug(
                `[FILE_WATCHER] Parent directory missing for ${file}; retrying for up to ${watcherPolicy.missingParentTimeoutMs}ms`
            );
        }

        const remainingMs = watcherPolicy.missingParentTimeoutMs - elapsedMs;
        const retryDelayMs = Math.min(watcherPolicy.missingParentRetryDelayMs, remainingMs);
        await delayUnrefAbortable(retryDelayMs, abortSignal);
        elapsedMs += retryDelayMs;
    }

    return false;
}

async function waitForFileToExist(
    opts: {
        file: string;
        parentDir: string;
        targetName: string;
        abortSignal: AbortSignal;
        watcherPolicy: StartFileWatcherPolicy;
    }
): Promise<boolean> {
    const { file, parentDir, targetName, abortSignal, watcherPolicy } = opts;

    if (await pathExists(file)) {
        return true;
    }

    if (abortSignal.aborted) {
        return false;
    }

    const parentExists = await waitForParentDirectory({ file, parentDir, abortSignal, watcherPolicy });
    if (!parentExists || abortSignal.aborted) {
        return false;
    }

    logger.debug(`[FILE_WATCHER] Waiting for file to exist: ${file}`);

    while (!abortSignal.aborted) {
        let dirWatcher: AsyncIterable<unknown>;
        try {
            dirWatcher = watch(parentDir, { persistent: true, signal: abortSignal });
        } catch (error) {
            if (abortSignal.aborted) {
                return false;
            }
            if (hasErrorCode(error, 'ENOENT')) {
                const recovered = await waitForParentDirectory({ file, parentDir, abortSignal, watcherPolicy });
                if (!recovered) {
                    return false;
                }
                continue;
            }
            throw error;
        }

        if (await pathExists(file)) {
            return true;
        }

        for await (const event of dirWatcher) {
            if (abortSignal.aborted) {
                return false;
            }

            const name = typeof (event as { filename?: unknown })?.filename === 'string'
                ? String((event as { filename: string }).filename)
                : null;
            if (name && name !== targetName) {
                continue;
            }

            if (await pathExists(file)) {
                logger.debug(`[FILE_WATCHER] File appeared: ${file}`);
                return true;
            }
        }
    }

    return false;
}

export function startFileWatcher(file: string, onFileChange: (file: string) => void) {
    const abortController = new AbortController();
    const parentDir = dirname(file);
    const targetName = basename(file);
    const watcherPolicy = DEFAULT_WATCHER_POLICY;

    const watcherTask = (async () => {
        while (true) {
            try {
                const fileExists = await waitForFileToExist({
                    file,
                    parentDir,
                    targetName,
                    abortSignal: abortController.signal,
                    watcherPolicy,
                });
                if (!fileExists) {
                    return;
                }

                // Emit an initial callback once we know the file exists, even if it existed before we started watching.
                // This makes "watch + read once" consumers race-free.
                onFileChange(file);

                logger.debug(`[FILE_WATCHER] Starting watcher for ${file}`);
                const watcher = watch(file, { persistent: true, signal: abortController.signal });
                for await (const event of watcher) {
                    if (abortController.signal.aborted) {
                        return;
                    }
                    logger.debug(`[FILE_WATCHER] File changed: ${file}`);
                    onFileChange(file);
                }
            } catch (e) {
                if (abortController.signal.aborted) {
                    return;
                }
                logger.debug(`[FILE_WATCHER] Watch error: ${errorMessage(e)}, restarting watcher in ${watcherPolicy.watchRestartDelayMs}ms`);
                await delayUnrefAbortable(watcherPolicy.watchRestartDelayMs, abortController.signal);
            }
        }
    })();

    return async () => {
        abortController.abort();
        await watcherTask;
    };
}
