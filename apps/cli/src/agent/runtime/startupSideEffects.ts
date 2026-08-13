import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { Metadata } from '@/api/types';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import { buildTerminalFallbackMessage } from '@/terminal/attachment/terminalFallbackMessage';
import { logger } from '@/ui/logger';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';

export { persistTerminalAttachmentInfoIfNeeded } from '@/agent/runtime/terminal/persistTerminalAttachmentInfo';

type DaemonReportDeps = {
    notifyDaemonSessionStartedFn?: typeof notifyDaemonSessionStarted;
    sleepFn?: (ms: number) => Promise<void>;
    nowFn?: () => number;
    retryTimeoutMs?: number;
    retryIntervalMs?: number;
    reportAttemptTimeoutMs?: number;
    onReported?: (opts: { sessionId: string }) => Promise<void> | void;
};

type InFlightDaemonSessionReport = {
    latestMetadata: Metadata;
    revision: number;
    requireDaemonAck: boolean;
    onReportedCallbacks: Set<NonNullable<DaemonReportDeps['onReported']>>;
    promise: Promise<void>;
};

const inFlightDaemonSessionReports = new Map<string, InFlightDaemonSessionReport>();

function isTransientDaemonReportError(error: string): boolean {
    const normalized = error.trim().toLowerCase();
    if (!normalized) return false;
    return (
        normalized.includes('no daemon running') ||
        normalized.includes('daemon is not running') ||
        normalized.includes('request failed') ||
        normalized.includes('unauthorized') ||
        normalized.includes('timeout') ||
        normalized.includes('fetch failed') ||
        normalized.includes('econn') ||
        normalized.includes('network')
    );
}

function resolveDaemonReportRetryValue(raw: string | undefined, fallback: number, bounds: { min: number; max: number }): number {
    const value = (raw ?? '').trim();
    if (!value) return fallback;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(bounds.max, Math.max(bounds.min, parsed));
}

function isTruthyEnvFlag(raw: string | undefined): boolean {
    const normalized = (raw ?? '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'y';
}

export function primeAgentStateForUi(session: ApiSessionClient, logPrefix: string): void {
    // Bump agentStateVersion early so the UI can reliably treat the agent as "ready" to receive messages.
    // The server does not currently persist agentState during initial session creation; it starts at version 0
    // and only changes via 'update-state'. The UI uses agentStateVersion > 0 as its readiness signal.
    updateAgentStateBestEffort(
        session,
        (currentState) => ({ ...currentState }),
        logPrefix,
        'prime agent state for ui',
    );
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

async function runDaemonSessionReport(
  sessionId: string,
  state: InFlightDaemonSessionReport,
  deps: DaemonReportDeps,
): Promise<void> {
    const notifyFn = deps.notifyDaemonSessionStartedFn ?? notifyDaemonSessionStarted;
    const sleepFn = deps.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const nowFn = deps.nowFn ?? (() => Date.now());
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
        const revision = state.revision;
        const metadata = state.latestMetadata;
        const startedBy = String(metadata?.startedBy ?? '').trim().toLowerCase();
        const daemonAutostartEnabled = isTruthyEnvFlag(process.env.HAPPIER_SESSION_AUTOSTART_DAEMON);
        const defaultRetryTimeoutMs =
            startedBy === 'daemon'
                ? 90_000
                : daemonAutostartEnabled
                    ? 30_000
                    : 10_000;
        const retryTimeoutMs =
            deps.retryTimeoutMs ??
            resolveDaemonReportRetryValue(process.env.HAPPIER_DAEMON_REPORT_SESSION_RETRY_TIMEOUT_MS, defaultRetryTimeoutMs, {
                min: 0,
                max: 120_000,
            });
        const defaultReportAttemptTimeoutMs = startedBy === 'daemon' ? 10_000 : 2_500;
        const reportAttemptTimeoutMs =
            deps.reportAttemptTimeoutMs ??
            resolveDaemonReportRetryValue(process.env.HAPPIER_DAEMON_REPORT_SESSION_HTTP_TIMEOUT_MS, defaultReportAttemptTimeoutMs, {
                min: 100,
                max: 30_000,
            });
        const boundedAttemptTimeoutMs = Math.min(reportAttemptTimeoutMs, Math.max(100, retryTimeoutMs));

        try {
            logger.debug(`[START] Reporting session ${sessionId} to daemon (attempt ${attempt})`);
            const result = await notifyFn(
                sessionId,
                metadata,
                { timeoutMs: boundedAttemptTimeoutMs },
            );
            if (!result?.error) {
                if (state.revision !== revision) continue;
                logger.debug(`[START] Reported session ${sessionId} to daemon`);
                for (const onReported of state.onReportedCallbacks) {
                    try {
                        await onReported({ sessionId });
                    } catch (error) {
                        logger.debug('[START] Failed to run daemon session-reported callback', error);
                    }
                }
                return;
            }

            const message = String(result.error);
            const timedOut = nowFn() - startedAt >= retryTimeoutMs;
            if (!isTransientDaemonReportError(message) || timedOut) {
                logger.debug(`[START] Failed to report to daemon (may not be running):`, result.error);
                if (state.requireDaemonAck) {
                    throw new Error('Claude runtime readiness was not acknowledged by the daemon');
                }
                return;
            }
            await sleepFn(retryIntervalMs);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error ?? '');
            const timedOut = nowFn() - startedAt >= retryTimeoutMs;
            if (!isTransientDaemonReportError(message) || timedOut) {
                logger.debug('[START] Failed to report to daemon (may not be running):', error);
                if (state.requireDaemonAck) {
                    throw new Error('Claude runtime readiness was not acknowledged by the daemon');
                }
                return;
            }
            await sleepFn(retryIntervalMs);
        }
    }
}

export function reportSessionToDaemonIfRunning(opts: {
    sessionId: string;
    metadata: Metadata;
    requireDaemonAck?: boolean;
}, deps: DaemonReportDeps = {}): Promise<void> {
    const sessionId = opts.sessionId.trim();
    const existing = inFlightDaemonSessionReports.get(sessionId);
    if (existing) {
        existing.latestMetadata = opts.metadata;
        existing.revision += 1;
        existing.requireDaemonAck ||= opts.requireDaemonAck === true;
        if (deps.onReported) existing.onReportedCallbacks.add(deps.onReported);
        return existing.promise;
    }

    const state: InFlightDaemonSessionReport = {
        latestMetadata: opts.metadata,
        revision: 0,
        requireDaemonAck: opts.requireDaemonAck === true,
        onReportedCallbacks: new Set(deps.onReported ? [deps.onReported] : []),
        promise: Promise.resolve(),
    };
    inFlightDaemonSessionReports.set(sessionId, state);
    state.promise = runDaemonSessionReport(sessionId, state, deps).finally(() => {
        if (inFlightDaemonSessionReports.get(sessionId) === state) {
            inFlightDaemonSessionReports.delete(sessionId);
        }
    });
    return state.promise;
}
