import { beforeEach, describe, expect, it, vi } from 'vitest';

const axiosGet = vi.hoisted(() => vi.fn());

vi.mock('axios', () => ({
  default: {
    get: (...args: unknown[]) => axiosGet(...args),
  },
}));

vi.mock('@/api/client/serverHttpBaseUrl', () => ({
  resolveServerHttpBaseUrl: () => 'https://api.example.test',
}));

import {
  readMachineOperationProtocolCapabilitiesV1,
  readMachineOperationProtocolCapabilitiesProjectionV1,
} from './machineOperationProtocolCapabilities';

const validMachineSnapshot = {
  id: 'machine-1',
  revokedAt: null,
  replacedByMachineId: null,
  operationProtocolCapabilities: {
    sessionSpawn: { protocolVersions: [1] },
  },
  operationProtocolCapabilitiesRevision: 4,
};

describe('readMachineOperationProtocolCapabilitiesProjectionV1', () => {
  it('accepts only a current complete strict Machine capability snapshot', () => {
    expect(readMachineOperationProtocolCapabilitiesProjectionV1({
      machineId: 'machine-1',
      value: validMachineSnapshot,
    })).toEqual({
      capabilities: {
        sessionSpawn: { protocolVersions: [1] },
      },
      revision: 4,
    });
  });

  it.each([
    ['missing capability projection', { ...validMachineSnapshot, operationProtocolCapabilities: undefined }],
    ['malformed capability projection', {
      ...validMachineSnapshot,
      operationProtocolCapabilities: { sessionSpawn: { protocolVersions: [1], extra: true } },
    }],
    ['missing revision', { ...validMachineSnapshot, operationProtocolCapabilitiesRevision: null }],
    ['non-positive revision', { ...validMachineSnapshot, operationProtocolCapabilitiesRevision: 0 }],
    ['revoked Machine', { ...validMachineSnapshot, revokedAt: 1 }],
    ['replaced Machine', { ...validMachineSnapshot, replacedByMachineId: 'machine-2' }],
    ['wrong Machine identity', { ...validMachineSnapshot, id: 'machine-2' }],
  ])('fails closed for a %s', (_name, value) => {
    expect(readMachineOperationProtocolCapabilitiesProjectionV1({
      machineId: 'machine-1',
      value,
    })).toBeNull();
  });
});

describe('readMachineOperationProtocolCapabilitiesV1', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reads the exact Machine snapshot from the configured server with caller cancellation', async () => {
    axiosGet.mockResolvedValue({
      status: 200,
      data: { machine: validMachineSnapshot },
    });
    const controller = new AbortController();

    await expect(readMachineOperationProtocolCapabilitiesV1({
      credentials: { token: 'account-token' },
      machineId: 'machine-1',
      signal: controller.signal,
    })).resolves.toEqual({
      capabilities: {
        sessionSpawn: { protocolVersions: [1] },
      },
      revision: 4,
    });

    expect(axiosGet).toHaveBeenCalledWith(
      'https://api.example.test/v1/machines/machine-1',
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer account-token' }),
        signal: controller.signal,
      }),
    );
  });

  it('treats a missing exact Machine as incompatible without a fallback target', async () => {
    axiosGet.mockResolvedValue({ status: 404, data: { error: 'Machine not found' } });

    await expect(readMachineOperationProtocolCapabilitiesV1({
      credentials: { token: 'account-token' },
      machineId: 'machine-1',
    })).resolves.toBeNull();
  });

  it('preserves an authentication rejection instead of relabeling it as incompatibility', async () => {
    axiosGet.mockResolvedValue({ status: 401, data: { error: 'not-authenticated' } });

    await expect(readMachineOperationProtocolCapabilitiesV1({
      credentials: { token: 'expired-token' },
      machineId: 'machine-1',
    })).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 401 },
    });
  });
});
