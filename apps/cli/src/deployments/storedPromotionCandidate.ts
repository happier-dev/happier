import { resolveDeploymentStoredDefinitionRevisionV1, DeploymentOwnServerContentV1Schema, type DeploymentContentV1,
    type DeploymentEnvironmentDetailV1, type DeploymentReceiptDetailV1, type DeploymentReceiptHeaderV1 } from '@happier-dev/deployment-protocol';
import type { ActionExecutorContext, DeploymentPromoteActionInputV1 } from '@happier-dev/protocol';
import type { OwnServerDeploymentTargetHostInput } from './targets/ownServer/ownServerDeploymentTarget';

/** Controller preparation and installed child review reopen the same pinned
 * source receipt and current destination before deriving replacement content. */
export async function readStoredPromotionCandidateForHost(request: Readonly<{
    input: DeploymentPromoteActionInputV1; context: ActionExecutorContext; admittedDeployment?: DeploymentReceiptHeaderV1;
}>, readers: Pick<OwnServerDeploymentTargetHostInput, 'readEnvironment' | 'readReceipt' | 'readEnvironmentMetadata'>) {
    const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
    const { input, context } = request;
    if (input.artifact !== 'image') return refuse('unsupported');
    if (!readers.readEnvironmentMetadata) return refuse('deployment_executor_unavailable');
    const [sourceEnvironment, sourceReceipt, destination] = await Promise.all([
        readers.readEnvironmentMetadata({ environmentId: input.sourceEnvironmentId, context }),
        readers.readReceipt({ environmentId: input.sourceEnvironmentId, deploymentId: input.sourceDeploymentId, context }),
        readers.readEnvironment({ environmentId: input.environmentId, context }),
    ]);
    if (!request.admittedDeployment && (!sourceEnvironment.capabilities.deploy
        || !destination.environment.capabilities.manage || !destination.environment.capabilities.deploy)) return refuse('deployment_access_denied');
    const prepared = 'contentArtifactId' in input ? input : undefined;
    const targetLinkId = prepared?.targetLinkId ?? destination.environment.runtimeTargetLinkId;
    const accepted = request.admittedDeployment?.acceptedExecution;
    if (request.admittedDeployment && (!accepted?.builder || request.admittedDeployment.operation !== 'promote'
        || request.admittedDeployment.environmentId !== input.environmentId
        || request.admittedDeployment.targetLinkId !== targetLinkId)) return refuse('deployment_conflict');
    if (sourceEnvironment.id !== input.sourceEnvironmentId
        || sourceReceipt.deployment.environmentId !== input.sourceEnvironmentId || sourceReceipt.deployment.id !== input.sourceDeploymentId
        || destination.environment.id !== input.environmentId
        || !request.admittedDeployment && prepared && destination.environment.revision !== prepared.expectedRevision) return refuse('deployment_conflict');
    const link = destination.targetLinks.find(item => item.targetLink.id === targetLinkId)?.targetLink;
    const buildMachineId = request.admittedDeployment ? accepted?.builder?.machineId : destination.environment.buildMachineId;
    if (!link || link.id !== destination.environment.runtimeTargetLinkId || prepared && link.revision !== prepared.expectedTargetLinkRevision
        || !buildMachineId) return refuse('deployment_conflict');
    const candidateEnvironmentContent = prepareStoredPromotionCandidate(sourceReceipt, destination);
    return { sourceReceipt, destination, link, candidateEnvironmentContent, buildMachineId };
}

/** Initial preparation and prepared replay derive the same receipt content. */
export function createStoredPromotionReceiptContentForHost(
    promotion: Awaited<ReturnType<typeof readStoredPromotionCandidateForHost>>,
    onFailure: NonNullable<DeploymentContentV1['onFailure']>,
) {
    return DeploymentOwnServerContentV1Schema.parse({ sourceIntent: promotion.candidateEnvironmentContent.definition,
        machines: promotion.link.machines, buildMachineId: promotion.buildMachineId,
        ...(promotion.destination.environment.ingress ? { ingress: promotion.destination.environment.ingress } : {}),
        onFailure,
        images: promotion.sourceReceipt.content.images, machineResults: [], steps: [] });
}

/** A promotion replaces only the destination definition, using captured receipt bytes. */
export function prepareStoredPromotionCandidate(source: DeploymentReceiptDetailV1, destination: DeploymentEnvironmentDetailV1) {
    const refuse = (code: string): never => { throw Object.assign(new Error(code), { code }); };
    if (source.deployment.state !== 'succeeded' && source.deployment.state !== 'running_unverified') refuse('deployment_conflict');
    const captured = source.content.sourceIntent;
    const incumbent = destination.content.definition;
    if (captured?.kind !== 'stored' || incumbent.kind !== 'stored') return refuse('deployment_invalid');
    const contentRevision = resolveDeploymentStoredDefinitionRevisionV1(incumbent, captured);
    if (contentRevision === null) return refuse('deployment_conflict');
    return { ...destination.content, definition: { ...captured, contentRevision } };
}
