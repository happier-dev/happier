import { describe, expect, it, vi } from 'vitest';
import { RpcHandlerManager } from '@/api/rpc/RpcHandlerManager';
import { authorizeMachineRpcRequest } from '@/api/machine/machineRpcAuthorization';
import { RPC_METHODS } from '@happier-dev/protocol/rpc/methods';
import { MACHINE_ACCESS_LOSS_SERVER_ORIGIN } from '@happier-dev/protocol/socketRpc';
import { registerMachineAccessLossReceiver } from '../externalActions/registerMachineAccessLossReceiver';
import { createMachineLiveStreamCaptureRegistry } from '../peer/mediation/stream/captureRegistry';
import { native } from './driver/nativeComputerBoundary.testkit';
import { createComputerRoutes, type ComputerActionContext } from './routes';

const window = {
  kind: 'window',
  displayId: ':73',
  pid: 42,
  windowId: 123,
} as const;
const admission = (actorAccountId: string, role: 'use' | 'manage') => ({
  actorAccountId,
  custodianAccountId: 'owner',
  role,
  machineId: 'machine',
  installationId: 'installation',
  encryptionMode: 'plain' as const,
});
/** An Agent Session on the owner's Machine, admitted through its requester's Machine grant. */
const grantee = (
  accountId: string,
  sessionId: string,
): ComputerActionContext => ({
  authority: 'account_automation',
  surface: 'agent',
  defaultSessionId: sessionId,
  bypassApprovals: true,
  machineAdmission: admission(accountId, 'manage'),
  verifyMachineAdmissionCurrent: async () => true,
});
/** The custodian's own ordinary Agent Session. */
const owner: ComputerActionContext = {
  authority: 'account_automation',
  surface: 'agent',
  defaultSessionId: 'owner-session',
  bypassApprovals: true,
};
const select = (
  routes: ReturnType<typeof createComputerRoutes>,
  context: ComputerActionContext,
) =>
  routes.dispatch(
    'computer.target.select',
    { machineId: 'machine', target: window },
    context,
  );

function fixture() {
  vi.stubEnv('WAYLAND_DISPLAY', undefined);
  native.call.mockImplementation(async ({ name }) =>
    name === 'list_windows'
      ? {
          structuredContent: {
            windows: [{ pid: 42, window_id: 123, title: 'Owner editor' }],
          },
        }
      : name === 'get_screen_size'
        ? { structuredContent: { width: 800, height: 600, scale_factor: 1 } }
        : { structuredContent: { x11: true, xsend_event: true } },
  );
  const registry = createMachineLiveStreamCaptureRegistry();
  const routes = createComputerRoutes({
    machineId: 'machine',
    defaultDisplayId: ':73',
    executablePath: '/managed/cua-driver',
    registry,
    requesterHost: {
      custodianAccountId: 'owner',
      installationId: 'installation',
      readHomeServerIdentityId: async () => 'home',
      prepareNativeOperation: async () => {
        throw new Error('Owner-display selection prepares no member desktop');
      },
    },
  });
  const rpc = new RpcHandlerManager({
    scopePrefix: 'machine',
    encryptionMode: 'plain',
    logger: () => {},
    authorizeRequest: (request) =>
      authorizeMachineRpcRequest(request, {
        machineId: 'machine',
        resolveCustodianAccountId: async () => 'owner',
        resolveInstallationId: () => 'installation',
        // Home's current-admission verification is the network boundary; parsing,
        // receiver custody and the Computer selection owner stay real.
        verifyMachineAdmission: async () => true,
      }),
  });
  // Production composition: the receiver delegates to the Computer route owner.
  registerMachineAccessLossReceiver(rpc, {
    machineId: 'machine',
    serverId: 'home',
    resolveInstallationId: () => 'installation',
    readLiveWorkInventory: async () => ({ coverage: 'complete', items: [] }),
    readRequesterMachineResourceAccountIds: () => routes.readRequesterAccountIds(),
    releaseRequesterComputerSelections: (input) =>
      routes.releaseRequesterSelections(input),
    cleanupRequesterMachineResources: async () => ({ kind: 'settled' }),
  });
  /** The Home's reconnect census: who holds work here that a missed withdrawal must still reach. */
  const census = () => rpc.handleRequest({
    method: `machine:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`,
    authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN,
    params: { v: 1, kind: 'requesters' },
    machineAdmission: admission('owner', 'manage'),
  });
  const withdraw = (subjectAccountId: string, remainingRole?: 'use') =>
    rpc.handleRequest({
      method: `machine:${RPC_METHODS.DAEMON_MACHINE_ACCESS_LOSS}`,
      authorization: MACHINE_ACCESS_LOSS_SERVER_ORIGIN,
      params: {
        v: 1,
        subjectAccountId,
        ...(remainingRole ? { remainingRole } : {}),
      },
      machineAdmission: admission('owner', 'manage'),
    });
  const sessionsHolding = () =>
    registry
      .list()
      .flatMap((entry) =>
        entry.computer?.sourceIdentity.kind === 'session'
          ? [entry.computer.sourceIdentity.sessionId]
          : [],
      );
  return { routes, withdraw, census, sessionsHolding };
}

