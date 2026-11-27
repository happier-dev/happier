import { randomUUID } from 'node:crypto';
import { DeploymentTeardownDetachInputV1Schema, DeploymentTeardownInputV1Schema,
    type ActionExecutorDeps, type DeploymentTargetLinkHeaderV1 } from '@happier-dev/protocol';
import { DeploymentProviderTeardownContentV1Schema, type DeploymentEnvironmentDetailV1, type DeploymentProviderTeardownContentV1, type DeploymentReceiptDetailV1 } from '@happier-dev/deployments/contracts/v1';
import { DEPLOYMENT_TEARDOWN_STEPS_V1 } from '@happier-dev/protocol/deployments/deploymentTeardownContentV1';
import { readDeploymentTargetDisplayNameV1, readPlatformResourceName, selectDeploymentTargetRemovalChoicesV1 } from '@happier-dev/deployments';
import { DeploymentTargetDataInputV1Schema, DeploymentTargetDataRemovalResultV1Schema } from '@happier-dev/protocol/plugins/contributions/deploymentTargetRolesV1';
import { DeploymentTargetTeardownVolumePreviewV1Schema, DeploymentVolumeRemovalOutcomeV1Schema } from '@happier-dev/protocol/deployments/deploymentVolumeRemovalV1';
import { normalizeStrictJsonValue } from '@happier-dev/protocol/json/strictJsonValue';
import { parseQualifiedPluginActionId } from '@happier-dev/protocol/plugins/actions/qualifiedActionId';
import { buildQualifiedPluginContributionKey } from '@happier-dev/protocol/plugins/contribution-identity';
import { createActionExecuteFailureError, isActionOutcomeUnknownErrorCodeV1, type ActionExecuteFailure, type ActionExecuteResult } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readResolvedActionContribution } from '@/plugins/projection/registry/actions';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { resolveRegistryConnectedAccountActionCredentialPurposeAuthorization } from '@/daemon/connectedServices/purposeBindings/deriveRegistryConnectedAccountPurposeAuthorizations';
import { createDeploymentTargetRoleAdmissionHost } from '../targets/createDeploymentTargetRoleAdmissionHost';
import { acceptedReceiptOperand, admitDeploymentTargetRoleForHost } from '../targets/admitDeploymentTargetRoleForHost';
import { readDeploymentTargetV1 } from '../targets/deploymentTargetCatalog';
import { deploymentTeardownDetachPreview } from '../targets/contributedDeploymentTargetForHost';
import { projectDeploymentException, projectDeploymentFailure, projectDeploymentReceiptFailure, readProviderTeardownAbsenceFailure } from '../deploymentFailure';
import type { DeploymentReceiptDispatchV1 } from '../createCliDeploymentActionDeps';
import type { DataTeardownHost } from './dataTeardown';

type Request = Parameters<NonNullable<ActionExecutorDeps['prepareDeploymentTeardown']>>[0];
type Link = Pick<DeploymentTargetLinkHeaderV1, 'source' | 'targetKind' | 'role'>;
const failure = (code: string) => projectDeploymentFailure(code);
const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };

function projectInput(input: Pick<import('@happier-dev/protocol').DeploymentTeardownInputV1,
    'serverId' | 'environmentId' | 'expectedRevision' | 'targetLinkId' | 'expectedTargetLinkRevision'>,
    platform: DeploymentProviderTeardownContentV1['platform']) {
    const principal = platform.credentialPrincipal;
    const credentialRef = principal.kind === 'account' && principal.target.kind === 'account' ? principal.target.account
        : principal.kind === 'team' && principal.selection.deliveryMode === 'direct' ? principal.selection.disclosedMember : undefined;
    if (!credentialRef) return refuse('deployment_target_role_unavailable');
    return normalizeStrictJsonValue(DeploymentTargetDataInputV1Schema.parse({ v: 1,
        serverId: input.serverId, environmentId: input.environmentId, expectedRevision: input.expectedRevision,
        targetLinkId: input.targetLinkId, expectedTargetLinkRevision: input.expectedTargetLinkRevision,
        credentialRef, credentialPrincipal: principal, providerIdentity: platform.providerIdentity,
        providerEnvironment: platform.providerEnvironment,
        ...(platform.repositoryAccess ? { repositoryAccess: platform.repositoryAccess } : {}),
        ...(platform.preparedNative ? { preparedNative: platform.preparedNative } : {}) }));
}

