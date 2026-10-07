import type { z } from 'zod';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import { homeDomainActionInputSchemaV1 } from '@happier-dev/protocol/actions/homeDomainActionFamily';
import { type ManagedGitHubAppActionIdV1, MANAGED_GITHUB_APP_ACTION_INPUT_SCHEMAS_V1, MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1 } from '@happier-dev/protocol/identity/githubApps';

import type { ServerAccountScope } from '@/sync/domains/scope/serverAccountScope';
import { homeDomainFailureCode } from '@/sync/api/home/homeDomainActions';
import { scopedHomeActionExecutor } from '@/sync/ops/actions/scopedHomeActionExecutor';
import { classifyHomeActionOutcome } from '@/sync/ops/home/homeActionOutcome';
import {
    createHomeActionApprovalContinuation,
    type ActionApprovalContinuation,
} from '@/components/approvals/actionApprovalContinuation';

type InputMap = Readonly<{
    [TActionId in ManagedGitHubAppActionIdV1]: z.input<
        (typeof MANAGED_GITHUB_APP_ACTION_INPUT_SCHEMAS_V1)[TActionId]
    >;
}>;

type OutputMap = Readonly<{
    [TActionId in ManagedGitHubAppActionIdV1]: z.output<
        (typeof MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1)[TActionId]
    >;
}>;

type ManagedGitHubAppActionOutput = OutputMap[ManagedGitHubAppActionIdV1];

function parseManagedGitHubAppActionOutput(
    actionId: ManagedGitHubAppActionIdV1,
    value: unknown,
): ManagedGitHubAppActionOutput | null {
    switch (actionId) {
        case 'identity.githubApps.list': {
            const parsed = MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(value);
            return parsed.success ? parsed.data : null;
        }
        case 'identity.githubApps.create': {
            const parsed = MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(value);
            return parsed.success ? parsed.data : null;
        }
        case 'identity.githubApps.manifestSetup.start': {
            const parsed = MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(value);
            return parsed.success ? parsed.data : null;
        }
        case 'identity.githubApps.update': {
            const parsed = MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(value);
            return parsed.success ? parsed.data : null;
        }
        case 'identity.githubApps.verifyInstallation': {
            const parsed = MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(value);
            return parsed.success ? parsed.data : null;
        }
        case 'identity.githubApps.remove': {
            const parsed = MANAGED_GITHUB_APP_ACTION_OUTPUT_SCHEMAS_V1[actionId].safeParse(value);
            return parsed.success ? parsed.data : null;
        }
    }
}

type ManagedGitHubAppsExecuteOptions<TValue> = Readonly<{
    signal?: AbortSignal;
    onApprovalSucceeded?: (value: TValue) => void | Promise<void>;
    onApprovalFailed?: (code: string) => void;
}>;

type ManagedGitHubAppsExecuteImplementationOptions = Readonly<{
    signal?: AbortSignal;
    onApprovalSucceeded?: unknown;
    onApprovalFailed?: unknown;
}>;

function isManagedGitHubAppApprovalSucceededCallback(
    value: unknown,
): value is (output: ManagedGitHubAppActionOutput) => void | Promise<void> {
    return typeof value === 'function';
}

function isManagedGitHubAppApprovalFailedCallback(
    value: unknown,
): value is (code: string) => void {
    return typeof value === 'function';
}

export type ManagedGitHubAppsActionResult<TValue> =
    | Readonly<{ kind: 'succeeded'; value: TValue }>
    | Readonly<{ kind: 'approval_pending'; artifactId: string; approval: ActionApprovalContinuation }>
    | Readonly<{ kind: 'failed'; failure: Readonly<{ code: string; retryable: boolean }> }>;

export type ManagedGitHubAppsClient = Readonly<{
    execute: {
        (actionId: 'identity.githubApps.list', input: InputMap['identity.githubApps.list'], options?: ManagedGitHubAppsExecuteOptions<OutputMap['identity.githubApps.list']>): Promise<ManagedGitHubAppsActionResult<OutputMap['identity.githubApps.list']>>;
        (actionId: 'identity.githubApps.create', input: InputMap['identity.githubApps.create'], options?: ManagedGitHubAppsExecuteOptions<OutputMap['identity.githubApps.create']>): Promise<ManagedGitHubAppsActionResult<OutputMap['identity.githubApps.create']>>;
        (actionId: 'identity.githubApps.manifestSetup.start', input: InputMap['identity.githubApps.manifestSetup.start'], options?: ManagedGitHubAppsExecuteOptions<OutputMap['identity.githubApps.manifestSetup.start']>): Promise<ManagedGitHubAppsActionResult<OutputMap['identity.githubApps.manifestSetup.start']>>;
        (actionId: 'identity.githubApps.update', input: InputMap['identity.githubApps.update'], options?: ManagedGitHubAppsExecuteOptions<OutputMap['identity.githubApps.update']>): Promise<ManagedGitHubAppsActionResult<OutputMap['identity.githubApps.update']>>;
        (actionId: 'identity.githubApps.verifyInstallation', input: InputMap['identity.githubApps.verifyInstallation'], options?: ManagedGitHubAppsExecuteOptions<OutputMap['identity.githubApps.verifyInstallation']>): Promise<ManagedGitHubAppsActionResult<OutputMap['identity.githubApps.verifyInstallation']>>;
        (actionId: 'identity.githubApps.remove', input: InputMap['identity.githubApps.remove'], options?: ManagedGitHubAppsExecuteOptions<OutputMap['identity.githubApps.remove']>): Promise<ManagedGitHubAppsActionResult<OutputMap['identity.githubApps.remove']>>;
    };
}>;

