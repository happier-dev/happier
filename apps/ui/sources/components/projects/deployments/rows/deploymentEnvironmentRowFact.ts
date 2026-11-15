import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployment-protocol/v1';

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
 * The Machine an Environment's tree row opens onto (what runs there): one with a deploy runs on its controller Machine;
 * one never deployed runs nothing yet, so it has nothing to disclose.
 */
export function deploymentEnvironmentRunsOnMachine(
  item: EnvironmentItem | undefined,
): string | null {
  return item?.currentDeployment ? item.environment.controllerMachineId : null;
}
