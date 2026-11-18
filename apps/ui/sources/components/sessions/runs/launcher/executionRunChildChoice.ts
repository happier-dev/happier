import { ExecutionRunStartFailureDetailsV1Schema, readExecutionRunStartRunCreation,
    type ExecutionRunChildChoiceV1 } from '@happier-dev/protocol/execution/runs/responseSchemas';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { ProviderBoundModelRef} from '@happier-dev/protocol/providers/selection/v1';
import type { TeamCredentialProviderModelSelectionV1 } from '@happier-dev/protocol/teams/credentials/providerModelCatalogV1';

import { updateReviewLauncherEngineConfiguration } from './reviewLauncherSelection';

/** The part of a refused start a chooser reads: an Action result, or one member of a fan-out. */
export type ExecutionRunStartRefusal = Readonly<{ ok: boolean; error?: string; errorCode?: string; details?: unknown }>;

/** A chooser is permission for a fresh attempt, not a retry of an unknown-effect start. */
export function readExecutionRunChildChoice(result: ExecutionRunStartRefusal): ExecutionRunChildChoiceV1 | null {
    const details = !result.ok ? ExecutionRunStartFailureDetailsV1Schema.safeParse(result.details) : null;
    if (!result.ok && result.errorCode === 'execution_run_child_choice_required' && details?.success
        && details.data.childChoice && readExecutionRunStartRunCreation(details.data) === 'noRunCreated') {
        return details.data.childChoice;
    }
    return null;
}

/** One target of a review/plan/delegate fan-out: the Run it started, or the choice its refusal asks for. */
export type ExecutionRunFanoutMember = Readonly<{ key: string; runId: string | null; choice: ExecutionRunChildChoiceV1 | null }>;

/** The members of a bounded launch's result. A member neither started nor refused is an unknown outcome. */
export function readExecutionRunFanoutMembers(result: ActionExecuteResult): readonly ExecutionRunFanoutMember[] {
    const output = result.ok && result.result && typeof result.result === 'object'
        ? (result.result as { results?: readonly (ExecutionRunStartRefusal & { key?: unknown; result?: { runId?: unknown } })[] }).results
        : undefined;
    return (output ?? []).map((member) => {
        const startedRunId = member.ok === true ? member.result?.runId : undefined;
        const runId = typeof startedRunId === 'string' && startedRunId.trim() ? startedRunId : null;
        return { key: typeof member.key === 'string' ? member.key : '', runId, choice: readExecutionRunChildChoice(member) };
    });
}

export type ExecutionRunChildSelection = 'agentDefault' | ProviderBoundModelRef
    | Readonly<{ teamCredentialModel: TeamCredentialProviderModelSelectionV1 }>;

/** A start input with no model or route of its own: the session's (attached omission inherits at admission). */
function clearChildConfiguration(input: Record<string, unknown>): Record<string, unknown> {
    const { modelId: _modelId, modelSelection: _modelSelection, teamCredentialModel: _team, teamCredentialSessionBindingConsent: _consent,
        connectedServices: _connected, connectedServicesDefaultServiceIds: _defaults, connectedServicesByBackendTargetKey: _byTarget,
        childSelection: _child, ...rest } = input;
    return rest;
}

export function clearExecutionRunChildSelection<T extends Record<string, unknown>>(input: T): Record<string, unknown> {
    return Array.isArray(input.reviewers) ? updateReviewLauncherEngineConfiguration(input, clearChildConfiguration) : clearChildConfiguration(input);
}

/** A start input carrying exactly one child choice: the Agent's Account default or an exact model. */
export function applyExecutionRunChildSelection<T extends Record<string, unknown>>(input: T, selection: ExecutionRunChildSelection): Record<string, unknown> {
    const apply = (configuration: Record<string, unknown>) => {
        const rest = clearChildConfiguration(configuration);
        return selection === 'agentDefault' ? { ...rest, childSelection: 'agentDefault' }
            : 'teamCredentialModel' in selection ? { ...rest, teamCredentialModel: selection.teamCredentialModel }
            : { ...rest, modelSelection: selection };
    };
    return Array.isArray(input.reviewers) ? updateReviewLauncherEngineConfiguration(input, apply) : apply(input);
}
