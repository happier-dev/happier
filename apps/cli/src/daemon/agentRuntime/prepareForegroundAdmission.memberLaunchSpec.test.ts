import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { configuration } from '@/configuration';
import { ApiClient } from '@/api/api';
import { deriveAgentIsolationMemberIdentity } from '@/daemon/agentIsolation/provisioning';
import type { HostAgentIsolationLaunchContext } from '@/daemon/agentIsolation/agentIsolationLaunchPolicy';
import { createSessionAgentIsolationMemberPreparation } from '@/daemon/agentIsolation/sessionPreparation';
import { runMemberAgentEffect } from '@/daemon/agentIsolation/runMemberNativeOperation';
import { resolveConnectedServiceAuthForSpawn } from '@/daemon/connectedServices/resolveConnectedServiceAuthForSpawn';
import * as processIdentity from '@/daemon/processIdentity';

import { withRealForegroundAdmissionFixture } from './foregroundAdmission.testkit';
import { createForegroundPurposeOwnerFixture } from './prepareForegroundAdmission.connectedServices.testkit';
import { ForegroundAgentRuntimeAdmissionResponseV1Schema } from './foregroundAdmissionContract';

// The privileged member process is the OS boundary. Keep admission and claim real.
vi.mock('@/daemon/agentIsolation/runMemberNativeOperation', async importOriginal => ({
  ...await importOriginal<typeof import('@/daemon/agentIsolation/runMemberNativeOperation')>(),
  runMemberAgentEffect: vi.fn(),
}));

