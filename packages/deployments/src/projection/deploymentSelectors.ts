import type { DeploymentBackupConfigurationV1, DeploymentEnvironmentDetailV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/v1';

/** Retained custody is not serving authority; only the Environment pointer selects runtime. */
export function selectDeploymentRuntimeTargetLinkV1(
    detail: Readonly<{ environment: Pick<DeploymentEnvironmentDetailV1['environment'], 'runtimeTargetLinkId'>;
        targetLinks: readonly Readonly<{ targetLink: DeploymentTargetLinkHeaderV1 }>[] }>,
): DeploymentTargetLinkHeaderV1 | null {
    return detail.targetLinks.find(({ targetLink }) => targetLink.id === detail.environment.runtimeTargetLinkId
        && targetLink.detachedAtMs === undefined && targetLink.deletedAtMs === undefined)?.targetLink ?? null;
}

/** Backups capture the same runtime data target and its one serving deployment. */
export function deploymentBackupTargetOperands(detail: Parameters<typeof deploymentDataTargetOperands>[0],
    configuration: DeploymentBackupConfigurationV1) {
    const target = deploymentDataTargetOperands(detail);
    const deploymentId = detail.runtimeTargetLink?.activeDeploymentId;
    return target && deploymentId ? { ...target, deploymentId, configRevision: configuration.configRevision } : null;
}

/** Native services share runtime membership; data custody needs one unambiguous Machine. */
export function selectDeploymentSingleDataMachineV1(runtimeTargetLink: DeploymentTargetLinkHeaderV1 | null):
    DeploymentTargetLinkHeaderV1['members'][number] | null {
    return runtimeTargetLink?.targetKind === 'ownServer' && runtimeTargetLink.members.length === 1
        ? runtimeTargetLink.members[0]! : null;
}

/** Stateful data operations require one unambiguous runtime data owner. */
export function deploymentDataTargetOperands(detail: Readonly<{
    environment: Pick<DeploymentEnvironmentDetailV1['environment'], 'id' | 'revision'>;
    runtimeTargetLink: DeploymentTargetLinkHeaderV1 | null;
}>) {
    const link = detail.runtimeTargetLink;
    const member = selectDeploymentSingleDataMachineV1(link);
    if (!link || !member) return null;
    return {
        environmentId: detail.environment.id,
        expectedRevision: detail.environment.revision,
        machineId: member.machineId,
        installationId: member.installationId,
        targetLinkId: link.id,
    };
}
