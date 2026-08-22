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
  loggerFatalMock,
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
  loggerFatalMock: vi.fn(),
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

vi.mock('@/ui/logger', () => ({
  logger: {
    fatal: loggerFatalMock,
  },
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
  const originalDistIntegrityProbe = process.env.HAPPIER_CLI_DIST_INTEGRITY_PROBE;
  afterEach(() => {
    process.argv = originalArgv;
    process.exitCode = originalExitCode;
    if (originalDistIntegrityProbe === undefined) {
      delete process.env.HAPPIER_CLI_DIST_INTEGRITY_PROBE;
    } else {
      process.env.HAPPIER_CLI_DIST_INTEGRITY_PROBE = originalDistIntegrityProbe;
    }
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
    loggerFatalMock.mockReset();
    vi.resetModules();
  });

  it('keeps the process alive until runtime reexec and command dispatch settle', async () => {
    const reexecDeferred = createDeferred();
    maybeReexecToRuntimeMock.mockReturnValue(reexecDeferred.promise);
    process.argv = ['node', '/repo/apps/cli/dist/index.mjs', 'self', 'check'];
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');

    try {
      await import('./index');
      await vi.waitFor(() => {
        expect(maybeReexecToRuntimeMock).toHaveBeenCalledOnce();
      });

      expect(maybeAutoUpdateNoticeMock).not.toHaveBeenCalled();
      expect(dispatchCliMock).not.toHaveBeenCalled();
      expect(setIntervalSpy).toHaveBeenCalledOnce();
      const keepAliveHandle = setIntervalSpy.mock.results[0]?.value;
      expect(clearIntervalSpy).not.toHaveBeenCalledWith(keepAliveHandle);

      reexecDeferred.resolve();

      await vi.waitFor(() => {
        expect(maybeAutoUpdateNoticeMock).toHaveBeenCalledOnce();
        expect(dispatchCliMock).toHaveBeenCalledOnce();
        expect(clearIntervalSpy).toHaveBeenCalledWith(keepAliveHandle);
      });
    } finally {
      setIntervalSpy.mockRestore();
      clearIntervalSpy.mockRestore();
    }
  });

  it('does not dispatch the CLI when imported by the dist integrity probe', async () => {
    process.env.HAPPIER_CLI_DIST_INTEGRITY_PROBE = '1';
    process.argv = ['node', '/repo/apps/cli/dist/index.mjs'];

    await import('./index');
    await Promise.resolve();

    expect(maybeReexecToRuntimeMock).not.toHaveBeenCalled();
    expect(maybeAutoUpdateNoticeMock).not.toHaveBeenCalled();
    expect(dispatchCliMock).not.toHaveBeenCalled();
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
        expect(loggerFatalMock).toHaveBeenCalledWith(startupError);
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
