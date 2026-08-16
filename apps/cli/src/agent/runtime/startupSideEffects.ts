import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { Metadata } from '@/api/types';
import { configuration } from '@/configuration';
import { notifyDaemonSessionStarted } from '@/daemon/controlClient';
import {
    writeTerminalAttachmentInfo,
    writeTerminalHostAttachmentInfo,
    type TerminalAttachmentId,
} from '@/terminal/attachment/terminalAttachmentInfo';
import { buildTerminalHostProbeHandleFromMetadata } from '@/terminal/runtime/terminalMetadata';
import type { TerminalHostHandle } from '@happier-dev/agents';
import { buildTerminalFallbackMessage } from '@/terminal/attachment/terminalFallbackMessage';
import { logger } from '@/ui/logger';
import { updateAgentStateBestEffort } from '@/api/session/sessionWritesBestEffort';
import { resolveDaemonStartedSessionReportRetryPolicy } from '@/daemon/spawn/sessionWebhookTimeoutPolicy';

type DaemonReportDeps = {
    notifyDaemonSessionStartedFn?: typeof notifyDaemonSessionStarted;
    sleepFn?: (ms: number) => Promise<void>;
    nowFn?: () => number;
    retryTimeoutMs?: number;
    retryIntervalMs?: number;
    reportAttemptTimeoutMs?: number;
};

export class PersistedTakeoverAdmissionError extends Error {
    readonly code: string;

    constructor(code: string) {
        super(`Persisted takeover admission was not acknowledged: ${code}`);
        this.name = 'PersistedTakeoverAdmissionError';
        this.code = code;
    }
}

type PersistedTakeoverPhaseReportOptions = Readonly<{
    sessionId: string;
    metadata: Metadata;
    correlation: Readonly<{
        operationId: string;
        attemptId: string;
    }>;
}>;

async function reportPersistedTakeoverPhase(
    opts: PersistedTakeoverPhaseReportOptions,
    phase: 'admit' | 'runtime_bound',
    deps: Pick<
    DaemonReportDeps,
    'notifyDaemonSessionStartedFn' | 'reportAttemptTimeoutMs'
    > = {},
): Promise<void> {
    const notifyFn = deps.notifyDaemonSessionStartedFn ?? notifyDaemonSessionStarted;
    const timeoutMs = deps.reportAttemptTimeoutMs ?? 10_000;
    const attemptLimit = phase === 'runtime_bound' ? 2 : 1;
    for (let attempt = 0; attempt < attemptLimit; attempt += 1) {
        let result: Awaited<ReturnType<typeof notifyDaemonSessionStarted>>;
        try {
            result = await notifyFn(opts.sessionId, opts.metadata, {
                timeoutMs,
                persistedTakeoverAdmission: {
                    ...opts.correlation,
                    phase,
                },
            });
        } catch {
            result = {
                error: 'Persisted takeover admission response was ambiguous',
            };
        }
        if (result?.status === 'ok' && !result.error) return;
        const code = typeof result.errorCode === 'string'
            ? result.errorCode
            : 'persisted_takeover_admission_ambiguous';
        const canRetryAmbiguousRuntimeBound =
            phase === 'runtime_bound'
            && code === 'persisted_takeover_admission_ambiguous'
            && attempt + 1 < attemptLimit;
        if (!canRetryAmbiguousRuntimeBound) {
            throw new PersistedTakeoverAdmissionError(code);
        }
    }
}

export async function admitPersistedTakeoverBeforeRuntime(
    opts: PersistedTakeoverPhaseReportOptions,
    deps: Pick<
        DaemonReportDeps,
        'notifyDaemonSessionStartedFn' | 'reportAttemptTimeoutMs'
    > = {},
): Promise<void> {
    await reportPersistedTakeoverPhase(opts, 'admit', deps);
}

export async function reportPersistedTakeoverRuntimeBound(
    opts: PersistedTakeoverPhaseReportOptions,
    deps: Pick<
        DaemonReportDeps,
        'notifyDaemonSessionStartedFn' | 'reportAttemptTimeoutMs'
    > = {},
): Promise<void> {
    await reportPersistedTakeoverPhase(opts, 'runtime_bound', deps);
}

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

export function resolveTerminalAttachmentPersistenceBinding(
    terminal: NonNullable<Metadata['terminal']>,
): Readonly<{
    attachmentId: TerminalAttachmentId;
    handle: TerminalHostHandle & Readonly<{ attachmentId: TerminalAttachmentId }>;
}> | null {
    const serviceability = terminal.controlServiceabilityV1;
    const attachmentIdRaw = serviceability?.v === 1
        && serviceability.retired !== true
        && (serviceability.state === 'servable' || serviceability.state === 'recoverable_unservable')
        && typeof serviceability.attachmentId === 'string'
        ? serviceability.attachmentId.trim()
        : '';
    if (!attachmentIdRaw) return null;
    const attachmentId = attachmentIdRaw as TerminalAttachmentId;
    const handle = buildTerminalHostProbeHandleFromMetadata(terminal);
    if (!handle) return null;
    return {
        attachmentId,
        handle: { ...handle, attachmentId },
    };
}

