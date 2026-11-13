import type { ActionExecutorContext, ActionExecutorDeps, DeploymentEnvironmentCreateInputV1 } from '@happier-dev/protocol';
import type { HostReviewedChildrenPreparationV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { DeploymentEnvironmentCreateInputV1Schema, DeploymentEnvironmentCreateResultV1Schema,
    DeploymentDomainMutationResultV1Schema, DeploymentDomainListResultV1Schema,
    resolveDeploymentPreviewExecutionMachineIdV1 } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DEPLOYMENT_DEPLOY_ACTION_ID_V1, DEPLOYMENT_DOMAIN_ADD_ACTION_ID_V1, DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { DeploymentReceiptAcceptedResultV1Schema } from '@happier-dev/protocol/deployments/deploymentReceiptResultV1';
import type { DeploymentDomainContentV1 } from '@happier-dev/protocol/deployments/deploymentDomainContentV1';
import { readHostAdmittedReviewedParentV1, readHostAdmittedReviewedRootV1 } from '@happier-dev/protocol/actions/actionExecutor';
import { normalizeStrictJsonValue, sameStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { readDeploymentEnvironmentArtifactV1, type DeploymentEnvironmentContentV1 } from '@happier-dev/deployment-protocol';
import type { readDeploymentEnvironmentForHost } from './readEnvironmentForHost';
import { preparePreviewForkEligibilityForHost } from './previewAdmissionForHost';
import type { EnvironmentVariableBindingV1 } from '@happier-dev/protocol';
import type { ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readDeploymentDomainInventoryForHost } from './targets/ownServer/domainRouteSelection';

const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
type Storage = NonNullable<ActionExecutorDeps['deploymentAction']>;
type Open = Parameters<typeof readDeploymentEnvironmentArtifactV1>[1];
/** Admission reads only the Environment header and content, from either detail projection. */
type Environment = Pick<Awaited<ReturnType<typeof readDeploymentEnvironmentForHost>>, 'environment' | 'content'>;

/** The existing reviewed-child issuer is the sole authority to prepare fork code. */
export async function admitForkPreviewDeploymentForHost(input: Readonly<{
    environment: Environment; context: ActionExecutorContext; sha?: string;
}>, open: (artifactId: string) => Promise<Open>): Promise<void> {
    const root = readHostAdmittedReviewedParentV1(input.context.hostReviewedChild)
        ?? readHostAdmittedReviewedRootV1(input.context);
    if (root?.actionId !== DEPLOYMENT_ENVIRONMENT_CREATE_ACTION_ID_V1) return refuse('present_user_required');
    // This is the exact private Create operand already admitted by the issuer.
    const prepared = DeploymentEnvironmentCreateInputV1Schema.parse(root.input);
    if (!prepared.preview || prepared.projectSourceId !== input.environment.environment.projectSourceId
        || prepared.preview.templateEnvironmentId !== input.environment.environment.previewTemplateEnvironmentId
        || prepared.preview.pullRequestId !== input.environment.environment.previewPullRequestId
        || input.environment.environment.protection !== 'nonProduction') return refuse('credential_scope_denied');
    const opened = readDeploymentEnvironmentArtifactV1(prepared, await open(prepared.contentArtifactId));
    if (!opened.ok) return refuse(opened.error);
    if (opened.content.definition.kind !== 'repository' || !input.sha
        || opened.content.definition.ref !== input.sha
        || !sameStrictJsonValue(opened.content.previewProvenance, input.environment.content.previewProvenance))
        return refuse('credential_scope_denied');
}

/** Create owns both first creation and a new-head synchronization; Deploy remains its reviewed child. */
export async function prepareForkPreviewCreateForHost(input: Readonly<{
    prepared: DeploymentEnvironmentCreateInputV1; content: DeploymentEnvironmentContentV1; context: ActionExecutorContext;
    bindings?: readonly EnvironmentVariableBindingV1[];
    domain?: Readonly<{ domainId: string; content: DeploymentDomainContentV1; url: string }>;
}>, host: Readonly<{
    storage: Storage;
    readEnvironment(request: Parameters<typeof readDeploymentEnvironmentForHost>[0]): ReturnType<typeof readDeploymentEnvironmentForHost>;
    create?(request: Readonly<{ prepared: DeploymentEnvironmentCreateInputV1; context: ActionExecutorContext;
        existing?: Readonly<{ environmentId: string; revision: number; runtimeTargetLinkId: string }> }>): Promise<ActionExecuteResult>;
}>): Promise<HostReviewedChildrenPreparationV1> {
    const { prepared, content, context } = input;
    const preview = prepared.preview;
    const provenance = content.previewProvenance;
    if (!preview || !provenance || content.definition.kind !== 'repository'
        || prepared.protection !== 'nonProduction' || prepared.purpose !== 'preview'
        || content.bindings.length || content.template || prepared.previewDataTargetLinks?.length
        || prepared.copyFrom || prepared.copyPlan) return refuse('deployment_access_denied');
    const sha = content.definition.ref;
    const placement = await resolveDeploymentPreviewExecutionMachineIdV1({ serverId: prepared.serverId,
        projectSourceId: prepared.projectSourceId, preview: { ...preview, provenance, headSha: sha } }, {
        listEnvironments: input => host.storage('deployments.environments.list', input, context),
        readTemplateController: async () => ({ ok: true, machineId: prepared.controllerMachineId }),
    });
    if (!placement.ok) return refuse(placement.errorCode);
    const retained = placement.environment;
    const existing = retained ? await host.readEnvironment({ environmentId: retained.id, context }) : undefined;
    if (existing && (existing.environment.protection !== 'nonProduction'
        || existing.environment.previewTemplateEnvironmentId !== preview.templateEnvironmentId
        || existing.environment.previewPullRequestId !== preview.pullRequestId
        || !sameStrictJsonValue(existing.content.previewProvenance, provenance)
        || existing.content.bindings.some(binding => binding.purpose !== 'variable'
            || binding.source.kind !== 'value' && binding.source.kind !== 'deploymentFact') || existing.content.template
        || existing.targetLinks.some(row => row.role === 'data'))) return refuse('deployment_access_denied');
    const runtime = existing?.targetLinks.find(row => row.id === existing.environment.runtimeTargetLinkId);
    if (existing && !runtime) return refuse('target_mismatch');
    const selected = existing ? { ...prepared, controllerMachineId: existing.environment.controllerMachineId,
        buildMachineId: existing.environment.buildMachineId,
        firstTargetLink: prepared.firstTargetLink ? { ...prepared.firstTargetLink,
            machines: runtime!.members.map(({ machineId, installationId }) => ({ machineId, installationId })) } : undefined } : prepared;
    const eligibility = await preparePreviewForkEligibilityForHost({ serverId: selected.serverId, protection: prepared.protection,
        buildMachineId: selected.buildMachineId,
        runtime: runtime ?? (selected.firstTargetLink ? { source: { kind: 'host' },
            machines: selected.firstTargetLink.machines.map(member => member.machineId) } : undefined) },
        input => host.storage('deployments.environments.list', input, context));
    if (eligibility.kind !== 'eligible') return refuse('deployment_access_denied');
    return { input: selected, children: [
        ...(input.bindings?.length ? [{ action: 'deployments.bindings.set' as const, role: 'preview.bindings' }] : []),
        { action: DEPLOYMENT_DEPLOY_ACTION_ID_V1, role: 'preview.deploy' },
        ...(input.domain ? [{ action: DEPLOYMENT_DOMAIN_ADD_ACTION_ID_V1, role: 'template.domain:preview' }] : [])],
        requiredByPolicy: true,
        approvalPreview: normalizeStrictJsonValue({ preview: { headSha: sha, provenance,
            ...(input.bindings?.length ? { bindings: input.bindings } : {}),
            ...(input.domain ? { domain: input.domain.content, domainId: input.domain.domainId, domainUrl: input.domain.url } : {}) } }),
        executeAdmittedAction: async ({ context: admittedContext }) => {
            if (!readHostAdmittedReviewedParentV1(admittedContext.hostReviewedChild)) return refuse('present_user_required');
            const retained = existing ? { environmentId: existing.environment.id,
                revision: existing.environment.revision, runtimeTargetLinkId: runtime!.id } : undefined;
            const creation = host.create ? await host.create({ prepared: selected, context: admittedContext, existing: retained }) : null;
            if (creation && !creation.ok) return creation;
            const created = creation ? DeploymentEnvironmentCreateResultV1Schema.parse(creation.result)
                : retained ? { ok: true as const, ...retained }
                : DeploymentEnvironmentCreateResultV1Schema.parse(await host.storage('deployments.environments.create', selected, admittedContext));
            if (!created.ok) return { ok: false, errorCode: created.error, error: created.error };
            if (!created.runtimeTargetLinkId) return refuse('target_mismatch');
            const deployed = await admittedContext.hostReviewedChild!.invoke({ action: DEPLOYMENT_DEPLOY_ACTION_ID_V1,
                role: 'preview.deploy', ...(input.domain ? { invocationServices: { deploymentPreviewDomain: {
                    domainId: input.domain.domainId, url: input.domain.url } } } : {}),
                input: normalizeStrictJsonValue({ serverId: prepared.serverId,
                    environmentId: created.environmentId, targetLinkId: created.runtimeTargetLinkId,
                    requestKey: `${prepared.requestKey}-deploy`, sha }) });
            if (!deployed.ok) return deployed;
            if (input.domain) {
                const settled = DeploymentReceiptAcceptedResultV1Schema.parse(deployed.result);
                if ('kind' in settled || settled.state !== 'succeeded' && settled.state !== 'running_unverified')
                    return refuse('deployment_in_progress');
                const current = await host.readEnvironment({ environmentId: created.environmentId, context: admittedContext });
                const link = current.targetLinks.find(link => link.id === created.runtimeTargetLinkId) ?? refuse('target_mismatch');
                const inventory = await readDeploymentDomainInventoryForHost({ serverId: prepared.serverId,
                    environmentId: created.environmentId, signal: admittedContext.signal,
                    list: async query => {
                        const loaded = await host.storage('deployments.domains.list', query, admittedContext);
                        if ('ok' in loaded && loaded.ok === false && 'errorCode' in loaded) return refuse(loaded.errorCode);
                        return DeploymentDomainListResultV1Schema.parse(loaded);
                    } });
                if (inventory.kind !== 'ready') return refuse(inventory.reason);
                const previous = inventory.domains.find(domain => domain.id === created.environmentId);
                const domain = await admittedContext.hostReviewedChild!.invoke({ action: DEPLOYMENT_DOMAIN_ADD_ACTION_ID_V1,
                    role: 'template.domain:preview', input: normalizeStrictJsonValue({ serverId: prepared.serverId,
                        environmentId: created.environmentId, targetLinkId: link.id, expectedRevision: current.environment.revision,
                        expectedTargetLinkRevision: link.revision, domainId: created.environmentId,
                        ...(previous ? { expectedDomainRevision: previous.revision } : {}),
                        requestKey: `${prepared.requestKey}-domain`, content: input.domain.content }) });
                if (!domain.ok) return domain;
                const activated = DeploymentDomainMutationResultV1Schema.parse(domain.result);
                if (!activated.ok) return refuse(activated.error);
                if (activated.domain.state === 'failed') return refuse('native_route_unavailable');
                return { ok: true, result: { ...created, revision: activated.revision } };
            }
            return { ok: true, result: created };
        } };
}
