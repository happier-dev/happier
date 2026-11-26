import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { DeploymentTeardownResultV1Schema } from '@happier-dev/protocol/deployments/deploymentActionsV1';
import { DeploymentTeardownPreviewV1Schema } from '@happier-dev/protocol/deployments/deploymentTeardownVolumesV1';

import { resolveOwnServerDeploymentEnvironmentInstanceIdForHost } from '../../../../apps/cli/src/deployments/targets/ownServer/paths';
import { resolveEnvironmentComposeProjectName } from '../../../../apps/cli/src/workspaces/projectSetup/projectNativeResolution';
import {
  DBW_COMPOSE_CLEANUP_DIR,
  downDatabaseWorkbenchComposeProject,
  readDatabaseWorkbenchComposeResources,
} from '../../scripts/databaseWorkbenchComposeCleanup.mjs';
import type { startDatabaseWorkbenchFixture } from './databaseWorkbench';

const docker = promisify(execFile);

type Fixture = Awaited<ReturnType<typeof startDatabaseWorkbenchFixture>>;
type Account = Awaited<ReturnType<Fixture['createAccount']>>;

/** These fixtures do one initial deploy per Environment on their local daemon. */
export function trackDatabaseWorkbenchDeployments(fixture: Fixture, testDir: string) {
  const root = process.env[DBW_COMPOSE_CLEANUP_DIR] ?? testDir;
  const cleanups: Array<() => Promise<void>> = [];

  return {
    async recordInitialDeploy(account: Account, placement: { environmentId: string; targetLinkId: string }) {
      const target = { serverId: fixture.serverId, ...placement, reason: 'manual' };
      const environmentInstanceId = resolveOwnServerDeploymentEnvironmentInstanceIdForHost(fixture.serverId, placement.environmentId);
      const project = resolveEnvironmentComposeProjectName({ environmentInstanceId, services: [] });
      // Record before the Action can create a network, even if no receipt is returned.
      const directory = join(root, project);
      await mkdir(directory);
      cleanups.push(async () => {
        const before = await readDatabaseWorkbenchComposeResources(project);
        if (![...before.containers, ...before.networks, ...before.volumes].length) return;
        try {
          const preview = await account.execute('deployments.teardown', { ...target, mode: 'preview' });
          if (!preview.ok) throw new Error(`Teardown preview refused (${preview.errorCode})`);
          const inventory = DeploymentTeardownPreviewV1Schema.parse(preview.result);
          const removed = await account.executeReviewed('deployments.teardown', { ...target, removeEnvironment: true,
            volumes: inventory.volumes.map(({ name }) => ({ name, disposition: 'delete', confirmation: name })) },
          { presentUserConfirmation: { actionId: 'deployments.teardown' } });
          if (!removed.ok) throw new Error(`Teardown refused (${removed.errorCode})`);
          const settled = DeploymentTeardownResultV1Schema.parse(removed.result);
          if (!settled.ok || !('state' in settled ? settled.state === 'succeeded' : 'environmentRemoved' in settled)) {
            throw new Error('Teardown did not settle successfully');
          }
          const remaining = await readDatabaseWorkbenchComposeResources(project);
          const remainingVolumes = new Set(remaining.volumes);
          if (inventory.volumes.length) {
            const { stdout } = await docker('docker', ['volume', 'ls', '--format', '{{.Name}}']);
            const nativeVolumes = new Set(stdout.trim().split(/\r?\n/u));
            for (const { name } of inventory.volumes) {
              if (nativeVolumes.has(name)) remainingVolumes.add(name);
            }
          }
          if (remaining.containers.length || remaining.networks.length || remainingVolumes.size) {
            throw new Error(`Product Delete left resources for ${project}: ${JSON.stringify({ ...remaining, volumes: [...remainingVolumes] })}`);
          }
          console.log(`[dbw-compose] Product Delete removed ${project}`);
        } catch (error) {
          try {
            await downDatabaseWorkbenchComposeProject(directory, project);
          } catch (fallbackError) {
            throw new AggregateError([error, fallbackError], `Product and Compose cleanup failed for ${project}`);
          }
          throw new Error(`Product cleanup failed for ${project}; Compose cleanup ran`, { cause: error });
        }
      });
      return project;
    },
    async run(body: () => Promise<void>) {
      const errors: unknown[] = [];
      try {
        await body();
      } catch (error) {
        errors.push(error);
      } finally {
        for (const cleanup of [...cleanups.reverse(), () => fixture.stop()]) {
          try { await cleanup(); } catch (error) { errors.push(error); }
        }
      }
      if (errors.length === 1) throw errors[0];
      if (errors.length) throw new AggregateError(errors, 'DBW fixture and cleanup failures');
    },
  };
}