export async function persistTerminalAttachmentInfoIfNeeded(opts: {
    sessionId: string;
    terminal: Metadata['terminal'] | undefined;
}): Promise<void> {
    if (!opts.terminal) return;
    const binding = resolveTerminalAttachmentPersistenceBinding(opts.terminal);
    try {
        if (binding) {
            await writeTerminalHostAttachmentInfo({
                happyHomeDir: configuration.happyHomeDir,
                sessionId: opts.sessionId,
                handle: binding.handle,
            });
        }
        await writeTerminalAttachmentInfo({
            happyHomeDir: configuration.happyHomeDir,
            sessionId: opts.sessionId,
            terminal: opts.terminal,
        });
    } catch (error) {
        logger.debug('[START] Failed to persist terminal attachment info', error);
        if (binding) throw error;
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
    requireDaemonAck?: boolean;
}, deps: DaemonReportDeps = {}): Promise<void> {
    const notifyFn = deps.notifyDaemonSessionStartedFn ?? notifyDaemonSessionStarted;
    const sleepFn = deps.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const nowFn = deps.nowFn ?? (() => Date.now());
    const startedBy = String(opts.metadata?.startedBy ?? '').trim().toLowerCase();
    const daemonAutostartEnabled = isTruthyEnvFlag(process.env.HAPPIER_SESSION_AUTOSTART_DAEMON);
    const defaultRetryTimeoutMs =
        startedBy === 'daemon'
            ? 90_000
            : daemonAutostartEnabled
                ? 30_000
                : 10_000;
    const retryTimeoutMs =
        deps.retryTimeoutMs ??
        (startedBy === 'daemon'
            ? resolveDaemonStartedSessionReportRetryPolicy(process.env).retryTimeoutMs
            : resolveDaemonReportRetryValue(process.env.HAPPIER_DAEMON_REPORT_SESSION_RETRY_TIMEOUT_MS, defaultRetryTimeoutMs, {
                min: 0,
                max: 120_000,
            }));
    const retryIntervalMs =
        deps.retryIntervalMs ??
        (startedBy === 'daemon'
            ? resolveDaemonStartedSessionReportRetryPolicy(process.env).retryIntervalMs
            : resolveDaemonReportRetryValue(process.env.HAPPIER_DAEMON_REPORT_SESSION_RETRY_INTERVAL_MS, 250, {
                min: 50,
                max: 10_000,
            }));
    const defaultReportAttemptTimeoutMs = startedBy === 'daemon' ? 10_000 : 2_500;
    const reportAttemptTimeoutMs =
        deps.reportAttemptTimeoutMs ??
        (startedBy === 'daemon'
            ? resolveDaemonStartedSessionReportRetryPolicy(process.env).reportAttemptTimeoutMs
            : resolveDaemonReportRetryValue(process.env.HAPPIER_DAEMON_REPORT_SESSION_HTTP_TIMEOUT_MS, defaultReportAttemptTimeoutMs, {
                min: 100,
                max: 30_000,
            }));
    const boundedAttemptTimeoutMs = Math.min(reportAttemptTimeoutMs, Math.max(100, retryTimeoutMs));

    const startedAt = nowFn();
    let attempt = 0;
    while (true) {
        attempt += 1;
        let failure: unknown = null;
        try {
            logger.debug(`[START] Reporting session ${opts.sessionId} to daemon (attempt ${attempt})`);
            const result = await notifyFn(opts.sessionId, opts.metadata, { timeoutMs: boundedAttemptTimeoutMs });
            if (!result?.error) {
                logger.debug(`[START] Reported session ${opts.sessionId} to daemon`);
                return;
            }
            failure = result.error;
        } catch (error) {
            failure = error;
        }
        const message = failure instanceof Error ? failure.message : String(failure ?? '');
        const timedOut = nowFn() - startedAt >= retryTimeoutMs;
        if (!isTransientDaemonReportError(message) || timedOut) {
            logger.debug('[START] Failed to report to daemon (may not be running):', failure);
            if (opts.requireDaemonAck) {
                throw new Error(`Daemon session readiness was not acknowledged: ${message || 'unknown daemon report failure'}`);
            }
            return;
        }
        await sleepFn(retryIntervalMs);
    }
}
