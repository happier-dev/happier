import type { ActionOperationProjection } from '@/sync/domains/actionOperations/actionOperationSelectors';
import type { ProjectCommandAttachmentV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { ActionOperationObservation } from '@/sync/domains/actionOperations/actionOperationStore';
import { canRequestActionOperationStop } from './actionOperationPresentation';

type ActionOperationSnapshot = ActionOperationProjection['snapshot'];
export type MachineEnvironmentOutputAttachment = Extract<NonNullable<ActionOperationSnapshot['domainRef']>, { kind: 'machineEnvironment' }>;

export type ActionOperationDetailField = Readonly<{
    id: 'strategy' | 'result' | 'session' | 'phase' | 'reference';
    value: string;
}>;

export type ActionOperationDetailSummaryRow = Readonly<{
    label: string;
    value: string;
}>;

export type ActionOperationDetailRecovery =
    | Readonly<{ kind: 'fork_lineage'; referenceId: string; sessionId: string }>
    | Readonly<{ kind: 'spawn_custody'; referenceId: string }>
    | Readonly<{ kind: 'handoff'; actions: readonly string[] }>;

export type ActionOperationDetailProjection = Readonly<{
    kind: 'fork' | 'spawn' | 'handoff' | 'external' | 'plugin' | 'projectCommand' | 'machineEnvironment';
    projectCommand: ProjectCommandAttachmentV1 | null;
    machineEnvironment: MachineEnvironmentOutputAttachment | null;
    fields: readonly ActionOperationDetailField[];
    resultSummary: readonly ActionOperationDetailSummaryRow[];
    errorSummary: readonly ActionOperationDetailSummaryRow[];
    warning: Readonly<{ code: string; message: string }> | null;
    recovery: ActionOperationDetailRecovery | null;
    nextAction:
        | Readonly<{ kind: 'open_session'; sessionId: string }>
        | Readonly<{ kind: 'resume_handoff'; handoffId: string; sessionId: string; targetMachineId: string }>
        | Readonly<{ kind: 'open_output'; serverId: string; machineId: string; workspaceRefId?: string; cwd?: string; terminalId: string }>
        | null;
    canCancel: boolean;
}>;

type DetailProjector = (
    snapshot: ActionOperationSnapshot,
    observation: ActionOperationObservation,
) => Omit<ActionOperationDetailProjection, 'canCancel'>;

const EMPTY_DETAIL = Object.freeze({
    projectCommand: null,
    machineEnvironment: null,
    fields: Object.freeze([]),
    resultSummary: Object.freeze([]),
    errorSummary: Object.freeze([]),
    warning: null,
    recovery: null,
    nextAction: null,
});

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Readonly<Record<string, unknown>>
        : null;
}

function readString(value: unknown): string | null {
    return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function readField(record: Readonly<Record<string, unknown>> | null, field: string): string | null {
    return readString(record?.[field]);
}

function unwrapResult(snapshot: ActionOperationSnapshot): Readonly<Record<string, unknown>> | null {
    const outer = readRecord(snapshot.result);
    const inner = readRecord(outer?.result);
    return inner ?? outer;
}

function stableJsonValue(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableJsonValue);
    const record = readRecord(value);
    if (!record) return value;
    const ordered: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) ordered[key] = stableJsonValue(record[key]);
    return ordered;
}

function formatSummaryValue(value: unknown): string | null {
    const scalar = readString(value);
    if (scalar) return scalar;
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
    if (value === undefined) return null;
    try {
        const serialized = JSON.stringify(stableJsonValue(value));
        if (!serialized) return null;
        return serialized.length > 240 ? `${serialized.slice(0, 237)}…` : serialized;
    } catch {
        return null;
    }
}

function summarizeResult(value: unknown): readonly ActionOperationDetailSummaryRow[] {
    const record = readRecord(value);
    if (!record) {
        const formatted = formatSummaryValue(value);
        return formatted ? [{ label: 'result', value: formatted }] : [];
    }
    return Object.keys(record).sort().slice(0, 8).flatMap((label) => {
        const formatted = formatSummaryValue(record[label]);
        return formatted ? [{ label, value: formatted }] : [];
    });
}

