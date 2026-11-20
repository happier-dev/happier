import type { DeployShapeV1 } from './deployShapeV1.js';
import type { DeploymentTargetRecommendationV1 } from './deploymentTargetRecommendationV1.js';
import type { DeploymentTargetContributionV1 } from '../plugins/contributions/deploymentTargets.js';

type Target = NonNullable<DeploymentTargetRecommendationV1['target']>;
export type PublishTargetRecommendationInput = Readonly<{
    deploy?: DeployShapeV1;
    definition: Readonly<{ kind: 'repository'; compose?: unknown }> | Readonly<{ kind: 'stored' }> | Readonly<{ from: unknown }> | null;
    targets: readonly (Target & Readonly<{ availability: 'available' | 'needs_connection' | 'unavailable' | 'unknown';
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
    const compatible = input.targets.filter(target => {
        if (!sourceCompatible(target)) return false;
        if (!target.accepts || !outputs) return target.targetClass === 'ownServer';
        if (stored && target.needs?.includes('repository')) return false;
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
        offeredTargetIds: input.targets.filter(target => sourceCompatible(target) && (compatible.includes(target)
            || (!target.accepts || !outputs) && !stored)).map(target => target.id),
        evidence, uncertainty, corrections,
    };
}
