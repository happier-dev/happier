import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { delimiter, join } from 'node:path';
import { DeploymentActionOutputSchemasV1 } from '@happier-dev/protocol';
import { MachineInstallationIdentityV1Schema } from '@happier-dev/protocol/machines/identity/installationIdentity';
import { ProjectSourcesReadOutputV1Schema } from '@happier-dev/protocol/projects/sources/projectSourceV1';
import type { ActionId } from '@happier-dev/protocol/actions/actionIds';
import { createOwnServerDockerBoundary } from '../../../../apps/cli/src/deployments/targets/ownServer/ownServerDeployment.testkit';

/** Real CLI Actions and enrolled daemon with only external Docker substituted.
 * F2/F4 share actual deployment operands rather than fabricating admission or receipts. */
export async function startAutomationsEverywhereDeploymentFixture(testDir: string, options?: Readonly<{
  volumeBackup?: boolean;
  observeAutomationWriteFailures?: boolean;
}>) {
  const { startTeamSetupFFixture } = await import('./teamSetupF');
  // Docker alone is an external substitute. Its real executable is inherited
  // by the daemon; preparation, approval, Run custody and deployment stay real.
  const toolsDir = join(testDir, 'tools');
  const docker = await createOwnServerDockerBoundary(toolsDir);
  const fixture = await startTeamSetupFFixture({ testDir, observeActionRequests: true,
    observeAutomationWriteFailures: options?.observeAutomationWriteFailures,
    serverEnv: { HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1' } });
  try {
    const actor = await fixture.createAccount('deployer');
    const machine = await fixture.enrollDaemon(actor, { env: {
      HAPPIER_FEATURE_AUTOMATIONS__ENABLED: '1', HAPPIER_SERVER_URL: fixture.actionServerApiUrl,
      PATH: `${toolsDir}${delimiter}${process.env.PATH ?? ''}`,
    } });
    await fixture.assertKnownGoodMachineControl(actor, machine);
    async function invoke(actionId: ActionId, input: unknown) {
      const result = await actor.executeAsPerson(actionId, input, {
        externalActionTarget: { kind: 'machine', machineId: machine.target.machineId },
        presentUserConfirmation: { actionId },
      });
      if (!result.ok) throw new Error(`${actionId}: ${JSON.stringify(result)}`);
      return result.result;
    }
    const source = ProjectSourcesReadOutputV1Schema.parse(await invoke('projects.sources.create', {
      serverId: fixture.serverId, name: 'Approval deployment', requestKey: randomUUID(),
    }));
    if (!source.ok) throw new Error(`Project setup: ${source.error}`);
    const deployInput = await prepareAutomationsEverywhereDeployment({
      serverId: fixture.serverId, projectSourceId: source.source.id, machine, docker, invoke,
      ...(options?.volumeBackup ? { volumeBackup: true } : {}),
    });
    return { fixture, actor, machine, deployInput, docker, invoke };
  } catch (error) {
    await fixture.stop();
    throw error;
  }
}

/** Reuse the deployment's real admission path for the two-Account ship journey.
 * The caller supplies its already-created Team Source and acting Machine. */
export async function prepareAutomationsEverywhereDeployment(params: Readonly<{
  serverId: string;
  projectSourceId: string;
  name?: string;
  protection?: 'production' | 'nonProduction';
  volumeBackup?: boolean;
  machine: Readonly<{ homeDir: string; target: Readonly<{ machineId: string }> }>;
  docker: Awaited<ReturnType<typeof createOwnServerDockerBoundary>>;
  invoke: (actionId: ActionId, input: unknown) => Promise<unknown>;
}>) {
  const { serverId, projectSourceId, machine, docker, invoke } = params;
  const image = await docker.registerImage('app', 'approval-check');
  const document = JSON.stringify({ services: { app: { image: image.registryReference,
    ...(params.volumeBackup ? { volumes: ['data:/data'] } : {}) } },
    ...(params.volumeBackup ? { volumes: { data: {} } } : {}) });
  const environment = DeploymentActionOutputSchemasV1['deployments.environments.create'].parse(await invoke('deployments.environments.create', {
    serverId, projectSourceId, requestKey: randomUUID(),
    name: params.name ?? 'Approval deployment', retainPreviousDeployments: 1,
    definition: { from: 'compose', document, profiles: [], services: ['app'] },
    protection: params.protection ?? 'nonProduction', purpose: 'standard', deployerMode: 'managers',
    controllerMachineId: machine.target.machineId, buildMachineId: machine.target.machineId,
  }));
  if (!environment.ok) throw new Error(`Environment setup: ${environment.error}`);
  const identity = MachineInstallationIdentityV1Schema.parse(JSON.parse(await readFile(join(machine.homeDir, 'installation-identity.json'), 'utf8')));
  const target = DeploymentActionOutputSchemasV1['deployments.targets.link'].parse(await invoke('deployments.targets.link', {
    serverId, environmentId: environment.environmentId, expectedRevision: environment.revision,
    requestKey: randomUUID(), targetId: 'own-server', role: 'runtime',
    machines: [{ machineId: machine.target.machineId, installationId: identity.installationId }],
  }));
  if (!target.ok) throw new Error(`Target setup: ${target.error}`);

  const deployInput = { serverId, environmentId: environment.environmentId, targetLinkId: target.targetLinkId };
  return deployInput;
}
