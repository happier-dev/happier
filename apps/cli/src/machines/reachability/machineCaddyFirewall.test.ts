import { expect, it } from 'vitest';
import { machineNativeEffectAdmission } from '@/daemon/local/services/launch/machineNativeEffectAdmission';
import { settleMachineCaddyFirewallForHost } from './machineReachabilityHost';
import { observeOwnDaemonReachability } from './observeOwnDaemonReachability';

it('explains the missing Network posture before changing native or saved state', async () => {
  const metadata = {};
  await expect(machineNativeEffectAdmission.run({
    operation: { operationId: 'missing-network-posture', kind: 'deployments.domains.add' },
    keys: [{ kind: 'machineSetup' }],
  }, native => settleMachineCaddyFirewallForHost({
    machineId: 'machine', installationId: 'installation', operationId: 'missing-network-posture', native,
    basis: { kind: 'setup', machineId: 'machine', desiredRevision: 0 },
    port: { read: async () => ({ status: 'ready', metadata, metadataVersion: 1 }),
      compareAndSwap: async () => { throw new Error('Missing posture cannot write Machine metadata'); } },
    caddy: { containerName: 'happier-caddy', stateDirectory: '/var/lib/happier/caddy',
      adminDirectory: '/var/lib/happier/caddy-admin', daemonGroup: 'happier', daemonGroupId: 1000,
      initialConfig: '{}', originPort: 8080, routedNetworks: [] },
    // Privilege observation and process launch are genuine OS boundaries.
    elevation: { installationId: 'installation', installedCli: '/managed/happier',
      readPolicy: async () => ({ version: 1, mode: 'preauthorized' }),
      observe: async () => { throw new Error('Missing posture cannot observe native privileges'); },
      spawn: () => { throw new Error('Missing posture cannot start a native effect'); } },
    readDaemonProof: () => observeOwnDaemonReachability({ client: {
      isMachineControlRegistrationReady: () => false,
      callConnectedClientRpc: async () => { throw new Error('No Home call before posture review'); },
    } }),
  }))).rejects.toMatchObject({ code: 'machine_reachability_posture_unavailable',
    details: { requiredFact: 'reachabilityPosture', remedy: expect.any(String) } });
  expect(metadata).toEqual({});
});
