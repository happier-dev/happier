import type { ActionOperationSnapshotV1 } from '@happier-dev/protocol';

import type { IconName } from '@/components/ui/icons/Icon';
import { formatShortRelativeTimeAt } from '@/utils/time/formatShortRelativeTime';
import {
    actionOperationReentry,
    type ActionOperationLocalPresentation,
} from '@/sync/domains/actionOperations/actionOperationReentry';

export type ActionOperationObservationPresentation = 'available' | 'reconnecting' | 'status_unavailable';

export type ActionOperationPresentationStatus =
    | ActionOperationSnapshotV1['state']
    | Exclude<ActionOperationObservationPresentation, 'available'>
    | ActionOperationLocalPresentation['kind'];

export type ActionOperationPresentation = Readonly<{
    status: ActionOperationPresentationStatus;
    terminal: boolean;
    iconName: IconName;
    progressLabel: string | null;
    progressValue: string | null;
    timeValue: string;
    openSessionId: string | null;
}>;

export type ActionOperationDetailContent = Readonly<{
    iconName: IconName;
    openSessionId: string | null;
    resultSummary: string | null;
    warning: string | null;
    forkStrategy: string | null;
}>;

export type ActionOperationLedgerSections = Readonly<{
    inProgress: readonly ActionOperationSnapshotV1[];
    needsAttention: readonly ActionOperationSnapshotV1[];
    recent: readonly ActionOperationSnapshotV1[];
}>;

type ActionOperationDetailAdapter = Readonly<{
    iconName: IconName;
    readOpenSessionId?: (result: unknown) => string | null;
    readResultSummary?: (result: unknown) => string | null;
    readWarning?: (result: unknown) => string | null;
}>;

function readStringField(value: unknown, field: string): string | null {
    if (!value || typeof value !== 'object') return null;
    const candidate = (value as Readonly<Record<string, unknown>>)[field];
    return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : null;
}

function safeResultSummary(result: unknown): string | null {
    if (result === undefined || result === null) return null;
    if (typeof result === 'string') return result;
    if (typeof result === 'number' || typeof result === 'boolean') return String(result);
    try {
        return JSON.stringify(result, null, 2);
    } catch {
        return null;
    }
}

function readHandoffStatus(result: unknown): string | null {
    if (!result || typeof result !== 'object') return null;
    const status = (result as Readonly<Record<string, unknown>>).status;
    if (typeof status === 'string' && status.trim()) return status.trim();
    return readStringField(status, 'status');
}

function readHandoffWarning(result: unknown): string | null {
    if (!result || typeof result !== 'object') return null;
    const warning = (result as Readonly<Record<string, unknown>>).warning;
    return readStringField(warning, 'message');
}

const CORE_ACTION_OPERATION_DETAIL_ADAPTERS: Readonly<Record<string, ActionOperationDetailAdapter>> = {
    'session.fork': {
        iconName: 'git-branch',
        readOpenSessionId: (result) => readStringField(result, 'childSessionId') ?? readStringField(result, 'sessionId'),
        readResultSummary: (result) => readStringField(result, 'childSessionId') ?? readStringField(result, 'sessionId'),
    },
    'session.spawn_new': {
        iconName: 'plus',
        readOpenSessionId: (result) => readStringField(result, 'sessionId') ?? readStringField(result, 'childSessionId'),
        readResultSummary: (result) => readStringField(result, 'sessionId') ?? readStringField(result, 'childSessionId'),
    },
    'session.handoff': {
        iconName: 'arrows-left-right',
        readResultSummary: (result) => {
            const handoffId = readStringField(result, 'handoffId');
            const status = readHandoffStatus(result);
            return [handoffId, status].filter((value): value is string => value !== null).join(' · ') || null;
        },
        readWarning: readHandoffWarning,
    },
};

const STANDARD_ACTION_OPERATION_DETAIL_ADAPTER: ActionOperationDetailAdapter = {
    iconName: 'tray',
};

export function resolveActionOperationDetailAdapter(actionId: string): ActionOperationDetailAdapter {
    return CORE_ACTION_OPERATION_DETAIL_ADAPTERS[actionId] ?? STANDARD_ACTION_OPERATION_DETAIL_ADAPTER;
}

