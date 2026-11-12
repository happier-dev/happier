import { deploymentOutputValidationFailure } from './outputValidation';
import type { DeploymentEnvironmentCreateInputV1, ActionExecutorContext, ActionExecuteFailure } from '@happier-dev/protocol';
import { DeploymentTargetLinkResultV1Schema, type DeploymentTemplateInstantiationPartialV1Schema }
    from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentSecretBindingSourceV1Schema } from '@happier-dev/protocol/deployments/storedAppInputV1';
import { DeploymentTargetLinkProviderContentV1Schema, DeploymentTargetProviderIdentityV1Schema } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import { isActionOutcomeUnknownErrorCodeV1 } from '@happier-dev/protocol/actions/actionExecutionResult';
import { projectDeploymentFailureRecoveryV1 } from '@happier-dev/protocol/deployments/deploymentFailureRecoveryV1';
import { isRecord } from '@happier-dev/protocol/common/records';
import { projectNativeJsonValueForTransport } from '@happier-dev/protocol/json/strictJsonValue';

type PartialResult = ReturnType<typeof DeploymentTemplateInstantiationPartialV1Schema.parse>;
const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
export const copyEnvironmentDataProvisionRole = (targetLinkId: string) => `copy-data-provision:${targetLinkId}`;
export const copyEnvironmentDataLinkRole = (targetLinkId: string) => `copy-data-link:${targetLinkId}`;

/** A provision Action can already have saved credentials before the subsequent link fails. */
function producedSavedSecrets(output: Record<string, unknown>): PartialResult['savedSecrets'] {
    const saved: PartialResult['savedSecrets'] = [];
    const capture = (name: string, value: unknown) => {
        if (!isRecord(value)) return;
        const source = DeploymentSecretBindingSourceV1Schema.safeParse({ kind: 'secret', ref: value.ref,
            resourceRevision: value.resourceRevision });
        if (source.success) saved.push({ name, phase: 'runtime', source: source.data });
    };
    const connections = isRecord(output.connectionSave) && isRecord(output.connectionSave.connections)
        ? output.connectionSave.connections : undefined;
    if (connections) for (const [name, value] of Object.entries(connections)) capture(name, value);
    capture('rolePassword', output.rolePassword);
    return saved;
}

