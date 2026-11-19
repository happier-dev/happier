import { describe, expect, it } from 'vitest';
import type { DeploymentEnvironmentCollectionV1 } from '@happier-dev/deployments/contracts/v1';
import {
  createDeploymentEnvironmentHeaderV1,
  createDeploymentReceiptHeaderV1,
} from '@happier-dev/deployment-protocol/testing/v1';
import { compileDeploymentEnvironmentListFilterV1 } from '@happier-dev/protocol/deployments/deploymentEnvironmentListFilterV1';

import { deploymentEnvironmentListFilterFacts } from './useServicesListView';

type EnvironmentItem = DeploymentEnvironmentCollectionV1['items'][number];
type ReceiptState = NonNullable<EnvironmentItem['currentDeployment']>['state'];

function item(
  id: string,
  state: ReceiptState | null,
  machine = 'machine-a',
  project = 'project-a',
): EnvironmentItem {
  return {
    environment: createDeploymentEnvironmentHeaderV1({
      id,
      controllerMachineId: machine,
      projectSourceId: project,
    }),
    title: id,
    currentDeployment: state
      ? createDeploymentReceiptHeaderV1({ state })
      : null,
  };
}

describe('Services filter facts', () => {
  it('reads each row state from the readiness owner its State mark draws', () => {
    const states = (
      [
        'failed',
        'outcome_unknown',
        'running_unverified',
        'queued',
        'running',
        'succeeded',
        'cancelled',
        null,
      ] as const
    ).map(
      (state) =>
        deploymentEnvironmentListFilterFacts(item(String(state), state)).state,
    );
    expect(states).toEqual([
      'needsYou',
      'needsYou',
      'needsYou',
      'deploying',
      'deploying',
      'deployed',
      'deployed',
      'notDeployed',
    ]);
  });

  it('keeps the rows a saved Services view selects by project, state and Machine', () => {
    const rows = [
      item('billing-prod', 'failed', 'machine-a', 'billing'),
      item('billing-staging', 'succeeded', 'machine-b', 'billing'),
      item('shop-prod', 'failed', 'machine-b', 'shop'),
    ];
    const keep = (
      filter: Parameters<typeof compileDeploymentEnvironmentListFilterV1>[0],
    ) => {
      const match = compileDeploymentEnvironmentListFilterV1(filter);
      return rows
        .filter(
          (row) => match(deploymentEnvironmentListFilterFacts(row)) === 'match',
        )
        .map((row) => row.environment.id);
    };
    expect(keep({ states: { include: ['needsYou'], exclude: [] } })).toEqual([
      'billing-prod',
      'shop-prod',
    ]);
    expect(
      keep({
        projects: { include: ['billing'], exclude: [] },
        machines: { include: [], exclude: ['machine-a'] },
      }),
    ).toEqual(['billing-staging']);
  });
});
