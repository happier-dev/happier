import { afterEach, describe, expect, it, vi } from 'vitest';

type MockRepairResolution = {
  runtime: {
    platform: string;
    uid: number;
  };
  plan: {
    actions: Array<{ kind: string }>;
    manualWarnings: string[];
  };
};

const {
  handleServiceRepairCliCommandMock,
  resolveBackgroundServiceRepairPlanForCurrentRuntimeMock,
  resolveDaemonServiceCliRuntimeFromEnvMock,
} = vi.hoisted(() => ({
  handleServiceRepairCliCommandMock: vi.fn(async (_params: unknown) => undefined),
  resolveBackgroundServiceRepairPlanForCurrentRuntimeMock: vi.fn<(params: unknown) => Promise<MockRepairResolution>>(async (_params: unknown) => ({
    runtime: {
      platform: 'linux',
      uid: 1000,
    },
    plan: {
      actions: [],
      manualWarnings: [],
    },
  })),
  resolveDaemonServiceCliRuntimeFromEnvMock: vi.fn((_params?: unknown) => ({
    platform: 'linux',
    mode: 'user',
    uid: 1000,
  })),
}));

vi.mock('@/daemon/service/cli', () => ({
  resolveDaemonServiceCliRuntimeFromEnv: (params?: unknown) => resolveDaemonServiceCliRuntimeFromEnvMock(params),
}));

vi.mock('@/diagnostics/backgroundServiceRepair/resolveBackgroundServiceRepairPlanForCurrentRuntime', () => ({
  resolveBackgroundServiceRepairPlanForCurrentRuntime: (params: unknown) => resolveBackgroundServiceRepairPlanForCurrentRuntimeMock(params),
}));

vi.mock('../service/repair/handleServiceRepairCliCommand', () => ({
  handleServiceRepairCliCommand: (params: unknown) => handleServiceRepairCliCommandMock(params),
}));

describe('maybeRunDoctorRepair', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    handleServiceRepairCliCommandMock.mockReset();
    resolveBackgroundServiceRepairPlanForCurrentRuntimeMock.mockReset();
    resolveDaemonServiceCliRuntimeFromEnvMock.mockReset();
    resolveBackgroundServiceRepairPlanForCurrentRuntimeMock.mockResolvedValue({
      runtime: {
        platform: 'linux',
        uid: 1000,
      },
      plan: {
        actions: [] as Array<{ kind: string }>,
        manualWarnings: [] as string[],
      },
    });
    resolveDaemonServiceCliRuntimeFromEnvMock.mockImplementation((_params?: unknown) => ({
      platform: 'linux',
      mode: 'user',
      uid: 1000,
    }));
  });

  it('skips repair follow-up when the migration step already handled convergence', async () => {
    const { maybeRunDoctorRepair } = await import('./maybeRunDoctorRepair');

    await expect(maybeRunDoctorRepair({
      migrationRan: true,
    })).resolves.toBe(false);

    expect(resolveDaemonServiceCliRuntimeFromEnvMock).not.toHaveBeenCalled();
    expect(resolveBackgroundServiceRepairPlanForCurrentRuntimeMock).not.toHaveBeenCalled();
    expect(handleServiceRepairCliCommandMock).not.toHaveBeenCalled();
  });

  it('runs doctor repair when post-update repair work still exists', async () => {
    resolveBackgroundServiceRepairPlanForCurrentRuntimeMock.mockResolvedValueOnce({
      runtime: {
        platform: 'linux',
        uid: 1000,
      },
      plan: {
        actions: [{ kind: 'remove-service' }] as Array<{ kind: string }>,
        manualWarnings: [] as string[],
      },
    });
    const { maybeRunDoctorRepair } = await import('./maybeRunDoctorRepair');

    await expect(maybeRunDoctorRepair({
      migrationRan: false,
    })).resolves.toBe(true);

    expect(resolveDaemonServiceCliRuntimeFromEnvMock).toHaveBeenCalledWith({
      processEnv: process.env,
      mode: 'user',
    });
    expect(resolveBackgroundServiceRepairPlanForCurrentRuntimeMock).toHaveBeenCalledWith({
      preferredMode: 'user',
      includeAllModes: true,
      systemUser: '',
    });
    expect(handleServiceRepairCliCommandMock).toHaveBeenCalledWith({
      argv: ['repair'],
      commandPath: 'happier service',
    });
  });
});
