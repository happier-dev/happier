import type { ApiSessionClient } from '@/api/session/sessionClient';
import type { Metadata, SessionCreationOutcome } from '@/api/types';
import { configuration } from '@/configuration';
import {
    notifyDaemonSessionStarted,
    notifyDaemonSessionStartupFailure,
} from '@/daemon/controlClient';
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
import type {
    HostPrivatePersistedTakeoverAdmission,
    PersistedTakeoverAdmissionPhase,
} from '@/daemon/spawn/persistedTakeoverAdmission';
import type { SessionMetadataPublisherPreconditionV1 } from '@happier-dev/protocol';

type DaemonReportDeps = {
    notifyDaemonSessionStartedFn?: typeof notifyDaemonSessionStarted;
    notifyDaemonSessionStartupFailureFn?: typeof notifyDaemonSessionStartupFailure;
    sleepFn?: (ms: number) => Promise<void>;
    nowFn?: () => number;
    retryTimeoutMs?: number;
    retryIntervalMs?: number;
    reportAttemptTimeoutMs?: number;
};

type InFlightDaemonSessionReport = {
    latestMetadata: Metadata;
    latestSessionCreationOutcome?: SessionCreationOutcome;
    revision: number;
    requireDaemonAck: boolean;
    promise: Promise<void>;
};

const inFlightDaemonSessionReports = new Map<string, InFlightDaemonSessionReport>();

function hasSameSessionCreationOutcome(
    left: SessionCreationOutcome,
    right: SessionCreationOutcome,
): boolean {
    return left.disposition === right.disposition
        && left.organizationPlacement.folderId === right.organizationPlacement.folderId
        && left.organizationPlacement.tagIds.length === right.organizationPlacement.tagIds.length
        && left.organizationPlacement.tagIds.every(
            (tagId, index) => tagId === right.organizationPlacement.tagIds[index],
        );
}

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
    correlation: HostPrivatePersistedTakeoverAdmission & Readonly<{
        publisherPrecondition: SessionMetadataPublisherPreconditionV1;
    }>;
}>;

