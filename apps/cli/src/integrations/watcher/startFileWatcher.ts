import { logger } from "@/ui/logger";
import { delay } from "@/utils/time";
import { stat, watch } from "node:fs/promises";
import { basename, dirname } from "node:path";

export function startFileWatcher(file: string, onFileChange: (file: string) => void) {
    const abortController = new AbortController();
    const parentDir = dirname(file);
    const targetName = basename(file);

    void (async () => {
        while (true) {
            try {
                // Avoid noisy ENOENT loops when the target file doesn't exist yet (common for Task output_file handles).
                // Instead, watch the parent directory until the file appears, then watch the file itself.
                try {
                    await stat(file);
                } catch (e: any) {
                    if (abortController.signal.aborted) return;
                    if (e?.code === 'ENOENT') {
                        logger.debug(`[FILE_WATCHER] Waiting for file to exist: ${file}`);
                        const dirWatcher = watch(parentDir, { persistent: true, signal: abortController.signal });
                        // Close the race where the file is created between the initial stat() and the directory watcher startup.
                        try {
                            await stat(file);
                        } catch (err: any) {
                            if (err?.code !== 'ENOENT') throw err;
                            for await (const event of dirWatcher) {
                                if (abortController.signal.aborted) {
                                    return;
                                }
                                const name = typeof (event as any)?.filename === 'string' ? String((event as any).filename) : null;
                                if (name && name !== targetName) {
                                    continue;
                                }
                                try {
                                    await stat(file);
                                    logger.debug(`[FILE_WATCHER] File appeared: ${file}`);
                                    break;
                                } catch (nextErr: any) {
                                    if (nextErr?.code === 'ENOENT') {
                                        continue;
                                    }
                                    throw nextErr;
                                }
                            }
                        }
                    } else {
                        throw e;
                    }
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
            } catch (e: any) {
                if (abortController.signal.aborted) {
                    return;
                }
                logger.debug(`[FILE_WATCHER] Watch error: ${e.message}, restarting watcher in a second`);
                await delay(1000);
            }
        }
    })();

    return () => {
        abortController.abort();
    };
}
