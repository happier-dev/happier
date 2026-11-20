import type { ActionOperationProjection, ActionOperationSudoPrompt } from '@/sync/domains/actionOperations/actionOperationSelectors';
import { MachineSetupFailureDetailsV1Schema, type ProjectCommandAttachmentV1 } from '@happier-dev/protocol/actions/operations/v1';
import type { WorkspaceAddressV1, WorkspaceRefV1 } from '@happier-dev/protocol/workspaces/workspaceRefV1';
import { isWorkspacePathWithinRootV1 } from '@happier-dev/protocol/workspaces/workspaceRefResolutionV1';
import { resolveWorkspaceRefById } from '@/sync/domains/workspaces/workspaceRefs';
import { isActionOperationTerminal, type ActionOperationObservation } from '@/sync/domains/actionOperations/actionOperationStore';
import { canRequestActionOperationStop, describeActionOperationStatusLabel, readProjectCommandStepExitCode } from './actionOperationPresentation';
import { resolveSystemTaskFailureMessage } from '@/components/systemTasks/resolveSystemTaskFailureMessage';
import { presentActionFailureOutcome } from '@/components/tools/shell/approvals/approvalFailureOutcome';
import { resolveActionExecutionFailureMessage } from '@/sync/ops/actions/resolveActionExecutionFailureMessage';
import type { TechnicalDetailsLine } from '@/components/ui/lists/TechnicalDetailsDisclosure';
import type { QualifiedActionOperation } from '@/sync/domains/actionOperations/qualifiedActionOperation';
import { t } from '@/text';
import { describeMachineSetupFailureCause } from '@/components/machines/setup/machineSetupReasonText';
import type { PlanChecklistExecutionState, PlanChecklistItem, PlanChecklistItemStatus } from '@/components/systemTasks/planChecklist';
import type { MachineFirewallRecoveryV1 } from '@happier-dev/protocol/machines/adminAccessV1';
import { MACHINE_REACHABILITY_CONFIGURE_ACTION_ID_V1 } from '@happier-dev/protocol/machines/reachability/actionIdsV1';
import { MachineReachabilityConfigureResultV1Schema, MachineReachabilityConfigureFailureDetailsV1Schema } from '@happier-dev/protocol/machines/reachability/actionsV1';
import { DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentBackupRunResultV1Schema, type DeploymentBackupSourceV1 } from '@happier-dev/protocol/deployments/deploymentBackupActionsV1';
import { formatMachineBytes } from '@/components/machines/vitals/machineVitalsPresentation';
import { describeProjectCommandSource } from '@/components/projects/projectSetup/projectScriptPresentation';

type ActionOperationSnapshot = ActionOperationProjection['snapshot'];
export type MachineSetupOutputAttachment = Extract<NonNullable<ActionOperationSnapshot['domainRef']>, { kind: 'machineSetup' }>;
export type MachineRebootAttachment = Extract<NonNullable<ActionOperationSnapshot['domainRef']>, { kind: 'machineReboot' }>;

export type ActionOperationDetailField = Readonly<{
    id: 'strategy' | 'result' | 'session' | 'phase' | 'reference';
    value: string;
}>;

export type ActionOperationDetailSummaryRow = Readonly<{
    label: string;
    value: string;
}>;

/** A failed operation as a person reads it: the reason, and the typed code kept for Technical details. */
export type ActionOperationDetailFailure = Readonly<{
    reason: string;
    technicalLines: readonly TechnicalDetailsLine[];
}>;

export type ActionOperationDetailRecovery =
    | Readonly<{ kind: 'fork_lineage'; referenceId: string; sessionId: string }>
    | Readonly<{ kind: 'spawn_custody'; referenceId: string }>
    | Readonly<{ kind: 'handoff'; actions: readonly string[] }>;

