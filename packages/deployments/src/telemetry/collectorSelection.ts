import type { DeploymentEnvironmentDetailV1, DeploymentTargetLinkHeaderV1 } from '@happier-dev/deployment-protocol/v1';
import type { DeploymentEnvironmentTelemetrySetInputV1 } from '@happier-dev/protocol/deployments/deploymentTelemetryV1';
import { selectDeploymentRuntimeTargetLinkV1 } from '../projection/deploymentSelectors.js';
import { OWN_SERVER_DEPLOYMENT_TARGET_V1 } from '../targets/deploymentTargetCatalog.js';

export type TelemetryCollectorSelectionInputV1 = Readonly<{
    environment: Pick<DeploymentEnvironmentDetailV1['environment'], 'owner' | 'telemetryMachineId' | 'runtimeTargetLinkId'>;
    targetLinks: readonly Readonly<{ targetLink: DeploymentTargetLinkHeaderV1 }>[];
    projectDefaultMachineId?: string;
}> & Pick<DeploymentEnvironmentTelemetrySetInputV1, 'collector' | 'rotate'>;

export type TelemetryCollectorSelectionV1 =
    | Readonly<{ kind: 'selected'; machineId: string | null }>
    | Readonly<{ kind: 'collector_required'; recovery: 'choose_collector' }>
    | Readonly<{ kind: 'collector_required'; recovery: 'deploy_collector'; teamId: string; requireExplicitDestination: true }>;

/** Setup preselection, shared by the host Action and its presenters. Admission remains with the bindings writer. */
export function resolveTelemetryCollectorSelectionV1(input: TelemetryCollectorSelectionInputV1): TelemetryCollectorSelectionV1 {
    if (input.collector !== undefined) return { kind: 'selected', machineId: input.collector?.machineId ?? null };
    const previousMachineId = input.environment.telemetryMachineId ?? null;
    if (previousMachineId !== null && (input.rotate || input.environment.owner.kind === 'team')) {
        return { kind: 'selected', machineId: previousMachineId };
    }
    if (input.environment.owner.kind === 'team') {
        // Machine grants establish sharing, not always-on placement. D29's D25
        // recovery keeps the Team context and requires a deliberate destination.
        return { kind: 'collector_required', recovery: 'deploy_collector', teamId: input.environment.owner.teamId,
            requireExplicitDestination: true };
    }
    const runtime = selectDeploymentRuntimeTargetLinkV1(input);
    const machineId = input.projectDefaultMachineId
        ?? (runtime?.source.kind === 'host' && runtime.targetKind === OWN_SERVER_DEPLOYMENT_TARGET_V1.targetKind
            ? runtime.machines[0] : undefined);
    return machineId === undefined ? { kind: 'collector_required', recovery: 'choose_collector' }
        : { kind: 'selected', machineId };
}