function summarizeError(snapshot: ActionOperationSnapshot): readonly ActionOperationDetailSummaryRow[] {
    if (!snapshot.error) return [];
    const rows: ActionOperationDetailSummaryRow[] = [
        { label: 'code', value: snapshot.error.errorCode },
        { label: 'message', value: snapshot.error.error },
    ];
    return rows;
}

function readStringArray(value: unknown): readonly string[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
        const normalized = readString(entry);
        return normalized ? [normalized] : [];
    });
}

function projectFork(
    snapshot: ActionOperationSnapshot,
    observation: ActionOperationObservation,
): Omit<ActionOperationDetailProjection, 'canCancel'> {
    const result = unwrapResult(snapshot);
    const childSessionId = snapshot.state === 'succeeded' ? readField(result, 'childSessionId') : null;
    const strategy = readField(result, 'strategy');
    const fields: ActionOperationDetailField[] = [];
    if (strategy) fields.push({ id: 'strategy', value: strategy });
    if (childSessionId) fields.push({ id: 'result', value: childSessionId });

    const recovery = observation === 'unavailable'
        && snapshot.domainRef?.kind === 'forkRequest'
        && snapshot.scope.sessionId
        ? {
            kind: 'fork_lineage' as const,
            referenceId: snapshot.domainRef.id,
            sessionId: snapshot.scope.sessionId,
        }
        : null;
    return {
        ...EMPTY_DETAIL,
        kind: 'fork',
        fields,
        recovery,
        nextAction: childSessionId
            ? { kind: 'open_session', sessionId: childSessionId }
            : recovery ? { kind: 'open_session', sessionId: recovery.sessionId } : null,
    };
}

function projectSpawn(
    snapshot: ActionOperationSnapshot,
    observation: ActionOperationObservation,
): Omit<ActionOperationDetailProjection, 'canCancel'> {
    const result = unwrapResult(snapshot);
    const sessionId = snapshot.state === 'succeeded' ? readField(result, 'sessionId') : null;
    const disposition = readField(result, 'disposition') ?? readField(result, 'sessionCreationOutcome');
    const fields: ActionOperationDetailField[] = [];
    if (disposition) fields.push({ id: 'result', value: disposition });
    if (sessionId) fields.push({ id: 'session', value: sessionId });
    const recovery = observation === 'unavailable' && snapshot.domainRef?.kind === 'spawnAttempt'
        ? { kind: 'spawn_custody' as const, referenceId: snapshot.domainRef.id }
        : null;
    return {
        ...EMPTY_DETAIL,
        kind: 'spawn',
        fields,
        recovery,
        nextAction: sessionId ? { kind: 'open_session', sessionId } : null,
    };
}

function projectHandoff(snapshot: ActionOperationSnapshot): Omit<ActionOperationDetailProjection, 'canCancel'> {
    const result = unwrapResult(snapshot);
    const statusRecord = readRecord(result?.status);
    const phase = snapshot.progress?.kind === 'phase' ? snapshot.progress.label : null;
    const status = readString(result?.status) ?? readField(statusRecord, 'status');
    const handoffId = readField(result, 'handoffId')
        ?? (snapshot.domainRef?.kind === 'handoff' ? snapshot.domainRef.id : null);
    const fields: ActionOperationDetailField[] = [];
    if (phase) fields.push({ id: 'phase', value: phase });
    if (status) fields.push({ id: 'result', value: status });
    if (handoffId) fields.push({ id: 'reference', value: handoffId });

    const warningRecord = readRecord(result?.warning);
    const warningCode = readField(warningRecord, 'code');
    const warningMessage = readField(warningRecord, 'message');
    const recoveryActions = readStringArray(result?.recoveryActions).length > 0
        ? readStringArray(result?.recoveryActions)
        : readStringArray(statusRecord?.recoveryActions);
    return {
        ...EMPTY_DETAIL,
        kind: 'handoff',
        fields,
        warning: warningCode && warningMessage ? { code: warningCode, message: warningMessage } : null,
        recovery: recoveryActions.length > 0 ? { kind: 'handoff', actions: recoveryActions } : null,
        nextAction: snapshot.progress?.kind === 'phase'
            && snapshot.progress.phase === 'awaiting_user_resume'
            && snapshot.domainRef?.kind === 'handoff'
            && snapshot.domainRef.targetMachineId
            && snapshot.scope.sessionId
            ? {
                kind: 'resume_handoff',
                handoffId: snapshot.domainRef.id,
                sessionId: snapshot.scope.sessionId,
                targetMachineId: snapshot.domainRef.targetMachineId,
            }
            : null,
    };
}

