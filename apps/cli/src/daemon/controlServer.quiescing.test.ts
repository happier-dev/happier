import { describe, expect, it, vi } from 'vitest';

import { createDaemonControlApp } from './controlServer';

describe('daemon control server quiescing producer routes', () => {
  it('rejects runtime producer routes while shutdown is quiescing new work', async () => {
    const handleSessionConnectedServiceAuthSwitch = vi.fn(async () => ({ status: 'switched' }));
    const handleSessionRunnerRestart = vi.fn(async () => ({
      ok: true as const,
      status: 'restarted' as const,
      sessionId: 'sess-1',
    }));
    const handleSessionRunnerRestartAll = vi.fn(async () => ({
      ok: true as const,
      mode: 'force_current_cli' as const,
      requestedCount: 0,
      restartedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      results: [],
    }));
    const handleConnectedServiceTurnLifecycle = vi.fn(async () => ({
      status: 'continue' as const,
      turnCustody: {
        status: 'recorded' as const,
        activeTurnId: null,
      },
    }));
    const localServicesInventory = {
      getSnapshot: vi.fn(),
      refreshSnapshot: vi.fn(async () => ({
        v: 1 as const,
        machineId: 'machine_local',
        generatedAt: 1_000,
        refreshState: 'idle' as const,
        entries: [],
        diagnostics: [],
      })),
      patchLabel: vi.fn(async () => ({ ok: true as const })),
    };
    const localServicesActions = {
      execute: vi.fn(async () => ({
        v: 1 as const,
        requestId: 'local-action-1',
        action: 'copy_url' as const,
        status: 'succeeded' as const,
        auditEvents: [],
      })),
    };
    const simulatorPreview = {
      getSnapshot: vi.fn(),
      dispatchAction: vi.fn(async () => ({
        v: 1 as const,
        eventType: 'simulator.devices.list' as const,
        status: 'accepted' as const,
        diagnostics: [],
      })),
    };
    const sshTunnels = {
      ensureTunnel: vi.fn(async () => ({
        leaseId: 'lease-1',
        tunnelKey: 'ssh-tunnel:1',
        httpBaseUrl: 'http://127.0.0.1:49152',
        localPort: 49152,
        remoteHost: '127.0.0.1',
        remotePort: 8787,
        expiresAt: null,
        status: 'available' as const,
      })),
      listTunnels: vi.fn(async () => []),
      probeTunnel: vi.fn(),
      releaseTunnel: vi.fn(async () => undefined),
      stopTunnel: vi.fn(async () => undefined),
    };
    const spawnSession = vi.fn(async () => ({ type: 'success' as const, sessionId: 'happy-test-123' }));

    const app = createDaemonControlApp({
      getChildren: () => [],
      machineId: 'machine_local',
      stopSession: async () => ({ status: 'not_found' as const }),
      spawnSession,
      requestShutdown: () => {},
      isShuttingDown: () => true,
      onHappySessionWebhook: () => {},
      controlToken: 'test-token',
      handleSessionConnectedServiceAuthSwitch,
      handleSessionRunnerRestart,
      handleSessionRunnerRestartAll,
      handleConnectedServiceTurnLifecycle,
      localServicesInventory,
      localServicesActions,
      simulatorPreview,
      sshTunnels,
    });

    try {
      await app.ready();
      const headers = { 'x-happier-daemon-token': 'test-token' };
      const requests = [
        {
          url: '/spawn-session',
          payload: {},
        },
        {
          url: '/connected-service-auth/session/switch',
          payload: {
            sessionId: 'sess-1',
            agentId: 'codex',
            bindings: {
              v: 1,
              bindingsByServiceId: {
                'openai-codex': { source: 'connected', profileId: 'primary' },
              },
            },
          },
        },
        {
          url: '/session-runners/restart',
          payload: {
            sessionId: 'sess-1',
            mode: 'if_stale',
            reason: 'daemon_restart_session_runners_command',
          },
        },
        {
          url: '/session-runners/restart-all',
          payload: {
            mode: 'force_current_cli',
            reason: 'daemon_restart_session_runners_command',
          },
        },
        {
          url: '/connected-service-turn-lifecycle',
          payload: {
            sessionId: 'sess-1',
            event: 'prompt_or_steer',
          },
        },
        {
          url: '/local-services/inventory/refresh',
          payload: {},
        },
        {
          url: '/local-services/inventory/labels/patch',
          payload: {
            inventoryId: 'entry-1',
            label: { text: 'Web app' },
            source: 'user',
          },
        },
        {
          url: '/local-services/actions/execute',
          payload: {
            requestId: 'local-action-1',
            target: {
              kind: 'managed_service',
              managedServiceId: 'plugin-a:web',
              machineId: 'machine_local',
            },
            action: 'copy_url',
          },
        },
        {
          url: '/devices/simulator/preview/action',
          payload: {
            protocolVersion: 1,
            machineId: 'machine_local',
            event: { type: 'simulator.devices.list' },
          },
        },
        {
          url: '/ssh-tunnels/ensure',
          payload: {
            ssh: { target: 'dev@example.test', auth: 'agent' },
            remoteHost: '127.0.0.1',
            remotePort: 8787,
            purpose: 'remote-host-access',
          },
        },
        {
          url: '/ssh-tunnels/release',
          payload: { leaseId: 'lease-1' },
        },
        {
          url: '/ssh-tunnels/stop',
          payload: { tunnelKey: 'ssh-tunnel:1' },
        },
      ] as const;

      for (const request of requests) {
        const response = await app.inject({
          method: 'POST',
          url: request.url,
          headers,
          payload: request.payload,
        });

        expect(response.statusCode, `${request.url}: ${response.body}`).toBe(503);
        expect(response.json()).toMatchObject({ errorCode: 'daemon_shutting_down' });
      }
    } finally {
      await app.close();
    }

    expect(handleSessionConnectedServiceAuthSwitch).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
    expect(handleSessionRunnerRestart).not.toHaveBeenCalled();
    expect(handleSessionRunnerRestartAll).not.toHaveBeenCalled();
    expect(handleConnectedServiceTurnLifecycle).not.toHaveBeenCalled();
    expect(localServicesInventory.refreshSnapshot).not.toHaveBeenCalled();
    expect(localServicesInventory.patchLabel).not.toHaveBeenCalled();
    expect(localServicesActions.execute).not.toHaveBeenCalled();
    expect(simulatorPreview.dispatchAction).not.toHaveBeenCalled();
    expect(sshTunnels.ensureTunnel).not.toHaveBeenCalled();
    expect(sshTunnels.releaseTunnel).not.toHaveBeenCalled();
    expect(sshTunnels.stopTunnel).not.toHaveBeenCalled();
  });
});
