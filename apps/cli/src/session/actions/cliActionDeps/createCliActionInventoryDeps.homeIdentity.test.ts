import { afterEach, describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { reloadConfiguration } from '@/configuration';
import { createEnvKeyScope } from '@/testkit/env/envScope';
import { withTempDir } from '@/testkit/fs/tempDir';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { adoptServerProfileHomeConnectionDescriptor, setServerProfileEndpointsById } from '@/server/serverProfiles';
import { createCliActionInventoryDeps } from './createCliActionInventoryDeps';

const http = vi.hoisted(() => ({ get: vi.fn() }));
// HTTP is the boundary; the saved profile store, inventory and Action projection stay real.
vi.mock('axios', () => ({ default: { defaults: {}, get: http.get } }));

/**
 * A profile id (`env_<hash>`, `stack_<name>__id_default`, a chosen name) is local to one CLI home: two
 * Machines on one Home spell it differently. Inventory outputs are copied into Action inputs that cross
 * Machines (`executionTarget.serverId`), so they carry the portable Home identity whenever it is known.
 */
describe('Action inventory Home identity', () => {
  const env = createEnvKeyScope(['HAPPIER_HOME_DIR', 'HAPPIER_ACTIVE_SERVER_ID', 'HAPPIER_SERVER_URL', 'HAPPIER_WEBAPP_URL']);
  afterEach(() => { env.restore(); reloadConfiguration(); http.get.mockReset(); });

  it('publishes one server id vocabulary (the Home identity) from machines.list and servers.list', async () => {
    await withTempDir('happier-inventory-home-identity-', async homeDir => {
      env.patch({ HAPPIER_HOME_DIR: homeDir, HAPPIER_SERVER_URL: undefined, HAPPIER_WEBAPP_URL: undefined,
        HAPPIER_ACTIVE_SERVER_ID: undefined });
      reloadConfiguration();
      const url = 'https://home.example.test';
      await setServerProfileEndpointsById({ id: 'env_local', serverUrl: url, webappUrl: url });
      await adoptServerProfileHomeConnectionDescriptor({ observation: 'exact', expectedProfileId: 'env_local',
        descriptor: { v: 1, homeServerIdentityId: 'srv_fixture', canonicalServerUrl: url, revision: 1,
          endpoints: [{ kind: 'https', url }] } });
      http.get.mockResolvedValue({ status: 200, data: [{ id: 'machine-a', installationId: 'installation-a',
        active: true, revokedAt: null, replacedByMachineId: null }] });
      const inventory = createCliActionInventoryDeps({ token: 'fixture-token', sessionId: '', mode: 'plain', ctx: null,
        serverId: 'env_local', serverIdentityId: 'srv_fixture', serverHttpBaseUrl: url });
      const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory });
      const context = { surface: 'agent', authority: 'account_automation', serverId: 'env_local' } as const;
      const machines = await executor.execute('machines.list', {}, context);
      const servers = await executor.execute('servers.list', {}, context);
      const emitted = new Set([
        ...(machines.ok ? (machines.result as { items: Array<{ serverId: string }> }).items.map(item => item.serverId) : []),
        ...(servers.ok ? (servers.result as { items: Array<{ value: string }> }).items.map(item => item.value) : []),
      ]);
      expect(machines.ok && servers.ok).toBe(true);
      expect([...emitted]).toEqual(['srv_fixture']);
      // The profile itself stays addressable by its local id.
      expect(servers).toMatchObject({ ok: true, result: { items: [{ id: 'env_local' }] } });
    });
  });
});
