import type { DeploymentBackupConfigurationV1, DeploymentEnvironmentDetailV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/v1';
import { parseDeploymentComposeSourceV1 } from '@happier-dev/protocol/deployments/storedAppInputV1';

/** Move extracts into a dedicated PostgreSQL service on the supported native data target. */
export async function isDeploymentDatabaseMoveCandidateV1(
    content: Pick<DeploymentEnvironmentDetailV1['content'], 'definition' | 'template'>,
    runtimeTargetLink: DeploymentTargetLinkHeaderV1 | null,
): Promise<boolean> {
    if (!selectDeploymentSingleDataMachineV1(runtimeTargetLink)) return false;
    const data = content.template?.data;
    const definition = content.definition;
    if (definition.kind !== 'stored' || data?.length !== 1 || data[0]?.engine !== 'postgres') return false;
    let source: Record<string, unknown>;
    try { source = await parseDeploymentComposeSourceV1(definition.document); }
    catch { return false; }
    const services = source.services;
    if (!services || typeof services !== 'object' || Array.isArray(services)) return false;
    const selected = definition.services.length ? definition.services : Object.keys(services);
    if (selected.length !== 1 || selected[0] !== data[0].service) return false;
    const service = (services as Record<string, unknown>)[selected[0]];
    if (!service || typeof service !== 'object' || Array.isArray(service)) return false;
    // Compose also starts dependencies of an explicitly selected service.
    const dependencies = (service as Record<string, unknown>).depends_on;
    return dependencies === undefined || Array.isArray(dependencies) && dependencies.length === 0
        || dependencies !== null && typeof dependencies === 'object' && Object.keys(dependencies).length === 0;
}

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
