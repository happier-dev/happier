import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import {
  createTerminalAttachmentId,
  writeTerminalAttachmentInfo,
} from '@/terminal/attachment/terminalAttachmentInfo';
import { logger } from '@/ui/logger';

import { buildTerminalHostHandleFromAttachmentMetadata } from './attachmentMetadata';

/**
 * Persist the session's terminal attachment record from spawn-path terminal metadata.
 *
 * Modes whose metadata carries full host identity (tmux, zellij) are bound as version-2
 * records with an immutable attachment id. Other modes persist the version-1 record.
 * A failed bound write falls back to the version-1 write so a readable record always
 * exists whenever the filesystem write itself succeeds; the stop path fails closed on
 * missing evidence, so silently persisting nothing would strand the session.
 */
export async function persistTerminalAttachmentInfoIfNeeded(opts: {
    sessionId: string;
    terminal: Metadata['terminal'] | undefined;
    logPrefix?: string;
    writeAttachmentInfo?: typeof writeTerminalAttachmentInfo;
}): Promise<void> {
    if (!opts.terminal) return;
    const logPrefix = opts.logPrefix ?? '[START]';
    const writeAttachmentInfo = opts.writeAttachmentInfo ?? writeTerminalAttachmentInfo;
    try {
        const handle = buildTerminalHostHandleFromAttachmentMetadata(opts.terminal);
        const attachmentId = handle ? createTerminalAttachmentId() : undefined;
        if (handle && attachmentId) {
            try {
                await writeAttachmentInfo({
                    happyHomeDir: configuration.happyHomeDir,
                    sessionId: opts.sessionId,
                    attachmentId,
                    handle,
                    terminal: opts.terminal,
                });
                return;
            } catch (error) {
                logger.warn(`${logPrefix} Bound terminal attachment write failed; falling back to unbound record`, error);
            }
        }
        await writeAttachmentInfo({
            happyHomeDir: configuration.happyHomeDir,
            sessionId: opts.sessionId,
            terminal: opts.terminal,
        });
    } catch (error) {
        logger.debug(`${logPrefix} Failed to persist terminal attachment info`, error);
    }
}
