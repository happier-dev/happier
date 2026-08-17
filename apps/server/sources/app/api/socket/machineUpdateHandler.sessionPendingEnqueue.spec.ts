import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createFakeSocket, getSocketHandler } from '../testkit/socketHarness';

const enqueuePendingMessageByAuthenticatedMachine = vi.fn();
const readMachineAvailabilityState = vi.fn(async () => 'available');

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
vi.mock('@/app/machines/machineStateGuards', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/app/machines/machineStateGuards')>()),
  readMachineAvailabilityState,
}));
vi.mock('@/app/session/pending/pendingMessageService', () => ({
  enqueuePendingMessageByAuthenticatedMachine,
}));
vi.mock('@/storage/db', () => ({ db: {} }));
vi.mock('@/storage/inTx', () => ({ afterTx: vi.fn(), inTx: vi.fn() }));
vi.mock('@/app/changes/markAccountChanged', () => ({ markAccountChanged: vi.fn() }));
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

const request = {
  v: 1 as const,
  sessionId: 'session-1',
  targetMachineId: 'machine-target',
  localId: 'plugin-input-v1:abc',
  content: {
    t: 'plain' as const,
    v: { role: 'user', content: { type: 'text', text: 'hello' } },
  },
  requestedAction: { v: 1 as const, kind: 'enqueue' as const },
};

describe('machine Session Pending enqueue', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readMachineAvailabilityState.mockResolvedValue('available');
    enqueuePendingMessageByAuthenticatedMachine.mockResolvedValue({
      status: 'accepted',
      localId: request.localId,
    });
  });

  it('stamps the authenticated source Machine and preserves only the exact target routing fact', async () => {
    const { machineUpdateHandler } = await import('./machineUpdateHandler');
    const socket = createFakeSocket({
      data: { clientType: 'machine-scoped', machineId: 'machine-source' },
    });
    machineUpdateHandler('account-1', socket as never, options);
    const callback = vi.fn();

    await getSocketHandler(socket, 'session-pending-enqueue-by-machine-v1')(request, callback);

    expect(enqueuePendingMessageByAuthenticatedMachine).toHaveBeenCalledWith({
      accountId: 'account-1',
      sourceMachineId: 'machine-source',
      targetMachineId: 'machine-target',
      sessionId: 'session-1',
      localId: 'plugin-input-v1:abc',
      content: request.content,
      requestedAction: request.requestedAction,
    });
    expect(callback).toHaveBeenCalledWith({
      v: 1,
      result: { status: 'accepted', localId: request.localId },
    });
  });

  it('rejects an unavailable authenticated source before exposing target state', async () => {
    readMachineAvailabilityState.mockResolvedValueOnce('revoked');
    const { machineUpdateHandler } = await import('./machineUpdateHandler');
    const socket = createFakeSocket({
      data: { clientType: 'machine-scoped', machineId: 'machine-source' },
    });
    machineUpdateHandler('account-1', socket as never, options);
    const callback = vi.fn();

    await getSocketHandler(socket, 'session-pending-enqueue-by-machine-v1')(request, callback);

    expect(enqueuePendingMessageByAuthenticatedMachine).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      v: 1,
      result: { status: 'rejected', code: 'session_input_unauthorized' },
    });
  });

  it('rejects malformed input without calling the admission owner', async () => {
    const { machineUpdateHandler } = await import('./machineUpdateHandler');
    const socket = createFakeSocket({
      data: { clientType: 'machine-scoped', machineId: 'machine-source' },
    });
    machineUpdateHandler('account-1', socket as never, options);
    const callback = vi.fn();

    await getSocketHandler(socket, 'session-pending-enqueue-by-machine-v1')({
      ...request,
      machineId: 'forged-machine',
    }, callback);

    expect(enqueuePendingMessageByAuthenticatedMachine).not.toHaveBeenCalled();
    expect(callback).toHaveBeenCalledWith({
      v: 1,
      result: { status: 'rejected', code: 'session_input_invalid' },
    });
  });
});
