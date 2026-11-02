import { afterEach, describe, expect, it, vi } from 'vitest';
import { ACTION_ID_FAMILIES_V1 } from '@happier-dev/protocol/actions/actionIds';
import { getActionSpec } from '@happier-dev/protocol/actions/actionSpecs';
import * as machineRpc from '@/session/transport/rpc/machineRpc';
import { createCliMachineActionTransport } from './machineTransport';
import type { MachineActionDirectTargetTransport } from '../createCliActionDeps';

afterEach(() => vi.restoreAllMocks());

describe('isolation and admin-access Machine admission', () => {
  it.each([...ACTION_ID_FAMILIES_V1.machine_agent_isolation, ...ACTION_ID_FAMILIES_V1.machine_admin_access]
    .flatMap(actionId => { const method = getActionSpec(actionId).bindings?.rpcMethod; return method ? [method] : []; }))('keeps protected native %s on authenticated Machine ingress', async method => {
      const local = vi.fn<MachineActionDirectTargetTransport['invoke']>();
      const admitted = vi.spyOn(machineRpc, 'callMachineRpc').mockResolvedValue({ status: 'unavailable', code: 'permission_denied' });
      const transport = createCliMachineActionTransport({
        credentials: { token: 'fixture', encryption: null, credentialProvenance: 'stored_session' },
        serverId: 'home-profile', serverIdentityId: 'srv_home', serverHttpBaseUrl: 'https://home.example.test',
        machineActionDirectTargetTransport: { machineId: 'machine', invoke: local },
      });
      expect(await transport.callMachineAction({ machineId: 'machine', method, request: {} }))
        .toEqual({ status: 'unavailable', code: 'permission_denied' });
      expect(local).not.toHaveBeenCalled();
      expect(admitted).toHaveBeenCalledOnce();
    });
});
