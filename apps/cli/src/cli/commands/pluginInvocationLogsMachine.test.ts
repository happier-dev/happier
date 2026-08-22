import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createRpcCallError,
  DaemonPluginInvocationLogReadResponseV1Schema,
} from '@happier-dev/protocol';
import { RPC_ERROR_CODES, RPC_METHODS } from '@happier-dev/protocol/rpc';

const boundaries = vi.hoisted(() => ({
  axiosGet: vi.fn(),
  readStoredCredentials: vi.fn(),
  fetchServerFeaturesSnapshot: vi.fn(),
  callMachineRpc: vi.fn(),
}));

vi.mock('axios', () => ({
  default: { get: boundaries.axiosGet },
}));

vi.mock('@/api/clientCompatibility/cliClientCompatibility', () => ({
  buildCurrentAccountStoredContentCompatibilityHttpHeaders: () => ({
    'X-Happier-Account-Content': 'current',
  }),
}));

vi.mock('@/api/client/serverHttpBaseUrl', () => ({
  resolveServerHttpBaseUrl: () => 'https://api.example.test',
}));

vi.mock('@/features/serverFeaturesClient', () => ({
  fetchServerFeaturesSnapshot: boundaries.fetchServerFeaturesSnapshot,
}));

vi.mock('@/persistence', () => ({
  readStoredCredentials: boundaries.readStoredCredentials,
}));

vi.mock('@/session/transport/rpc/machineRpc', () => ({
  callMachineRpc: boundaries.callMachineRpc,
}));

import {
  readPluginInvocationLogsOnMachine,
  resolvePluginInvocationLogTarget,
} from './pluginInvocationLogsMachine';

const target = {
  serverIdentityId: 'srv_plugin_logs',
  serverLabel: 'https://public.example.test',
  machineId: 'machine-2',
  machineLabel: 'build-host',
} as const;

function currentMachine(id: string, host: string) {
  return {
    id,
    metadata: JSON.stringify({ host }),
    active: true,
    revokedAt: null,
    replacedByMachineId: null,
  };
}

beforeEach(() => {
  boundaries.axiosGet.mockReset();
  boundaries.readStoredCredentials.mockReset();
  boundaries.fetchServerFeaturesSnapshot.mockReset();
  boundaries.callMachineRpc.mockReset();
  boundaries.readStoredCredentials.mockResolvedValue({ token: 'token-1', encryption: null });
  boundaries.fetchServerFeaturesSnapshot.mockResolvedValue({
    status: 'ready',
    features: {
      capabilities: {
        serverIdentity: { serverIdentityId: 'srv_plugin_logs' },
        server: { canonicalServerUrl: 'https://public.example.test' },
      },
    },
  });
});

describe('plugin invocation log exact-machine transport', () => {
  it('selects only the requested current machine from the authenticated inventory', async () => {
    boundaries.axiosGet.mockResolvedValue({
      data: [
        currentMachine('machine-1', 'laptop'),
        currentMachine('machine-2', 'build-host'),
      ],
    });

    await expect(resolvePluginInvocationLogTarget({ requestedMachineId: 'machine-2' })).resolves.toEqual({
      kind: 'selected',
      target,
    });
    expect(boundaries.axiosGet).toHaveBeenCalledWith(
      'https://api.example.test/v1/machines',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
          'X-Happier-Account-Content': 'current',
        }),
      }),
    );
  });

  it('refuses an explicit revoked machine instead of selecting another inventory entry', async () => {
    boundaries.axiosGet.mockResolvedValue({
      data: [
        currentMachine('machine-current', 'laptop'),
        {
          ...currentMachine('machine-stale', 'old-laptop'),
          revokedAt: 1,
        },
      ],
    });

    await expect(resolvePluginInvocationLogTarget({ requestedMachineId: 'machine-stale' })).resolves.toMatchObject({
      kind: 'unavailable',
      code: 'machine_not_current',
    });
  });

  it('maps an older target daemon that lacks the method to a typed unsupported result without fallback', async () => {
    boundaries.callMachineRpc.mockRejectedValue(createRpcCallError({
      error: 'Method not found',
      errorCode: RPC_ERROR_CODES.METHOD_NOT_FOUND,
    }));

    await expect(readPluginInvocationLogsOnMachine({
      target,
      request: {
        pluginId: 'acme.example',
        generation: 'generation-1',
        correlationId: 'correlation-1',
      },
    })).resolves.toEqual({ kind: 'unavailable', code: 'daemon_plugin_log_read_unsupported' });
    expect(boundaries.callMachineRpc).toHaveBeenCalledWith(expect.objectContaining({
      machineId: 'machine-2',
      method: RPC_METHODS.DAEMON_PLUGIN_INVOCATION_LOGS_READ,
      request: expect.objectContaining({
        target: {
          serverIdentityId: 'srv_plugin_logs',
          machineId: 'machine-2',
        },
        query: {
          pluginId: 'acme.example',
          generation: 'generation-1',
          correlationId: 'correlation-1',
        },
      }),
    }));
  });

  it('preserves the exact host-stamped correlation filter and cancellation boundary', async () => {
    boundaries.callMachineRpc.mockResolvedValue(DaemonPluginInvocationLogReadResponseV1Schema.parse({
      version: 1,
      kind: 'available',
      records: [],
      cursor: 0,
      hasMore: false,
    }));

    await expect(readPluginInvocationLogsOnMachine({
      target,
      request: { pluginId: 'acme.example', correlationId: 'only-this-invocation' },
    })).resolves.toMatchObject({ kind: 'available', records: [] });
    expect(boundaries.callMachineRpc).toHaveBeenLastCalledWith(expect.objectContaining({
      request: expect.objectContaining({
        query: { pluginId: 'acme.example', correlationId: 'only-this-invocation' },
      }),
    }));

    const callsBeforeCancellation = boundaries.callMachineRpc.mock.calls.length;
    const controller = new AbortController();
    const cancelled = new Error('cancelled');
    controller.abort(cancelled);
    await expect(readPluginInvocationLogsOnMachine({
      target,
      request: { pluginId: 'acme.example' },
      signal: controller.signal,
    })).rejects.toBe(cancelled);
    expect(boundaries.callMachineRpc).toHaveBeenCalledTimes(callsBeforeCancellation);
  });
});
