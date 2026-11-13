import { describe, expect, it, vi } from 'vitest';
import { RPC_ERROR_CODES } from '@happier-dev/protocol/rpcErrors';

import { createDaemonControlApp } from './controlServer';
import { MACHINE_ROLE_CONTROL_ROUTES } from './roles/machineRoleRpcNamespaces';

describe('daemon control server: Machine role routes', () => {
  it('refuses new Sessions typed while the sessions role is off, after authentication, and serves them once it is on', async () => {
    let sessionsActive = false;
    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'session-1' }));
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession, requestShutdown: () => {}, onHappySessionWebhook: () => {}, controlToken: 'test-token',
      isMachineRoleActive: roleId => roleId !== 'sessions' || sessionsActive,
    });
    try {
      await app.ready();
      const headers = { 'Content-Type': 'application/json', 'x-happier-daemon-token': 'test-token' };
      const body = JSON.stringify({ directory: '/tmp', spawnNonce: 'roles-off' });
      // Every route the sessions role owns is a real route of this app.
      for (const url of MACHINE_ROLE_CONTROL_ROUTES.sessions) {
        expect(app.hasRoute({ method: 'POST', url }), url).toBe(true);
        const refused = await app.inject({ method: 'POST', url, headers, payload: body });
        expect(refused.statusCode, url).toBe(503);
        expect(refused.json(), url).toEqual({ success: false, error: expect.any(String),
          errorCode: RPC_ERROR_CODES.MACHINE_ROLE_INACTIVE, roleId: 'sessions' });
      }
      // Authentication still answers first: role state is not readable without the control token.
      expect((await app.inject({ method: 'POST', url: '/spawn-session',
        headers: { 'Content-Type': 'application/json' }, payload: body })).statusCode).toBe(401);
      expect(spawnSession).not.toHaveBeenCalled();
      // Machine core routes are unaffected.
      expect((await app.inject({ method: 'POST', url: '/stop-session', headers,
        payload: JSON.stringify({ sessionId: 'session-1' }) })).statusCode).not.toBe(503);

      sessionsActive = true;
      const served = await app.inject({ method: 'POST', url: '/spawn-session', headers,
        payload: JSON.stringify({ directory: '/tmp', spawnNonce: 'roles-on' }) });
      expect(served.json()).toMatchObject({ success: true, sessionId: 'session-1' });
      expect(spawnSession).toHaveBeenCalledOnce();
    } finally {
      await app.close();
    }
  });
});
