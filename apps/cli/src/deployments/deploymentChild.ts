import { isDeepStrictEqual } from 'node:util';
import { DeploymentChildRpcV1Schema, DeploymentReceiptGetResultV1Schema, DeploymentReceiptResultV1Schema,
    type DeploymentChildRpcV1, type ActionExecutorContext, type ActionExecutorDeps, type DeploymentPromoteInputV1 } from '@happier-dev/protocol';
import { ActionExecuteFailureSchema, type ActionExecuteFailure } from '@happier-dev/protocol/actions/actionExecutionResult';
import { readDeploymentReceiptArtifactV1, readDeploymentEnvironmentArtifactV1,
    DeploymentOwnServerContentV1Schema, type DeploymentContentV1, type DeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol';
import type { AccountArtifact } from '@/api/artifacts/accountArtifactStore';
import { readInstallationIdentityIfExistsSync } from '@/daemon/identity/store';
import { isReviewedDeploymentChild, readReviewedDeploymentDeployInput } from '@/api/externalActionExecutionAuthorization';
import { assertReviewedDeploymentSource } from './reviewedSource';
import type { DaemonDeploymentCandidateRequest, DaemonDeploymentCandidateResult } from './createDaemonDeploymentActionDeps';
import { buildOwnServerDeploymentReceipt } from './targets/ownServer/buildReceipt';
import { readStoredPromotionCandidateForHost } from './storedPromotionCandidate';
import { projectDeploymentTransitionResultForHost } from './deploymentTransitionResult';
import type { OwnServerDeploymentRequest, OwnServerDeploymentTargetHostInput,
    OwnServerDeploymentTargetForHost, OwnServerDeploymentResult, OwnServerDeploymentMemberRequest } from './targets/ownServer/ownServerDeploymentTarget';

const failure = (errorCode: string): ActionExecuteFailure => ({ ok: false, errorCode, error: errorCode });
const errorCode = (error: unknown) => error instanceof Error && 'code' in error && typeof error.code === 'string'
    ? error.code : 'deployment_content_unavailable';

/** Decode the native child transport result at its existing domain boundary. */
export function readDeploymentChildResult(result: unknown): OwnServerDeploymentResult {
    const parsed = DeploymentReceiptResultV1Schema.safeParse(result);
    if (parsed.success) {
        const projected = projectDeploymentTransitionResultForHost(parsed.data);
        if (projected) return projected;
    }
    const actionFailure = ActionExecuteFailureSchema.safeParse(result);
    if (actionFailure.success) return actionFailure.data;
    if (result && typeof result === 'object' && 'errorCode' in result && typeof result.errorCode === 'string') return failure(result.errorCode);
    return failure('invalid_action_transport_output');
}

/** Child jobs consume the existing receipt and native target, never another Action. */
export function createDaemonDeploymentChildExecutor(host: OwnServerDeploymentTargetHostInput, ports: Readonly<{
    target: OwnServerDeploymentTargetForHost;
    open(id: string, context: ActionExecutorContext): Promise<AccountArtifact | null>;
    storage: NonNullable<ActionExecutorDeps['deploymentAction']>;
    domainNative: ReturnType<typeof import('./targets/ownServer/ownServerDomainNative').createOwnServerDomainNative>;
    assertCurrent(context: ActionExecutorContext): Promise<void>;
    prepareCandidate(request: DaemonDeploymentCandidateRequest): Promise<DaemonDeploymentCandidateResult>;
}>) {
    const { target, open, storage, assertCurrent } = ports;
    async function readPromotion(input: DeploymentPromoteInputV1, context: ActionExecutorContext,
        content: DeploymentContentV1, admittedDeployment?: DeploymentReceiptHeaderV1) {
        const opened = readDeploymentEnvironmentArtifactV1(input.destinationContent,
            await open(input.destinationContent.contentArtifactId, context));
        if (!opened.ok) throw Object.assign(new Error(opened.error), { code: opened.error });
        const promotion = await readStoredPromotionCandidateForHost({ input, context, admittedDeployment }, host);
        if (!isDeepStrictEqual(opened.content, promotion.candidateEnvironmentContent)
            || !isDeepStrictEqual(content.sourceIntent, promotion.candidateEnvironmentContent.definition)
            || !isDeepStrictEqual(content.images, promotion.sourceReceipt.content.images)
            || !isDeepStrictEqual(content.machines, promotion.link.machines)
            || content.ownServer && !isDeepStrictEqual(content.ownServer.imageArchives, promotion.sourceReceipt.content.ownServer?.imageArchives)
            || content.buildMachineId !== promotion.buildMachineId
            || !isDeepStrictEqual(content.ingress, promotion.destination.environment.ingress)
            || admittedDeployment === undefined && (content.steps.length || content.machineResults.length)) {
            throw Object.assign(new Error('target_mismatch'), { code: 'target_mismatch' });
        }
        return opened.content;
    }
    return async function deploymentChild(raw: DeploymentChildRpcV1, context: ActionExecutorContext) {
        try {
            const parsed = DeploymentChildRpcV1Schema.safeParse(raw);
            if (!parsed.success) return failure('invalid_parameters');
            const job = parsed.data;
            if (job.input.serverId !== host.serverId || job.machineId !== host.machineId) return failure('target_mismatch');
            await assertCurrent(context);
            if (job.kind === 'domain' || job.kind === 'domainDiscover') return await ports.domainNative(job, context);
            const authorization = context.externalActionExecutionAuthorization;
            const templateRoot = authorization?.binding.actionId === 'deployments.templates.instantiate';
            if (templateRoot && !await isReviewedDeploymentChild({ authorization,
                envelope: context.originalActionEnvelope, actionId: job.actionId, machineId: job.machineId, params: job,
                ...(context.signal ? { signal: context.signal } : {}) })) return failure(context.signal?.aborted ? 'cancelled' : 'action_forbidden');
            const root = job.actionId === 'deployments.deploy' && authorization && !templateRoot
                ? await readReviewedDeploymentDeployInput({ authorization, envelope: context.originalActionEnvelope,
                    ...(context.signal ? { signal: context.signal } : {}) }) : undefined;
            if (job.actionId === 'deployments.deploy' && authorization && !templateRoot && !root) return failure(context.signal?.aborted ? 'cancelled' : 'action_forbidden');
            const semanticRoot = root && !('contentArtifactId' in root) ? root : undefined;
            const admitSource = async (content: DeploymentContentV1, issued: boolean,
                suppliedEnvironment?: Awaited<ReturnType<typeof host.readEnvironment>>) => {
                if (!semanticRoot) return;
                assertReviewedDeploymentSource({ intent: semanticRoot, content });
                if (!semanticRoot.sha && (issued || semanticRoot.targetLinkId !== undefined)) return;
                const environment = suppliedEnvironment ?? await host.readEnvironment({ environmentId: job.input.environmentId, context });
                if (!issued && semanticRoot.targetLinkId === undefined
                    && environment.environment.runtimeTargetLinkId !== job.input.targetLinkId) throw Object.assign(new Error('target_mismatch'), { code: 'target_mismatch' });
                const definition = environment.content.definition;
                if (semanticRoot.sha && (definition.kind !== 'repository' || content.sourceIntent?.kind !== 'repository'
                    || content.sourceIntent.projectSourceId !== environment.environment.projectSourceId
                    || !isDeepStrictEqual(content.sourceIntent.compose, definition.compose))) throw Object.assign(new Error('target_mismatch'), { code: 'target_mismatch' });
            };
            if (job.kind === 'prepare') {
                const environment = await host.readEnvironment({ environmentId: job.input.environmentId, context });
                const link = environment.targetLinks.find(item => item.targetLink.id === job.input.targetLinkId)?.targetLink;
                if (environment.environment.revision !== job.expectedRevision || link?.revision !== job.expectedTargetLinkRevision) return failure('deployment_conflict');
                if (environment.environment.buildMachineId !== host.machineId
                    || readInstallationIdentityIfExistsSync()?.installationId !== job.installationId) return failure('target_mismatch');
                if (semanticRoot && semanticRoot.targetLinkId === undefined
                    && environment.environment.runtimeTargetLinkId !== job.input.targetLinkId) return failure('target_mismatch');
                return await ports.prepareCandidate({ ...job.input, context });
            }
            if (job.kind === 'review') {
                if (readInstallationIdentityIfExistsSync()?.installationId !== job.installationId) return failure('target_mismatch');
                const candidate = readDeploymentReceiptArtifactV1(job.input, await open(job.input.contentArtifactId, context));
                if (!candidate.ok) return failure(candidate.error);
                await admitSource(candidate.content, false);
                const candidateEnvironmentContent = job.actionId === 'deployments.promote'
                    ? await readPromotion(job.input, context, candidate.content) : undefined;
                const common = { content: candidate.content, context, ...(candidateEnvironmentContent ? { candidateEnvironmentContent } : {}) };
                const request = job.actionId === 'deployments.deploy' ? { ...common, actionId: job.actionId, input: job.input }
                    : job.actionId === 'deployments.rollback' ? { ...common, actionId: job.actionId, input: job.input }
                        : { ...common, actionId: job.actionId, input: job.input };
                return await target.reviewMember({ request, machineId: job.machineId, installationId: job.installationId });
            }
            const loaded = await storage('deployments.receipts.get', { serverId: host.serverId,
                environmentId: job.input.environmentId, deploymentId: job.deploymentId }, context);
            if ('errorCode' in loaded) return loaded;
            const result = DeploymentReceiptGetResultV1Schema.parse(loaded);
            if (!result.ok) return result;
            const deployment = result.deployment;
            // The reference becomes an operation context only after this exact
            // canonical receipt proves the parent operation, never from the RPC.
            if (deployment.actionOperationId !== job.actionOperationId) return failure('operation_unavailable');
            if (readInstallationIdentityIfExistsSync()?.installationId !== job.installationId) return failure('target_mismatch');
            const environment = await host.readEnvironment({ environmentId: job.input.environmentId, context });
            const admittedContext: ActionExecutorContext = { ...context,
                operationAcceptance: { operationId: deployment.actionOperationId, actionId: job.actionId, accept() {} } };
            const receipt = { ok: true as const, environmentId: deployment.environmentId, revision: environment.environment.revision,
                deploymentId: deployment.id, deploymentRevision: deployment.revision, state: deployment.state };
            const request: OwnServerDeploymentRequest = job.actionId === 'deployments.deploy'
                ? { actionId: job.actionId, input: job.input, context: admittedContext, receipt }
                : job.actionId === 'deployments.rollback' ? { actionId: job.actionId, input: job.input, context: admittedContext, receipt }
                    : { actionId: job.actionId, input: job.input, context: admittedContext, receipt };
            let admitted: OwnServerDeploymentMemberRequest['admitted'];
            if (job.kind === 'build' || job.kind === 'member' || job.actionId === 'deployments.promote'
                || job.actionId === 'deployments.deploy' && semanticRoot) {
                // Stages advance the Artifact versions but never its stable id.
                // Build consumes this same admitted header and opened content.
                const current = readDeploymentReceiptArtifactV1(deployment, await open(deployment.contentArtifactId, context));
                if (!current.ok) return failure(current.error);
                if (job.actionId === 'deployments.deploy') await admitSource(current.content, true, environment);
                if (job.actionId === 'deployments.promote') await readPromotion(job.input, context, current.content, deployment);
                admitted = { environment, receipt: { deployment, content: DeploymentOwnServerContentV1Schema.parse(current.content) } };
                if (job.kind === 'build') return await buildOwnServerDeploymentReceipt(host, request, admitted);
            }
            if (job.kind === 'retention') return await target.retain({ request, machineId: job.machineId, installationId: job.installationId,
                settledTargetLinkRevision: job.settledTargetLinkRevision, settledDeploymentRevision: job.settledDeploymentRevision,
                activeDeploymentId: job.activeDeploymentId });
            return await target.executeMember({ request, admitted, machineId: job.machineId, installationId: job.installationId,
                phase: job.phase, selectedDeploymentId: job.selectedDeploymentId });
        } catch (error) { return failure(context.signal?.aborted ? 'cancelled' : errorCode(error)); }
    }
}
