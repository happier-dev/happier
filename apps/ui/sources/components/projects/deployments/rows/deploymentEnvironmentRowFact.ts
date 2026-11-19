import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployments/contracts/v1';
import { selectDeploymentSingleDataMachineV1 } from '@happier-dev/deployments';

import { isSameDeploymentName } from '../DeploymentEnvironmentCollection';

type EnvironmentItem = DeploymentEnvironmentCollectionV1['items'][number];

/**
 * An Environment row's one quiet fact (lab rdProj / sideSvc), shown when it has no state to say: its live version when
 * that says more than its name, otherwise how long ago it changed. A state (failed, unverified, deploying) is the row's
 * state mark instead (`DeploymentEnvironmentRowEnd`), never this text.
 */
export function deploymentEnvironmentRowFact(
  part: Readonly<{ title: string; detail: string }>,
  item: EnvironmentItem | undefined,
): string | null {
  const version = item?.liveVersionTitle;
  return version && !isSameDeploymentName(version, part.title)
    ? version
    : part.detail || null;
}

/**
 * A deployed Environment opens onto its one native runtime member. Platform and unplaced targets have no Machine
 * services to disclose; an Environment never deployed runs nothing yet.
 */
export function deploymentEnvironmentRunsOnMachine(
  item: EnvironmentItem | undefined,
): string | null {
  return item?.currentDeployment ? selectDeploymentSingleDataMachineV1(item.runtimeTargetLink ?? null)?.machineId ?? null : null;
}
