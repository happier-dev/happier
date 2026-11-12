import type { DeploymentEnvironmentDefinitionV1 } from '@happier-dev/deployment-protocol';
import type { DeploymentStoredDefinitionInputV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';
import type { DeploymentTargetRecommendationV1 } from '@happier-dev/protocol/deployments/deploymentTargetRecommendationV1';

type Target = NonNullable<DeploymentTargetRecommendationV1['target']>;
export type PublishTargetRecommendationInput = Readonly<{
    definition: Pick<Extract<DeploymentEnvironmentDefinitionV1, { kind: 'repository' }>, 'kind' | 'compose'>
        | Pick<Extract<DeploymentEnvironmentDefinitionV1, { kind: 'stored' }>, 'kind'>
        | Pick<DeploymentStoredDefinitionInputV1, 'from'> | null;
    targets: readonly (Target & Readonly<{ availability: 'available' | 'unavailable' | 'unknown' }>)[];
    explicitTarget?: Target | null;
    existingTarget?: Target | null;
}>;

/** No detection, probes, credential reads or effects. Owners supply admitted definition and availability facts. */
export function resolvePublishTargetRecommendation(input: PublishTargetRecommendationInput): DeploymentTargetRecommendationV1 {
    const stored = input.definition !== null && ('from' in input.definition || input.definition.kind === 'stored');
    const compose = input.definition !== null && 'compose' in input.definition && input.definition.compose !== undefined;
    const evidence: DeploymentTargetRecommendationV1['evidence'] = [];
    const uncertainty: DeploymentTargetRecommendationV1['uncertainty'] = [];
    const corrections: DeploymentTargetRecommendationV1['corrections'] = [];
    const preferred = input.explicitTarget ?? input.existingTarget;
    if (input.explicitTarget) evidence.push('explicit_target');
    else if (input.existingTarget) evidence.push('existing_target');
    if (stored) evidence.push('stored_definition');
    else {
        uncertainty.push('project_shape_unknown');
        if (compose) evidence.push('repository_compose');
    }
    // The current runtime declaration has deploy/upload methods, but no accepted-definition capability.
    // A method cannot establish Compose, static-output or Next-mode compatibility.
    if (input.targets.some(target => target.targetClass === 'platform') || preferred?.targetClass === 'platform') {
        uncertainty.push('platform_source_capability_unknown');
    }
    const servers = input.targets.filter(target => target.targetClass === 'ownServer');
    if (servers.some(target => target.availability === 'unknown')) uncertainty.push('machine_availability_unknown');
    for (const target of servers) {
        if (target.availability === 'unavailable') corrections.push({ targetId: target.id, kind: 'choose_machine' });
        if (!stored && !compose) corrections.push({ targetId: target.id, kind: 'prepare_repository' });
    }
    for (const target of input.targets) {
        if (target.targetClass === 'platform' && target.availability === 'unavailable') corrections.push({ targetId: target.id, kind: 'repair_target' });
    }
    if (preferred?.targetClass === 'platform' && !input.targets.some(target => target.id === preferred.id)) {
        corrections.push({ targetId: preferred.id, kind: 'repair_target' });
    }
    if (preferred?.targetClass === 'ownServer' && !input.targets.some(target => target.id === preferred.id)) {
        corrections.push({ targetId: preferred.id, kind: 'choose_machine' });
    }
    const recommended = stored ? servers.find(target => target.availability === 'available') : undefined;
    return {
        target: preferred ?? (recommended ? { id: recommended.id, targetClass: recommended.targetClass } : null),
        compatibleTargetIds: servers.map(target => target.id),
        offeredTargetIds: input.targets.filter(target => target.targetClass === 'ownServer' || !stored).map(target => target.id),
        evidence, uncertainty, corrections,
    };
}