function projectPlugin(snapshot: ActionOperationSnapshot): Omit<ActionOperationDetailProjection, 'canCancel'> {
    return {
        ...EMPTY_DETAIL,
        kind: 'plugin',
        resultSummary: snapshot.state === 'succeeded' ? summarizeResult(snapshot.result) : [],
        errorSummary: summarizeError(snapshot),
    };
}

function projectExternal(snapshot: ActionOperationSnapshot): Omit<ActionOperationDetailProjection, 'canCancel'> {
    return {
        ...EMPTY_DETAIL,
        kind: 'external',
        fields: snapshot.progress?.label ? [{ id: 'phase', value: snapshot.progress.label }] : [],
        nextAction: snapshot.scope.sessionId ? { kind: 'open_session', sessionId: snapshot.scope.sessionId } : null,
    };
}

const DETAIL_PROJECTORS_BY_ACTION_ID: Readonly<Record<string, DetailProjector>> = Object.freeze({
    'session.fork': projectFork,
    'session.spawn_new': projectSpawn,
    'session.handoff': projectHandoff,
    'sessions.external.materialize.start': projectExternal,
    'sessions.external.takeover.start': projectExternal,
});

function projectProjectCommand(snapshot: ActionOperationSnapshot): Omit<ActionOperationDetailProjection, 'canCancel'> {
    const attachment = snapshot.domainRef;
    if (attachment?.kind !== 'projectCommand') return projectPlugin(snapshot);
    return {
        ...EMPTY_DETAIL,
        kind: 'projectCommand',
        projectCommand: attachment,
        errorSummary: summarizeError(snapshot),
        resultSummary: snapshot.state === 'succeeded' ? summarizeResult(snapshot.result) : [],
        nextAction: attachment.terminalId ? {
            kind: 'open_output', serverId: attachment.serverId, machineId: attachment.machineId,
            workspaceRefId: attachment.workspaceRefId, cwd: attachment.cwd, terminalId: attachment.terminalId,
        } : null,
    };
}

/** Only declared retained output targets; never infer a Project from a Machine setup. */
export function readActionOperationOutputAttachment(snapshot: ActionOperationSnapshot): ProjectCommandAttachmentV1 | MachineEnvironmentOutputAttachment | null {
    const attachment = snapshot.domainRef;
    return attachment?.kind === 'projectCommand' || attachment?.kind === 'machineEnvironment' ? attachment : null;
}

function projectMachineEnvironment(snapshot: ActionOperationSnapshot): Omit<ActionOperationDetailProjection, 'canCancel'> {
    const attachment = snapshot.domainRef;
    if (attachment?.kind !== 'machineEnvironment') return projectPlugin(snapshot);
    return {
        ...EMPTY_DETAIL,
        kind: 'machineEnvironment',
        machineEnvironment: attachment,
        errorSummary: summarizeError(snapshot),
        resultSummary: snapshot.state === 'succeeded' ? summarizeResult(snapshot.result) : [],
        nextAction: attachment.terminalId ? {
            kind: 'open_output', serverId: attachment.serverId, machineId: attachment.machineId, terminalId: attachment.terminalId,
        } : null,
    };
}

export function projectActionOperationDetail(
    snapshot: ActionOperationSnapshot,
    observation: ActionOperationObservation,
): ActionOperationDetailProjection {
    const projector = snapshot.domainRef?.kind === 'projectCommand'
        ? projectProjectCommand : snapshot.domainRef?.kind === 'machineEnvironment'
            ? projectMachineEnvironment : DETAIL_PROJECTORS_BY_ACTION_ID[snapshot.actionId] ?? projectPlugin;
    const detail = projector(snapshot, observation);
    return {
        ...detail,
        errorSummary: detail.errorSummary.length > 0 ? detail.errorSummary : summarizeError(snapshot),
        canCancel: canRequestActionOperationStop(snapshot, observation),
    };
}