describe('foreground Agent CLI launch admission', () => {
  it.skipIf(process.platform !== 'linux').each(['owner', 'cold separated member'] as const)(
    'hands a fresh %s Codex terminal to the admitted isolated Session launch', async entry => {
    await withRealForegroundAdmissionFixture({}, async fixture => {
      const machineId = 'machine-1';
      const accountId = entry === 'owner' ? 'fixture-owner' : 'fixture-member';
      const serverIdentityId = 'fixture-home';
      const firstMetadataRead = Promise.withResolvers<void>();
      const binding = Promise.withResolvers<void>();
      let published = entry === 'owner';
      const agentIsolation: HostAgentIsolationLaunchContext = {
        awaitReadable: () => binding.promise,
        read: () => published
          ? { enabled: true, memberProvisioning: 'linuxUsersV1',
            status: { kind: 'effective', platform: 'linux' }, workspaceRoots: [] }
          : { enabled: true, status: { kind: 'unavailable', code: 'metadata_unavailable' }, workspaceRoots: [] },
        prepareMember: async ({ requesterIdentity }) => ({
          identity: {
            ...deriveAgentIsolationMemberIdentity(requesterIdentity),
            home: join(fixture.home, 'owner-agent'),
            agentUid: 994,
            agentGid: 994,
          },
          daemonObservation: { daemonIdentity: 'nonRoot', daemonUid: 1000, daemonUsername: 'happier' },
        }),
      };
      const prepareAgentIsolationMember = createSessionAgentIsolationMemberPreparation({
        machineId, custodianAccountId: accountId, agentIsolation,
      })(null, new AbortController().signal, async () => published ? {
        kind: 'freshAccount',
        origin: { machineId, serverIdentityId },
        hostAccountAgent: { accountId, custodianAccountId: accountId, machineId, installationId: 'guest-installation' },
      } : undefined);

      // Plain `happier codex` has Happier sign-in and no daemon-spawned runtime descriptor.
      const admission = fixture.prepare({}, {
        readMachineMetadataSnapshot: () => {
          firstMetadataRead.resolve();
          return published ? { status: 'ready', metadataVersion: 1, metadata: {} } : { status: 'unavailable' };
        },
        agentIsolation,
        prepareAgentIsolationMember,
      });
      await firstMetadataRead.promise;
      published = true;
      binding.resolve();
      const result = ForegroundAgentRuntimeAdmissionResponseV1Schema.parse(await admission);
      expect(result).toMatchObject({
        ok: false,
        error: { failureCause: { phase: 'foreground.member_runtime_descriptor' } },
        sessionSpawnRequired: { machineId },
      });
    });
  });

  it.skipIf(process.platform !== 'linux')('claims the executable already admitted for the separated member', async () => {
    await withRealForegroundAdmissionFixture({
      runtimeOptions: { pluginIds: ['happier.agent.claude'] },
    }, async fixture => {
      const requester = { serverId: 'fixture-server', accountId: 'fixture-member', machineId: 'machine-1',
        installationId: 'fixture-installation' };
      const home = join(fixture.home, 'member');
      const identity = { ...deriveAgentIsolationMemberIdentity({ requester, homeServerIdentityId: 'fixture-home' }),
        home, agentUid: process.getuid!(), agentGid: process.getgid!() };
      const spec = { source: 'managed', resolvedPath: join(home, 'claude'), command: join(home, 'claude'), args: [] };
      const memberEffect = vi.mocked(runMemberAgentEffect);
      memberEffect.mockImplementationOnce(async input => {
        expect(input.request).toMatchObject({ kind: 'resolve' });
        const result = input.readRecord({ t: 'resolved', launch: spec });
        if (result === undefined) throw new Error('Expected the member resolution record to settle');
        return result;
      });
      try {
        const consumer = { pluginId: 'happier.agent.claude', localId: 'claude' };
        const catalogEntry = await fixture.runtime.registry.acquireAgentCatalogEntry?.('claude');
        const { owner } = createForegroundPurposeOwnerFixture({
          consumer, service: { pluginId: consumer.pluginId, localId: 'claude-subscription' },
          materializeAccount: async () => { throw new Error('No Connected Account was selected'); },
        });
        const admission = await fixture.prepare({
          agentId: 'claude',
          backendTarget: { kind: 'backend', backendId: 'claude', sourceKind: 'built_in' },
          runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: {} },
          connectedServices: { v: 2, bindingsByServiceId: {} },
        }, {
          prepareAgentIsolationMember: async () => ({ kind: 'member', identity, requesterIdentity: requester, snapshot: undefined }),
          agentIsolation: { managedHappierBinaryPath: join(fixture.home, 'happier'), read: () => undefined },
          connectedServicesMaterializationBaseDir: join(fixture.home, 'connected-services'),
          connectedAccountsOwner: owner,
          activateSessionPurposeBindings: owner.activateSessionPurposeBindings,
          resolveConnectedServiceAuthForSpawn: async input => {
            const credentials = { token: 'fixture-account', encryption: null } as const;
            return await resolveConnectedServiceAuthForSpawn({ ...input, credentials, api: await ApiClient.create(credentials),
              activeServerDir: configuration.activeServerDir, baseDir: fixture.directory });
          },
          resolveDaemonSpawnHooks: async () => await catalogEntry?.getDaemonSpawnHooks?.() ?? null,
        });
        expect(admission).toMatchObject({ ok: true });
        if (!admission.ok) throw new Error(admission.error.code);
        expect(memberEffect).toHaveBeenCalledTimes(1);
        // The idle fixture keeps its real process birth. Model the command of
        // a CLI source runner so first-party source attestation runs as usual.
        const readProcessIdentity = processIdentity.readProcessIdentityByPid;
        const sourceEntrypoint = fileURLToPath(new URL('../../index.ts', import.meta.url));
        const runnerCommand = `node "${sourceEntrypoint}"`;
        const runnerIdentity = vi.spyOn(processIdentity, 'readProcessIdentityByPid').mockImplementation(async (pid, deps) => {
          const observed = await readProcessIdentity(pid, deps);
          return pid === fixture.foregroundPid && observed ? { ...observed, command: runnerCommand } : observed;
        });
        try {
          const claim = await admission.prepared.claim({
            canonicalSessionId: 'session-1', httpPort: 43127, foregroundSatisfiedProfileSecretRequirementNames: [],
          });
          expect(claim).toMatchObject({ ok: true, invocationContext: { agentCliLaunch: { localAgentId: 'claude', spec } } });
          expect(memberEffect).toHaveBeenCalledTimes(1);
        } finally {
          runnerIdentity.mockRestore();
        }
      } finally {
        memberEffect.mockReset();
      }
    });
  });
});
