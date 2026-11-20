import type { SessionLifecycleStateReason } from '@happier-dev/protocol/sessions/metadata/sessionMetadataSchemasV1';
import type { StoredCredentials } from '@/persistence';
import { assertSessionMetadataMutationCurrentness, updateSessionMetadataWithRetry, verifySessionMetadataMutationCurrentness,
    type SessionMetadataMutationCurrentness } from '@/session/metadata/updateSessionMetadataWithRetry';
import { fetchSessionByIdCompat } from '@/session/transport/http/sessionsHttp';
import { fetchAccountEncryptionCurrentness } from '@/api/client/connectedServiceCredentialApi';
import type { TerminalMode } from '@/terminal/runtime/terminalConfig';
import { configuration } from '@/configuration';
import { isPidPresent } from '@happier-dev/cli-common/process';
import { readTerminalHostAttachmentState } from '@/terminal/attachment/terminalAttachmentInfo';
import { logger } from '@/ui/logger';
import { serializeAxiosErrorForLog } from '@/api/client/serializeAxiosErrorForLog';
import { readSessionMarker, type DaemonSessionMarker } from '../sessionRegistry';
import type { TrackedSession } from '../types';
import { resolveTrackedSessionRunnerIdentity } from './sessionReportCorrelation';

import { clearTerminalControlServiceabilityProjection } from '../startup/terminalControlServiceabilityProjection';
import { isUnrecordedPlainRunner, readRetiredPlainRunnerObservation } from './plainRunnerRetirement';

export type ExactTerminalControlServiceabilityRetirement = 'retired' | 'superseded';
export type RetainedPlainRunnerRetirement = ExactTerminalControlServiceabilityRetirement | 'deferred';
export type TerminalControlServiceabilityRetirementTarget = Readonly<{ attachmentId: string; terminalMode: TerminalMode; expectedRunner?: never; expectedPlainRetirement?: never }>
    | Readonly<{ attachmentId?: never; terminalMode: 'plain'; expectedRunner: Readonly<{ pid: number; startTimeMs?: number; sessionEndObserved?: Promise<void> }>; expectedPlainRetirement?: never }>
    // null selects an unrecorded plain runner; a number selects a retained exit observation.
    | Readonly<{ attachmentId?: never; terminalMode: 'plain'; expectedRunner?: never; expectedPlainRetirement: number | null }>;

/** The existing marker is the recovery obligation; a live or unrecorded runner cannot defer publication. */
export async function readRetainedPlainRunnerExitMarker(tracked: TrackedSession): Promise<DaemonSessionMarker | null> {
    const runner = resolveTrackedSessionRunnerIdentity(tracked);
    if (!runner) return null;
    const { pid, processStartTimeMs: startTimeMs } = runner;
    if (!tracked.happySessionId || startTimeMs === undefined
        || isPidPresent(pid) || (pid !== tracked.pid && isPidPresent(tracked.pid))) return null;
    const marker = await readSessionMarker(tracked.trackingKey);
    if (!marker || marker.pid !== pid || marker.startedBy !== tracked.startedBy || marker.happySessionId !== tracked.happySessionId
        || marker.processStartTimeMs !== startTimeMs) return null;
    const attachment = await readTerminalHostAttachmentState({ happyHomeDir: configuration.happyHomeDir, sessionId: marker.happySessionId });
    return attachment.status === 'absent' ? marker : null;
}

export async function retireStoppedPlainRunnerControlServiceability(params: Readonly<{
    sessionId: string;
    trackedSession: TrackedSession;
    publishRetirement: (expectedRunner: Readonly<{ pid: number; startTimeMs: number; sessionEndObserved?: Promise<void> }>) => Promise<ExactTerminalControlServiceabilityRetirement>;
}>): Promise<RetainedPlainRunnerRetirement> {
    try {
        const runner = resolveTrackedSessionRunnerIdentity(params.trackedSession);
        const startTimeMs = runner?.processStartTimeMs;
        if (!runner || typeof startTimeMs !== 'number' || !Number.isInteger(startTimeMs) || startTimeMs < 0) {
            throw new Error('terminal_control_serviceability_retirement_runner_or_host_unresolved');
        }
        return await params.publishRetirement({ pid: runner.pid, startTimeMs,
            ...(params.trackedSession.hostedSession ? { sessionEndObserved: params.trackedSession.hostedSession.observed } : {}) });
    } catch (error) {
        if (params.trackedSession.happySessionId !== params.sessionId
            || !await readRetainedPlainRunnerExitMarker(params.trackedSession)) throw error;
        logger.warn('[DAEMON STOP] Home retirement deferred to retained Session marker', {
            sessionId: params.sessionId, error: serializeAxiosErrorForLog(error),
        });
        return 'deferred';
    }
}

