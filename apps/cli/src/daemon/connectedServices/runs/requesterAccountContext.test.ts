import axios from 'axios';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createRequesterCurrentnessSocketHarness } from '@/testkit/backends/requesterCurrentnessSocketHarness';
import { createRequesterSessionControlRuntimeFixture } from '@/daemon/testkit/requesterSessionControlRuntimeFixture';
import { prepareRequesterSessionBootstrap } from '@/daemon/sessionEncryption/requesterSessionCredentials';
import { createRequesterSessionRuntimeContext } from '@/daemon/sessionEncryption/createRequesterSessionRuntimeContext';
import { createProviderAccountUsageStore } from '../accountUsage/store';
import { ConnectedServiceRuntimeRegistry } from '../runtimeRegistry/registry';
import { createExecutionRunRequesterAccountAccess } from './requesterAccountContext';

it('borrows the admitted guest Account without retiring its Workflow bootstrap when a consumer releases', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'workflow-requester-runtime-'));
  const channel = await createRequesterCurrentnessSocketHarness();
  const token = `e30.${Buffer.from(JSON.stringify({ sub: 'guest', tokenEpoch: 1,
    provenance: { v: 1, kind: 'account', authority: 'present_user' } })).toString('base64url')}.fixture`;
  // Only Home HTTP and the loopback Account change transport are substituted.
  const get = vi.spyOn(axios, 'get').mockImplementation(async (url: string) => ({ status: 200,
    data: url.endsWith('/profile') ? { id: 'guest' }
      : url.endsWith('/currentness') ? { mode: 'plain', version: 1, updatedAt: 1,
        signingKeyFingerprint: null, contentKeyFingerprint: null }
      : url.endsWith('/account/encryption') ? { mode: 'plain', updatedAt: 1 }
      : { content: { t: 'plain', v: {} }, version: 1 },
  }));
  let host: Awaited<ReturnType<typeof createRequesterSessionControlRuntimeFixture>> | undefined;
  let prepared: Awaited<ReturnType<typeof prepareRequesterSessionBootstrap>> = null;
  try {
    const registry = new ConnectedServiceRuntimeRegistry();
    host = await createRequesterSessionControlRuntimeFixture({ happyHomeDir: directory, activeServerDir: directory,
      serverId: 'home', serverHttpBaseUrl: 'https://workflow-home.test', machineId: 'machine', custodianAccountId: 'owner',
      credentials: { token: 'owner', encryption: null }, connectedServicesMaterializationBaseDir: join(directory, 'materialized'),
      registry, trackedSessions: new Map(), getRequester: () => null, resolveQualifiedConnectedAccountV4Support: () => 'indeterminate' });
    prepared = await prepareRequesterSessionBootstrap({ credentials: { token, encryption: null },
      attribution: { serverId: 'home', accountId: 'guest', machineId: 'machine', installationId: 'installation' },
      boundary: { serverId: 'home', serverHttpBaseUrl: 'https://workflow-home.test', happyHomeDir: directory },
      verifyMachineAdmissionCurrent: async () => true });
    if (!prepared) throw new Error('Guest bootstrap admission refused');
    const coordinator = host.runtime.connectedServiceAuthGroupPreTurnSwitchCoordinator;
    const access = createExecutionRunRequesterAccountAccess({
      resolveSession: async () => null, releaseSession: async () => {}, assertSession: async () => {},
      createRequester: async (bootstrap, options) => await createRequesterSessionRuntimeContext({ bootstrap, ...options,
        providerAccountUsageStore: createProviderAccountUsageStore(), activeServerDir: directory,
        connectedServicesMaterializationBaseDir: join(directory, 'materialized'), resolveQualifiedConnectedAccountV4Support: () => 'indeterminate',
        coordinatorInput: { machineId: 'machine', machineIdProvider: () => 'machine', runtimeId: 'runtime', happyHomeDir: directory,
          logger: { debug() {}, info() {}, warn() {} }, processEnv: { HAPPIER_CONNECTED_SERVICES_REFRESH_ENABLED: '0',
            HAPPIER_CONNECTED_SERVICES_QUOTAS_ENABLED: '0' }, pidToTrackedSession: new Map(), connectedServiceRuntimeRegistry: registry,
          connectedServiceAuthGroupPreTurnSwitchCoordinator: coordinator } }),
    });
    const first = await access.resolve(null, prepared.admitted);
    expect(first?.bootstrap.credentials.token).toBe(token);
    expect(first?.connectedServicesMaterializationBaseDir).toContain('account-guest');
    await access.assertCurrent(null, first);
    await access.release(first);
    expect(await prepared.admitted.isCurrent()).toBe(true);
    expect(prepared.admitted.savedSecretOperationContext.readSnapshot()).not.toBeNull();
    const next = await access.resolve(null, prepared.admitted);
    await access.assertCurrent(null, next);
    await access.release(next);
    await prepared.cleanupOnFailure();
    expect(await prepared.admitted.isCurrent()).toBe(false);
    await expect(access.resolve(null, prepared.admitted)).rejects.toThrow('requester_session_not_current');
  } finally {
    await prepared?.cleanupOnFailure();
    await host?.dispose();
    get.mockRestore();
    await channel.close();
    await rm(directory, { recursive: true, force: true });
  }
});
