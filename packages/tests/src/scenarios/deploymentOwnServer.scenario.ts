import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect } from 'vitest';
import { connectUiPersonActionClient } from '@happier-tests/ui-action-client';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { DeploymentReceiptGetResultV1Schema, DeploymentReceiptResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { createOwnServerDockerBoundary } from '../../../../apps/cli/src/deployments/targets/ownServer/ownServerDeployment.testkit';
import { prepareAutomationsEverywhereDeployment } from '../testkit/automationsEverywhereDeployment';
import type { TeamSetupFFixture } from '../testkit/teamSetupF';
import { runDeploymentOwnServerBackup } from '../testkit/deploymentOwnServerBackup';
import { runFreshDeploymentSourceSmoke } from './deployments.scenario';

/** Real Account, Source and enrolled daemon setup belongs to the journey's fixture lifetime. */
export async function prepareOwnServerDeploymentJourney(fixture: TeamSetupFFixture) {
  const tools = await mkdtemp(join(tmpdir(), 'deployment-journey-docker-'));
  const docker = await createOwnServerDockerBoundary(tools);
  const source = await runFreshDeploymentSourceSmoke(fixture, {
    env: { PATH: `${tools}${delimiter}${process.env.PATH ?? ''}` },
  });
  return { tools, docker, ...source };
}

export type PreparedOwnServerDeploymentJourney = Awaited<ReturnType<typeof prepareOwnServerDeploymentJourney>>;

/** Fake Docker executable is the OS boundary; the daemon, preparation and receipts remain real. */
export async function runOwnServerDeploymentJourney(fixture: TeamSetupFFixture, prepared: PreparedOwnServerDeploymentJourney) {
  const { tools, docker, account, machine, sourceId } = prepared;
  async function invoke(actionId: ActionId, input: unknown) {
    const result = await account.executeReviewed(actionId, input, {
      externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
      presentUserConfirmation: { actionId },
    });
    if (!result.ok) throw new Error(`${actionId}: ${JSON.stringify(result)}`);
    return result.result;
  }
  const input = await prepareAutomationsEverywhereDeployment({ serverId: fixture.serverId,
    projectSourceId: sourceId, machine, docker, invoke, volumeBackup: true });
  const deployed = DeploymentReceiptResultV1Schema.parse(await invoke('deployments.deploy', input));
  expect(deployed).toMatchObject({ ok: true, state: 'succeeded' });
  if (!deployed.ok || !('deploymentId' in deployed)) throw new Error('Own-server deploy did not settle');
  const receipt = DeploymentReceiptGetResultV1Schema.parse(await invoke('deployments.receipts.get', {
    serverId: fixture.serverId, environmentId: input.environmentId, deploymentId: deployed.deploymentId,
  }));
  expect(receipt).toMatchObject({ ok: true, deployment: { state: 'succeeded' } });
  await runDeploymentOwnServerBackup({ fixture, account, machine, docker, tools, ...input, deploymentId: deployed.deploymentId });
  const teardown = DeploymentReceiptResultV1Schema.parse(await invoke('deployments.teardown', {
    ...input, reason: 'manual',
  }));
  expect(teardown).toMatchObject({ ok: true, state: 'succeeded' });
  if (!teardown.ok || !('deploymentId' in teardown)) throw new Error('Own-server teardown did not settle');
  const proof = DeploymentReceiptGetResultV1Schema.parse(await invoke('deployments.receipts.get', { serverId: fixture.serverId,
    environmentId: input.environmentId, deploymentId: teardown.deploymentId }));
  expect(proof).toMatchObject({ ok: true, deployment: { state: 'succeeded' } });
  if (!proof.ok) throw new Error('Teardown receipt unavailable');
  const ui = await connectUiPersonActionClient({ serverUrl: fixture.actionServerApiUrl,
    addressAnchorUrl: fixture.server.baseUrl, accountSecret: account.auth.accountSigningSeed });
  try {
    const detail = await ui.readDeploymentReceipt(input.environmentId, teardown.deploymentId);
    if (!detail.ok) throw new Error(`Teardown proof unavailable: ${detail.failure.code}`);
    expect(detail.value.content.teardown?.proofs).toEqual(expect.arrayContaining([expect.objectContaining({ step: 'verify' })]));
  } finally { await ui.close(); }
  expect(await docker.readRunningImageConfig('app')).toBeNull();
}
