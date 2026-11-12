import { afterEach, describe, expect, it, vi } from 'vitest';
import { execFileWithDeadline } from '@happier-dev/cli-common/process';
import { createComputerRoutes } from './routes';
import { createMachineLiveStreamCaptureRegistry } from '../peer/mediation/stream/captureRegistry';
import { createDaemonRuntimeActionExecutor } from '../runtimeActionExecutor';
import { assertActionOutputContract } from '@/testkit/actionOutputContract';

// OS dispatch is the boundary; Action admission and native routes remain real.
vi.mock('@happier-dev/cli-common/process', async importOriginal => ({
  ...await importOriginal<typeof import('@happier-dev/cli-common/process')>(),
  execFileWithDeadline: vi.fn(async () => ({ stdout: '', stderr: '' })),
}));

const originalPlatform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform });
  vi.restoreAllMocks();
});

describe('computer privacy settings Action execution', () => {
  it.each([
    ['capture', 'Privacy_ScreenCapture'],
    ['input', 'Privacy_Accessibility'],
  ] as const)('opens the %s pane for an admitted request on the addressed Mac', async (permission, pane) => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const routes = createComputerRoutes({ machineId: 'machine', registry: createMachineLiveStreamCaptureRegistry() });
    const execute = createDaemonRuntimeActionExecutor({ env: {}, resolveRouteOwners: () => ({ computer: routes }),
      resolveServerFeaturesSnapshot: () => undefined });
    const input = { machineId: 'machine', permission };
    const context = { authority: 'account_automation' as const, defaultSessionId: 'session', bypassApprovals: true };
    const launched: string[] = [];
    vi.mocked(execFileWithDeadline).mockImplementation(async (command, args) => {
      expect(command).toBe('/usr/bin/open');
      launched.push(...args);
      return { stdout: '', stderr: '' };
    });
    try {
      // Action admission owns approval; this runtime seam consumes its admitted context.
      expect(await execute({ actionId: 'computer.permissions.openSettings', input: { ...input, machineId: 'other' },
        context })).toMatchObject({ ok: false, errorCode: 'computer_machine_mismatch' });
      expect(launched).toEqual([]);
      const result = await execute({ actionId: 'computer.permissions.openSettings', input, context });
      assertActionOutputContract('computer.permissions.openSettings', result);
      expect(result).toEqual({ status: 'dispatched' });
      expect(launched).toEqual([`x-apple.systempreferences:com.apple.preference.security?${pane}`]);
    } finally { await routes.dispose(); }
  });

  it.each(['linux', 'win32'] as const)('refuses OS dispatch on %s through the registered Action family', async platform => {
    Object.defineProperty(process, 'platform', { value: platform });
    const routes = createComputerRoutes({ machineId: 'machine', registry: createMachineLiveStreamCaptureRegistry() });
    const execute = createDaemonRuntimeActionExecutor({ env: {}, resolveRouteOwners: () => ({ computer: routes }),
      resolveServerFeaturesSnapshot: () => undefined });
    vi.mocked(execFileWithDeadline).mockImplementation(async () => { throw new Error('Unsupported host must not launch a pane'); });
    try {
      const result = await execute({ actionId: 'computer.permissions.openSettings', input: { machineId: 'machine', permission: 'capture' },
        context: { authority: 'present_user', defaultSessionId: 'session' } });
      assertActionOutputContract('computer.permissions.openSettings', result);
      expect(result).toEqual({ status: 'failed', code: 'platform_unsupported' });
    } finally { await routes.dispose(); }
  });

  it.each([false, true])('reports failed OS launch without claiming success (cancelled: %s)', async cancelled => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const routes = createComputerRoutes({ machineId: 'machine', registry: createMachineLiveStreamCaptureRegistry() });
    const execute = createDaemonRuntimeActionExecutor({ env: {}, resolveRouteOwners: () => ({ computer: routes }),
      resolveServerFeaturesSnapshot: () => undefined });
    const controller = new AbortController();
    vi.mocked(execFileWithDeadline).mockImplementation(async () => {
      if (cancelled) controller.abort();
      throw new Error('OS refused');
    });
    try {
      const result = await execute({ actionId: 'computer.permissions.openSettings', input: { machineId: 'machine', permission: 'input' },
        context: { authority: 'present_user', defaultSessionId: 'session', signal: controller.signal } });
      assertActionOutputContract('computer.permissions.openSettings', result);
      expect(result).toEqual({ status: 'failed', code: cancelled ? 'cancelled' : 'settings_dispatch_failed' });
    } finally { await routes.dispose(); }
  });
});
