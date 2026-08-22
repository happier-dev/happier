import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ManagedConnectionState } from '@happier-dev/connection-supervisor';

const {
  repairOperationProgressProjectionsMock,
  repairDiagnosticMock,
} = vi.hoisted(() => ({
  repairOperationProgressProjectionsMock: vi.fn(),
  repairDiagnosticMock: vi.fn(),
}));

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
});
