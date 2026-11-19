import { isSessionTaskItemV1, type SessionTaskProgressV1, type SessionWorkDisplayItemV1 } from '@happier-dev/protocol/sessions/work/state/sessionWorkStatePrimary';

export type SessionAgentPlanStepStatus = 'done' | 'current' | 'todo';

export type SessionAgentPlanStep = Readonly<{
    id: string;
    text: string;
    status: SessionAgentPlanStepStatus;
}>;

export type SessionAgentPlan = Readonly<{
    steps: readonly SessionAgentPlanStep[];
    doneCount: number;
    total: number;
    /** 1-based step the agent marked in progress, if any. */
    currentStep: number | null;
    /** 1-based first step not yet done, if any. */
    nextStep: number | null;
}>;

const projected = new WeakMap<readonly SessionWorkDisplayItemV1[], SessionAgentPlan>();

function stepStatus(status: SessionWorkDisplayItemV1['status']): SessionAgentPlanStepStatus {
    if (status === 'complete') return 'done';
    if (status === 'active') return 'current';
    return 'todo';
}

export function projectSessionAgentPlan(
    items?: readonly SessionWorkDisplayItemV1[] | null,
    progress?: SessionTaskProgressV1,
): SessionAgentPlan | null {
    if (!items || !progress) return null;
    const cached = projected.get(items);
    if (cached) return cached;

    let currentStep: number | null = null;
    let nextStep: number | null = null;
    const steps: SessionAgentPlanStep[] = [];
    for (const item of items) {
        if (!isSessionTaskItemV1(item)) continue;
        const status = stepStatus(item.status);
        const position = steps.length + 1;
        if (status === 'current' && currentStep === null) currentStep = position;
        if (status !== 'done' && nextStep === null) nextStep = position;
        steps.push(Object.freeze({ id: item.id, text: item.title, status }));
    }
    const plan = Object.freeze({
        steps: Object.freeze(steps),
        doneCount: progress.done,
        total: progress.total,
        currentStep,
        nextStep,
    });
    projected.set(items, plan);
    return plan;
}