/** Project removal uses the selected data declaration and the ordinary reviewed receipt path. */
export function createDataProjectTeardownForHost(host: DataTeardownHost) {
    async function leaseDeclaration(link: Link) {
        if (!host.acquirePluginRuntimeRegistryLease) return refuse('unsupported_action');
        const lease = await host.acquirePluginRuntimeRegistryLease();
        const target = readDeploymentTargetV1(link.source, lease.registry.contributes.deploymentTargets);
        const projects = target?.role === 'data' && target.targetKind === link.targetKind ? target.dataV1?.projects : undefined;
        const reference = projects?.delete;
        const action = reference?.kind === 'plugin' ? parseQualifiedPluginActionId(reference.actionId) : null;
        const observeAction = projects?.observe?.kind === 'plugin' ? parseQualifiedPluginActionId(projects.observe.actionId) : null;
        const preview = projects?.teardownPreview?.kind === 'plugin' ? parseQualifiedPluginActionId(projects.teardownPreview.actionId) : null;
        return { lease, action, observeAction, preview, target, declaration: action ? readResolvedActionContribution(lease.registry.contributes, action) : null };
    }
    return {
        async prepareProject(request: Request, environment: DeploymentEnvironmentDetailV1) {
            const { input, context } = request;
            const row = environment.targetLinks.find(item => item.targetLink.id === input.targetLinkId);
            if (row?.targetLink.role !== 'data' || row.targetLink.source.kind !== 'plugin') return null;
            try {
                if (input.serverId !== host.serverId) return failure('server_scope_mismatch');
                if ('dataCreation' in input || 'detachKeepRunning' in input) return null;
                if (input.volumes !== undefined || 'machines' in input && input.machines !== undefined) return failure('deployment_invalid');
                const { lease, action, observeAction, preview, target, declaration } = await leaseDeclaration(row.targetLink);
                try {
                    const choices = selectDeploymentTargetRemovalChoicesV1(row.targetLink.source, [{
                        pluginId: row.targetLink.source.contribution.pluginId, targetId: row.targetLink.source.contribution.localId,
                        ...(action ? { teardown: true as const } : {}) }], row.content?.providerResourceOrigin);
                    const removal = 'contentArtifactId' in input ? 'delete'
                        : 'providerRemoval' in input && input.providerRemoval ? input.providerRemoval : choices.defaultChoice;
                    if (!choices.choices.includes(removal)) return failure('deployment_target_role_unavailable');
                    if (removal === 'unlink') {
                        if (input.removeEnvironment) return failure('unsupported_action');
                        return { input: DeploymentTeardownDetachInputV1Schema.parse({ serverId: input.serverId,
                            environmentId: input.environmentId, expectedRevision: environment.environment.revision,
                            targetLinkId: row.targetLink.id, expectedTargetLinkRevision: row.targetLink.revision,
                            requestKey: input.requestKey ?? randomUUID(), reason: input.reason, detachKeepRunning: true }),
                            preview: deploymentTeardownDetachPreview };
                    }
                    if (!action || !row.content || !target) return failure('deployment_target_role_unavailable');
                    const prior = !('contentArtifactId' in input) && input.requestKey ? await host.findReceipt({
                        environmentId: input.environmentId, targetLinkId: row.targetLink.id, requestKey: input.requestKey }, context) : null;
                    const retained = prior ? DeploymentProviderTeardownContentV1Schema.safeParse(prior.content)
                        : 'contentArtifactId' in input ? DeploymentProviderTeardownContentV1Schema.safeParse(await host.readContent(input, context)) : null;
                    if (prior && (prior.deployment.operation !== 'teardown' || !retained?.success)) return failure('deployment_conflict');
                    if (retained && !retained.success) return failure('deployment_content_unavailable');
                    const content = retained?.success ? retained.data : DeploymentProviderTeardownContentV1Schema.parse({
                        machines: [], images: [], machineResults: [], steps: [], teardown: { reason: input.reason,
                            targetLinkRevision: row.targetLink.revision, machines: [], resources: [], proofs: [] },
                        platform: { ...row.content, targetLinkRevision: row.targetLink.revision,
                            observation: { v: 1, state: 'queued', observedAtMs: Date.now() } } });
                    const custody = { serverId: input.serverId, environmentId: input.environmentId,
                        expectedRevision: 'expectedRevision' in input ? input.expectedRevision : environment.environment.revision,
                        targetLinkId: row.targetLink.id, expectedTargetLinkRevision: content.platform.targetLinkRevision };
                    const child = projectInput(custody, content.platform);
                    const admittedTarget = declaration?.admittedTarget;
                    const executionTarget = admittedTarget?.declaration.execution.target;
                    if (!admittedTarget || executionTarget !== 'account' && executionTarget !== 'daemon') return failure('deployment_target_role_unavailable');
                    const admission = await createDeploymentTargetRoleAdmissionHost(context, {
                        resolveRequesterIdentity: host.resolveRequesterIdentity, readCurrentMachineId: () => host.machineId,
                        accountExecution: { credentials: host.credentials, serverUrl: host.serverHttpBaseUrl,
                            serverIdentityId: host.serverId, machineId: host.machineId,
                            isCurrent: async () => { await host.assertCurrent(context); return true; } } });
                    if (!admission) return failure('deployment_access_denied');
                    await admitDeploymentTargetRoleForHost({ ...action, role: 'projects.delete', phase: 'preparation',
                        bindings: admittedTarget.deploymentTargetRoles ?? [], executionTarget, input: child, context,
                        purposeAuthorization: resolveRegistryConnectedAccountActionCredentialPurposeAuthorization({ registry: lease.registry.contributes,
                            qualifiedActionId: buildQualifiedPluginContributionKey(action), fieldPath: 'credentialRef', requireSelect: false }) },
                    { ...admission, readEnvironment: async () => environment });
                    const reviewed = preview && request.invokePreview ? await request.invokePreview({
                        action: preview, input: child,
                    }).catch(() => null) : null;
                    context.signal?.throwIfAborted();
                    const volumePreview = reviewed?.ok ? DeploymentTargetTeardownVolumePreviewV1Schema.safeParse(reviewed.result) : null;
                    const providerScope = volumePreview?.success ? volumePreview.data.providerScope : undefined;
                    const volumeRemoval = volumePreview?.success ? volumePreview.data.volumeRemoval : preview ? { kind: 'unchecked' } : undefined;
                    const prepared = 'contentArtifactId' in input ? DeploymentTeardownInputV1Schema.parse(input)
                        : DeploymentTeardownInputV1Schema.parse({ ...custody, reason: input.reason,
                            requestKey: input.requestKey ?? randomUUID(), ...(input.removeEnvironment ? { removeEnvironment: true } : {}),
                            ...(prior ? { contentArtifactId: prior.deployment.contentArtifactId,
                                contentHeaderVersion: prior.deployment.contentHeaderVersion, contentBodyVersion: prior.deployment.contentBodyVersion }
                                : await host.createCandidate(environment, content, context)) });
                    const platform = readDeploymentTargetDisplayNameV1(target);
                    return { input: prepared, preview: normalizeStrictJsonValue({
                        summary: 'Delete this linked resource at its provider.',
                        removal: { subject: { kind: 'platformResource', name: readPlatformResourceName(content.platform) ?? platform, platform },
                            environment: environment.content.name, removeEnvironment: input.removeEnvironment === true,
                            ...(providerScope ? { providerScope } : {}), ...(volumeRemoval ? { volumeRemoval } : {}) },
                    }),
                        hostReviewedChildren: { children: [{ action, role: 'projects.delete', input: child },
                            ...(observeAction ? [{ action: observeAction, role: 'projects.observe' as const, input: child }] : [])] } };
                } finally { await lease.release(); }
            } catch (error) { return projectDeploymentException(error, { signal: context.signal }); }
        },
        async executeProject(request: DeploymentReceiptDispatchV1, receipt: DeploymentReceiptDetailV1, link: Link) {
            const parsed = DeploymentProviderTeardownContentV1Schema.safeParse(receipt.content);
            if (!parsed.success || request.actionId !== 'deployments.teardown' || link.role !== 'data') return failure('target_mismatch');
            const accepted = receipt.deployment.acceptedExecution;
            if (receipt.deployment.operation !== 'teardown' || receipt.deployment.targetLinkId !== request.input.targetLinkId
                || receipt.deployment.requestKey !== request.input.requestKey || accepted?.controller.machineId !== host.machineId) return failure('target_mismatch');
            if (receipt.deployment.state !== 'queued' && receipt.deployment.state !== 'running'
                && receipt.deployment.state !== 'outcome_unknown') return { ok: true as const,
                environmentId: receipt.deployment.environmentId, revision: request.receipt.revision, deploymentId: receipt.deployment.id,
                deploymentRevision: receipt.deployment.revision, state: receipt.deployment.state };
            const installation = readInstallationIdentityIfExistsSync();
            if (!installation || accepted.controller.installationId !== installation.installationId) return failure('machine_unavailable');
            if (receipt.deployment.actionOperationId !== request.context.operationAcceptance?.operationId) return failure('operation_unavailable');
            if (request.context.signal?.aborted || receipt.deployment.cancelRequestedAtMs !== undefined) return failure('cancelled');
            const port = request.context.hostReviewedChild;
            if (!port) return failure('unsupported_action');
            const content = parsed.data;
            const deleting = receipt.deployment.state === 'queued';
            let response: ActionExecuteResult;
            try {
                const { lease, action, observeAction } = await leaseDeclaration(link);
                try {
                    const selected = deleting ? action : observeAction;
                    if (!selected) return failure('deployment_target_role_unavailable');
                    response = await port.invoke({ action: selected,
                        role: deleting ? 'projects.delete' : 'projects.observe',
                        input: projectInput(request.input, content.platform),
                        invocationServices: { deploymentAcceptedReceipt: acceptedReceiptOperand(receipt) } });
                } finally { await lease.release(); }
            } catch (error) { response = { ...projectDeploymentException(error, { signal: request.context.signal }), effectAttempted: true }; }
            const observation = response.ok ? DeploymentTargetDataRemovalResultV1Schema.safeParse(response.result) : null;
            const childFailure: ActionExecuteFailure | null = response.ok
                ? observation?.success ? readProviderTeardownAbsenceFailure(observation.data)
                    : { ...failure('outcome_unknown'), effectAttempted: true }
                : response;
            const state = childFailure ? isActionOutcomeUnknownErrorCodeV1(childFailure.errorCode) || childFailure.effectAttempted === true
                ? 'outcome_unknown' as const : 'failed' as const : observation?.success ? observation.data.state : 'outcome_unknown' as const;
            const { failure: previousFailure, ...withoutFailure } = content;
            const details = childFailure?.details;
            const authored = details && typeof details === 'object' && 'details' in details ? details.details : undefined;
            const failedVolumeRemoval = authored && typeof authored === 'object' && 'volumeRemoval' in authored
                ? DeploymentVolumeRemovalOutcomeV1Schema.safeParse(authored.volumeRemoval).data : undefined;
            const observed = observation?.success ? observation.data : undefined;
            const volumeRemoval = observed?.volumeRemoval ?? failedVolumeRemoval ?? content.platform.observation.volumeRemoval;
            // Service observation can settle without any new evidence about the volume.
            const retainedDeleteFailure = previousFailure?.phase === 'teardown' && volumeRemoval?.kind === 'kept-unchecked'
                && observed && observed.volumeRemoval === undefined ? previousFailure : undefined;
            const nextContent: DeploymentProviderTeardownContentV1 = { ...withoutFailure,
                ...(observed || failedVolumeRemoval ? { platform: { ...content.platform, observation: {
                    ...(observed ?? content.platform.observation), ...(volumeRemoval ? { volumeRemoval } : {}),
                } } } : {}),
                ...(childFailure ? { failure: { ...projectDeploymentReceiptFailure(childFailure, 'teardown'),
                    ...(!deleting ? { phase: 'observe' as const } : {}) } }
                    : retainedDeleteFailure ? { failure: retainedDeleteFailure } : {}) };
            try {
                const written = await host.writeTransition({ environmentId: request.input.environmentId, deploymentId: receipt.deployment.id,
                    receiptHeader: receipt.deployment, expectedRevision: receipt.deployment.revision, state, content: nextContent, context: request.context,
                    ...(state === 'succeeded' ? { teardownProof: { targetLinkRevision: request.input.expectedTargetLinkRevision,
                        machines: [accepted.controller], workloadAbsent: true, retainedProviderResource: false, steps: [...DEPLOYMENT_TEARDOWN_STEPS_V1] } } : {}) });
                return childFailure ?? (written.ok ? written : { ...written, errorCode: 'outcome_unknown', effectAttempted: true });
            } catch (error) {
                return childFailure ?? { ...projectDeploymentException(error, { signal: request.context.signal }), errorCode: 'outcome_unknown', effectAttempted: true };
            }
        },
    };
}
