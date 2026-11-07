import { z } from 'zod/mini';
import type { ActionExecutorContext } from '@happier-dev/protocol';
import type { ActionExecuteFailure, ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import type { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import type { ProjectSourceRepositorySelectorV1 } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import { normalizeScmHostingRepositoryIdentity, ScmHostingRepositoryIdentityV1Schema } from '@happier-dev/protocol/scm/hostingRepositoryIdentity';
import { ScmCommitOidSchema } from '@happier-dev/protocol/scm/commitPublication';
import { sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { projectPluginActionFailureCode } from '@happier-dev/protocol/plugins/actions/invocation';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';
import type { PluginRuntimeRegistryLease } from '@/plugins/runtime/reload/controller';

export type ExecuteScmSourceReadAction = (action: Readonly<{ pluginId: string; localId: string }>, input: unknown,
    context: ActionExecutorContext) => Promise<ActionExecuteResult>;

/** Signed ingress must retain the requester executor; controller custody is never a substitute. */
export function executeScmSourceReadForRequester(localExecutor: Pick<ReturnType<typeof createActionExecutor>, 'execute'>,
    action: Parameters<ExecuteScmSourceReadAction>[0], input: unknown, context: ActionExecutorContext): Promise<ActionExecuteResult> {
    const authorization = context.externalActionExecutionAuthorization;
    const reader = authorization ? authorization.requesterAccountExecutor : localExecutor;
    if (!reader) return Promise.resolve({ ok: false, errorCode: 'scm_ref_credential_unavailable', error: 'scm_ref_credential_unavailable' });
    return reader.execute('action.invoke', { action, input }, { ...context, requiredContributedActionDangerLevel: 'safe' });
}
const resultSchema = z.union([
    z.object({ kind: z.literal('value'), value: z.object({ repository: ScmHostingRepositoryIdentityV1Schema,
        branch: z.string(), headSha: ScmCommitOidSchema }) }),
    z.object({ kind: z.literal('unavailable'), failure: z.object({ code: z.string().check(z.minLength(1)) }) }),
]);
const refuse = (code: string, cause?: ActionExecuteFailure): never => { throw Object.assign(new Error(code, { cause }), { code }); };

/** The hosting provider owns the remote read; the requester Account executor owns its credential. */
export async function resolveScmHostingRefForHost(input: Readonly<{
    repository: ProjectSourceRepositorySelectorV1; ref: string; context: ActionExecutorContext;
    acquireRuntimeRegistryLease?(): Promise<PluginRuntimeRegistryLease>;
    executeSourceReadAction?: ExecuteScmSourceReadAction;
}>): Promise<string> {
    if (!input.acquireRuntimeRegistryLease || !input.executeSourceReadAction) return refuse('scm_ref_resolution_unavailable');
    const lease = await input.acquireRuntimeRegistryLease();
    try {
        const provider = lease.registry.contributes.scmHostingProviders?.find(entry => entry.pluginId
            && `${entry.pluginId}/${entry.definition.id}` === input.repository.provider.id);
        if (!provider?.pluginId || !provider.definition.resolveRefAction) return refuse('scm_ref_resolution_unavailable');
        const action = { pluginId: provider.pluginId, localId: provider.definition.resolveRefAction };
        const declaration = readResolvedActionContribution(lease.registry.contributes, action);
        if (declaration?.definition.dangerLevel !== 'safe' || declaration.definition.readOnly !== true
            || declaration.definition.execution?.target !== 'account') return refuse('scm_ref_resolution_unavailable');
        const repository = normalizeScmHostingRepositoryIdentity({ kind: input.repository.provider.kind,
            deployment: input.repository.provider.baseUrl, repository: input.repository.repository.nameWithOwner });
        if (!repository) return refuse('scm_ref_resolution_unavailable');
        const result = await input.executeSourceReadAction(action, { repository, ref: input.ref }, input.context);
        if (!result.ok) return refuse(projectPluginActionFailureCode(result.errorCode), result);
        const resolved = resultSchema.safeParse(result.result);
        if (!resolved.success) return refuse('scm_ref_resolution_unavailable');
        if (resolved.data.kind === 'unavailable') return refuse(projectPluginActionFailureCode(resolved.data.failure.code));
        if (!sameStrictJsonValue(resolved.data.value.repository, repository) || resolved.data.value.branch !== input.ref)
            return refuse('scm_ref_resolution_mismatch');
        return resolved.data.value.headSha;
    } finally { await lease.release(); }
}
