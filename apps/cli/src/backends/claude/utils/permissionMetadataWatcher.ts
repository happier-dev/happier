import { logger } from '@/lib';
import { configuration } from '@/configuration';
import { syncClaudePermissionModeFromMetadata } from '@/backends/claude/utils/syncPermissionModeFromMetadata';

import type { Session } from '../runtime/session/ClaudeSession';

export function startClaudePermissionMetadataWatcher(params: Readonly<{
    session: Session;
    onPermissionModeUpdated: (mode: string) => void;
}>): AbortController | null {
    if (typeof params.session.client.waitForMetadataUpdate !== 'function') return null;

    const controller = new AbortController();
    const signal = controller.signal;
    const backoffMs = configuration.claudeMetadataWatcherIdleBackoffMs;
    const waitForAbortOrBackoff = async (): Promise<void> => {
        if (signal.aborted) return;
        if (backoffMs <= 0) return;
        await new Promise<void>((resolve) => {
            let settled = false;
            const onAbort = () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                signal.removeEventListener('abort', onAbort);
                resolve();
            };
            const timer = setTimeout(() => {
                if (settled) return;
                settled = true;
                signal.removeEventListener('abort', onAbort);
                resolve();
            }, backoffMs);
            timer.unref?.();
            signal.addEventListener('abort', onAbort, { once: true });
        });
    };

    void (async () => {
        while (!signal.aborted) {
            const updated = await params.session.client.waitForMetadataUpdate(signal).catch(() => false);
            if (!updated || signal.aborted) {
                // `waitForMetadataUpdate` can fail closed when the session client is detached/disconnected.
                // Back off to avoid a tight loop that can OOM.
                await waitForAbortOrBackoff();
                continue;
            }
            try {
                const next = syncClaudePermissionModeFromMetadata({
                    session: params.session,
                    permissionHandler: { handleModeChange: params.onPermissionModeUpdated },
                });
                if (next) {
                    logger.debug(`[Claude] Permission mode updated from metadata while waiting: ${next}`);
                }
            } catch (error) {
                logger.debug('[Claude] Failed to sync permission mode from metadata (non-fatal)', error);
            }
        }
    })();

    return controller;
}
