import { describe, expect, it, vi } from 'vitest';
import { createActionExecutor } from '@happier-dev/protocol/actions/actionExecutor';
import { createUnavailableActionTransportDeps } from '@/testkit/actionTransportDeps';
import { createCliActionInventoryDeps } from './createCliActionInventoryDeps';

const http = vi.hoisted(() => ({ get: vi.fn() }));
// HTTP is the boundary; bootstrap parsing, inventory and Action projection stay real.
vi.mock('axios', () => ({ default: { defaults: {}, get: http.get } }));

describe('machines.list installation discovery', () => {
  it.each(['manage', 'use'] as const)('retains the visible %s target identity without disclosing stored content', async role => {
    const access = { custodian: { accountId: 'other-owner', displayName: 'Owner' }, role,
      resourceMode: 'e2ee', accessState: 'key_pending' };
    http.get.mockResolvedValue({ status: 200, data: [{ id: 'shared-machine', installationId: 'shared-installation',
      active: true, revokedAt: null, replacedByMachineId: null, access,
      metadata: 'private-metadata', daemonState: 'private-daemon-state', dataEncryptionKey: 'private-wrapped-key',
      installationPublicKey: 'public-key-not-needed',
    }, { id: 'legacy-machine', active: false, revokedAt: null, replacedByMachineId: null }] });
    const inventory = createCliActionInventoryDeps({ token: 'requester-token', sessionId: '', mode: 'plain', ctx: null,
      serverId: 'home', serverHttpBaseUrl: 'https://machines.example.test' });
    const executor = createActionExecutor({ ...createUnavailableActionTransportDeps(), ...inventory });
    const result = await executor.execute('machines.list', {}, { surface: 'agent', authority: 'account_automation', serverId: 'home' });
    expect(result).toMatchObject({ ok: true, result: { items: [
      { serverId: 'home', machineId: 'shared-machine', installationId: 'shared-installation', access },
      { machineId: 'legacy-machine', installationId: null },
    ] } });
    expect(JSON.stringify(result)).not.toMatch(/private-|public-key-not-needed|requester-token/);
  });
});