/** Create/associate only. Connection authoring remains with the existing managed-data Actions. */
export async function copyEnvironmentDataForHost(request: Readonly<{
    input: DeploymentEnvironmentCreateInputV1; context: ActionExecutorContext; environmentId: string; revision: number;
}>): Promise<{ ok: true; environmentId: string; revision: number } | ActionExecuteFailure> {
    const { input, context, environmentId } = request;
    let revision = request.revision;
    const data = input.copyPlan?.data ?? [];
    let nextUnattempted = 0;
    const savedSecrets: PartialResult['savedSecrets'] = [];
    let continuation: PartialResult['continuation'];
    let createdResource: string | undefined;
    const partial = (cause: string | ActionExecuteFailure): ActionExecuteFailure => {
        const errorCode = typeof cause === 'string' ? cause : cause.errorCode;
        const inherited = typeof cause === 'string' ? undefined
            : projectDeploymentFailureRecoveryV1(isRecord(cause.details) ? cause.details : {}, cause.errorCode);
        const pending = data.slice(nextUnattempted).map(row => `data:${row.targetLinkId}:createEmpty`);
        return { ...(typeof cause === 'string' ? failure(cause) : cause), effectAttempted: true,
            details: { kind: 'partial', phase: 'target', environmentId, revision, errorCode, savedSecrets,
                ...(continuation ? { continuation } : {}),
                ...(inherited ? { requiredFact: inherited.requiredFact } : {}),
                ...(pending.length ? { requiredFact: [inherited?.requiredFact, ...pending].filter(Boolean).join(', '), remedy:
                    `${inherited ? `${inherited.remedy} ` : ''}Open the Environment Overview and add/manage a managed database. ${createdResource ? `Inspect the provider and link the resource already created: ${createdResource}. ` : ''}Explicitly create/configure the listed unattempted resources. Do not replay Duplicate.` }
                    : { remedy: `${inherited ? `${inherited.remedy} ` : ''}Open the Environment Overview and add/manage a managed database. ${createdResource ? `Inspect the provider and link the resource already created: ${createdResource}.` : 'Inspect the provider outcome before choosing an existing resource.'} Do not replay Duplicate.` }),
            } satisfies PartialResult };
    };
    try {
        for (const row of data) {
            context.signal?.throwIfAborted();
            const provisionInput = { ...row.provision.input, serverId: input.serverId, environmentId, expectedRevision: revision };
            nextUnattempted++;
            const created = await context.hostReviewedChild!.invoke({ action: row.provision.action,
                role: copyEnvironmentDataProvisionRole(row.targetLinkId), input: provisionInput });
            if (!created.ok) {
                if (created.effectAttempted === false && !isActionOutcomeUnknownErrorCodeV1(created.errorCode))
                    continuation = { actionId: 'action.invoke', input: { action: row.provision.action, input: provisionInput } };
                return partial(created);
            }
            // Once the provider reports an effect, repeating Create is never its recovery action.
            continuation = undefined;
            if (!isRecord(created.result)) return partial(deploymentOutputValidationFailure('copyEnvironmentDataForHost', undefined));
            savedSecrets.push(...producedSavedSecrets(created.result));
            if (created.result.status === 'outcome_unknown' || created.result.status === 'unavailable') {
                const identity = DeploymentTargetProviderIdentityV1Schema.safeParse(created.result.providerIdentity);
                if (identity.success) createdResource = `${identity.data.providerAccountId}/${identity.data.providerResourceId}`;
                return partial(typeof created.result.code === 'string' ? created.result.code : created.result.status);
            }
            const provider = DeploymentTargetLinkProviderContentV1Schema.safeParse({
                credentialPrincipal: row.provision.input.credentialPrincipal,
                providerIdentity: created.result.providerIdentity, providerEnvironment: created.result.providerEnvironment });
            if (!provider.success) return partial(deploymentOutputValidationFailure('deployments.copy.data.provision', undefined, provider.error));
            createdResource = `${provider.data.providerIdentity.providerAccountId}/${provider.data.providerIdentity.providerResourceId}`;
            const linkInput = { serverId: input.serverId, environmentId, expectedRevision: revision,
                requestKey: `${input.requestKey}-data-${row.targetLinkId}`, targetId: row.targetId,
                source: { kind: 'plugin' as const, contribution: row.contribution }, targetKind: row.targetKind,
                role: 'data' as const, machines: [], provider: provider.data };
            continuation = { actionId: 'deployments.targets.link', input: linkInput };
            const linked = await context.hostReviewedChild!.invoke({ action: 'deployments.targets.link',
                role: copyEnvironmentDataLinkRole(row.targetLinkId), input: projectNativeJsonValueForTransport(linkInput) });
            if (!linked.ok) return partial(linked);
            const parsed = DeploymentTargetLinkResultV1Schema.safeParse(linked.result);
            if (!parsed.success) return partial(deploymentOutputValidationFailure('deployments.targets.link', undefined, parsed.error));
            if (!parsed.data.ok) return partial(parsed.data.error);
            if (parsed.data.environmentId !== environmentId) return partial(deploymentOutputValidationFailure('copyEnvironmentDataForHost', undefined));
            revision = parsed.data.revision;
            continuation = undefined;
            createdResource = undefined;
        }
        return { ok: true, environmentId, revision };
    } catch (error) {
        // Transport exceptions can conceal a completed provider write. Never offer a blind replay.
        return partial(context.signal?.aborted ? 'cancelled' : error instanceof Error && 'code' in error
            && typeof error.code === 'string' ? error.code : 'deployment_content_unavailable');
    }
}
