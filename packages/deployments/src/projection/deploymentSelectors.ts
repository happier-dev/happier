import type { DeploymentEnvironmentDetailV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/v1';

/** Retained custody is not serving authority; only the Environment pointer selects runtime. */
export function selectDeploymentRuntimeTargetLinkV1(
    detail: Pick<DeploymentEnvironmentDetailV1, 'environment' | 'targetLinks'>,
): DeploymentTargetLinkHeaderV1 | null {
    return detail.targetLinks.find(({ targetLink }) => targetLink.id === detail.environment.runtimeTargetLinkId
        && targetLink.detachedAtMs === undefined && targetLink.deletedAtMs === undefined)?.targetLink ?? null;
}
