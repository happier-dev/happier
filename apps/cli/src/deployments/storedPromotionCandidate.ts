import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { resolveDeploymentStoredDefinitionRevisionV1, DeploymentOwnServerContentV1Schema, type DeploymentContentV1,
    type DeploymentEnvironmentDetailV1, type DeploymentReceiptDetailV1 } from '@happier-dev/deployment-protocol';
import type { ActionExecutorContext, DeploymentPromoteActionInputV1 } from '@happier-dev/protocol';
import type { OwnServerDeploymentTargetHostInput } from './targets/ownServer/ownServerDeploymentTarget';
import { requireOwnServerDeploymentBuildMachine } from './targets/ownServer/ownServerTargetAdmission';

/** Controller preparation and installed child review reopen the same pinned
 * source receipt and current destination before deriving replacement content. */
export async function readPromotionSelectionForHost(request: Readonly<{
    input: DeploymentPromoteActionInputV1; context: ActionExecutorContext;
}>, readers: Pick<OwnServerDeploymentTargetHostInput, 'readEnvironment' | 'readEnvironmentMetadata'> & Readonly<{
    readReceipt(request: Parameters<OwnServerDeploymentTargetHostInput['readReceipt']>[0]): Promise<DeploymentReceiptDetailV1>;
}>) {
    const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };
    const { input, context } = request;
    if (input.artifact !== 'image') return refuse('unsupported');
    if (!readers.readEnvironmentMetadata) return refuse('deployment_executor_unavailable');
    const [sourceEnvironment, sourceReceipt, destination] = await Promise.all([
        readers.readEnvironmentMetadata({ environmentId: input.sourceEnvironmentId, context }),
        readers.readReceipt({ environmentId: input.sourceEnvironmentId, deploymentId: input.sourceDeploymentId, context }),
        readers.readEnvironment({ environmentId: input.environmentId, context }),
    ]);
    if (!sourceEnvironment.capabilities.deploy
        || !destination.environment.capabilities.manage || !destination.environment.capabilities.deploy) return refuse('deployment_access_denied');
    const prepared = 'contentArtifactId' in input ? input : undefined;
    const targetLinkId = prepared?.targetLinkId ?? destination.environment.runtimeTargetLinkId;
    if (sourceEnvironment.id !== input.sourceEnvironmentId
        || sourceReceipt.deployment.environmentId !== input.sourceEnvironmentId || sourceReceipt.deployment.id !== input.sourceDeploymentId
        || destination.environment.id !== input.environmentId
        || prepared && destination.environment.revision !== prepared.expectedRevision) return refuse('deployment_conflict');
    const target = destination.targetLinks.find(item => item.targetLink.id === targetLinkId);
    const link = target?.targetLink;
    if (!target || !link || link.id !== destination.environment.runtimeTargetLinkId
        || prepared && link.revision !== prepared.expectedTargetLinkRevision) return refuse('deployment_conflict');
    return { sourceReceipt, destination, link, target };
}

export async function readStoredPromotionCandidateForHost(request: Parameters<typeof readPromotionSelectionForHost>[0],
    readers: Parameters<typeof readPromotionSelectionForHost>[1]) {
    return prepareStoredPromotionForHost(await readPromotionSelectionForHost(request, readers));
}

/** Only the native target needs stored Compose and a builder. */
export function prepareStoredPromotionForHost(selection: Awaited<ReturnType<typeof readPromotionSelectionForHost>>) {
    const { destination, link } = selection;
    const sourceReceipt = { ...selection.sourceReceipt, content: DeploymentOwnServerContentV1Schema.parse(selection.sourceReceipt.content) };
    const buildMachineId = requireOwnServerDeploymentBuildMachine(destination.environment.buildMachineId);
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
    const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };
    if (source.deployment.state !== 'succeeded' && source.deployment.state !== 'running_unverified') refuse('deployment_conflict');
    const captured = source.content.sourceIntent;
    const incumbent = destination.content.definition;
    if (captured?.kind !== 'stored' || incumbent.kind !== 'stored') return refuse('deployment_invalid');
    const contentRevision = resolveDeploymentStoredDefinitionRevisionV1(incumbent, captured);
    if (contentRevision === null) return refuse('deployment_conflict');
    return { ...destination.content, definition: { ...captured, contentRevision } };
}
