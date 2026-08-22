import { getBackendCatalogDefinition } from '@happier-dev/agents';
import {
    ExecutionRunPublicStateSchema,
    type ExecutionRunPublicState,
} from '@happier-dev/protocol';
import { normalizeExecutionRunPublicStateBackendTarget } from './executionRunPublicStateBackendTarget';
import {
    isConcreteLegacyConfiguredBackendId,
    isLegacyConfiguredBackendSentinelId,
} from '@/session/backendTargets/compat/legacyConfiguredBackend';

import type { RawHistoryRow } from './getSessionHistory';

type TranscriptExecutionRunState = Readonly<{
    runId: string;
    callId: string | null;
    sidechainId: string | null;
    intent: string | null;
    backendTarget: Record<string, unknown> | null;
    displayTitle: string | null;
    permissionMode: string | null;
    retentionPolicy: string | null;
    runClass: string | null;
    ioMode: string | null;
    status: string | null;
    startedAtMs: number | null;
    finishedAtMs: number | null;
}>;

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;
}

function readString(record: Record<string, unknown> | null, key: string): string | null {
    const value = record?.[key];
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readNumber(record: Record<string, unknown> | null, key: string): number | null {
    const value = record?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function minNumber(values: ReadonlyArray<number | null | undefined>): number | null {
    let min: number | null = null;
    for (const value of values) {
        if (typeof value !== 'number' || !Number.isFinite(value)) {
            continue;
        }
        min = min === null ? value : Math.min(min, value);
    }
    return min;
}

function isSubAgentRunEvent(row: RawHistoryRow): Readonly<{
    kind: 'tool-call' | 'tool-result';
    event: Record<string, unknown>;
}> | null {
    if (row.role !== 'agent') return null;
    const content = asRecord(row.raw?.content);
    if (readString(content, 'type') !== 'acp') return null;
    const event = asRecord(content?.data);
    if (!event) return null;
    const kind = readString(event, 'type');
    if (kind !== 'tool-call' && kind !== 'tool-result') return null;

    const directName = (() => {
        if (kind === 'tool-call') {
            return readString(event, 'name');
        }

        const output = asRecord(event?.output);
        const happierMeta = asRecord(output?._happier);
        return readString(happierMeta, 'canonicalToolName');
    })();
    if (directName !== 'SubAgentRun') return null;

    return { kind, event };
}

function readBackendTarget(input: Record<string, unknown> | null, output: Record<string, unknown> | null): Record<string, unknown> | null {
    const fromInput = normalizeExecutionRunPublicStateBackendTarget(input?.backendTarget);
    if (fromInput) return fromInput;
    const fromOutput = normalizeExecutionRunPublicStateBackendTarget(output?.backendTarget);
    if (fromOutput) return fromOutput;

    const legacyBackendId = readString(input, 'backendId') ?? readString(output, 'backendId');
    const legacyConfiguredBackendId = readString(input, 'configuredBackendId') ?? readString(output, 'configuredBackendId');
    const legacySourceKind = readString(input, 'sourceKind') ?? readString(output, 'sourceKind');
    if (legacyConfiguredBackendId || legacySourceKind === 'configured') {
        const configuredBackendId = legacyConfiguredBackendId ?? legacyBackendId;
        if (!isConcreteLegacyConfiguredBackendId(configuredBackendId)) {
            return null;
        }
        return normalizeExecutionRunPublicStateBackendTarget({
            kind: 'configuredAcpBackend',
            backendId: configuredBackendId,
        });
    }

    if (legacyBackendId) {
        if (isLegacyConfiguredBackendSentinelId(legacyBackendId)) {
            return null;
        }
        const legacyTarget = getBackendCatalogDefinition(legacyBackendId)
            ? {
                kind: 'builtInAgent',
                agentId: legacyBackendId,
            }
            : {
                kind: 'configuredAcpBackend',
                backendId: legacyBackendId,
            };
        return normalizeExecutionRunPublicStateBackendTarget(legacyTarget);
    }
    return null;
}

function toExecutionRunPublicState(state: TranscriptExecutionRunState): ExecutionRunPublicState | null {
    const runClass = state.runClass ?? 'bounded';
    const ioMode = state.ioMode ?? (runClass === 'long_lived' ? 'streaming' : 'request_response');
    const retentionPolicy = state.retentionPolicy ?? (runClass === 'long_lived' ? 'resumable' : 'ephemeral');

    const parsed = ExecutionRunPublicStateSchema.safeParse({
        runId: state.runId,
        callId: state.callId,
        sidechainId: state.sidechainId ?? state.callId,
        intent: state.intent,
        backendTarget: state.backendTarget,
        ...(state.displayTitle ? { display: { title: state.displayTitle } } : {}),
        permissionMode: state.permissionMode ?? 'unknown',
        retentionPolicy,
        runClass,
        ioMode,
        status: state.status,
        // Never `?? state.finishedAtMs`: a start borrowed from the end reports every run it touches
        // as having taken zero time, which is the defect the roster shipped for months (D-8). The
        // wire field is required, so 0 is the unknown sentinel and renderers guard on `> 0`.
        startedAtMs: state.startedAtMs ?? 0,
        ...(typeof state.finishedAtMs === 'number' ? { finishedAtMs: state.finishedAtMs } : {}),
    });
    return parsed.success ? parsed.data : null;
}

export function listExecutionRunPublicStatesFromHistoryRows(rows: readonly RawHistoryRow[]): readonly ExecutionRunPublicState[] {
    const byRunId = new Map<string, TranscriptExecutionRunState>();

    for (const row of rows) {
        const parsed = isSubAgentRunEvent(row);
        if (!parsed) continue;

        const event = parsed.event;
        const input = parsed.kind === 'tool-call' ? asRecord(event.input) : null;
        const output = parsed.kind === 'tool-result' ? asRecord(event.output) : null;
        const runId = readString(input, 'runId') ?? readString(output, 'runId');
        if (!runId) continue;

        const current = byRunId.get(runId);
        const nextStatus = parsed.kind === 'tool-call'
            ? current?.status ?? 'running'
            : readString(output, 'status') ?? current?.status ?? 'unknown';
        const nextCallId = readString(event, 'callId') ?? readString(input, 'callId') ?? readString(output, 'callId') ?? current?.callId ?? null;
        const nextSidechainId = readString(input, 'sidechainId') ?? readString(output, 'sidechainId') ?? nextCallId ?? current?.sidechainId ?? null;

        byRunId.set(runId, {
            runId,
            callId: nextCallId,
            sidechainId: nextSidechainId,
            intent: readString(input, 'intent') ?? readString(output, 'intent') ?? current?.intent ?? null,
            backendTarget: readBackendTarget(input, output) ?? current?.backendTarget ?? null,
            displayTitle: readString(input, 'label') ?? readString(output, 'label') ?? current?.displayTitle ?? null,
            permissionMode: readString(input, 'permissionMode') ?? readString(output, 'permissionMode') ?? current?.permissionMode ?? null,
            retentionPolicy: readString(input, 'retentionPolicy') ?? readString(output, 'retentionPolicy') ?? current?.retentionPolicy ?? null,
            runClass: readString(input, 'runClass') ?? readString(output, 'runClass') ?? current?.runClass ?? null,
            ioMode: readString(input, 'ioMode') ?? readString(output, 'ioMode') ?? current?.ioMode ?? null,
            status: nextStatus,
            startedAtMs: minNumber([
                current?.startedAtMs,
                readNumber(input, 'startedAtMs'),
                readNumber(output, 'startedAtMs'),
                row.createdAt,
            ]),
            finishedAtMs: nextStatus === 'running'
                ? null
                : readNumber(output, 'finishedAtMs') ?? current?.finishedAtMs ?? row.createdAt,
        });
    }

    return Array.from(byRunId.values())
        .map(toExecutionRunPublicState)
        .filter((run): run is ExecutionRunPublicState => run !== null)
        .sort((left, right) => left.startedAtMs - right.startedAtMs);
}

export function findExecutionRunPublicStateInHistoryRows(
    rows: readonly RawHistoryRow[],
    runId: string,
): ExecutionRunPublicState | null {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) return null;
    return listExecutionRunPublicStatesFromHistoryRows(rows).find((run) => run.runId === normalizedRunId) ?? null;
}
