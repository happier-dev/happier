import { resolveSystemTaskStepLabel } from '@/components/systemTasks/resolveSystemTaskStepLabel';
import type { SystemTaskRunState } from '@/components/systemTasks/types';
import {
    createPlanChecklistLogEntryFromSystemTaskEvent,
    resolveSystemTaskEventStepId,
    type PlanChecklistExecutionState,
    type PlanChecklistLogEntry,
} from '@/components/systemTasks/planChecklist';

import type { ThisComputerSetupStageId } from './buildThisComputerSetupStageModel';

export type ThisComputerSetupStageExecution = Readonly<Record<ThisComputerSetupStageId, PlanChecklistExecutionState>>;
export type ThisComputerSetupExecutionById = Readonly<Record<string, PlanChecklistExecutionState>>;

const STAGE_ORDER: readonly ThisComputerSetupStageId[] = [
    'setup.thisComputer.stage.installTools',
    'setup.thisComputer.stage.useRelay',
    'setup.thisComputer.stage.registerComputer',
    'setup.thisComputer.stage.backgroundService',
] as const;

const STEP_ORDER = [
    'setup.thisComputer.ensureCli',
    'setup.thisComputer.resolveRelay',
    'setup.thisComputer.checkAuth',
    'setup.thisComputer.configureRelay',
    'setup.thisComputer.auth.request',
    'setup.thisComputer.auth.wait',
    'setup.thisComputer.preflight.releaseChannel',
    'setup.thisComputer.preflight.manualRelayTakeover',
    'setup.thisComputer.preflight.serviceConflict',
    'setup.thisComputer.installService',
    'setup.thisComputer.startService',
    'setup.thisComputer.verifyService',
] as const;

const OPTIONAL_STAGE_IDS = new Set<ThisComputerSetupStageId>([
    'setup.thisComputer.stage.backgroundService',
]);

const OPTIONAL_STEP_IDS = new Set<string>([
    'setup.thisComputer.preflight.releaseChannel',
    'setup.thisComputer.preflight.manualRelayTakeover',
    'setup.thisComputer.preflight.serviceConflict',
    'setup.thisComputer.installService',
    'setup.thisComputer.startService',
    'setup.thisComputer.verifyService',
]);

const STEP_TO_STAGE: Readonly<Record<string, ThisComputerSetupStageId>> = {
    'setup.thisComputer.ensureCli': 'setup.thisComputer.stage.installTools',
    'setup.thisComputer.resolveRelay': 'setup.thisComputer.stage.useRelay',
    'setup.thisComputer.checkAuth': 'setup.thisComputer.stage.useRelay',
    'setup.thisComputer.configureRelay': 'setup.thisComputer.stage.useRelay',
    'setup.thisComputer.preflight.releaseChannel': 'setup.thisComputer.stage.backgroundService',
    'setup.thisComputer.preflight.manualRelayTakeover': 'setup.thisComputer.stage.backgroundService',
    'setup.thisComputer.preflight.serviceConflict': 'setup.thisComputer.stage.backgroundService',
    'setup.thisComputer.auth.request': 'setup.thisComputer.stage.registerComputer',
    'setup.thisComputer.auth.wait': 'setup.thisComputer.stage.registerComputer',
    'setup.thisComputer.installService': 'setup.thisComputer.stage.backgroundService',
    'setup.thisComputer.startService': 'setup.thisComputer.stage.backgroundService',
    'setup.thisComputer.verifyService': 'setup.thisComputer.stage.backgroundService',
};

function normalizeStepId(stepId: unknown): string {
    return resolveSystemTaskEventStepId({ stepId }) ?? '';
}

export function resolveThisComputerSetupStageIdForStepId(stepId: unknown): ThisComputerSetupStageId | null {
    return STEP_TO_STAGE[normalizeStepId(stepId)] ?? null;
}

function isStageSelected(stageId: ThisComputerSetupStageId, selectedIds: readonly string[]): boolean {
    return selectedIds.some((selectedId) => STEP_TO_STAGE[selectedId] === stageId);
}

function isStepSelected(stepId: string, selectedIds: readonly string[]): boolean {
    if (selectedIds.length > 0) {
        return selectedIds.includes(stepId);
    }
    return !OPTIONAL_STEP_IDS.has(stepId);
}

function aggregateExecutionStates(states: readonly PlanChecklistExecutionState[]): PlanChecklistExecutionState {
    const logs = states.flatMap((state) => state.logs);
    const error = states.find((state) => state.error)?.error;
    const hasError = states.some((state) => state.status === 'error');
    const hasRunning = states.some((state) => state.status === 'running');
    const hasQueued = states.some((state) => state.status === 'queued');
    const hasDone = states.some((state) => state.status === 'done');
    const allIdle = states.every((state) => state.status === 'idle');
    const allDone = states.length > 0 && states.every((state) => state.status === 'done');

    return {
        status: hasError
            ? 'error'
            : hasRunning
                ? 'running'
                : hasQueued
                    ? 'queued'
                    : allDone
                        ? 'done'
                        : allIdle
                            ? 'idle'
                            : hasDone
                                ? 'done'
                                : 'idle',
        logs,
        error,
    };
}

