import type { WorkflowRunExecutionTargetV1 } from '@happier-dev/protocol/workflows/workflowDefinitionV1';

import type { DetachedExecutionRunSupport } from '@/sync/ops/actions/executionRunDetachedSupport';

/**
 * Which **Run as** targets a person may actually choose right now.
 *
 * `Run as` is one page-level, Run-scoped choice frozen with the recipe at
 * admission. The Protocol accepts two execution classes; whether the
 * detached one can actually carry a Run is a fact about the selected machine,
 * so it is projected from the canonical Execution Run capability owner
 * (`executionRunDetachedSupport`) — the same owner the `execution.run.*`
 * transport consults before it will dispatch a detached-scope call.
 *
 * This resolver deliberately adds no Workflow-specific capability bit and holds
 * no standing policy: it is a pure projection, so the UI and the transport
 * cannot disagree about what the machine supports.
 */

export type WorkflowRunAsTargetKind = WorkflowRunExecutionTargetV1['kind'];

/**
 * Why a runtime cannot be chosen. Each value has its own localized sentence, so
 * an unavailable choice explains itself instead of reading "not available yet"
 * for four different causes.
 */
export type WorkflowRunAsUnavailableReason =
    | 'machine_not_selected'
    | 'capability_unknown'
    | 'machine_does_not_support_detached_runs';

export type WorkflowRunAsTarget =
    | Readonly<{ kind: WorkflowRunAsTargetKind; available: true }>
    | Readonly<{
        kind: WorkflowRunAsTargetKind;
        available: false;
        unavailableReason: WorkflowRunAsUnavailableReason;
    }>;

function projectDetachedTarget(support: DetachedExecutionRunSupport): WorkflowRunAsTarget {
    switch (support) {
        case 'supported':
            return { kind: 'detached_run', available: true };
        case 'unsupported':
            return {
                kind: 'detached_run',
                available: false,
                unavailableReason: 'machine_does_not_support_detached_runs',
            };
        case 'machine_not_selected':
            return {
                kind: 'detached_run',
                available: false,
                unavailableReason: 'machine_not_selected',
            };
        case 'unknown':
            return {
                kind: 'detached_run',
                available: false,
                unavailableReason: 'capability_unknown',
            };
    }
}

export function resolveWorkflowRunAsTargets(params: Readonly<{
    detachedExecutionRun: DetachedExecutionRunSupport;
}>): readonly WorkflowRunAsTarget[] {
    return [
        // The detached probe says nothing about Session execution and must
        // never be allowed to block it.
        { kind: 'session', available: true },
        projectDetachedTarget(params.detachedExecutionRun),
    ];
}

export function isWorkflowRunAsTargetAvailable(
    targets: readonly WorkflowRunAsTarget[],
    kind: WorkflowRunAsTargetKind,
): boolean {
    return targets.some((target) => target.kind === kind && target.available);
}

/**
 * The target an admission should carry.
 *
 * `session` is the Protocol default and stays omitted on the wire. An
 * unavailable selection is refused rather than downgraded, because quietly
 * running effectful work under different execution semantics is exactly the
 * substitution this control exists to prevent.
 */
export function resolveAdmittedWorkflowExecutionTarget(params: Readonly<{
    selected: WorkflowRunAsTargetKind;
    targets: readonly WorkflowRunAsTarget[];
}>): WorkflowRunExecutionTargetV1 | null {
    if (!isWorkflowRunAsTargetAvailable(params.targets, params.selected)) return null;
    return { kind: params.selected };
}
