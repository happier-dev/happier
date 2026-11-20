import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import fastify, { type FastifyInstance } from 'fastify';
import { createDeferred } from '@/testkit/async/deferred';
import { installAxiosFastifyAdapter } from '@/testkit/http/axiosAdapter';

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
  it('accepts a current Machine snapshot while dropping stored capability extras', () => {
    expect(readMachineOperationProtocolCapabilitiesProjectionV1({
      machineId: 'machine-1',
      value: {
        ...validMachineSnapshot,
        operationProtocolCapabilities: {
          sessionSpawn: { protocolVersions: [1], extra: true },
          futureCapability: { protocolVersions: [1] },
        },
      },
    })).toEqual({
      capabilities: {
        sessionSpawn: { protocolVersions: [1] },
      },
      revision: 4,
    });
  });

  it('drops a malformed capability while preserving a valid sibling and revision', () => {
    const projection = readMachineOperationProtocolCapabilitiesProjectionV1({
      machineId: 'machine-1',
      value: {
        ...validMachineSnapshot,
        operationProtocolCapabilities: {
          sessionSpawn: { protocolVersions: [2] },
          finiteTransferRpc: { protocolVersions: [1] },
        },
      },
    });

    expect(projection?.capabilities.sessionSpawn).toBeUndefined();
    expect(projection?.capabilities.finiteTransferRpc).toEqual({ protocolVersions: [1] });
    expect(projection?.revision).toBe(4);
  });

  it.each([
    ['missing capability projection', { ...validMachineSnapshot, operationProtocolCapabilities: undefined }],
    ['malformed capability projection', { ...validMachineSnapshot, operationProtocolCapabilities: [] }],
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
  const path = '/v1/machines/machine-1';
  let app: FastifyInstance;
  let restoreAdapter: () => void;

  beforeEach(() => {
    app = fastify();
    restoreAdapter = installAxiosFastifyAdapter({ app, origin: 'https://api.example.test' });
  });

  afterEach(async () => {
    restoreAdapter();
    await app.close();
  });

  it('reads the exact Machine snapshot from the configured server with caller cancellation', async () => {
    let requests = 0;
    const requestStarted = createDeferred();
    const releaseResponse = createDeferred();
    app.get(path, async (request) => {
      requests++;
      expect(request.headers.authorization).toBe('Bearer account-token');
      if (requests === 2) {
        requestStarted.resolve();
        await releaseResponse.promise;
      }
      return { machine: validMachineSnapshot };
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

    const pending = readMachineOperationProtocolCapabilitiesV1({
      credentials: { token: 'account-token' },
      machineId: 'machine-1',
      signal: controller.signal,
    });
    const cancelled = expect(pending).rejects.toMatchObject({ code: 'ERR_CANCELED' });
    await requestStarted.promise;
    controller.abort();
    releaseResponse.resolve();
    await cancelled;
    expect(requests).toBe(2);
  });

  it('treats a missing exact Machine as incompatible without a fallback target', async () => {
    app.get(path, async (_request, reply) => reply.code(404).send({ error: 'Machine not found' }));

    await expect(readMachineOperationProtocolCapabilitiesV1({
      credentials: { token: 'account-token' },
      machineId: 'machine-1',
    })).resolves.toBeNull();
  });

  it('preserves an authentication rejection instead of relabeling it as incompatibility', async () => {
    app.get(path, async (_request, reply) => reply.code(401).send({ error: 'not-authenticated' }));

    await expect(readMachineOperationProtocolCapabilitiesV1({
      credentials: { token: 'expired-token' },
      machineId: 'machine-1',
    })).rejects.toMatchObject({
      name: 'HttpStatusError',
      response: { status: 401 },
    });
  });
});
