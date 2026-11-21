import type { DeployShapeV1 } from './deployShapeV1.js';
import type { DeploymentTargetRecommendationV1 } from './deploymentTargetRecommendationV1.js';
import type { DeploymentTargetContributionV1 } from '../plugins/contributions/deploymentTargets.js';
import type { DeploySuggestionCatalogV1 } from './suggestions/deploySuggestionsV1.js';

type Target = NonNullable<DeploymentTargetRecommendationV1['target']>;
export type PublishTargetRecommendationInput = Readonly<{
    deploy?: DeployShapeV1;
    definition: Readonly<{ kind: 'repository'; compose?: unknown }> | Readonly<{ kind: 'stored' }> | Readonly<{ from: unknown }> | null;
    targets: readonly (Target & Readonly<{ availability: DeploySuggestionCatalogV1['targets'][number]['availability'];
        accepts?: Readonly<DeploymentTargetContributionV1['accepts']>;
        needs?: Readonly<DeploymentTargetContributionV1['needs']>;
        sources?: Readonly<DeploymentTargetContributionV1['sources']>;
    }>)[];
    explicitTarget?: Target | null;
    existingTarget?: Target | null;
    repositoryProviderKind?: string;
    publishProviderKinds?: readonly string[];
    uploadAvailable?: boolean;
}>;

export const DEPLOYMENT_TARGET_REQUIRES_REPOSITORY_DEFINITION = 'deployment_target_requires_repository_definition';

export function readDeploymentDefinitionSourceKindV1(
    definition: PublishTargetRecommendationInput['definition'],
): 'repository' | 'stored' | null {
    if (definition === null) return null;
    return 'from' in definition || definition.kind === 'stored' ? 'stored' : 'repository';
}

function refuseStoredDefinition(sourceKind: ReturnType<typeof readDeploymentDefinitionSourceKindV1>) {
    return sourceKind === 'stored' ? DEPLOYMENT_TARGET_REQUIRES_REPOSITORY_DEFINITION : null;
}

/** The declared source requirement. With no requirement, the caller need not open protected content. */
export function readDeploymentTargetSourceCheckV1(
    target: Pick<PublishTargetRecommendationInput['targets'][number], 'needs'>,
): typeof refuseStoredDefinition | null {
    return target.needs?.includes('repository') ? refuseStoredDefinition : null;
}

/** No detection, probes, credential reads or effects. Owners supply admitted definition and availability facts. */
export function resolvePublishTargetRecommendation(input: PublishTargetRecommendationInput): DeploymentTargetRecommendationV1 {
    const sourceKind = readDeploymentDefinitionSourceKindV1(input.definition);
    const stored = sourceKind === 'stored';
    const compose = input.definition !== null && 'compose' in input.definition && input.definition.compose !== undefined;
    const evidence: DeploymentTargetRecommendationV1['evidence'] = [];
    const uncertainty: DeploymentTargetRecommendationV1['uncertainty'] = [];
    const corrections: DeploymentTargetRecommendationV1['corrections'] = [];
    const preferred = input.explicitTarget ?? input.existingTarget;
    if (input.explicitTarget) evidence.push('explicit_target');
    else if (input.existingTarget) evidence.push('existing_target');
    if (stored) evidence.push('stored_definition');
    else if (!input.deploy) {
        uncertainty.push('project_shape_unknown');
        if (compose) evidence.push('repository_compose');
    }
    const outputs: readonly DeployShapeV1['output'][] | null = input.deploy ? [input.deploy.output]
        : stored ? ['compose', 'container'] : compose ? ['compose'] : null;
    const sourceCompatible = (target: PublishTargetRecommendationInput['targets'][number]) => {
        if (input.publishProviderKinds === undefined && input.repositoryProviderKind === undefined) return true;
        return Boolean(input.publishProviderKinds?.some(providerKind =>
            (!input.repositoryProviderKind || providerKind === input.repositoryProviderKind)
            && (target.sources?.gitIntegration.includes(providerKind)
                || target.sources?.upload && input.uploadAvailable)));
    };
    const sourceCandidates = input.targets.filter(target => {
        if (readDeploymentTargetSourceCheckV1(target)?.(sourceKind)) {
            corrections.push({ targetId: target.id, kind: 'prepare_repository' });
            return false;
        }
        return sourceCompatible(target);
    });
    const compatible = sourceCandidates.filter(target => {
        if (!target.accepts || !outputs) return target.targetClass === 'ownServer';
        return outputs.some(output => target.accepts!.includes(output)
            && (!target.needs?.includes('stateless') || output === 'static' || output === 'server' || output === 'workers')
            && (!target.needs?.includes('volumes') || output === 'container' || output === 'compose'));
    });
    if (input.targets.some(target => target.targetClass === 'platform' && (!target.accepts || !outputs))
        || preferred?.targetClass === 'platform' && !input.targets.some(target => target.id === preferred.id)) {
        uncertainty.push('platform_source_capability_unknown');
    }
    const servers = input.targets.filter(target => target.targetClass === 'ownServer');
    if (servers.some(target => target.availability === 'unknown')) uncertainty.push('machine_availability_unknown');
    for (const target of servers) {
        if (target.availability === 'unavailable') corrections.push({ targetId: target.id, kind: 'choose_machine' });
        if (!stored && !compose && !input.deploy) corrections.push({ targetId: target.id, kind: 'prepare_repository' });
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
    const recommended = stored || input.deploy ? compatible.find(target => target.availability === 'available') : undefined;
    return {
        target: preferred ?? (recommended ? { id: recommended.id, targetClass: recommended.targetClass } : null),
        compatibleTargetIds: compatible.map(target => target.id),
        offeredTargetIds: sourceCandidates.filter(target => compatible.includes(target)
            || (!target.accepts || !outputs) && !stored).map(target => target.id),
        evidence, uncertainty, corrections,
    };
}
