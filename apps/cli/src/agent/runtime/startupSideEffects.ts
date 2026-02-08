import type { ApiSessionClient } from '@/api/apiSession';
import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { writeTerminalAttachmentInfo } from '@/terminal/terminalAttachmentInfo';
import { buildTerminalFallbackMessage } from '@/terminal/terminalFallbackMessage';
import { logger } from '@/ui/logger';

type DaemonReportDeps = {
    notifyDaemonSessionStartedFn?: typeof notifyDaemonSessionStarted;
    sleepFn?: (ms: number) => Promise<void>;
    nowFn?: () => number;
    retryTimeoutMs?: number;
    retryIntervalMs?: number;
};

function isTransientDaemonReportError(error: string): boolean {
    const normalized = error.trim().toLowerCase();
    if (!normalized) return false;
    return normalized.includes('no daemon running') || normalized.includes('daemon is not running');
}

function resolveDaemonReportRetryValue(raw: string | undefined, fallback: number, bounds: { min: number; max: number }): number {
    const value = (raw ?? '').trim();
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

export function primeAgentStateForUi(session: ApiSessionClient, logPrefix: string): void {
    // Bump agentStateVersion early so the UI can reliably treat the agent as "ready" to receive messages.
    // The server does not currently persist agentState during initial session creation; it starts at version 0
    // and only changes via 'update-state'. The UI uses agentStateVersion > 0 as its readiness signal.
    try {
        session.updateAgentState((currentState) => ({ ...currentState }));
    } catch (e) {
        logger.debug(`${logPrefix} Failed to prime agent state (non-fatal)`, e);
    }
}

export async function persistTerminalAttachmentInfoIfNeeded(opts: {
    sessionId: string;
    terminal: Metadata['terminal'] | undefined;
}): Promise<void> {
    if (!opts.terminal) return;
    try {
        await writeTerminalAttachmentInfo({
            happyHomeDir: configuration.happyHomeDir,
            sessionId: opts.sessionId,
            terminal: opts.terminal,
        });
    } catch (error) {
        logger.debug('[START] Failed to persist terminal attachment info', error);
    }
}

export function sendTerminalFallbackMessageIfNeeded(opts: {
    session: ApiSessionClient;
    terminal: Metadata['terminal'] | undefined;
}): void {
    if (!opts.terminal) return;
    const fallbackMessage = buildTerminalFallbackMessage(opts.terminal);
    if (!fallbackMessage) return;
    opts.session.sendSessionEvent({ type: 'message', message: fallbackMessage });
}

export async function reportSessionToDaemonIfRunning(opts: {
    sessionId: string;
    metadata: Metadata;
}, deps: DaemonReportDeps = {}): Promise<void> {
    const notifyFn = deps.notifyDaemonSessionStartedFn ?? notifyDaemonSessionStarted;
    const sleepFn = deps.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const nowFn = deps.nowFn ?? (() => Date.now());
    const retryTimeoutMs =
        deps.retryTimeoutMs ??
        resolveDaemonReportRetryValue(process.env.HAPPIER_DAEMON_REPORT_SESSION_RETRY_TIMEOUT_MS, 10_000, {
            min: 0,
            max: 120_000,
        });
    const retryIntervalMs =
        deps.retryIntervalMs ??
        resolveDaemonReportRetryValue(process.env.HAPPIER_DAEMON_REPORT_SESSION_RETRY_INTERVAL_MS, 250, {
            min: 50,
            max: 10_000,
        });

    const startedAt = nowFn();
    let attempt = 0;
    while (true) {
        attempt += 1;
        try {
            logger.debug(`[START] Reporting session ${opts.sessionId} to daemon (attempt ${attempt})`);
            const result = await notifyFn(opts.sessionId, opts.metadata);
            if (!result?.error) {
                logger.debug(`[START] Reported session ${opts.sessionId} to daemon`);
                return;
            }

            const message = String(result.error);
            const timedOut = nowFn() - startedAt >= retryTimeoutMs;
            if (!isTransientDaemonReportError(message) || timedOut) {
                logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
                return;
            }
            await sleepFn(retryIntervalMs);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error ?? '');
            const timedOut = nowFn() - startedAt >= retryTimeoutMs;
            if (!isTransientDaemonReportError(message) || timedOut) {
                logger.debug('[START] Failed to report to daemon (may not be running):', error);
                return;
            }
            await sleepFn(retryIntervalMs);
        }
    }
}
