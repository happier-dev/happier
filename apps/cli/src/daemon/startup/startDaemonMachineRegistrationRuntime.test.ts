import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '@/api/api';
import type { Credentials } from '@/persistence';

const startDaemonMachineRegistrationMock = vi.hoisted(() => vi.fn());
const createLoopbackReadinessProbeMock = vi.hoisted(() => vi.fn(() => async () => ({ status: 'ready' as const })));
const endpointSupervisor = vi.hoisted(() => ({
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  reportFailure: vi.fn(),
  invalidate: vi.fn(),
  subscribe: vi.fn(() => () => {}),
}));
const createManagedEndpointSupervisorMock = vi.hoisted(() => vi.fn(() => endpointSupervisor));

vi.mock('@happier-dev/connection-supervisor', () => ({
  DEFAULT_MANAGED_CONNECTION_POLICY: {
    initialFastRetryDelayMs: 250,
    maxFastRetries: 1,
    backoffMinMs: 1_000,
    backoffMaxMs: 60_000,
    jitterRatio: 0.2,
  },
  createManagedEndpointSupervisor: createManagedEndpointSupervisorMock,
}));

vi.mock('@/api/connection/createLoopbackReadinessProbe', () => ({
  createLoopbackReadinessProbe: createLoopbackReadinessProbeMock,
}));

vi.mock('@/configuration', () => ({
  configuration: {
    apiServerUrl: 'https://api.example.test',
    happyHomeDir: '/tmp/happy-home',
  },
}));

vi.mock('@/projectPath', () => ({
  projectPath: () => '/tmp/happy-lib',
}));

vi.mock('../machine/startDaemonMachineRegistration', () => ({
  startDaemonMachineRegistration: startDaemonMachineRegistrationMock,
}));

import { startDaemonMachineRegistrationRuntime } from './startDaemonMachineRegistrationRuntime';

function createParams() {
  const shutdown = new Promise<void>(() => {});
  return {
    api: {} as unknown as ApiClient,
    credentials: {
      token: 'token-1',
    } satisfies Pick<Credentials, 'token'>,
    metadataForRegistration: {
      host: 'host',
      platform: 'platform',
      happyCliVersion: '0.0.0-test',
      homeDir: '/tmp/home',
      happyHomeDir: '/tmp/happy-home',
      happyLibDir: '/tmp/happy-lib',
    },
    initialDaemonState: { status: 'running' },
    processEnv: {},
    resolvePositiveIntEnv: vi.fn((_raw: string | undefined, fallback: number) => fallback),
    resolvesWhenShutdownRequested: shutdown,
    initialPreflightMachineRegistration: null,
    resolveMachineId: () => 'machine-1',
    setMachineId: vi.fn(),
    isShuttingDown: () => false,
    bootstrapRuntime: {} as Parameters<typeof startDaemonMachineRegistrationRuntime>[0]['bootstrapRuntime'],
    onMachineSyncRuntime: vi.fn(),
    filesystemAccessPolicy: { kind: 'osUser' },
    takeoverRequested: false,
    preferredHost: 'host',
    connectedServiceRefreshLoopHandle: null,
    connectedServiceQuotasLoopHandle: null,
  } satisfies Parameters<typeof startDaemonMachineRegistrationRuntime>[0];
}

describe('startDaemonMachineRegistrationRuntime', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('passes a lazy shared endpoint-readiness wake source into machine registration', () => {
    startDaemonMachineRegistrationRuntime(createParams());

    expect(createLoopbackReadinessProbeMock).not.toHaveBeenCalled();
    expect(endpointSupervisor.start).not.toHaveBeenCalled();
    expect(startDaemonMachineRegistrationMock).toHaveBeenCalledWith(expect.objectContaining({
      machineRegistrationRetryWakeSource: expect.objectContaining({
        reportFailure: expect.any(Function),
        invalidate: expect.any(Function),
        subscribe: expect.any(Function),
        stop: expect.any(Function),
      }),
    }));

    const wakeSource = startDaemonMachineRegistrationMock.mock.calls[0]?.[0]?.machineRegistrationRetryWakeSource;
    wakeSource?.reportFailure({ errorMessage: 'connect ECONNREFUSED' });
    wakeSource?.invalidate();

    expect(createLoopbackReadinessProbeMock).toHaveBeenCalledWith({
      serverUrl: 'https://api.example.test',
      token: 'token-1',
    });
    expect(createManagedEndpointSupervisorMock).toHaveBeenCalledWith(expect.objectContaining({
      probeReadiness: createLoopbackReadinessProbeMock.mock.results[0]?.value,
    }));
    expect(endpointSupervisor.start).toHaveBeenCalledTimes(1);
    expect(endpointSupervisor.reportFailure).toHaveBeenCalledWith({ errorMessage: 'connect ECONNREFUSED' });
    expect(endpointSupervisor.invalidate).toHaveBeenCalledTimes(1);
  });
});
