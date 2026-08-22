import { describe, expect, it, vi } from 'vitest';

import { DaemonPluginInvocationLogReadRequestV1Schema } from '@happier-dev/protocol';

import { createDaemonPluginInvocationLogReadHandler } from './daemonPluginInvocationLogs';

const request = DaemonPluginInvocationLogReadRequestV1Schema.parse({
  version: 1,
  target: {
    serverIdentityId: 'srv_plugin_logs',
    machineId: 'machine-logs',
  },
  query: {
    pluginId: 'acme.example',
    generation: 'generation-1',
    correlationId: 'correlation-1',
  },
});

describe('daemon plugin invocation log RPC handler', () => {
  it('rejects a stale or cross-machine target before the canonical logger can read', async () => {
    const readLogs = vi.fn();
    const handler = createDaemonPluginInvocationLogReadHandler({
      resolveCurrentTarget: async () => ({
        serverIdentityId: 'srv_plugin_logs',
        machineId: 'machine-current',
      }),
      readLogs,
    });

    await expect(handler(request)).resolves.toEqual({
      version: 1,
      kind: 'unavailable',
      code: 'plugin_log_target_mismatch',
    });
    expect(readLogs).not.toHaveBeenCalled();
  });

  it('honors cancellation before resolving target currentness or reading logs', async () => {
    const controller = new AbortController();
    const cancelled = new Error('cancelled');
    controller.abort(cancelled);
    const resolveCurrentTarget = vi.fn(async () => ({
      serverIdentityId: 'srv_plugin_logs',
      machineId: 'machine-logs',
    }));
    const readLogs = vi.fn();
    const handler = createDaemonPluginInvocationLogReadHandler({
      resolveCurrentTarget,
      readLogs,
    });

    await expect(handler(request, { signal: controller.signal })).rejects.toBe(cancelled);
    expect(resolveCurrentTarget).not.toHaveBeenCalled();
    expect(readLogs).not.toHaveBeenCalled();
  });

  it('rechecks cancellation after target currentness resolves before reading the logger', async () => {
    const controller = new AbortController();
    const cancelled = new Error('cancelled-after-currentness');
    const readLogs = vi.fn();
    const handler = createDaemonPluginInvocationLogReadHandler({
      resolveCurrentTarget: async () => {
        controller.abort(cancelled);
        return {
          serverIdentityId: 'srv_plugin_logs',
          machineId: 'machine-logs',
        };
      },
      readLogs,
    });

    await expect(handler(request, { signal: controller.signal })).rejects.toBe(cancelled);
    expect(readLogs).not.toHaveBeenCalled();
  });
});
