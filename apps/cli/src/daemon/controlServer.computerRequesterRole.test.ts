import { describe, expect, it, vi } from 'vitest';

import { createDaemonControlApp } from './controlServer';
import { createDaemonRuntimeActionExecutor } from './runtimeActionExecutor';
import { createComputerRoutes } from './computer/routes';
import { createMachineLiveStreamCaptureRegistry } from './peer/mediation/stream/captureRegistry';
import { BROWSER_RUNTIME_ACTION_CONTROL_PATH } from './browser/actions/controlTransport';
import { buildDaemonControlHttpHeaders } from './controlHttp';
import type { TrackedSession } from './types';
import { native } from './computer/driver/nativeComputerBoundary.testkit';
import { legacyPidSessionTrackingKey } from '@/daemon/sessions/sessionTrackingKey';

// With isolation Off, a personal desktop starts a private worker rather than
// preparing a member. Refuse that OS boundary; never start a real desktop here.
vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  spawn: vi.fn(() => { throw Object.assign(new Error('Separated native desktop unavailable'), { code: 'agent_isolation_unavailable' }); }),
}));

// Own-desktop admission consumes the tracked Session's private custody through
// the real control route, daemon executor and Computer owner.
function requesterSession(
  sessionId: string,
  role: 'use' | 'manage' | undefined,
): TrackedSession {
  return {
    trackingKey: legacyPidSessionTrackingKey(4242), startedBy: 'daemon',
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
  it('uses the owner desktop for an owner Session birth without a Machine-role receipt and keeps another person separated', async () => {
    // The native MCP subprocess is the system boundary; requester admission and
    // desktop selection remain real. Listing must actually acquire the desktop.
    native.call.mockImplementation(async ({ name }) => name === 'list_windows'
      ? { structuredContent: { windows: [{ pid: 42, window_id: 123, title: 'Synthetic canary' }] } }
      : { isError: true, content: [] });
    const children = ['owner', 'guest'].map(accountId => ({
      trackingKey: legacyPidSessionTrackingKey(4242), startedBy: 'daemon', happySessionId: `${accountId}-agent-session`, pid: 4242,
      requesterSessionRuntimeContext: { bootstrap: {
        attribution: { serverId: 'home', accountId, machineId: 'machine', installationId: 'installation' },
        homeServerIdentityId: 'home', savedSecretOperationContext: {},
      } },
    } as unknown as TrackedSession));
    const computer = createComputerRoutes({ machineId: 'machine', defaultDisplayId: ':73', executablePath: '/managed/cua-driver',
      registry: createMachineLiveStreamCaptureRegistry(), requesterHost: {
        custodianAccountId: 'owner', installationId: 'installation', readHomeServerIdentityId: async () => 'home',
        prepareNativeOperation: async () => { throw Object.assign(new Error('Separated native desktop unavailable'), { code: 'agent_isolation_unavailable' }); },
      } });
    const app = createDaemonControlApp({ getChildren: () => children, machineId: 'machine', controlToken: 'control-token',
      stopSession: async () => ({ status: 'not_found' }), spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {},
      runtimeActionExecute: createDaemonRuntimeActionExecutor({ env: {},
        resolveRouteOwners: () => ({ computer }), resolveServerFeaturesSnapshot: () => undefined }),
    });
    const call = async (accountId: string) => (await app.inject({ method: 'POST', url: BROWSER_RUNTIME_ACTION_CONTROL_PATH,
      headers: buildDaemonControlHttpHeaders('control-token'), payload: { actionId: 'computer.targets.list',
        input: { machineId: 'machine' }, sessionId: `${accountId}-agent-session` } })).json().result;
    try {
      const owner = await call('owner');
      expect(owner, JSON.stringify(owner)).toMatchObject({ targets: [{ title: 'Synthetic canary' }] });
      expect(await call('guest')).toMatchObject({ ok: false, errorCode: 'plugin_exec_spawn_failed' });
    } finally { await app.close(); await computer.dispose(); }
  });
  it('keeps standalone owner MCP capture and query on the owner desktop without reading a synthetic Session birth', async () => {
    const birthReads: string[] = [];
    const computer = createComputerRoutes({ machineId: 'machine', defaultDisplayId: ':73',
      executablePath: '/managed/cua-driver', registry: createMachineLiveStreamCaptureRegistry(),
      requesterHost: {
        custodianAccountId: 'owner', installationId: 'installation', readHomeServerIdentityId: async () => 'home',
        readSessionRequester: async sessionId => {
          birthReads.push(sessionId);
          throw Object.assign(new Error('No Session birth exists'), { code: 'agent_isolation_unavailable' });
        },
        prepareNativeOperation: async () => { throw new Error('Owner automation needs no personal desktop'); },
      },
    });
    const app = createDaemonControlApp({
      getChildren: () => [], machineId: 'machine', controlToken: 'control-token',
      stopSession: async () => ({ status: 'not_found' }),
      spawnSession: async () => ({ type: 'success', sessionId: 'unused' }),
      requestShutdown: () => {}, onHappySessionWebhook: () => {},
      runtimeActionExecute: createDaemonRuntimeActionExecutor({ env: {},
        resolveRouteOwners: () => ({ computer }), resolveServerFeaturesSnapshot: () => undefined }),
    });
    try {
      for (const actionId of ['computer.capture', 'computer.query'] as const) {
        const response = await app.inject({ method: 'POST', url: BROWSER_RUNTIME_ACTION_CONTROL_PATH,
          headers: buildDaemonControlHttpHeaders('control-token'),
          payload: { actionId, input: { machineId: 'machine' }, sessionId: 'cli-global' } });
        expect(response.statusCode).toBe(200);
        expect(response.json().result).toMatchObject({ status: 'target_selection_required' });
      }
      expect(birthReads).toEqual([]);
      // A genuine missing Session still requires its private birth; it cannot
      // inherit the standalone owner path merely because recovery failed.
      const unknown = await app.inject({ method: 'POST', url: BROWSER_RUNTIME_ACTION_CONTROL_PATH,
        headers: buildDaemonControlHttpHeaders('control-token'),
        payload: { actionId: 'computer.target.get', input: { machineId: 'machine' }, sessionId: 'missing-session' } });
      expect(unknown.json().result).toMatchObject({ ok: false, errorCode: 'agent_isolation_unavailable' });
      expect(birthReads).toEqual(['missing-session']);
    } finally { await app.close(); await computer.dispose(); }
  });
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
        trackingKey: legacyPidSessionTrackingKey(4343), startedBy: 'daemon',
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
