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

const STAGE_ORDER: readonly ThisComputerSetupStageId[] = [
    'setup.thisComputer.stage.installTools',
    'setup.thisComputer.stage.useRelay',
    'setup.thisComputer.stage.registerComputer',
    'setup.thisComputer.stage.backgroundService',
] as const;

const OPTIONAL_STAGE_IDS = new Set<ThisComputerSetupStageId>([
    'setup.thisComputer.stage.backgroundService',
]);

const STEP_TO_STAGE: Readonly<Record<string, ThisComputerSetupStageId>> = {
    'setup.thisComputer.ensureCli': 'setup.thisComputer.stage.installTools',
    'setup.thisComputer.resolveRelay': 'setup.thisComputer.stage.useRelay',
    'setup.thisComputer.checkAuth': 'setup.thisComputer.stage.useRelay',
    'setup.thisComputer.configureRelay': 'setup.thisComputer.stage.useRelay',
    'setup.thisComputer.preflight.releaseChannel': 'setup.thisComputer.stage.backgroundService',
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

export function mapThisComputerSetupExecutionToStages(
    snapshot: SystemTaskRunState | null,
    selectedIds: readonly string[] = [],
): ThisComputerSetupStageExecution {
    const logsByStage = new Map<ThisComputerSetupStageId, PlanChecklistLogEntry[]>();
    for (const stageId of STAGE_ORDER) {
        logsByStage.set(stageId, []);
    }

    const seenStageIds = new Set<ThisComputerSetupStageId>();
    if (snapshot) {
        for (const [index, event] of snapshot.events.entries()) {
            const logEntry = createPlanChecklistLogEntryFromSystemTaskEvent(event, resolveSystemTaskStepLabel, index);
            if (!logEntry) {
                continue;
            }
            const stageId = STEP_TO_STAGE[normalizeStepId((event as { stepId?: unknown }).stepId)];
            if (!stageId) {
                continue;
            }
            logsByStage.get(stageId)?.push(logEntry);
            seenStageIds.add(stageId);
        }
    }

    const currentStageId = resolveThisComputerSetupStageIdForStepId(snapshot?.currentStepId);
    const currentIndex = currentStageId ? STAGE_ORDER.indexOf(currentStageId) : -1;
    const executionById = {} as Record<ThisComputerSetupStageId, PlanChecklistExecutionState>;

    for (const [index, stageId] of STAGE_ORDER.entries()) {
        const logs = logsByStage.get(stageId) ?? [];
        let status: PlanChecklistExecutionState['status'] = 'idle';
        if (snapshot?.status === 'succeeded') {
            status = OPTIONAL_STAGE_IDS.has(stageId) && !isStageSelected(stageId, selectedIds) && logs.length === 0
                ? 'idle'
                : 'done';
        } else if (snapshot?.status === 'failed' || snapshot?.status === 'canceled') {
            status = stageId === currentStageId ? 'error' : index < currentIndex ? 'done' : 'idle';
        } else if (currentIndex >= 0) {
            if (index < currentIndex) {
                status = 'done';
            } else if (index === currentIndex) {
                status = 'running';
            } else {
                status = 'queued';
            }
        } else if (seenStageIds.has(stageId)) {
            status = 'done';
        }

        executionById[stageId] = {
            status,
            logs,
            error: snapshot?.result && !snapshot.result.ok && stageId === currentStageId
                ? {
                    title: snapshot.result.error.code,
                    message: snapshot.result.error.message,
                    raw: snapshot.result.error,
                }
                : undefined,
        };
    }

    return executionById;
}
