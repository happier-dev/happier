import { afterEach, describe, expect, it, vi } from 'vitest';

const {
  ensureJavaScriptRuntimeExecutableMock,
  discoverHappierServicesMock,
  resolveDaemonServiceRuntimeTargetMock,
  planDaemonServiceInstallMock,
  applyDaemonServiceInstallPlanMock,
  isBunMock,
} = vi.hoisted(() => ({
  ensureJavaScriptRuntimeExecutableMock: vi.fn(async () => '/managed/node'),
  discoverHappierServicesMock: vi.fn(async () => ({ services: [] })),
  resolveDaemonServiceRuntimeTargetMock: vi.fn(() => ({
    nodePath: '/managed/node',
    entryPath: '/opt/happier/package-dist/index.mjs',
  })),
  planDaemonServiceInstallMock: vi.fn(() => ({ files: [], commands: [] })),
  applyDaemonServiceInstallPlanMock: vi.fn(async () => undefined),
  isBunMock: vi.fn(() => true),
}));

vi.mock('@/runtime/js/ensureJavaScriptRuntimeExecutable', () => ({
  ensureJavaScriptRuntimeExecutable: ensureJavaScriptRuntimeExecutableMock,
}));

vi.mock('./runtimeTarget', () => ({
  resolveDaemonServiceRuntimeTarget: resolveDaemonServiceRuntimeTargetMock,
}));

vi.mock('@happier-dev/cli-common/happierRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happier-dev/cli-common/happierRuntime')>();
  return {
    ...actual,
    discoverHappierServices: discoverHappierServicesMock,
  };
});

vi.mock('./plan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plan')>();
  return {
    ...actual,
    planDaemonServiceInstall: planDaemonServiceInstallMock,
  };
});

vi.mock('./apply', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./apply')>();
  return {
    ...actual,
    applyDaemonServiceInstallPlan: applyDaemonServiceInstallPlanMock,
  };
});

vi.mock('@/utils/runtime', () => ({
  isBun: isBunMock,
}));

describe('installDaemonService runtime resolution', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('resolves a node runtime even when the parent process is bun-hosted', async () => {
    const { installDaemonService } = await import('./installer');

    await installDaemonService({
      platform: 'linux',
      uid: 123,
      userHomeDir: '/home/test',
      happierHomeDir: '/home/test/.happier',
      instanceId: 'cloud',
      runCommands: false,
    });

    expect(ensureJavaScriptRuntimeExecutableMock).toHaveBeenCalledWith({
      isBunRuntime: false,
      currentExecPath: process.execPath,
    });
    expect(resolveDaemonServiceRuntimeTargetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeExecutable: '/managed/node',
      }),
    );
  });
});
