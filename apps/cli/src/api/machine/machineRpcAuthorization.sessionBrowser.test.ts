import { describe, expect, it } from 'vitest';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { projectSessionAccessCapabilitiesV1 } from '@happier-dev/protocol/sessions/access/sessionEffectiveAccessV1';
import type { SocketRpcSessionBrowserAuthorizationContext } from '@happier-dev/protocol/socketRpc';
import { authorizeMachineRpcRequest, type MachineRpcAdmissionBoundary } from './machineRpcAuthorization';

const machine: MachineRpcAdmissionBoundary = {
  machineId: 'machine', resolveInstallationId: () => 'installation',
  resolveCustodianAccountId: async () => 'owner',
  verifyMachineAdmission: async () => { throw new Error('Session Browser must not require a Machine grant'); },
};
function access(level: 'view' | 'edit'): SocketRpcSessionBrowserAuthorizationContext {
  return { kind: 'session.browser', sessionId: 'session', actorAccountId: 'recipient', custodianAccountId: 'owner',
    machineId: 'machine', installationId: 'installation', effectiveAccess: { v: 1, level,
      sources: [{ kind: 'direct', shareId: 'share' }], capabilities: projectSessionAccessCapabilitiesV1({ owner: false,
        grants: [{ accessLevel: level, canApprovePermissions: false }] }) } };
}
describe('installed Session Browser admission', () => {
  it.each(['view', 'edit'] as const)('accepts Home-admitted %s discovery without a Machine grant', async level => {
    expect(await authorizeMachineRpcRequest({ method: `machine:${RPC_METHODS.DAEMON_BROWSER_VIEW_LIST}`,
      params: { browserSessionId: 'session' }, authorization: access(level), callerAuthority: 'present_user' },
    machine, 'authenticated_home_socket')).toEqual({ ok: true });
  });
  it('allows only Steer to drive and binds the exact Session, installation and trusted Home ingress', async () => {
    const request = { method: `machine:${RPC_METHODS.DAEMON_BROWSER_CONTROL_DISPATCH}`,
      params: { command: { browserSessionId: 'session' } }, authorization: access('edit'), callerAuthority: 'present_user' as const };
    expect(await authorizeMachineRpcRequest(request, machine, 'authenticated_home_socket')).toEqual({ ok: true });
    expect(await authorizeMachineRpcRequest({ ...request, authorization: access('view') }, machine, 'authenticated_home_socket')).toMatchObject({ ok: false });
    expect(await authorizeMachineRpcRequest(request, machine)).toMatchObject({ ok: false });
    expect(await authorizeMachineRpcRequest({ ...request, params: { command: { browserSessionId: 'other' } } }, machine, 'authenticated_home_socket')).toMatchObject({ ok: false });
    expect(await authorizeMachineRpcRequest({ ...request, authorization: { ...access('edit'), installationId: 'other' } }, machine, 'authenticated_home_socket')).toMatchObject({ ok: false });
  });
});
