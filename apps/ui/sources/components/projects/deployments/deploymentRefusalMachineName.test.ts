import { afterEach, expect, it } from 'vitest';
import { createMachineFixture, standardCleanup } from '@/dev/testkit';

afterEach(() => standardCleanup());
const { readDeploymentRefusalRecovery } =
  await import('./deploymentPresentation');
const { storage } = await import('@/sync/domains/state/storage');

// QA-SWEEP-172 #201: a refusal that names a Machine says the name the person sees elsewhere, never its raw id.
it('names the Machine a refusal points at by its display name', () => {
  const scope = { serverId: 'home', accountId: 'account' };
  storage.setState({ profileScope: scope });
  const machineId = 'a729f841-7ab0-4e2c-9c3d-1f2e3d4c5b6a';
  storage
    .getState()
    .applyMachines(
      [
        createMachineFixture({
          id: machineId,
          installationId: 'installation-a',
          metadata: {
            host: 'NLDW3-5-36-33',
            platform: 'linux',
            happyCliVersion: '0.3.0',
            happyHomeDir: '/h',
            homeDir: '/h',
          },
        }),
      ],
      true,
      { sourceServerId: scope.serverId, sourceAccountId: scope.accountId },
    );
  const recovery = readDeploymentRefusalRecovery(
    'machine_admin_access_required',
    { step: 'native_execution', machineId },
  );
  expect(recovery?.remedy).toContain('NLDW3-5-36-33');
  expect(recovery?.remedy).not.toContain(machineId);
  expect(recovery?.nextAction.machineId).toBe(machineId);
});
