import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeSocket, getSocketHandler } from '../testkit/socketHarness';

const updateMany = vi.fn();
const machineFindFirst = vi.fn();
const markAccountChanged = vi.fn(async () => 17);

vi.mock('@/app/events/eventRouter', () => ({
  eventRouter: { emitEphemeral: vi.fn(), emitUpdate: vi.fn() },
  buildMachineActivityEphemeral: vi.fn(),
  buildUpdateMachineUpdate: vi.fn(),
}));
vi.mock('@/app/monitoring/metrics/index', () => ({
  machineAliveEventsCounter: { inc: vi.fn() },
  websocketEventsCounter: { inc: vi.fn() },
}));
vi.mock('@/app/presence/sessionCache', () => ({
  activityCache: { invalidateMachine: vi.fn(), isMachineValid: vi.fn() },
}));
vi.mock('@/app/presence/presenceRecorder', () => ({ recordMachineAlive: vi.fn() }));
vi.mock('@/app/presence/publishSessionPublisherClose', () => ({
  publishSessionPublisherClose: vi.fn(),
}));
vi.mock('@/storage/db', () => ({
  db: { machine: { findFirst: machineFindFirst } },
}));
vi.mock('@/storage/inTx', () => ({
  afterTx: vi.fn((_tx: unknown, callback: () => void) => callback()),
  inTx: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) => await callback({
    machine: { findFirst: machineFindFirst, updateMany },
  })),
}));
vi.mock('@/app/changes/markAccountChanged', () => ({ markAccountChanged }));
vi.mock('@/utils/keys/randomKeyNaked', () => ({ randomKeyNaked: vi.fn(() => 'change') }));
vi.mock('@/utils/logging/log', () => ({ log: vi.fn() }));
vi.mock('@/app/session/externalSessionHistoricalImportCommand', () => ({
  executeExternalSessionHistoricalImportCommand: vi.fn(),
}));

const options = {
  operationSocketBatchLimits: {
    ok: true as const,
    limits: { maxItems: 200, maxSerializedBytes: 524_288 },
  },
};

describe('machine operation protocol capability projection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    machineFindFirst.mockResolvedValue({
      revokedAt: null,
      replacedByMachineId: null,
      operationProtocolCapabilitiesRevision: 7,
    });
    updateMany.mockResolvedValue({ count: 1 });
  });

  it('replaces the complete authenticated projection and advances its revision', async () => {
    const { machineUpdateHandler } = await import('./machineUpdateHandler');
    const socket = createFakeSocket({
      data: { clientType: 'machine-scoped', machineId: 'machine-1' },
    });
    machineUpdateHandler('account-1', socket as never, options);
    const callback = vi.fn();

    await getSocketHandler(socket, 'machine-update-operation-protocol-capabilities')({
      machineId: 'machine-1',
      capabilities: {
        sessionSpawn: { protocolVersions: [1] },
      },
    }, callback);

    expect(updateMany).toHaveBeenCalledWith({
      where: {
        accountId: 'account-1',
        id: 'machine-1',
        revokedAt: null,
        replacedByMachineId: null,
        operationProtocolCapabilitiesRevision: 7,
      },
      data: {
        operationProtocolCapabilities: {
          sessionSpawn: { protocolVersions: [1] },
        },
        operationProtocolCapabilitiesRevision: 8,
      },
    });
    expect(markAccountChanged).toHaveBeenCalledWith(expect.anything(), {
      accountId: 'account-1',
      kind: 'machine',
      entityId: 'machine-1',
    });
    expect(callback).toHaveBeenCalledWith({ v: 1, result: 'success', revision: 8 });
  });

  it('withdraws every older leaf when the next complete projection is empty', async () => {
    machineFindFirst.mockResolvedValueOnce({
      revokedAt: null,
      replacedByMachineId: null,
      operationProtocolCapabilitiesRevision: 7,
      operationProtocolCapabilities: {
        sessionInputAdmission: { protocolVersions: [1] },
      },
    });
    const { machineUpdateHandler } = await import('./machineUpdateHandler');
    const socket = createFakeSocket({
      data: { clientType: 'machine-scoped', machineId: 'machine-1' },
    });
    machineUpdateHandler('account-1', socket as never, options);
    const callback = vi.fn();

    await getSocketHandler(socket, 'machine-update-operation-protocol-capabilities')({
      capabilities: {},
    }, callback);

    expect(updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: {
        operationProtocolCapabilities: {},
        operationProtocolCapabilitiesRevision: 8,
      },
    }));
    expect(callback).toHaveBeenCalledWith({ v: 1, result: 'success', revision: 8 });
  });

  it('rejects malformed projections without mutating the Machine', async () => {
    const { machineUpdateHandler } = await import('./machineUpdateHandler');
    const socket = createFakeSocket({
      data: { clientType: 'machine-scoped', machineId: 'machine-1' },
    });
    machineUpdateHandler('account-1', socket as never, options);
    const callback = vi.fn();

    await getSocketHandler(socket, 'machine-update-operation-protocol-capabilities')({
      capabilities: {
        sessionSpawn: { protocolVersions: [1], stale: true },
      },
    }, callback);

    expect(updateMany).not.toHaveBeenCalled();
    expect(markAccountChanged).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({ v: 1, result: 'error', code: 'invalid_request' });
  });

  it.each([
    ['revoked', { revokedAt: new Date(1), replacedByMachineId: null }],
    ['replaced', { revokedAt: null, replacedByMachineId: 'machine-replacement' }],
  ])('does not let a %s socket overwrite its prior complete projection', async (_state, unavailableState) => {
    machineFindFirst.mockResolvedValueOnce({
      ...unavailableState,
      operationProtocolCapabilitiesRevision: 7,
    });
    const { machineUpdateHandler } = await import('./machineUpdateHandler');
    const socket = createFakeSocket({
      data: { clientType: 'machine-scoped', machineId: 'machine-1' },
    });
    machineUpdateHandler('account-1', socket as never, options);
    const callback = vi.fn();

    await getSocketHandler(socket, 'machine-update-operation-protocol-capabilities')({
      capabilities: { sessionSpawn: { protocolVersions: [1] } },
    }, callback);

    expect(updateMany).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({ v: 1, result: 'error', code: 'machine_unavailable' });
  });
});