export function resolveActionOperationDetailContent(
    operation: ActionOperationSnapshotV1,
): ActionOperationDetailContent {
    const adapter = resolveActionOperationDetailAdapter(operation.actionId);
    const terminalSuccess = operation.state === 'succeeded';
    return {
        iconName: adapter.iconName,
        openSessionId: terminalSuccess && adapter.readOpenSessionId
            ? adapter.readOpenSessionId(operation.result)
            : null,
        resultSummary: terminalSuccess
            ? (adapter.readResultSummary?.(operation.result) ?? safeResultSummary(operation.result))
            : null,
        warning: terminalSuccess ? (adapter.readWarning?.(operation.result) ?? null) : null,
        forkStrategy: operation.domainRef?.kind === 'forkRequest'
            ? (operation.domainRef.strategy ?? null)
            : null,
    };
}

function isTerminal(operation: ActionOperationSnapshotV1): boolean {
    return operation.state === 'succeeded' || operation.state === 'failed' || operation.state === 'cancelled';
}

function resolveProgress(operation: ActionOperationSnapshotV1): Readonly<{
    progressLabel: string | null;
    progressValue: string | null;
}> {
    const progress = operation.progress;
    if (!progress) return { progressLabel: null, progressValue: null };
    if (progress.kind === 'determinate') {
        return {
            progressLabel: progress.label ?? null,
            progressValue: `${progress.current} / ${progress.total}`,
        };
    }
    return {
        progressLabel: progress.label ?? null,
        progressValue: null,
    };
}

export function resolveActionOperationPresentation(
    operation: ActionOperationSnapshotV1,
    observation: ActionOperationObservationPresentation,
    nowMs = Date.now(),
    localPresentation: ActionOperationLocalPresentation | null = actionOperationReentry.resolvePresentation(operation),
): ActionOperationPresentation {
    const terminal = isTerminal(operation);
    const detail = resolveActionOperationDetailContent(operation);
    const status = localPresentation?.kind
        ?? (terminal || observation === 'available' ? operation.state : observation);
    const { progressLabel, progressValue } = terminal
        ? { progressLabel: null, progressValue: null }
        : resolveProgress(operation);
    const timeAnchor = terminal ? operation.settledAt : (operation.startedAt ?? operation.createdAt);

    return {
        status,
        terminal,
        iconName: detail.iconName,
        progressLabel,
        progressValue,
        timeValue: formatShortRelativeTimeAt(timeAnchor ?? operation.createdAt, nowMs),
        openSessionId: detail.openSessionId,
    };
}

export function buildActionOperationLedgerSections(
    operations: readonly ActionOperationSnapshotV1[],
    options?: Readonly<{
        preferredSessionId?: string | null;
        localPresentationForOperation?: (operation: ActionOperationSnapshotV1) => ActionOperationLocalPresentation | null;
        observationForOperation?: (operation: ActionOperationSnapshotV1) => ActionOperationObservationPresentation;
    }>,
): ActionOperationLedgerSections {
    const unique = new Map<string, ActionOperationSnapshotV1>();
    for (const operation of operations) {
        const existing = unique.get(operation.operationId);
        if (!existing || operation.revision > existing.revision) unique.set(operation.operationId, operation);
    }

    const inProgress: ActionOperationSnapshotV1[] = [];
    const needsAttention: ActionOperationSnapshotV1[] = [];
    const recent: ActionOperationSnapshotV1[] = [];
    for (const operation of unique.values()) {
        const observation = options?.observationForOperation?.(operation) ?? 'available';
        if (
            (operation.state === 'accepted' || operation.state === 'running')
            && observation !== 'status_unavailable'
        ) {
            inProgress.push(operation);
        } else if (
            operation.state === 'failed'
            || observation === 'status_unavailable'
            || (options?.localPresentationForOperation ?? actionOperationReentry.resolvePresentation)(operation)?.kind === 'setup_needs_attention'
        ) {
            needsAttention.push(operation);
        } else {
            recent.push(operation);
        }
    }

    const preferredSessionId = options?.preferredSessionId ?? null;
    const comparePreference = (left: ActionOperationSnapshotV1, right: ActionOperationSnapshotV1): number => {
        if (!preferredSessionId) return 0;
        const leftPreferred = left.scope.sessionId === preferredSessionId;
        const rightPreferred = right.scope.sessionId === preferredSessionId;
        return leftPreferred === rightPreferred ? 0 : leftPreferred ? -1 : 1;
    };
    inProgress.sort((left, right) => comparePreference(left, right) || right.createdAt - left.createdAt);
    needsAttention.sort((left, right) => comparePreference(left, right)
        || (right.settledAt ?? right.createdAt) - (left.settledAt ?? left.createdAt));
    recent.sort((left, right) => comparePreference(left, right)
        || (right.settledAt ?? right.createdAt) - (left.settledAt ?? left.createdAt));

    return { inProgress, needsAttention, recent };
}
