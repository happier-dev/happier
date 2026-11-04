import { describe, expect, it } from 'vitest';

import { createDaemonControlApp } from './controlServer';
import { createDaemonRuntimeActionExecutor } from './runtimeActionExecutor';
import { createComputerRoutes } from './computer/routes';
import { createMachineLiveStreamCaptureRegistry } from './peer/mediation/stream/captureRegistry';
import { BROWSER_RUNTIME_ACTION_CONTROL_PATH } from './browser/actions/controlTransport';
import { buildDaemonControlHttpHeaders } from './controlHttp';
import type { TrackedSession } from './types';

// Own-desktop admission consumes the tracked Session's private custody through
// the real control route, daemon executor and Computer owner.
function requesterSession(
  sessionId: string,
  role: 'use' | 'manage' | undefined,
): TrackedSession {
  return {
    startedBy: 'daemon',
    happySessionId: sessionId,
    pid: 4242,
    requesterSessionRuntimeContext: {
      bootstrap: {
        attribution: { serverId: 'home', accountId: 'guest', machineId: 'machine', installationId: 'installation' },
        homeServerIdentityId: 'home',
        savedSecretOperationContext: {
          machineAdmission: {
            actorAccountId: 'guest',
            custodianAccountId: 'owner',
            ...(role ? { role } : {}),
          },
        },
      },
    },
  } as unknown as TrackedSession;
}

describe('daemon admission of a Session computer Action', () => {
  it('scopes use guests to their desktop, refuses missing custody, and preserves Manage and owner Sessions', async () => {
    const computer = createComputerRoutes({
      machineId: 'machine',
      machineDisplayName: 'Workstation',
      registry: createMachineLiveStreamCaptureRegistry(),
    });
    const children = [
      requesterSession('guest_view', 'use'),
      requesterSession('guest_unknown', undefined),
      requesterSession('guest_manage', 'manage'),
      {
        startedBy: 'daemon',
        happySessionId: 'owner_session',
        pid: 4343,
      } as TrackedSession,
    ];
    const app = createDaemonControlApp({
      getChildren: () => children,
      machineId: 'machine',
      stopSession: async () => ({ status: 'not_found' }),
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {},
      onHappySessionWebhook: () => {},
      controlToken: 'control-token',
      runtimeActionExecute: createDaemonRuntimeActionExecutor({
        env: {},
        resolveRouteOwners: () => ({ computer }),
        resolveServerFeaturesSnapshot: () => undefined,
      }),
    });
    const call = async (sessionId: string) =>
      JSON.parse(
        (
          await app.inject({
            method: 'POST',
            url: BROWSER_RUNTIME_ACTION_CONTROL_PATH,
            headers: buildDaemonControlHttpHeaders('control-token'),
            payload: {
              actionId: 'computer.target.get',
              input: { machineId: 'machine' },
              sessionId,
            },
          })
        ).body,
      ).result;
    try {
      for (const sessionId of ['guest_unknown']) {
        expect(await call(sessionId), sessionId).toEqual({
          ok: false,
          errorCode: 'access_denied',
          error: 'access_denied',
        });
      }
      // An admitted use guest now reaches their desktop owner. Without the
      // host's launch custody it settles unavailable, never on the owner display.
      expect(await call('guest_view')).toMatchObject({ ok: false, errorCode: 'agent_isolation_unavailable' });
      // Admitted Sessions reach the computer owner, which answers with this host's display state.
      const owner = await call('owner_session');
      expect(owner).not.toMatchObject({ errorCode: 'access_denied' });
      expect(await call('guest_manage')).toEqual(owner);
    } finally {
      await app.close();
      await computer.dispose();
    }
  });
});
