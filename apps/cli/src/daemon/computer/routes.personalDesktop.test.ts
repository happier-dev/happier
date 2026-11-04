import { describe, expect, it } from 'vitest';
import { native } from './driver/nativeComputerBoundary.testkit';
import { createComputerRoutes } from './routes';
import { createMachineLiveStreamCaptureRegistry } from '../peer/mediation/stream/captureRegistry';

const context = {
  authority: 'present_user' as const, defaultSessionId: 'guest-session',
  machineAdmission: {
    actorAccountId: 'guest', custodianAccountId: 'owner', role: 'use' as const,
    machineId: 'machine', installationId: 'installation', encryptionMode: 'plain' as const,
  },
  verifyMachineAdmissionCurrent: async () => true,
};

describe('personal desktop target boundary', () => {
  it('never lists the owner display for a use guest when their desktop authority is unavailable', async () => {
    native.call.mockImplementation(async ({ name }) => name === 'get_screen_size'
      ? { structuredContent: { width: 800, height: 600, scale_factor: 1 } }
      : name === 'list_windows' ? { structuredContent: { windows: [] } }
        : { structuredContent: { x11: true, xsend_event: true } });
    const routes = createComputerRoutes({ machineId: 'machine', defaultDisplayId: ':73',
      executablePath: '/managed/cua-driver', registry: createMachineLiveStreamCaptureRegistry() });
    try {
      const result = await routes.dispatch('computer.targets.list', { machineId: 'machine' }, context);
      expect(result).toMatchObject({ ok: false, errorCode: 'agent_isolation_unavailable' });
      expect(native.instances).toHaveLength(0);
    } finally { await routes.dispose(); }
  });

  it('does not disclose or admit the owner display through get, select or privacy settings for a use guest', async () => {
    const routes = createComputerRoutes({ machineId: 'machine', defaultDisplayId: ':73',
      executablePath: '/managed/cua-driver', registry: createMachineLiveStreamCaptureRegistry() });
    try {
      for (const [actionId, input] of [
        ['computer.target.get', { machineId: 'machine' }],
        ['computer.target.select', { machineId: 'machine', target: { kind: 'display', displayId: ':73' } }],
        ['computer.permissions.openSettings', { machineId: 'machine', permission: 'capture' }],
      ] as const) {
        expect(await routes.dispatch(actionId, input, context)).toMatchObject({ ok: false });
      }
      expect(native.instances).toHaveLength(0);
    } finally { await routes.dispose(); }
  });

  it('keeps the owner and admitted Machine manager on the existing display path', async () => {
    const routes = createComputerRoutes({ machineId: 'machine', defaultDisplayId: ':73',
      registry: createMachineLiveStreamCaptureRegistry() });
    try {
      const owner = await routes.dispatch('computer.target.get', { machineId: 'machine' }, {
        authority: 'account_automation', defaultSessionId: 'owner-session',
      });
      expect(owner).not.toMatchObject({ ok: false });
      expect(await routes.dispatch('computer.target.get', { machineId: 'machine' }, {
        ...context, machineAdmission: { ...context.machineAdmission, role: 'manage' },
      })).toEqual(owner);
    } finally { await routes.dispose(); }
  });
});
