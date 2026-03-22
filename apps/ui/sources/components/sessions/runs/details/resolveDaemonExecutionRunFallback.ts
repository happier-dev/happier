import type { DaemonExecutionRunEntry, ExecutionRunPublicState } from '@happier-dev/protocol';
import type { Message } from '@/sync/domains/messages/messageTypes';

import { machineExecutionRunsList } from '@/sync/ops/machineExecutionRuns';
import { storage } from '@/sync/domains/state/storage';
import { readDisplayMachineIdForSession } from '@/sync/ops/sessionMachineTarget';
import { resolveServerIdForSessionIdFromLocalCache } from '@/sync/runtime/orchestration/serverScopedRpc/resolveServerIdForSessionIdFromLocalCache';
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

function readNonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

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
}>): ExecutionRunPublicState {
    const fallbackRun = params.transcriptFallback?.run ?? null;

    return {
        runId: params.entry.runId,
        callId: params.entry.callId,
        sidechainId: params.entry.sidechainId,
        intent: params.entry.intent,
        backendTarget: params.entry.backendTarget,
        permissionMode: readNonEmptyString((params.entry as { permissionMode?: unknown }).permissionMode)
            ?? fallbackRun?.permissionMode
            ?? 'unknown',
        retentionPolicy: params.entry.retentionPolicy,
        runClass: params.entry.runClass,
        ioMode: params.entry.ioMode,
        status: params.entry.status,
        startedAtMs: params.entry.startedAtMs,
        ...(typeof params.entry.finishedAtMs === 'number' ? { finishedAtMs: params.entry.finishedAtMs } : {}),
        ...(params.entry.resumeHandle ? { resumeHandle: params.entry.resumeHandle } : {}),
        ...(params.entry.display ? { display: params.entry.display } : fallbackRun?.display ? { display: fallbackRun.display } : {}),
        ...(fallbackRun?.transcript ? { transcript: fallbackRun.transcript } : {}),
        ...(fallbackRun?.error ? { error: fallbackRun.error } : {}),
    };
}

export async function resolveDaemonExecutionRunFallback(params: Readonly<{
    sessionId: string;
    runId: string;
    transcriptFallback?: ExecutionRunTranscriptFallback | null;
}>): Promise<ExecutionRunDaemonFallback | null> {
    const session = storage.getState().sessions?.[params.sessionId];
    const machineId = readDisplayMachineIdForSession({
        sessionId: params.sessionId,
        metadata: session?.metadata ?? null,
    }) || null;
    if (!machineId) return null;
    const serverId = resolveServerIdForSessionIdFromLocalCache(params.sessionId);

    const listed = await machineExecutionRunsList(machineId, { ...(serverId ? { serverId } : {}) });
    if (!listed || listed.ok !== true) return null;

    const match = listed.runs.find((run) => String(run?.runId ?? '') === params.runId) ?? null;
    if (!match) return null;

    return {
        run: buildExecutionRunPublicStateFromDaemonEntry({
            entry: match,
            transcriptFallback: params.transcriptFallback ?? null,
        }),
        daemonProcessLine: buildDaemonProcessLine(match),
    };
}