describe('Computer selection after Machine access loss', () => {
  it('lets the owner take back a display a withdrawn Manage guest still selected', async () => {
    const { routes, withdraw, census, sessionsHolding } = fixture();
    try {
      expect(
        await select(routes, grantee('guest', 'guest-session')),
      ).toMatchObject({ selectedTarget: window });
      expect(await census()).toEqual({ kind: 'requesters', accountIds: ['guest'], coverage: 'complete' });
      // Control: while the guest's grant is current, the hold rules are unchanged.
      expect(await select(routes, owner)).toMatchObject({
        ok: false,
        errorCode: 'computer_target_in_use',
      });
      expect(
        await select(routes, grantee('carol', 'carol-session')),
      ).toMatchObject({ ok: false, errorCode: 'computer_target_in_use' });
      // Another person's withdrawal never displaces a guest who still has access.
      expect(await withdraw('carol')).toEqual({ kind: 'settled' });
      expect(sessionsHolding()).toEqual(['guest-session']);

      expect(await withdraw('guest')).toEqual({ kind: 'settled' });
      expect(sessionsHolding()).toEqual([]);
      expect(await select(routes, owner)).toMatchObject({
        selectedTarget: window,
      });
      expect(sessionsHolding()).toEqual(['owner-session']);
      expect(await census()).toEqual({ kind: 'requesters', accountIds: [], coverage: 'complete' });
      // The released guest selection cannot bind the owner's new source.
      expect(
        await routes.dispatch(
          'computer.capture',
          { machineId: 'machine' },
          grantee('guest', 'guest-session'),
        ),
      ).toMatchObject({ status: 'target_selection_required' });
      // Owner holds, guest denied: unchanged after the take-back.
      expect(
        await select(routes, grantee('guest', 'guest-session')),
      ).toMatchObject({ ok: false, errorCode: 'computer_target_in_use' });
    } finally {
      await routes.dispose();
    }
  });

  it('releases a Manage-admitted owner-display hold when Manage narrows to Use', async () => {
    const { routes, withdraw, sessionsHolding } = fixture();
    try {
      expect(
        await select(routes, grantee('guest', 'guest-session')),
      ).toMatchObject({ selectedTarget: window });
      expect(await withdraw('guest', 'use')).toEqual({ kind: 'settled' });
      expect(sessionsHolding()).toEqual([]);
      expect(await select(routes, owner)).toMatchObject({
        selectedTarget: window,
      });
    } finally {
      await routes.dispose();
    }
  });

  it('never releases the custodian’s own selection through a requester withdrawal', async () => {
    const { routes, withdraw, sessionsHolding } = fixture();
    try {
      expect(await select(routes, owner)).toMatchObject({
        selectedTarget: window,
      });
      expect(await withdraw('owner')).toEqual({ kind: 'settled' });
      expect(sessionsHolding()).toEqual(['owner-session']);
      expect(
        await select(routes, grantee('guest', 'guest-session')),
      ).toMatchObject({ ok: false, errorCode: 'computer_target_in_use' });
    } finally {
      await routes.dispose();
    }
  });
});
