import type { DaemonExecutionRunEntry, ExecutionRunPublicState } from '@happier-dev/protocol';
import { convertBackendTargetRefV2ToV1 } from '@happier-dev/protocol';
import type { Message } from '@/sync/domains/messages/messageTypes';

import { machineExecutionRunsList } from '@/sync/ops/machineExecutionRuns';
import { storage } from '@/sync/domains/state/storage';
import { normalizeSessionId } from '@/sync/domains/session/normalizeSessionId';
import { resolvePreferredServerIdForSessionId } from '@/sync/runtime/orchestration/serverScopedRpc/resolvePreferredServerIdForSessionId';
import { readDisplayMachineIdForSession } from '@/sync/ops/sessionMachineTarget';
import { t } from '@/text';

export type ExecutionRunTranscriptFallback = Readonly<{
    run: ExecutionRunPublicState;
    latestToolResult?: unknown;
    message?: Message | null;
}>;

export type ExecutionRunDaemonFallback = Readonly<{
    run: ExecutionRunPublicState;
    daemonProcessLine: string | null;
}>;

function buildDaemonProcessLine(entry: DaemonExecutionRunEntry | null): string | null {
    const processInfo = entry?.process;
    if (!processInfo || typeof processInfo !== 'object') return null;

    const pid = typeof processInfo.pid === 'number' ? processInfo.pid : null;
    const cpu = typeof processInfo.cpu === 'number' ? processInfo.cpu : null;
    const memory = typeof processInfo.memory === 'number' ? processInfo.memory : null;
    const memoryMb = typeof memory === 'number' && Number.isFinite(memory)
        ? Math.round((memory / (1024 * 1024)) * 10) / 10
        : null;
    const parts = [
        typeof pid === 'number' ? t('runs.detail.pid', { pid }) : null,
        typeof cpu === 'number' ? t('runs.detail.cpu', { percent: String(cpu) }) : null,
        typeof memoryMb === 'number' ? t('runs.detail.memory', { megabytes: memoryMb }) : null,
    ].filter((value): value is string => Boolean(value));
    return parts.length > 0 ? parts.join(' · ') : null;
}

function buildExecutionRunPublicStateFromDaemonEntry(params: Readonly<{
    entry: DaemonExecutionRunEntry;
    transcriptFallback?: ExecutionRunTranscriptFallback | null;
}>): ExecutionRunPublicState | null {
    const fallbackRun = params.transcriptFallback?.run ?? null;
    // Marker persistence intentionally retains only bounded identity/status facts.
    // Do not fabricate the run's configuration or resumability from that marker;
    // a matching transcript state remains the canonical source for those fields.
    if (!fallbackRun || fallbackRun.runId !== params.entry.runId) return null;

    return {
        runId: params.entry.runId,
        callId: params.entry.callId,
        sidechainId: params.entry.sidechainId,
        intent: params.entry.intent,
        backendTarget: convertBackendTargetRefV2ToV1(params.entry.backendTarget),
        permissionMode: fallbackRun.permissionMode,
        retentionPolicy: fallbackRun.retentionPolicy,
        runClass: fallbackRun.runClass,
        ioMode: fallbackRun.ioMode,
        status: params.entry.status,
        startedAtMs: params.entry.startedAtMs,
        ...(typeof params.entry.finishedAtMs === 'number' ? { finishedAtMs: params.entry.finishedAtMs } : {}),
        ...(fallbackRun.resumeHandle ? { resumeHandle: fallbackRun.resumeHandle } : {}),
        ...(fallbackRun.display ? { display: fallbackRun.display } : {}),
        ...(fallbackRun.transcript ? { transcript: fallbackRun.transcript } : {}),
        ...(fallbackRun.error ? { error: fallbackRun.error } : {}),
    };
}

export async function resolveDaemonExecutionRunFallback(params: Readonly<{
    sessionId: string;
    runId: string;
    transcriptFallback?: ExecutionRunTranscriptFallback | null;
}>): Promise<ExecutionRunDaemonFallback | null> {
    const normalizedSessionId = normalizeSessionId(params.sessionId);
    const session = storage.getState().sessions?.[normalizedSessionId];
    const machineId = readDisplayMachineIdForSession({
        sessionId: normalizedSessionId,
        metadata: session?.metadata ?? null,
    }) || null;
    if (!machineId) return null;
    const serverId = (
        resolvePreferredServerIdForSessionId(normalizedSessionId)
        ?? session?.serverId
        ?? ''
    ).trim() || null;

    const listed = await machineExecutionRunsList(machineId, { ...(serverId ? { serverId } : {}) });
    if (!listed || listed.ok !== true) return null;

    const match = listed.runs.find((run) => String(run?.runId ?? '') === params.runId) ?? null;
    if (!match) return null;

    const run = buildExecutionRunPublicStateFromDaemonEntry({
        entry: match,
        transcriptFallback: params.transcriptFallback ?? null,
    });
    if (!run) return null;

    return {
        run,
        daemonProcessLine: buildDaemonProcessLine(match),
    };
}
