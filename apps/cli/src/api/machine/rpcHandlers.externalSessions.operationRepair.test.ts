import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';

const {
  abandonDeletedSessionOperationsMock,
  repairOperationProgressProjectionsMock,
  repairDiagnosticMock,
} = vi.hoisted(() => ({
  abandonDeletedSessionOperationsMock: vi.fn(),
  repairOperationProgressProjectionsMock: vi.fn(),
  repairDiagnosticMock: vi.fn(),
}));

vi.mock(
  '@/session/actions/externalSessions/operationRecordStore',
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import('@/session/actions/externalSessions/operationRecordStore')
    >();
    return {
      ...actual,
      abandonExternalSessionOperationsForDeletedSession:
        abandonDeletedSessionOperationsMock,
    };
  },
);

vi.mock(
  '@/session/actions/externalSessions/responseErrors',
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import('@/session/actions/externalSessions/responseErrors')
    >();
    return {
      ...actual,
      logExternalSessionsInternalError: repairDiagnosticMock,
    };
  },
);

vi.mock(
  '@/session/actions/externalSessions/operationProgressPublisher',
  async (importOriginal) => {
    const actual = await importOriginal<
      typeof import('@/session/actions/externalSessions/operationProgressPublisher')
    >();
    return {
      ...actual,
      repairExternalSessionOperationProgressProjections:
        repairOperationProgressProjectionsMock,
    };
  },
);

import { registerMachineExternalSessionsRpcHandlers } from './rpcHandlers.externalSessions';
import {
  createDaemonConnectivityCoordinator,
} from '@/daemon/connection/createDaemonConnectivityCoordinator';

function createRpcHandlerManager() {
  return {
    registerHandler: vi.fn(),
  };
}

function buildConnectivityState(
  phase: ManagedConnectionState['phase'],
): ManagedConnectionState {
  return {
    phase,
    reason: phase === 'online' ? 'initial_connect' : 'server_unreachable',
    attempt: 0,
    nextRetryAt: null,
    lastConnectedAt: null,
    lastDisconnectedAt: null,
    lastErrorMessage: null,
  };
}

describe('External Session operation projection lifecycle repair', () => {
  beforeEach(() => {
    repairOperationProgressProjectionsMock.mockReset();
    abandonDeletedSessionOperationsMock.mockReset();
    repairDiagnosticMock.mockReset();
  });

  it('retries the same bounded boot repair on the daemon connectivity resume transition', async () => {
    repairOperationProgressProjectionsMock
      .mockRejectedValueOnce(new Error('initial projection unavailable'))
      .mockResolvedValue(1);
    const registration = registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: createRpcHandlerManager() as never,
    });

    await vi.waitFor(() => {
      expect(repairOperationProgressProjectionsMock).toHaveBeenCalledTimes(1);
    });
    expect(registration.connectivityResource).toBeDefined();
    const coordinator = createDaemonConnectivityCoordinator({
      resources: [registration.connectivityResource!],
    });

    await coordinator.applyState(buildConnectivityState('offline'));
    await coordinator.applyState(buildConnectivityState('online'));
    await coordinator.applyState(buildConnectivityState('online'));

    expect(repairOperationProgressProjectionsMock).toHaveBeenCalledTimes(2);
    for (const call of repairOperationProgressProjectionsMock.mock.calls) {
      expect(call).toEqual([
        expect.any(String),
        {
          inspectOperationClaim: expect.any(Function),
          withOperationClaimBarrier: expect.any(Function),
        },
      ]);
    }
    expect(repairDiagnosticMock).toHaveBeenCalledExactlyOnceWith(
      'external_session.operation_projection_repair_lifecycle',
      expect.any(Error),
    );
    await registration.dispose();
  });

  it('binds authoritative Session deletion to the existing operation cleanup owner and defers cursor acknowledgement for an active claim', async () => {
    let listener: ((change: Readonly<{
      sessionId: string;
      cursor: number;
      accountScope: Readonly<{
        activeServerDir: string;
        accountSubject: string;
      }>;
    }>) => Promise<void>) | null = null;
    abandonDeletedSessionOperationsMock
      .mockResolvedValueOnce({ deleted: 1, deferred: 0, retained: 0 })
      .mockResolvedValueOnce({ deleted: 0, deferred: 1, retained: 0 });
    const registration = registerMachineExternalSessionsRpcHandlers({
      rpcHandlerManager: createRpcHandlerManager() as never,
      subscribeSessionDeletedChanges: (next) => {
        listener = async (change) => await next(change);
        return () => {
          listener = null;
        };
      },
    });

    const deletionChange = {
      sessionId: 'session-deleted',
      cursor: 12,
      accountScope: {
        activeServerDir: 'server-dir',
        accountSubject: 'account-sub-a',
      },
    };

    await expect(listener!(deletionChange))
      .resolves.toBeUndefined();
    expect(abandonDeletedSessionOperationsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'session-deleted',
        activeServerDir: expect.any(String),
        accountScope: {
          activeServerDir: 'server-dir',
          accountSubject: 'account-sub-a',
        },
        withSessionOperationBarrier: expect.any(Function),
        cleanupPrivateOperation: expect.any(Function),
      }),
    );
    await expect(listener!(deletionChange))
      .rejects.toThrow('external_session_operation_abandonment_claim_active');

    await registration.dispose();
    expect(listener).toBeNull();
  });
});