export async function retireExactTerminalControlServiceability(params: Readonly<{
    credentials: StoredCredentials;
    sessionId: string;
    currentness?: SessionMetadataMutationCurrentness;
    resolveAuthorizationHeaders?: Parameters<typeof updateSessionMetadataWithRetry>[0]['resolveAuthorizationHeaders'];
    /** Supplied only by the Stop owner after positive runner or hosted Session retirement. */
    stoppedAt?: number;
    lifecycleStateReason?: SessionLifecycleStateReason;
}> & TerminalControlServiceabilityRetirementTarget): Promise<ExactTerminalControlServiceabilityRetirement> {
    const matchesRetirementTarget = (metadata: Readonly<Record<string, unknown>>) => {
        if (params.expectedPlainRetirement !== undefined) {
            if (params.expectedPlainRetirement === null) return isUnrecordedPlainRunner(metadata);
            return readRetiredPlainRunnerObservation(metadata) === params.expectedPlainRetirement;
        }
        if (!params.expectedRunner) return true;
        if (metadata.hostPid !== undefined || metadata.hostProcessStartTimeMs !== undefined) {
            return metadata.hostPid === params.expectedRunner.pid
                && (params.expectedRunner.startTimeMs === undefined || metadata.hostProcessStartTimeMs === params.expectedRunner.startTimeMs);
        }
        // Startup may never publish a runner tuple; confirmed exit may already
        // retire it. Neither absence can supersede this Stop. Still require the
        // local runner-end/absent-attachment proof below.
        if (metadata.terminal === undefined || readRetiredPlainRunnerObservation(metadata) !== null) return true;
        const terminal = metadata.terminal;
        return !!terminal && typeof terminal === 'object' && !Array.isArray(terminal)
            && (terminal as Record<string, unknown>).mode === 'plain'
            && (terminal as Record<string, unknown>).controlServiceabilityV1 === undefined;
    };
    // A shared host stays alive for its other Sessions. Its existing per-Session
    // end report settles this runner's custody without lending a sibling's exit.
    await params.expectedRunner?.sessionEndObserved;
    assertSessionMetadataMutationCurrentness(params.currentness);
    const currentnessHeaders = params.resolveAuthorizationHeaders?.({ method: 'GET', path: '/v1/account/encryption/currentness' });
    if (params.resolveAuthorizationHeaders && !currentnessHeaders) throw new Error('Terminal retirement Account authorization unavailable');
    // Fetch independent facts under the captured Account together. Opening the
    // tuple awaits admission; the writer rechecks currentness before its CAS.
    const [, rawSession, accountEncryptionCurrentness] = await Promise.all([
        verifySessionMetadataMutationCurrentness(params.currentness),
        fetchSessionByIdCompat({ reason: 'session-control',
            token: params.credentials.token,
            sessionId: params.sessionId,
            ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
        }),
        fetchAccountEncryptionCurrentness({ credentials: params.credentials, token: params.credentials.token,
            ...(currentnessHeaders ? { authorizationHeaders: currentnessHeaders } : {}) }),
    ]);
    if (!rawSession) {
        // Callers prove physical retirement before reaching this publication step.
        // A deleted Session has no remaining control projection to clear.
        await verifySessionMetadataMutationCurrentness(params.currentness);
        return 'retired';
    }
    let retiredAttachmentId = params.attachmentId;
    let projectionAlreadyAbsent = false;
    const withStoppedLifecycle = (metadata: Record<string, unknown>) => params.stoppedAt === undefined
        || metadata.lifecycleState === 'stopped' && typeof metadata.lifecycleStateSince === 'number'
            && (params.lifecycleStateReason === undefined || metadata.lifecycleStateReason === params.lifecycleStateReason)
        ? metadata
        : { ...metadata, lifecycleState: 'stopped',
            lifecycleStateSince: metadata.lifecycleState === 'stopped' && typeof metadata.lifecycleStateSince === 'number'
                ? metadata.lifecycleStateSince : params.stoppedAt,
            ...(params.lifecycleStateReason ? { lifecycleStateReason: params.lifecycleStateReason } : {}) };
    const updated = await updateSessionMetadataWithRetry({
        token: params.credentials.token,
        credentials: params.credentials,
        sessionId: params.sessionId,
        rawSession,
        accountEncryptionCurrentness,
        currentness: params.currentness,
        ...(params.resolveAuthorizationHeaders ? { resolveAuthorizationHeaders: params.resolveAuthorizationHeaders } : {}),
        updater: async (metadata) => {
            retiredAttachmentId = params.attachmentId;
            projectionAlreadyAbsent = false;
            if (!matchesRetirementTarget(metadata)) return metadata;
            if (params.expectedRunner || params.expectedPlainRetirement !== undefined) {
                const attachment = await readTerminalHostAttachmentState({
                    happyHomeDir: configuration.happyHomeDir, sessionId: params.sessionId,
                });
                if (attachment.status !== 'absent' || params.expectedRunner
                    && !params.expectedRunner.sessionEndObserved && isPidPresent(params.expectedRunner.pid)) {
                    throw new Error('terminal_control_serviceability_retirement_runner_or_host_unresolved');
                }
                // Runner-bound retirement also clears that departed runner's
                // historical host projection. A current descriptor or a newer
                // metadata runner cannot lend authority to this mutation.
                const terminal = metadata.terminal;
                // An unrecorded runner or mode-only descriptor has no projection
                // to clear. Explicit Stop only needs to publish its lifecycle.
                if (params.expectedPlainRetirement === null || (terminal && typeof terminal === 'object' && !Array.isArray(terminal)
                    && !('controlServiceabilityV1' in terminal))) {
                    projectionAlreadyAbsent = true;
                    return withStoppedLifecycle(metadata);
                }
                if (terminal && typeof terminal === 'object' && !Array.isArray(terminal)) {
                    const serviceability = (terminal as Record<string, unknown>).controlServiceabilityV1;
                    if (serviceability && typeof serviceability === 'object' && !Array.isArray(serviceability)) {
                        const attachmentId = (serviceability as Record<string, unknown>).attachmentId;
                        if (typeof attachmentId === 'string' && attachmentId.trim()) retiredAttachmentId = attachmentId;
                    }
                }
            }
            const retired = clearTerminalControlServiceabilityProjection({
                metadata,
                retiredAttachmentId,
                retiredAt: Date.now(),
                terminalMode: params.terminalMode,
            });
            const serviceability = retired.terminal && typeof retired.terminal === 'object' && !Array.isArray(retired.terminal)
                ? (retired.terminal as Record<string, unknown>).controlServiceabilityV1 : null;
            // Clearing a stale attachment is a no-op. It cannot authorize a
            // terminal fact about the replacement that now owns the Session.
            return serviceability && typeof serviceability === 'object' && !Array.isArray(serviceability)
                && (serviceability as Record<string, unknown>).attachmentId === retiredAttachmentId
                && (serviceability as Record<string, unknown>).retired === true
                ? withStoppedLifecycle(retired) : retired;
        },
    });
    if (!matchesRetirementTarget(updated.metadata)) return 'superseded';
    if (projectionAlreadyAbsent) return 'retired';
    const terminal = updated.metadata.terminal;
    if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)) return 'superseded';
    const serviceability = (terminal as Record<string, unknown>).controlServiceabilityV1;
    if (!serviceability || typeof serviceability !== 'object' || Array.isArray(serviceability)) return 'superseded';
    const projection = serviceability as Record<string, unknown>;
    return projection.attachmentId === retiredAttachmentId && projection.retired === true
        ? 'retired'
        : 'superseded';
}
