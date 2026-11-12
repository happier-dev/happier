import type { PluginActionExecution } from '@happier-dev/plugin-ui';
import type { JsonValue, PluginContributionRef } from '@happier-dev/plugin-sdk';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { projectTriageSourceReadFailureV1, projectTriageSourceInvocationFailureV1 as forgeCiInvocationFailureV1 } from '@happier-dev/triage-sources/runtime';
import {
    ForgeCiActionInputSchemasV1, ForgeCiActionResultSchemasV1, ForgeCiMutationResultV1Schema,
    type ForgeCiActionInputByOperationV1, type ForgeCiActionResultByOperationV1,
    type ForgeCiMutationResultV1, type ForgeCiOperationIdV1, type ForgeCiRunRefV1,
} from '@happier-dev/triage-protocol/ci/v1';

export type ForgeCiAdapterOptionsV1 = Readonly<{
    actionRefs: Readonly<Record<ForgeCiOperationIdV1, PluginContributionRef | null>>;
    invoke: (action: PluginContributionRef, input: JsonValue,
        options?: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>;
}>;

export type ForgeCiAdapterV1 = {
    readonly [K in ForgeCiOperationIdV1]: (
        input: ForgeCiActionInputByOperationV1[K], options?: Readonly<{ signal?: AbortSignal }>,
    ) => Promise<ForgeCiActionResultByOperationV1[K]>;
};

function resultFamily(operation: ForgeCiOperationIdV1): 'read' | 'mutation' | 'download' {
    // This selects the declared result envelope, never effect admission policy.
    switch (operation) {
        case 'downloadArtifact':
        case 'downloadJobLog':
            return 'download';
        case 'dispatchWorkflow':
        case 'enableWorkflow':
        case 'disableWorkflow':
        case 'rerunAll':
        case 'rerunFailed':
        case 'rerunJob':
        case 'cancelRun':
        case 'forceCancelRun':
        case 'approveForkRun':
        case 'approveDeployment':
        case 'rejectDeployment':
            return 'mutation';
        default:
            return 'read';
    }
}

function unboundResult(family: ReturnType<typeof resultFamily>) {
    const failure = { class: 'unsupportedContract', code: 'ci_operation_unbound' } as const;
    if (family === 'download') return { success: false, status: 'failed', error: 'CI operation is not bound', errorCode: 'unsupportedContract' };
    return { kind: family === 'mutation' ? 'rejected' : 'unavailable', failure };
}

function unknownMutation(input: ForgeCiActionInputByOperationV1[ForgeCiOperationIdV1]): ForgeCiMutationResultV1 {
    const run: ForgeCiRunRefV1 | undefined = 'runId' in input
        ? { v: 1, repository: input.repository, runId: input.runId }
        : undefined;
    return {
        kind: 'outcome_unknown',
        affected: {
            repository: input.repository,
            ...(run ? { run } : {}),
            ...(run && 'attempt' in input && input.attempt !== undefined
                ? { selection: { kind: 'attempt', attempt: { run, attemptId: input.attempt } } }
                : {}),
            ...('workflowId' in input && input.workflowId !== undefined ? { workflowId: input.workflowId } : {}),
            ...('ref' in input ? { ref: input.ref } : {}),
            ...('jobId' in input ? { jobId: input.jobId } : {}),
            ...('environmentIds' in input ? { environmentIds: input.environmentIds } : {}),
        },
        failure: { class: 'transient', code: 'ci_invocation_outcome_unknown' },
    };
}

/** Compatibility name for the shared invocation owner consumed by CI and Releases. */
export { forgeCiInvocationFailureV1 };

function failedInvocation(
    family: ReturnType<typeof resultFamily>,
    input: ForgeCiActionInputByOperationV1[ForgeCiOperationIdV1],
    invalidResult: boolean,
    error?: unknown,
) {
    if (family === 'mutation') {
        // A canonical host denial settled before execution; transport loss or
        // an invalid possible-effect response still cannot prove a non-effect.
        if (!invalidResult && isPluginError(error) && error.code === 'denied') {
            return { kind: 'rejected', failure: forgeCiInvocationFailureV1(error, 'ci_invocation_failed') };
        }
        return unknownMutation(input);
    }
    if (family === 'download') return { success: false, status: 'unknown', error: 'Download result is unknown', errorCode: 'ci_download_outcome_unknown' };
    return {
        kind: 'unavailable',
        failure: invalidResult
            ? { class: 'unsupportedContract', code: 'ci_invalid_result' }
            : forgeCiInvocationFailureV1(error, 'ci_invocation_failed'),
    };
}

/** The CI result boundary shared by raw automation and the original host-control settlement. */
export function projectForgeCiMutationExecutionV1(
    input: ForgeCiActionInputByOperationV1[ForgeCiOperationIdV1],
    execution: PluginActionExecution,
): ForgeCiMutationResultV1 | null {
    if (execution.status === 'idle' || execution.status === 'pending') return null;
    if (execution.status === 'success') {
        const parsed = ForgeCiMutationResultV1Schema.safeParse(execution.result);
        return parsed.success ? parsed.data : unknownMutation(input);
    }
    const { class: failureClass, code, requestId } = projectTriageSourceReadFailureV1(
        execution, 'ci_invocation_failed', 'ci_invocation_failed',
    );
    const failure = { class: failureClass, code, ...(requestId === undefined ? {} : { requestId }) };
    return execution.status === 'outcomeUnknown'
        ? { ...unknownMutation(input), failure }
        : { kind: 'rejected', failure };
}

/** Bind ordinary Actions; the host keeps admission, transport and approvals. */
export function createForgeCiAdapterV1(options: ForgeCiAdapterOptionsV1): ForgeCiAdapterV1 {
    const methods = Object.fromEntries(
        (Object.keys(ForgeCiActionInputSchemasV1) as ForgeCiOperationIdV1[]).map(operation => {
            const action = options.actionRefs[operation];
            const schema = ForgeCiActionResultSchemasV1[operation];
            const family = resultFamily(operation);
            return [operation, async (
                input: ForgeCiActionInputByOperationV1[ForgeCiOperationIdV1],
                invocationOptions?: Readonly<{ signal?: AbortSignal }>,
            ) => {
                if (action === null) {
                    return schema.parse(unboundResult(family));
                }
                let result: unknown;
                try {
                    result = await options.invoke(action, projectNativeJsonValueForTransport(input), invocationOptions);
                } catch (error) {
                    // A lost host response cannot prove the provider did not act.
                    return schema.parse(failedInvocation(family, input, false, error));
                }
                if (family === 'mutation') return projectForgeCiMutationExecutionV1(input, { status: 'success', result });
                try {
                    // This is the single admission of the external unknown value.
                    return schema.parse(result);
                } catch {
                    return schema.parse(failedInvocation(family, input, true));
                }
            }] as const;
        }),
    );
    // The canonical operation map supplies every key and its corresponding parser.
    return Object.freeze(methods) as ForgeCiAdapterV1;
}
