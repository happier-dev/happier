import { afterEach, expect, it, vi } from 'vitest';
import type { createDaemonControlApp, startDaemonControlServer } from '@/daemon/controlServer';
import { reloadConfiguration } from '@/configuration';
import { createInstalledProjectAgentDaemonFixture } from '@/daemon/testkit/installedProjectAgentDaemonFixture';

const boundary = vi.hoisted(() => ({
  control: null as unknown,
  app: null as ReturnType<typeof createDaemonControlApp> | null,
}));
// Substitute the OS listener, retaining actual daemon composition and strict control ingress.
vi.mock('@/daemon/controlServer', async original => {
  const actual = await original<typeof import('@/daemon/controlServer')>();
  return { ...actual, startDaemonControlServer: async (input: Parameters<typeof actual.startDaemonControlServer>[0]) => {
    boundary.control = input;
    const app = actual.createDaemonControlApp(input);
    boundary.app = app;
    return { port: 46313, stop: async () => { await app.close(); } };
  } };
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); reloadConfiguration(); });

it('consumes actual provider readiness through the existing runner activity authority', async () => {
  const fixture = await createInstalledProjectAgentDaemonFixture(
    () => boundary.control as Parameters<typeof startDaemonControlServer>[0]);
  const { tracked, sessionId } = fixture;
  expect(tracked.providerInputAdmissionReady).toBeUndefined();
  const app = boundary.app;
  if (!app) throw new Error('Daemon control listener was not constructed');
  const notify = (providerInputAdmissionReady: boolean) => app.inject({ method: 'POST', url: '/session-activity-changed',
    headers: { 'x-happier-daemon-token': (boundary.control as Parameters<typeof startDaemonControlServer>[0]).controlToken },
    payload: { sessionId, providerInputAdmissionReady },
  });
  expect((await notify(false)).statusCode).toBe(200);
  expect(tracked.providerInputAdmissionReady).toBe(false);
  expect((await notify(true)).statusCode).toBe(200);
  expect(tracked.providerInputAdmissionReady).toBe(true);
});