async function reportPersistedTakeoverPhase(
    opts: PersistedTakeoverPhaseReportOptions,
    phase: PersistedTakeoverAdmissionPhase,
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

/**
 * Gives the daemon's existing spawn waiter one bounded chance to receive the
 * exact server creation refusal before this runner exits. A reporting failure
 * is advisory and must never replace the server-authored terminal error.
 */
export async function reportSessionStartupFailureToDaemonIfRunning(
    opts: Readonly<{
        spawnNonce: string;
        errorDetail: import('@happier-dev/protocol').SessionCreationTerminalSpawnErrorDetail;
    }>,
    deps: Pick<
        DaemonReportDeps,
        'notifyDaemonSessionStartupFailureFn' | 'reportAttemptTimeoutMs'
    > = {},
): Promise<void> {
    const spawnNonce = opts.spawnNonce.trim();
    if (!spawnNonce) return;
    const notifyFn =
        deps.notifyDaemonSessionStartupFailureFn
        ?? notifyDaemonSessionStartupFailure;
    try {
        const result = await notifyFn({
            spawnNonce,
            errorDetail: opts.errorDetail,
        }, {
            timeoutMs: deps.reportAttemptTimeoutMs ?? 10_000,
        });
        if (result.status !== 'ok' || result.error) {
            logger.debug('[START] Daemon did not acknowledge terminal startup failure report');
        }
    } catch {
        logger.debug('[START] Terminal startup failure report was unavailable');
    }
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

export async function sendTerminalFallbackMessageIfNeeded(opts: {
    session: ApiSessionClient;
    terminal: Metadata['terminal'] | undefined;
}): Promise<void> {
    if (!opts.terminal) return;
    const fallbackMessage = buildTerminalFallbackMessage(opts.terminal);
    if (!fallbackMessage) return;
    const admission = await opts.session.enqueueSessionEventCommitted({
        type: 'message',
        message: fallbackMessage,
    });
    if (!admission.persisted) {
        throw new Error('Terminal fallback transcript notice was not durably admitted');
    }
}

async function runDaemonSessionReport(
    sessionId: string,
    state: InFlightDaemonSessionReport,
    deps: DaemonReportDeps,
): Promise<void> {
    const notifyFn = deps.notifyDaemonSessionStartedFn ?? notifyDaemonSessionStarted;
    const sleepFn = deps.sleepFn ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const nowFn = deps.nowFn ?? (() => Date.now());
    const startedAt = nowFn();
    let attempt = 0;
    while (true) {
        attempt += 1;
        const revision = state.revision;
        const metadata = state.latestMetadata;
        const sessionCreationOutcome = state.latestSessionCreationOutcome;
        const startedBy = String(metadata?.startedBy ?? '').trim().toLowerCase();
        const daemonAutostartEnabled = isTruthyEnvFlag(process.env.HAPPIER_SESSION_AUTOSTART_DAEMON);
        const defaultRetryTimeoutMs =
            startedBy === 'daemon'
                ? 90_000
                : daemonAutostartEnabled
                    ? 30_000
                    : 10_000;
        const daemonStartedPolicy = startedBy === 'daemon'
            ? resolveDaemonStartedSessionReportRetryPolicy(process.env)
            : null;
        const retryTimeoutMs =
            deps.retryTimeoutMs ??
            (daemonStartedPolicy?.retryTimeoutMs ?? resolveDaemonReportRetryValue(
                process.env.HAPPIER_DAEMON_REPORT_SESSION_RETRY_TIMEOUT_MS,
                defaultRetryTimeoutMs,
                { min: 0, max: 120_000 },
            ));
        const retryIntervalMs =
            deps.retryIntervalMs ??
            (daemonStartedPolicy?.retryIntervalMs ?? resolveDaemonReportRetryValue(
                process.env.HAPPIER_DAEMON_REPORT_SESSION_RETRY_INTERVAL_MS,
                250,
                { min: 50, max: 10_000 },
            ));
        const defaultReportAttemptTimeoutMs = startedBy === 'daemon' ? 10_000 : 2_500;
        const reportAttemptTimeoutMs =
            deps.reportAttemptTimeoutMs ??
            (daemonStartedPolicy?.reportAttemptTimeoutMs ?? resolveDaemonReportRetryValue(
                process.env.HAPPIER_DAEMON_REPORT_SESSION_HTTP_TIMEOUT_MS,
                defaultReportAttemptTimeoutMs,
                { min: 100, max: 30_000 },
            ));
        const boundedAttemptTimeoutMs = Math.min(reportAttemptTimeoutMs, Math.max(100, retryTimeoutMs));

        let failure: unknown = null;
        try {
            logger.debug(`[START] Reporting session ${sessionId} to daemon (attempt ${attempt})`);
            const result = await notifyFn(sessionId, metadata, {
                timeoutMs: boundedAttemptTimeoutMs,
                ...(sessionCreationOutcome ? { sessionCreationOutcome } : {}),
            });
            if (!result?.error) {
                if (state.revision !== revision) continue;
                logger.debug(`[START] Reported session ${sessionId} to daemon`);
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
            if (state.requireDaemonAck) {
                throw new Error(`Daemon session readiness was not acknowledged: ${message || 'unknown daemon report failure'}`);
            }
            return;
        }
        await sleepFn(retryIntervalMs);
    }
}

export function reportSessionToDaemonIfRunning(opts: {
    sessionId: string;
    metadata: Metadata;
    sessionCreationOutcome?: SessionCreationOutcome;
    requireDaemonAck?: boolean;
}, deps: DaemonReportDeps = {}): Promise<void> {
    const sessionId = opts.sessionId.trim();
    const existing = inFlightDaemonSessionReports.get(sessionId);
    if (existing) {
        if (
            opts.sessionCreationOutcome
            && existing.latestSessionCreationOutcome
            && !hasSameSessionCreationOutcome(
                existing.latestSessionCreationOutcome,
                opts.sessionCreationOutcome,
            )
        ) {
            return Promise.reject(
                new Error('Conflicting create-or-rejoin outcome for one daemon session report'),
            );
        }
        existing.latestMetadata = opts.metadata;
        existing.latestSessionCreationOutcome ??= opts.sessionCreationOutcome;
        existing.revision += 1;
        existing.requireDaemonAck ||= opts.requireDaemonAck === true;
        return existing.promise;
    }

    const state: InFlightDaemonSessionReport = {
        latestMetadata: opts.metadata,
        ...(opts.sessionCreationOutcome
            ? { latestSessionCreationOutcome: opts.sessionCreationOutcome }
            : {}),
        revision: 0,
        requireDaemonAck: opts.requireDaemonAck === true,
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