/** The owner's typed isolation review, with the original request identity a newly approved set resumes on. */
export type AgentIsolationReviewDetail = Readonly<{
    review: Pick<Extract<NonNullable<ActionOperationSnapshot['observation']>, { kind: 'review_required'; code: 'agent_isolation_effect_changed' }>, 'machineId' | 'enabled' | 'current'>;
    requestId: string | null;
}>;

/** What the one fresh CHECK after an unknown isolation outcome says is left; `needs` is a review to approve again. */
export type AgentIsolationRecoveryDetail =
    | Readonly<{ kind: 'satisfied'; enabled: boolean }>
    | Readonly<{ kind: 'applying' }>
    | Readonly<{ kind: 'needs'; detail: AgentIsolationReviewDetail }>
    | Readonly<{ kind: 'unavailable' }>;

export function projectAgentIsolationRecovery(
    recovery: NonNullable<QualifiedActionOperation['agentIsolationRecovery']>,
    machineId: string,
): AgentIsolationRecoveryDetail {
    const { preview, enabled } = recovery;
    if (preview.kind === 'unavailable') return { kind: 'unavailable' };
    if (preview.status.kind === 'applying') return { kind: 'applying' };
    const { plan, status } = preview;
    const settled = status.kind === (enabled ? 'effective' : 'disabled');
    // Roots and ancestor ACLs remain inventories after native CHECKs are satisfied.
    // The producer summarizes native drift in requiresAdmin; status owns runtime qualification.
    const nothingLeft = plan.sessionsToReplace === 0 && !plan.requiresAdmin;
    return settled && nothingLeft
        ? { kind: 'satisfied', enabled }
        // A retry is approved from the CHECK's own reviewed facts and runs as a new request, never the unknown one.
        : { kind: 'needs', detail: { review: { machineId, enabled, current: preview }, requestId: null } };
}

export type ActionOperationDetailProjection = Readonly<{
    kind: 'fork' | 'spawn' | 'handoff' | 'external' | 'plugin' | 'projectCommand' | 'machineSetup' | 'machineReboot';
    projectCommand: ProjectCommandAttachmentV1 | null;
    machineSetup: MachineSetupOutputAttachment | null;
    machineFirewallRecovery: MachineFirewallRecoveryV1 | null;
    machineReboot: MachineRebootAttachment | null;
    agentIsolationReview: AgentIsolationReviewDetail | null;
    fields: readonly ActionOperationDetailField[];
    resultSummary: readonly ActionOperationDetailSummaryRow[];
    /** Structured result values, whole, for the Technical details disclosure; never a summary row. */
    resultTechnicalLines: readonly TechnicalDetailsLine[];
    failure: ActionOperationDetailFailure | null;
    warning: Readonly<{ code: string; message: string }> | null;
    recovery: ActionOperationDetailRecovery | null;
    nextAction:
        | Readonly<{ kind: 'open_session'; sessionId: string }>
        | Readonly<{ kind: 'resume_handoff'; handoffId: string; sessionId: string; targetMachineId: string }>
        | Readonly<{ kind: 'open_output'; serverId: string; machineId: string; workspaceRefId?: string; cwd?: string; terminalId: string }>
        /** The Environment's Backups, where a completed backup run's snapshots now live. */
        | Readonly<{ kind: 'open_deployment_backups'; serverId: string; environmentId: string }>
        | null;
    canCancel: boolean;
}>;

type DetailProjector = (
    snapshot: ActionOperationSnapshot,
    observation: ActionOperationObservation,
) => Omit<ActionOperationDetailProjection, 'canCancel'>;

