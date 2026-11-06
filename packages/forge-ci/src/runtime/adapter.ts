import type { JsonValue, PluginContributionRef } from '@happier-dev/plugin-sdk';
import { isPluginError } from '@happier-dev/plugin-sdk/errors';
import { projectNativeJsonValueForTransport } from '@happier-dev/plugin-sdk/protocol';
import { TriageSourceFailureV1Schema, type TriageSourceFailureV1 } from '@happier-dev/triage-protocol/v1';
import {
    ForgeCiActionInputSchemasV1, ForgeCiActionResultSchemasV1,
    type ForgeCiActionInputByOperationV1, type ForgeCiActionResultByOperationV1,
    type ForgeCiMutationResultV1, type ForgeCiOperationIdV1, type ForgeCiRunRefV1,
} from '@happier-dev/triage-protocol/ci/v1';

export type ForgeCiAdapterOptionsV1 = Readonly<{
    actionRefs: Readonly<Record<ForgeCiOperationIdV1, PluginContributionRef | null>>;
    invoke: (action: PluginContributionRef, input: JsonValue,
        options?: Readonly<{ signal?: AbortSignal }>) => Promise<unknown>;
    activeRunPollIntervalMs: number;
}>;

export type ForgeCiAdapterV1 = Readonly<{ activeRunPollIntervalMs: number }> & {
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

/** CI and Releases preserve the same canonical host refusal without disclosing private context. */
export function forgeCiInvocationFailureV1(error: unknown, fallbackCode: string): TriageSourceFailureV1 {
    if (isPluginError(error)) {
        // Mounted transports keep the exact refusal in a diagnostic when the
        // host's top-level code describes only availability or stale custody.
        const wrapped = error.code === 'unavailable' || error.code === 'denied' || error.code === 'stale_surface';
        const code = wrapped ? error.diagnostics?.find(diagnostic => diagnostic.severity === 'error')?.code ?? error.code : error.code;
        const failure = TriageSourceFailureV1Schema.safeParse({
            class: error.code === 'denied' ? 'permission' : error.retryable ? 'transient' : 'unsupportedContract',
            code,
        });
        // Do not disclose arbitrary messages, diagnostic details or raw errors.
        if (failure.success) return failure.data;
    }
    return { class: 'transient', code: fallbackCode };
}

function failedInvocation(
    family: ReturnType<typeof resultFamily>,
    input: ForgeCiActionInputByOperationV1[ForgeCiOperationIdV1],
    invalidResult: boolean,
    error?: unknown,
) {
    if (family === 'mutation') return unknownMutation(input);
    if (family === 'download') return { success: false, status: 'unknown', error: 'Download result is unknown', errorCode: 'ci_download_outcome_unknown' };
    return {
        kind: 'unavailable',
        failure: invalidResult
            ? { class: 'unsupportedContract', code: 'ci_invalid_result' }
            : forgeCiInvocationFailureV1(error, 'ci_invocation_failed'),
    };
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
    return Object.freeze({ ...methods, activeRunPollIntervalMs: options.activeRunPollIntervalMs }) as ForgeCiAdapterV1;
}