function resolveFailureMessage(snapshot: SystemTaskRunState): string | undefined {
    if (!snapshot.result || snapshot.result.ok) {
        return undefined;
    }
    const explicit = snapshot.result.error.message.trim();
    if (explicit.length > 0) {
        return explicit;
    }
    const latestMessage = typeof snapshot.latestMessage === 'string' ? snapshot.latestMessage.trim() : '';
    if (latestMessage.length > 0) {
        return latestMessage;
    }
    const stepLabel = snapshot.currentStepId ? resolveSystemTaskStepLabel(snapshot.currentStepId) : null;
    if (stepLabel && stepLabel.trim().length > 0) {
        return stepLabel.trim();
    }
    return undefined;
}

export function mapThisComputerSetupExecutionToStages(
    snapshot: SystemTaskRunState | null,
    selectedIds: readonly string[] = [],
): ThisComputerSetupExecutionById {
    const logsByStage = new Map<ThisComputerSetupStageId, PlanChecklistLogEntry[]>();
    const logsByStep = new Map<string, PlanChecklistLogEntry[]>();
    for (const stageId of STAGE_ORDER) {
        logsByStage.set(stageId, []);
    }

    const seenStageIds = new Set<ThisComputerSetupStageId>();
    const seenStepIds = new Set<string>();
    if (snapshot) {
        for (const [index, event] of snapshot.events.entries()) {
            const logEntry = createPlanChecklistLogEntryFromSystemTaskEvent(event, resolveSystemTaskStepLabel, index);
            if (!logEntry) {
                continue;
            }
            const stepId = normalizeStepId((event as { stepId?: unknown }).stepId);
            const stageId = STEP_TO_STAGE[stepId];
            if (!stageId) {
                continue;
            }
            logsByStage.get(stageId)?.push(logEntry);
            const currentStepLogs = logsByStep.get(stepId) ?? [];
            currentStepLogs.push(logEntry);
            logsByStep.set(stepId, currentStepLogs);
            seenStageIds.add(stageId);
            seenStepIds.add(stepId);
        }
    }

    const currentStepId = normalizeStepId(snapshot?.currentStepId);
    const currentStageId = resolveThisComputerSetupStageIdForStepId(snapshot?.currentStepId);
    const currentStepIndex = currentStepId ? STEP_ORDER.indexOf(currentStepId as (typeof STEP_ORDER)[number]) : -1;
    const executionById: Record<string, PlanChecklistExecutionState> = {};

    for (const [index, stepId] of STEP_ORDER.entries()) {
        const logs = logsByStep.get(stepId) ?? [];
        const selected = isStepSelected(stepId, selectedIds);
        let status: PlanChecklistExecutionState['status'] = 'idle';

        if (snapshot?.status === 'succeeded') {
            status = logs.length > 0 || selected ? 'done' : 'idle';
        } else if (snapshot?.status === 'failed' || snapshot?.status === 'canceled') {
            if (stepId === currentStepId) {
                status = 'error';
            } else if (logs.length > 0 || (currentStepIndex >= 0 && index < currentStepIndex && selected)) {
                status = 'done';
            } else if (currentStepIndex >= 0 && index > currentStepIndex && selected) {
                status = 'queued';
            }
        } else if (currentStepIndex >= 0) {
            if (stepId === currentStepId) {
                status = 'running';
            } else if (logs.length > 0 || (index < currentStepIndex && selected)) {
                status = 'done';
            } else if (index > currentStepIndex && selected) {
                status = 'queued';
            }
        } else if (seenStepIds.has(stepId)) {
            status = 'done';
        }

        executionById[stepId] = {
            status,
            logs,
            error: snapshot?.result && !snapshot.result.ok && stepId === currentStepId
                ? {
                    title: snapshot.result.error.code,
                    message: resolveFailureMessage(snapshot),
                    raw: snapshot.result.error,
                }
                : undefined,
        };
    }

    for (const stageId of STAGE_ORDER) {
        const stepStates = STEP_ORDER
            .filter((stepId) => STEP_TO_STAGE[stepId] === stageId)
            .map((stepId) => executionById[stepId]);

        if (stepStates.length === 0) {
            executionById[stageId] = {
                status: 'idle',
                logs: logsByStage.get(stageId) ?? [],
            };
            continue;
        }

        const aggregate = aggregateExecutionStates(stepStates);
        if (snapshot?.status === 'succeeded' && OPTIONAL_STAGE_IDS.has(stageId) && !isStageSelected(stageId, selectedIds) && aggregate.logs.length === 0) {
            executionById[stageId] = {
                status: 'idle',
                logs: [],
            };
            continue;
        }
        if (aggregate.status === 'idle' && seenStageIds.has(stageId)) {
            executionById[stageId] = {
                status: 'done',
                logs: aggregate.logs,
                error: aggregate.error,
            };
            continue;
        }

        executionById[stageId] = aggregate;
    }

    return executionById;
}
