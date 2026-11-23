import { createActionExecuteFailureError } from '@happier-dev/protocol/actions/actionExecutionResult';
import { DEPLOYMENT_PROMOTE_ACTION_ID_V1 } from '@happier-dev/protocol/deployments/deploymentActionIdsV1';
import { isNativeDeploymentPromotionSourceV1, isDeploymentProductionPromotionPairV1, resolveDeploymentStoredDefinitionRevisionV1, DeploymentOwnServerContentV1Schema, type DeploymentContentV1, type DeploymentEnvironmentDetailV1, type DeploymentReceiptDetailV1 } from '@happier-dev/deployments/contracts/v1';
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
    if (!sourceEnvironment.capabilities.deploy || !destination.environment.capabilities.deploy) return refuse('deployment_access_denied');
    const production = destination.environment.protection === 'production';
    if (production && !isDeploymentProductionPromotionPairV1(sourceEnvironment, destination.environment)) return refuse('target_mismatch');
    if (!production && !destination.environment.capabilities.manage) return refuse('deployment_access_denied');
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
    return { sourceEnvironment, sourceReceipt, destination, link, target };
}

export async function readStoredPromotionCandidateForHost(request: Parameters<typeof readPromotionSelectionForHost>[0],
    readers: Parameters<typeof readPromotionSelectionForHost>[1]) {
    return prepareStoredPromotionForHost(await readPromotionSelectionForHost(request, readers));
}

/** Production handoff uses the selected Receipt and retains the destination definition. */
export function usesCapturedPromotionSource(actionId: string, destinationProtection: string): boolean {
    return actionId === DEPLOYMENT_PROMOTE_ACTION_ID_V1 && destinationProtection === 'production';
}

/** Native image promotion derives its snapshot from the selected Receipt. */
export function prepareStoredPromotionForHost(selection: Awaited<ReturnType<typeof readPromotionSelectionForHost>>) {
    const { sourceEnvironment, destination, link } = selection;
    const sourceReceipt = { ...selection.sourceReceipt, content: DeploymentOwnServerContentV1Schema.parse(selection.sourceReceipt.content) };
    const intent = sourceReceipt.content.sourceIntent;
    if ((intent.kind !== 'stored' && destination.environment.protection !== 'production')
        || (intent.kind === 'repository' && intent.projectSourceId !== sourceEnvironment.projectSourceId)) {
        throw createActionExecuteFailureError({ ok: false, errorCode: 'target_mismatch', error: 'target_mismatch' });
    }
    const buildMachineId = requireOwnServerDeploymentBuildMachine(destination.environment.buildMachineId);
    const candidateEnvironmentContent = prepareStoredPromotionCandidate(sourceReceipt, destination);
    return { sourceReceipt, destination, link, candidateEnvironmentContent, buildMachineId };
}

/** Initial preparation and prepared replay derive the same receipt content. */
export function createStoredPromotionReceiptContentForHost(
    promotion: Awaited<ReturnType<typeof readStoredPromotionCandidateForHost>>,
    onFailure: NonNullable<DeploymentContentV1['onFailure']>,
) {
    const selected = promotion.sourceReceipt.content;
    const definition = promotion.candidateEnvironmentContent.definition;
    return DeploymentOwnServerContentV1Schema.parse({
        sourceIntent: promotion.destination.environment.protection === 'production' ? selected.sourceIntent : definition,
        ...(selected.commitSubject === undefined ? {} : { commitSubject: selected.commitSubject }),
        ...(selected.services === undefined ? {} : { services: selected.services }),
        machines: promotion.link.machines, buildMachineId: promotion.buildMachineId,
        ...(promotion.destination.content.ingress ? { ingress: promotion.destination.content.ingress } : {}),
        onFailure,
        images: promotion.sourceReceipt.content.images, machineResults: [], steps: [] });
}

/** Legacy stored promotions may replace the definition. Production handoff retains it. */
export function prepareStoredPromotionCandidate(source: DeploymentReceiptDetailV1, destination: DeploymentEnvironmentDetailV1) {
    const refuse = (code: string): never => { throw createActionExecuteFailureError({ ok: false, errorCode: code, error: code }); };
    if (!isNativeDeploymentPromotionSourceV1({ state: source.deployment.state, hasImages: source.content.images.length > 0 })) {
        return refuse('deployment_conflict');
    }
    const captured = source.content.sourceIntent;
    const incumbent = destination.content.definition;
    if (destination.environment.protection === 'production') return destination.content;
    if (captured?.kind !== 'stored' || incumbent.kind !== 'stored') return refuse('deployment_invalid');
    const contentRevision = resolveDeploymentStoredDefinitionRevisionV1(incumbent, captured);
    if (contentRevision === null) return refuse('deployment_conflict');
    return { ...destination.content, definition: { ...captured, contentRevision } };
}