const EMPTY_DETAIL = Object.freeze({
    projectCommand: null,
    machineSetup: null,
    machineFirewallRecovery: null,
    machineReboot: null,
    agentIsolationReview: null,
    fields: Object.freeze([]),
    resultSummary: Object.freeze([]),
    resultTechnicalLines: Object.freeze([]),
    failure: null,
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

function formatScalarValue(value: unknown): string | null {
    const scalar = readString(value);
    if (scalar) return scalar;
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
    return null;
}

function formatStructuredValue(value: unknown): string | null {
    if (value === undefined) return null;
    try {
        return JSON.stringify(stableJsonValue(value)) || null;
    } catch {
        return null;
    }
}

type ResultFacts = Pick<ActionOperationDetailProjection, 'resultSummary' | 'resultTechnicalLines'>;
const NO_RESULT_FACTS: ResultFacts = Object.freeze({ resultSummary: Object.freeze([]), resultTechnicalLines: Object.freeze([]) });

/** A generic result as a person reads it: readable values are facts; structured values stay whole behind Technical details. */
function summarizeResult(value: unknown): ResultFacts {
    const record = readRecord(value);
    const entries: ReadonlyArray<readonly [string, unknown]> = record
        ? Object.keys(record).sort().slice(0, 8).map(label => [label, record[label]] as const)
        : [['result', value]];
    const resultSummary: ActionOperationDetailSummaryRow[] = [];
    const resultTechnicalLines: TechnicalDetailsLine[] = [];
    for (const [label, entry] of entries) {
        const scalar = formatScalarValue(entry);
        if (scalar !== null) { resultSummary.push({ label, value: scalar }); continue; }
        const structured = formatStructuredValue(entry);
        if (structured !== null) resultTechnicalLines.push({ key: `result.${label}`, label, value: structured });
    }
    return { resultSummary, resultTechnicalLines };
}

function succeededResultFacts(snapshot: ActionOperationSnapshot, value: unknown = snapshot.result): ResultFacts {
    return snapshot.state === 'succeeded' ? summarizeResult(value) : NO_RESULT_FACTS;
}

function backupSourceLabel(source: DeploymentBackupSourceV1 | undefined, sourceId: string): string {
    if (!source) return sourceId;
    return source.kind === 'dump' ? t('projects.deployments.backupSourceDump', { service: source.service })
        : t('projects.deployments.backupSourceVolume', { service: source.service, volume: source.volume });
}

/** A completed backup run says what it saved (each source and its size) and opens the Environment's Backups. */
function projectDeploymentBackupRun(snapshot: ActionOperationSnapshot): Omit<ActionOperationDetailProjection, 'canCancel'> {
    const detail = projectPlugin(snapshot);
    const parsed = snapshot.state === 'succeeded' ? DeploymentBackupRunResultV1Schema.safeParse(unwrapResult(snapshot)) : null;
    if (!parsed?.success) return detail;
    const sources = new Map(parsed.data.restoreCaptures?.flatMap(capture =>
        capture.configuration.sources.map(source => [source.sourceId, source] as const)) ?? []);
    const reference = snapshot.domainRef;
    return {
        ...detail,
        resultSummary: parsed.data.manifests.map(manifest => ({
            label: backupSourceLabel(sources.get(manifest.sourceId), manifest.sourceId),
            value: formatMachineBytes(manifest.totalBytesProcessed, 'storage'),
        })),
        resultTechnicalLines: [],
        nextAction: reference?.kind === 'deployment'
            ? { kind: 'open_deployment_backups', serverId: reference.serverId, environmentId: reference.environmentId } : null,
    };
}

/** The shared failure presenter reads the operation's failure: readable words first, the code only as a detail. */
export function presentFailure(snapshot: ActionOperationSnapshot): ActionOperationDetailFailure | null {
    if (!snapshot.error) return null;
    const { errorCode, error } = snapshot.error;
    const observedStepExit = readProjectCommandStepExitCode(snapshot);
    const sentence = observedStepExit !== null
        ? t('localServices.actions.failure.exitCode', { code: String(observedStepExit) })
        : resolveSystemTaskFailureMessage({ code: errorCode, message: error }) ?? error;
    const presented = presentActionFailureOutcome({ ...snapshot.error, requestId: snapshot.requestId }, undefined, sentence);
    const fallback = presented.reason || t('inbox.actionOperations.failureGeneric');
    return {
        // Domain refusals retain their full cause in result; error may only summarize the settlement.
        reason: resolveActionExecutionFailureMessage({ ok: true, result: snapshot.result }, fallback) ?? fallback,
        technicalLines: presented.technicalDetails,
    };
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
        ...succeededResultFacts(snapshot),
        failure: presentFailure(snapshot),
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
    [DEPLOYMENT_BACKUP_RUN_ACTION_ID_V1]: projectDeploymentBackupRun,
});

function projectProjectCommand(snapshot: ActionOperationSnapshot): Omit<ActionOperationDetailProjection, 'canCancel'> {
    const attachment = snapshot.domainRef;
    if (attachment?.kind !== 'projectCommand') return projectPlugin(snapshot);
    return {
        ...EMPTY_DETAIL,
        kind: 'projectCommand',
        projectCommand: attachment,
        failure: presentFailure(snapshot),
        ...succeededResultFacts(snapshot),
        nextAction: attachment.terminalId ? {
            kind: 'open_output', serverId: attachment.serverId, machineId: attachment.machineId,
            workspaceRefId: attachment.workspaceRefId, cwd: attachment.cwd, terminalId: attachment.terminalId,
        } : null,
    };
}

/** Only declared retained output targets; never infer a Project from a Machine setup. */
export function readActionOperationOutputAttachment(snapshot: ActionOperationSnapshot): ProjectCommandAttachmentV1 | MachineSetupOutputAttachment | null {
    const attachment = snapshot.domainRef;
    return attachment?.kind === 'projectCommand' || attachment?.kind === 'machineSetup' ? attachment : null;
}

/** Output belongs to the actual accepted checkout; the process cwd may be below its root. */
export function readProjectCommandOutputWorkspace(attachment: ProjectCommandAttachmentV1,
    workspaceRefs: readonly WorkspaceRefV1[]): WorkspaceAddressV1 | null {
    const selected = resolveWorkspaceRefById(workspaceRefs, attachment.workspaceRefId, attachment.serverId);
    if (selected.kind !== 'resolved' || selected.ref.machineId !== attachment.machineId
        || !isWorkspacePathWithinRootV1(attachment.cwd, selected.ref.rootPath)) return null;
    return { serverId: selected.ref.serverId, workspaceId: selected.ref.id,
        machineId: selected.ref.machineId, rootPath: selected.ref.rootPath };
}

function projectMachineSetup(snapshot: ActionOperationSnapshot): Omit<ActionOperationDetailProjection, 'canCancel'> {
    const attachment = snapshot.domainRef;
    if (attachment?.kind !== 'machineSetup') return projectPlugin(snapshot);
    let machineFirewallRecovery: MachineFirewallRecoveryV1 | null = null;
    let summary: unknown = snapshot.result;
    if (snapshot.actionId === MACHINE_REACHABILITY_CONFIGURE_ACTION_ID_V1) {
        const configured = MachineReachabilityConfigureResultV1Schema.safeParse(unwrapResult(snapshot));
        if (configured.success) {
            const { recovery, ...result } = configured.data;
            machineFirewallRecovery = recovery ?? null;
            // The complete capture has its own copyable surface, never a truncated generic summary.
            summary = result;
        }
        if (snapshot.error) {
            const failure = MachineReachabilityConfigureFailureDetailsV1Schema.safeParse(snapshot.error.details);
            if (failure.success && 'recovery' in failure.data) machineFirewallRecovery = failure.data.recovery ?? null;
        }
    }
    return {
        ...EMPTY_DETAIL,
        kind: 'machineSetup',
        machineSetup: attachment,
        machineFirewallRecovery,
        failure: presentFailure(snapshot),
        ...succeededResultFacts(snapshot, summary),
        nextAction: attachment.terminalId ? {
            kind: 'open_output', serverId: attachment.serverId, machineId: attachment.machineId, terminalId: attachment.terminalId,
        } : null,
    };
}

type MachineSetupStep = NonNullable<MachineSetupOutputAttachment['steps']>[number];

export type MachineSetupStepChecklistItem = PlanChecklistItem & Readonly<{
    needsAttention: boolean;
    output: Extract<NonNullable<ActionOperationDetailProjection['nextAction']>, { kind: 'open_output' }> | null;
}>;

export type MachineSetupStepChecklist = Readonly<{
    items: readonly MachineSetupStepChecklistItem[];
    selectedIds: readonly string[];
    executionById: Readonly<Record<string, PlanChecklistExecutionState>>;
    progressObservationLabel: string | null;
}>;

const SETUP_STEP_STATUS = {
    pending: 'queued', running: 'running', succeeded: 'done', failed: 'error', cancelled: 'idle',
} as const satisfies Record<MachineSetupStep['state'], PlanChecklistItemStatus>;

const NO_LOGS: readonly never[] = Object.freeze([]);

/** The setup operation's reviewed steps as rows of the shared checklist; `(planIndex, stepId)` is the row identity. */
export function projectMachineSetupStepChecklist(
    attachment: MachineSetupOutputAttachment,
    localizeLabel: (label: MachineSetupStep['label']) => string,
    question: ActionOperationSudoPrompt | null = null,
    observation: ActionOperationObservation = 'available',
    /** The stopped run's own typed failure ({@link readMachineSetupRunFailure}): it explains the step where the run stopped. */
    runFailure: string | null = null,
): MachineSetupStepChecklist | null {
    const steps = attachment.steps;
    if (!steps || steps.length === 0) return null;
    const items: MachineSetupStepChecklistItem[] = [];
    const executionById: Record<string, PlanChecklistExecutionState> = {};
    let progressObservationLabel: string | null = null;
    let stoppedStepFailure = runFailure;
    for (const step of steps) {
        const id = `${step.planIndex}:${step.stepId}`;
        const title = typeof step.label !== 'string' && step.label.key === 'machinePresets.setup.scriptNumbered'
            && typeof step.label.params?.index === 'number'
            ? t('machinePresets.setup.scriptNumbered', { index: step.label.params.index }) : localizeLabel(step.label);
        const stoppedHere = step.state === 'failed' ? stoppedStepFailure : null;
        if (stoppedHere) stoppedStepFailure = null;
        const subtitle = step.state === 'failed' ? stoppedHere ?? describeMachineSetupFailureCause(step.failureCause)
            : step.state === 'cancelled' ? t('inbox.actionOperations.status.cancelled') : undefined;
        const unobserved = observation !== 'available' && (step.state === 'running' || step.state === 'pending');
        if (unobserved && step.state === 'running') {
            progressObservationLabel ??= describeActionOperationStatusLabel({ kind: 'host', value: observation });
        }
        items.push({ id, title, satisfied: false, disabled: true, ...(subtitle ? { subtitle } : {}),
            needsAttention: !unobserved && question !== null && step.state === 'running',
            output: step.terminalId ? { kind: 'open_output', serverId: attachment.serverId,
                machineId: attachment.machineId, terminalId: step.terminalId } : null });
        executionById[id] = { status: unobserved ? 'idle' : SETUP_STEP_STATUS[step.state], logs: NO_LOGS };
    }
    return { items, selectedIds: items.map((item) => item.id), executionById, progressObservationLabel };
}

type ProjectCommandStep = NonNullable<ProjectCommandAttachmentV1['steps']>[number];
const PROJECT_STEP_STATUS = {
    pending: 'queued', running: 'running', succeeded: 'done', failed: 'error', cancelled: 'idle', outcome_uncertain: 'idle',
} as const satisfies Record<ProjectCommandStep['state'], PlanChecklistItemStatus>;

/**
 * A Project setup's reviewed commands as rows of the same run checklist a Machine setup uses (plan E U2). The
 * finite owner reports each command's state; a running command with its terminal opens that terminal in place,
 * which is where an arbitrary init's own questions are answered.
 */
export function projectProjectCommandStepChecklist(
    attachment: ProjectCommandAttachmentV1,
    observation: ActionOperationObservation = 'available',
): MachineSetupStepChecklist | null {
    const steps = attachment.steps;
    if (!steps || steps.length === 0) return null;
    const items: MachineSetupStepChecklistItem[] = [];
    const executionById: Record<string, PlanChecklistExecutionState> = {};
    let progressObservationLabel: string | null = null;
    for (const step of steps) {
        const id = String(step.index);
        // The row names its place ("Step 2") and says the reviewed command whole beneath it; a command as the
        // title truncates in the detail's column (live L2, 1120).
        const command = describeProjectCommandSource(step.source).reference;
        const outcome = step.state === 'failed' && step.exitCode !== undefined
            ? t('localServices.actions.failure.exitCode', { code: String(step.exitCode) })
            : step.state === 'outcome_uncertain' ? t('inbox.actionOperations.status.outcomeUncertain')
            : step.state === 'cancelled' ? t('inbox.actionOperations.status.cancelled') : null;
        const subtitle = outcome ? `${command} · ${outcome}` : command;
        const unobserved = observation !== 'available' && (step.state === 'running' || step.state === 'pending');
        if (unobserved && step.state === 'running') {
            progressObservationLabel ??= describeActionOperationStatusLabel({ kind: 'host', value: observation });
        }
        items.push({ id, title: t('projects.scripts.setup.step', { n: step.index + 1 }), subtitle, satisfied: false, disabled: true,
            needsAttention: false,
            output: step.terminalId ? { kind: 'open_output', serverId: attachment.serverId,
                machineId: attachment.machineId, terminalId: step.terminalId } : null });
        executionById[id] = { status: unobserved ? 'idle' : PROJECT_STEP_STATUS[step.state], logs: NO_LOGS };
    }
    return { items, selectedIds: items.map((item) => item.id), executionById, progressObservationLabel };
}

/**
 * A stopped setup run's own failure in words, when the setup owner settled it with a typed remedy ("Check the selected
 * packages…"): more exact than the step's coarse reason code, and the same sentence the operation's detail shows.
 */
export function readMachineSetupRunFailure(snapshot: ActionOperationSnapshot | null | undefined): string | null {
    if (snapshot?.state !== 'failed' || !snapshot.error) return null;
    const details = MachineSetupFailureDetailsV1Schema.safeParse(snapshot.error.details);
    return details.success && 'remedy' in details.data.failure && details.data.failure.remedy ? presentFailure(snapshot)?.reason ?? null : null;
}

function projectMachineReboot(snapshot: ActionOperationSnapshot): Omit<ActionOperationDetailProjection, 'canCancel'> {
    const attachment = snapshot.domainRef;
    if (attachment?.kind !== 'machineReboot') return projectPlugin(snapshot);
    return {
        ...EMPTY_DETAIL,
        kind: 'machineReboot',
        machineReboot: attachment,
        failure: presentFailure(snapshot),
        ...succeededResultFacts(snapshot),
    };
}

export function projectActionOperationDetail(
    snapshot: ActionOperationSnapshot,
    observation: ActionOperationObservation,
): ActionOperationDetailProjection {
    const projector = snapshot.domainRef?.kind === 'projectCommand'
        ? projectProjectCommand : snapshot.domainRef?.kind === 'machineSetup'
            ? projectMachineSetup : snapshot.domainRef?.kind === 'machineReboot'
                ? projectMachineReboot : DETAIL_PROJECTORS_BY_ACTION_ID[snapshot.actionId] ?? projectPlugin;
    const detail = projector(snapshot, observation);
    const review = snapshot.observation;
    return {
        ...detail,
        agentIsolationReview: review?.kind === 'review_required' && review.code === 'agent_isolation_effect_changed' && snapshot.actionId === 'machines.agentIsolation.set'
            && !isActionOperationTerminal(snapshot.state)
            ? { review, requestId: snapshot.requestId ?? null } : null,
        failure: detail.failure ?? presentFailure(snapshot),
        canCancel: canRequestActionOperationStop(snapshot, observation),
    };
}
