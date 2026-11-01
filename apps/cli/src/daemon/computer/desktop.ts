import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { resolveExecutableCommand } from '@happier-dev/cli-common/process';
import { ComputerDriverError } from './driver/nativeTransport';

export type ComputerDesktopConnection = Readonly<{ displayId: string; environment: Readonly<Record<string, string>> }>;

const unavailable = () => new ComputerDriverError('computer_display_unavailable',
  'Managed desktop unavailable. Install the virtual-display recipe on this Machine.');

/** Linux-only, lazy daemon-lifetime desktop. Never mutates the daemon/Agent environment. */
export function createComputerDesktop() {
  let connection: ComputerDesktopConnection | undefined;
  let initialization: Promise<ComputerDesktopConnection> | undefined;
  let closed = false;
  let alive = true;
  let runtimeDirectory: string | undefined;
  const children: ChildProcess[] = [];

  const stop = async () => {
    for (const child of [...children].reverse()) {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue;
      const exited = once(child, 'close');
      // Each child owns a new POSIX process group; include D-Bus-activated AT-SPI children.
      try { process.kill(-child.pid, 'SIGTERM'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      await exited;
    }
    children.length = 0;
    if (runtimeDirectory) await rm(runtimeDirectory, { recursive: true, force: true });
  };
  const launch = (executable: string, args: string[], environment: NodeJS.ProcessEnv, displayFd = false, persistent = true) => {
    if (closed) throw unavailable();
    const child = spawn(executable, args, { env: environment, detached: true,
      stdio: displayFd ? ['ignore', 'ignore', 'ignore', 'pipe'] : ['ignore', 'pipe', 'ignore'] });
    children.push(child);
    // These are optional capability processes. Exit withdraws only this desktop.
    child.on('error', () => { if (persistent) alive = false; });
    child.on('exit', () => { if (persistent) alive = false; });
    return child;
  };
  const line = (child: ChildProcess, stream: Readable): Promise<string> => new Promise((resolve, reject) => {
    let buffered = '';
    const cleanup = () => { stream.off('data', data); stream.off('end', fail); child.off('error', fail); child.off('exit', fail); };
    const fail = () => { cleanup(); reject(unavailable()); };
    const data = (chunk: Buffer) => {
      buffered += chunk.toString();
      if (!buffered.includes('\n')) return;
      cleanup(); resolve(buffered.split('\n')[0]!);
    };
    stream.on('data', data); stream.once('end', fail); child.once('error', fail); child.once('exit', fail);
  });
  const start = async (xvfb: string, dbus: string, gdbus: string, wm: string): Promise<ComputerDesktopConnection> => {
    try {
      runtimeDirectory = await mkdtemp(join(tmpdir(), 'happier-desktop-'));
      // Enable only this session, without changing the person's persistent desktop preferences.
      const environment: NodeJS.ProcessEnv = { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory, XDG_CONFIG_HOME: runtimeDirectory,
        GSETTINGS_BACKEND: 'memory', NO_AT_BRIDGE: '0', GTK_A11Y: 'always' };
      for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'AT_SPI_BUS_ADDRESS']) delete environment[key];
      // Preserve the accessibility bus's X root property between driver/app connections.
      const display = launch(xvfb, ['-displayfd', '3', '-nolisten', 'tcp', '-noreset'], environment, true);
      const displayNumber = await line(display, display.stdio[3] as Readable);
      if (!/^\d+$/.test(displayNumber)) throw unavailable();
      const displayId = `:${displayNumber}`;
      const bus = launch(dbus, ['--session', '--nofork', '--print-address=1', `--address=unix:path=${join(runtimeDirectory, 'bus')}`],
        { ...environment, DISPLAY: displayId });
      const busAddress = await line(bus, bus.stdout!);
      const desktopEnvironment = { DISPLAY: displayId, DBUS_SESSION_BUS_ADDRESS: busAddress,
        XDG_RUNTIME_DIR: runtimeDirectory, XDG_CONFIG_HOME: runtimeDirectory, GSETTINGS_BACKEND: 'memory', NO_AT_BRIDGE: '0', GTK_A11Y: 'always' };
      // Activate the private accessibility bus and enable the toolkit bridge before discovery.
      const accessibility = launch(gdbus, ['call', '--session', '--dest', 'org.a11y.Bus', '--object-path', '/org/a11y/bus',
        '--method', 'org.freedesktop.DBus.Properties.Set', 'org.a11y.Status', 'IsEnabled', '<true>'], { ...environment, ...desktopEnvironment }, false, false);
      const [code] = await once(accessibility, 'exit');
      if (code !== 0) throw unavailable();
      const ready = launch(gdbus, ['call', '--session', '--dest', 'org.a11y.Bus', '--object-path', '/org/a11y/bus',
        '--method', 'org.a11y.Bus.GetAddress'], { ...environment, ...desktopEnvironment }, false, false);
      const [readyCode] = await once(ready, 'exit');
      if (readyCode !== 0) throw unavailable();
      const windowManager = launch(wm, ['--sm-disable'], { ...environment, ...desktopEnvironment });
      await once(windowManager, 'spawn');
      if (closed) throw unavailable();
      connection = { displayId, environment: desktopEnvironment };
      return connection;
    } catch {
      await stop();
      throw unavailable();
    }
  };
  return {
    current() { return alive && !closed ? connection : undefined; },
    async ensure(): Promise<ComputerDesktopConnection> {
      if (closed || process.platform !== 'linux' || !alive) throw unavailable();
      if (initialization) return initialization;
      // Missing software is not a started desktop. A later explicit request may
      // use the recipe the person has since installed, without an automatic retry.
      const xvfb = resolveExecutableCommand('Xvfb');
      const dbus = resolveExecutableCommand('dbus-daemon');
      const gdbus = resolveExecutableCommand('gdbus');
      const wm = resolveExecutableCommand('openbox');
      if (!xvfb || !dbus || !gdbus || !wm) throw unavailable();
      return initialization = start(xvfb, dbus, gdbus, wm);
    },
    async dispose() {
      closed = true;
      await stop();
      await initialization?.catch(() => undefined);
      await stop();
    },
  };
}
