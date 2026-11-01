import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveExecutableCommand } from '@happier-dev/cli-common/process';
import { describe, expect, it, vi } from 'vitest';
import { createComputerDesktop } from './desktop';
import { openNativeComputerTransport } from './driver/nativeTransport';

const executablePath = process.env.HAPPIER_TEST_NATIVE_EXECUTABLE;
const fixturePath = process.env.HAPPIER_TEST_NATIVE_ACCESSIBILITY_FIXTURE;

describe.skipIf(process.platform !== 'linux' || !executablePath || !fixturePath)('managed Linux desktop', () => {
  it('settles a missing window manager with the recipe remedy and admits the next explicit request after installation', async () => {
    const installedPath = process.env.PATH;
    const prerequisites = await mkdtemp(join(tmpdir(), 'happier-desktop-prerequisites-'));
    const desktop = createComputerDesktop();
    try {
      for (const name of ['Xvfb', 'dbus-daemon', 'gdbus']) {
        const executable = resolveExecutableCommand(name);
        if (!executable) throw new Error(`Integration prerequisite missing: ${name}`);
        await symlink(executable, join(prerequisites, name));
      }
      vi.stubEnv('PATH', prerequisites);
      await expect(desktop.ensure()).rejects.toMatchObject({ code: 'computer_display_unavailable',
        message: expect.stringContaining('virtual-display') });
      vi.stubEnv('PATH', installedPath);
      const connection = await desktop.ensure();
      expect(connection.displayId).toMatch(/^:\d+$/);
      expect(desktop.current()).toBe(connection);
    } finally {
      vi.unstubAllEnvs();
      await desktop.dispose();
      await rm(prerequisites, { recursive: true, force: true });
    }
  });
  it('keeps one private accessibility desktop discoverable by explicit DISPLAY and retires its processes', async () => {
    const inheritedDisplay = process.env.DISPLAY;
    const inheritedBus = process.env.DBUS_SESSION_BUS_ADDRESS;
    const desktop = createComputerDesktop();
    let fixture: ChildProcess | undefined;
    let native: Awaited<ReturnType<typeof openNativeComputerTransport>> | undefined;
    try {
      const [connection, other] = await Promise.all([desktop.ensure(), desktop.ensure()]);
      expect(other).toBe(connection);
      expect(process.env.DISPLAY).toBe(inheritedDisplay);
      expect(process.env.DBUS_SESSION_BUS_ADDRESS).toBe(inheritedBus);
      const environment: NodeJS.ProcessEnv = { ...process.env, DISPLAY: connection.displayId };
      for (const key of ['WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS', 'AT_SPI_BUS_ADDRESS']) delete environment[key];
      fixture = spawn(fixturePath!, [], { env: environment, stdio: ['ignore', 'pipe', 'ignore'] });
      const ready = once(fixture.stdout!, 'data');
      await Promise.race([ready, once(fixture, 'exit').then(() => { throw new Error('Fixture exited before readiness'); })]);
      native = await openNativeComputerTransport(executablePath!, connection.displayId, { environment: connection.environment });
      const listed = await native.call('list_windows', { on_screen_only: true });
      const windows = listed.structuredContent?.windows;
      if (!Array.isArray(windows)) throw new Error('No window enumeration');
      const window: unknown = windows.find((entry: unknown) => entry && typeof entry === 'object' && 'pid' in entry && entry.pid === fixture?.pid);
      if (!window || typeof window !== 'object' || !('window_id' in window)) throw new Error('Fixture not enumerated');
      const state = await native.call('get_window_state', { pid: fixture.pid, window_id: window.window_id,
        include_screenshot: false, include_accessibility_tree: true, full_output: true });
      expect(state.structuredContent).toMatchObject({ elements_complete: true,
        elements: expect.arrayContaining([expect.objectContaining({ label: 'Probe click', actions: ['click'] })]) });
      expect(desktop.current()).toBe(connection);
      await native.close();
      native = undefined;
      const closed = once(fixture, 'close');
      fixture.kill('SIGTERM');
      await closed;
      fixture = undefined;
      await desktop.dispose();
      expect(desktop.current()).toBeUndefined();
      await expect(access(`/tmp/.X11-unix/X${connection.displayId.slice(1)}`)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(access(connection.environment.XDG_RUNTIME_DIR!)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await native?.close();
      if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
        const closed = once(fixture, 'close'); fixture.kill('SIGTERM'); await closed;
      }
      await desktop.dispose();
    }
  });
});
