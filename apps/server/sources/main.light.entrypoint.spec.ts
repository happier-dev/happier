import { expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  initializeServerSentry: vi.fn(),
  registerProcessHandlers: vi.fn(),
  startServer: vi.fn(async () => {}),
}));

vi.mock('@/app/monitoring/sentry', () => ({
  initializeServerSentry: mocks.initializeServerSentry,
}));
vi.mock('@/utils/process/processHandlers', () => ({
  registerProcessHandlers: mocks.registerProcessHandlers,
}));
vi.mock('@/startServer', () => ({
  startServer: mocks.startServer,
}));

it('starts the light server when the executable entrypoint is evaluated', async () => {
  await import('./main.light?entrypoint-test');

  await vi.waitFor(() => {
    expect(mocks.startServer).toHaveBeenCalledWith('light');
  });
});