export function createManagedGitHubAppsClient(scope: ServerAccountScope): ManagedGitHubAppsClient {
    const executeManagedAction = scopedHomeActionExecutor(scope);
    function execute(
        actionId: 'identity.githubApps.list',
        input: InputMap['identity.githubApps.list'],
        options?: ManagedGitHubAppsExecuteOptions<OutputMap['identity.githubApps.list']>,
    ): Promise<ManagedGitHubAppsActionResult<OutputMap['identity.githubApps.list']>>;
    function execute(
        actionId: 'identity.githubApps.create',
        input: InputMap['identity.githubApps.create'],
        options?: ManagedGitHubAppsExecuteOptions<OutputMap['identity.githubApps.create']>,
    ): Promise<ManagedGitHubAppsActionResult<OutputMap['identity.githubApps.create']>>;
    function execute(
        actionId: 'identity.githubApps.manifestSetup.start',
        input: InputMap['identity.githubApps.manifestSetup.start'],
        options?: ManagedGitHubAppsExecuteOptions<OutputMap['identity.githubApps.manifestSetup.start']>,
    ): Promise<ManagedGitHubAppsActionResult<OutputMap['identity.githubApps.manifestSetup.start']>>;
    function execute(
        actionId: 'identity.githubApps.update',
        input: InputMap['identity.githubApps.update'],
        options?: ManagedGitHubAppsExecuteOptions<OutputMap['identity.githubApps.update']>,
    ): Promise<ManagedGitHubAppsActionResult<OutputMap['identity.githubApps.update']>>;
    function execute(
        actionId: 'identity.githubApps.verifyInstallation',
        input: InputMap['identity.githubApps.verifyInstallation'],
        options?: ManagedGitHubAppsExecuteOptions<OutputMap['identity.githubApps.verifyInstallation']>,
    ): Promise<ManagedGitHubAppsActionResult<OutputMap['identity.githubApps.verifyInstallation']>>;
    function execute(
        actionId: 'identity.githubApps.remove',
        input: InputMap['identity.githubApps.remove'],
        options?: ManagedGitHubAppsExecuteOptions<OutputMap['identity.githubApps.remove']>,
    ): Promise<ManagedGitHubAppsActionResult<OutputMap['identity.githubApps.remove']>>;
    async function execute(
        actionId: ManagedGitHubAppActionIdV1,
        input: InputMap[ManagedGitHubAppActionIdV1],
        options?: ManagedGitHubAppsExecuteImplementationOptions,
    ): Promise<ManagedGitHubAppsActionResult<ManagedGitHubAppActionOutput>> {
        const onApprovalSucceeded = isManagedGitHubAppApprovalSucceededCallback(options?.onApprovalSucceeded)
            ? options.onApprovalSucceeded
            : undefined;
        const onApprovalFailed = isManagedGitHubAppApprovalFailedCallback(options?.onApprovalFailed)
            ? options.onApprovalFailed
            : undefined;
        const parsedInput = homeDomainActionInputSchemaV1(actionId).safeParse(input);
        if (!parsedInput.success) {
            return { kind: 'failed', failure: { code: 'invalid_parameters', retryable: false } };
        }
        const actionResult = await executeManagedAction(actionId, parsedInput.data, {
            surface: 'ui',
            authority: 'present_user',
            serverId: scope.serverId,
            ...(options?.signal ? { signal: options.signal } : {}),
        });
        const outcome = classifyHomeActionOutcome(actionResult);
        if (outcome.kind === 'failed') {
            return {
                kind: 'failed',
                failure: {
                    code: homeDomainFailureCode(outcome.failure),
                    retryable: outcome.failure.retryable,
                },
            };
        }
        if (outcome.kind === 'approval_pending') {
            if (getActionSpec(actionId).sideEffectClass === 'read') {
                return { kind: 'failed', failure: { code: 'invalid_action_output', retryable: false } };
            }
            return {
                ...outcome,
                approval: createHomeActionApprovalContinuation<ManagedGitHubAppActionOutput, ManagedGitHubAppActionIdV1>({
                    artifactId: outcome.artifactId,
                    actionId,
                    scope,
                    expectedInput: parsedInput.data,
                    onSucceeded: async (value) => await onApprovalSucceeded?.(value),
                    ...(onApprovalFailed ? { onFailed: onApprovalFailed } : {}),
                }),
            };
        }
        const parsedOutput = parseManagedGitHubAppActionOutput(actionId, outcome.result);
        if (parsedOutput === null) {
            return { kind: 'failed', failure: { code: 'invalid_action_output', retryable: false } };
        }
        return { kind: 'succeeded', value: parsedOutput };
    }
    return Object.freeze({
        execute,
    });
}
