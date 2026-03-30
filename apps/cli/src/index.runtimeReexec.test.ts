import { afterEach, describe, expect, it, vi } from 'vitest';
import { captureConsoleText } from '@/testkit/logger/captureOutput';

const {
  dispatchCliMock,
  ensureWindowsUtf8CodePageMock,
  initToolTraceIfEnabledMock,
  installAxiosProxySupportMock,
  maybeAutoUpdateNoticeMock,
  maybeReexecToRuntimeMock,
  normalizeCliArgvMock,
  parseCliArgsMock,
  resolveNpmPackageNameOverrideMock,
  installConsoleWriteErrorGuardsMock,
  shouldInstallConsoleWriteErrorGuardsMock,
} = vi.hoisted(() => ({
  dispatchCliMock: vi.fn(async () => undefined),
  ensureWindowsUtf8CodePageMock: vi.fn(),
  initToolTraceIfEnabledMock: vi.fn(),
  installAxiosProxySupportMock: vi.fn(),
  maybeAutoUpdateNoticeMock: vi.fn(),
  maybeReexecToRuntimeMock: vi.fn(async () => undefined),
  normalizeCliArgvMock: vi.fn((argv: string[]) => argv),
  parseCliArgsMock: vi.fn(() => ({ args: { _: [] }, terminalRuntime: undefined })),
  resolveNpmPackageNameOverrideMock: vi.fn(({ fallback }: { fallback: string }) => fallback),
  installConsoleWriteErrorGuardsMock: vi.fn(),
  shouldInstallConsoleWriteErrorGuardsMock: vi.fn(() => true),
}));

vi.mock('@/cli/dispatch', () => ({
  dispatchCli: dispatchCliMock,
}));

vi.mock('@/cli/parseArgs', () => ({
  normalizeCliArgv: normalizeCliArgvMock,
  parseCliArgs: parseCliArgsMock,
}));

vi.mock('@/agent/tools/trace/toolTrace', () => ({
  initToolTraceIfEnabled: initToolTraceIfEnabledMock,
}));

vi.mock('axios', () => ({
  default: {},
}));

vi.mock('@/configuration', () => ({
  configuration: { happyHomeDir: '/home/test/.happier' },
}));

vi.mock('@/cli/runtime/update/autoUpdateNotice', () => ({
  maybeAutoUpdateNotice: maybeAutoUpdateNoticeMock,
}));

vi.mock('@/cli/runtime/update/runtimeReexec', () => ({
  maybeReexecToRuntime: maybeReexecToRuntimeMock,
}));

vi.mock('@happier-dev/cli-common/update', () => ({
  resolveNpmPackageNameOverride: resolveNpmPackageNameOverrideMock,
}));

vi.mock('@/utils/proxy/axiosProxy', () => ({
  installAxiosProxySupport: installAxiosProxySupportMock,
}));

vi.mock('@/utils/platform/windows/ensureWindowsUtf8CodePage', () => ({
  ensureWindowsUtf8CodePage: ensureWindowsUtf8CodePageMock,
}));

vi.mock('@/utils/writeConsoleBestEffort', () => ({
  installConsoleWriteErrorGuards: installConsoleWriteErrorGuardsMock,
  shouldInstallConsoleWriteErrorGuards: shouldInstallConsoleWriteErrorGuardsMock,
}));

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<undefined>((resolvePromise) => {
    const resolveDeferred: () => void = () => {
      resolvePromise(undefined);
    };
    resolve = resolveDeferred;
  });
  return { promise, resolve };
}

describe('CLI startup runtime reexec', () => {
  const originalArgv = process.argv;
  const originalExitCode = process.exitCode;
  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    dispatchCliMock.mockReset();
    dispatchCliMock.mockResolvedValue(undefined);
    ensureWindowsUtf8CodePageMock.mockReset();
    initToolTraceIfEnabledMock.mockReset();
    installAxiosProxySupportMock.mockReset();
    maybeAutoUpdateNoticeMock.mockReset();
    maybeReexecToRuntimeMock.mockReset();
    maybeReexecToRuntimeMock.mockResolvedValue(undefined);
    normalizeCliArgvMock.mockReset();
    normalizeCliArgvMock.mockImplementation((argv: string[]) => argv);
    parseCliArgsMock.mockReset();
    parseCliArgsMock.mockReturnValue({ args: { _: [] }, terminalRuntime: undefined });
    resolveNpmPackageNameOverrideMock.mockReset();
    resolveNpmPackageNameOverrideMock.mockImplementation(({ fallback }: { fallback: string }) => fallback);
    installConsoleWriteErrorGuardsMock.mockReset();
    shouldInstallConsoleWriteErrorGuardsMock.mockReset();
    shouldInstallConsoleWriteErrorGuardsMock.mockReturnValue(true);
    vi.resetModules();
  });

  it('waits for runtime reexec resolution before continuing startup', async () => {
    const reexecDeferred = createDeferred();
    maybeReexecToRuntimeMock.mockReturnValue(reexecDeferred.promise);
    process.argv = ['node', '/repo/apps/cli/dist/index.mjs', 'self', 'check'];

    await import('./index');
    await Promise.resolve();

    expect(maybeReexecToRuntimeMock).toHaveBeenCalledOnce();
    expect(maybeAutoUpdateNoticeMock).not.toHaveBeenCalled();
    expect(dispatchCliMock).not.toHaveBeenCalled();

    reexecDeferred.resolve();

    await vi.waitFor(() => {
      expect(maybeAutoUpdateNoticeMock).toHaveBeenCalledOnce();
      expect(dispatchCliMock).toHaveBeenCalledOnce();
    });
  });

  it('reports startup failures instead of rejecting silently', async () => {
    const startupError = new Error('startup blew up');
    dispatchCliMock.mockRejectedValue(startupError);
    process.argv = ['node', '/repo/apps/cli/dist/index.mjs', 'install', 'provider', 'codex'];
    const output = captureConsoleText();

    try {
      await import('./index');

      await vi.waitFor(() => {
        expect(output.lines).toContain('Error: startup blew up');
        expect(process.exitCode).toBe(1);
      });
    } finally {
      output.restore();
    }
  });

  it('skips console stream guard installation when the runtime says not to', async () => {
    shouldInstallConsoleWriteErrorGuardsMock.mockReturnValue(false);
    process.argv = ['node', '/repo/apps/cli/dist/index.mjs', '--help'];

    await import('./index');

    await vi.waitFor(() => {
      expect(shouldInstallConsoleWriteErrorGuardsMock).toHaveBeenCalledOnce();
      expect(installConsoleWriteErrorGuardsMock).not.toHaveBeenCalled();
    });
  });
});
