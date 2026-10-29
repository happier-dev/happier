import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  sentryPreload: vi.fn(),
  sentryInit: vi.fn(),
  registerProcessHandlers: vi.fn(),
  startServer: vi.fn(async () => {}),
}));

// Exercise real instrumentation while isolating the third-party telemetry SDK.
vi.mock('@sentry/node', () => ({
  preloadOpenTelemetry: mocks.sentryPreload,
  init: mocks.sentryInit,
  getClient: () => undefined,
}));
vi.mock('@/utils/process/processHandlers', () => ({
  registerProcessHandlers: mocks.registerProcessHandlers,
}));
vi.mock('@/startServer', () => ({
  startServer: mocks.startServer,
}));

it('starts the light executable and preserves its command exit status', async () => {
  const originalExitCode = process.exitCode;
  process.exitCode = 37;
  const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
  try {
    await import('./main.light?entrypoint-test');
    await vi.dynamicImportSettled();

    await vi.waitFor(() => {
      expect(mocks.startServer).toHaveBeenCalledWith('light');
      expect(exit).toHaveBeenCalledWith(37);
    });
  } finally {
    process.exitCode = originalExitCode;
    exit.mockRestore();
  }
});
