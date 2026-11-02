import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { resolveExecutableCommand } from '@happier-dev/cli-common/process';
import { terminateProcessTree } from '@/processes/terminate/terminateProcessTree';
import { ComputerDriverError } from './driver/nativeTransport';

export type ComputerDesktopConnection = Readonly<{ displayId: string; environment: Readonly<Record<string, string>> }>;

const unavailable = () => new ComputerDriverError('computer_display_unavailable',
  'Managed desktop unavailable. Install the virtual-display recipe on this Machine.');

const pad = (length: number) => Buffer.alloc((4 - (length % 4)) % 4);

/**
 * Insert the server-interpreted host entry `localuser:<daemon user>` (X11 ChangeHosts), so apps the
 * daemon's own OS user runs with an explicit DISPLAY connect without the cookie; other uids still
 * need it. A GetInputFocus reply after the request proves the server accepted it.
 */
function admitDaemonUser(socketPath: string, cookie: Buffer): Promise<void> {
  const name = Buffer.from('MIT-MAGIC-COOKIE-1');
  const setup = Buffer.alloc(12);
  setup.write('l', 0, 'latin1'); setup.writeUInt16LE(11, 2); setup.writeUInt16LE(name.length, 6); setup.writeUInt16LE(cookie.length, 8);
  const address = Buffer.from(`localuser\0${userInfo().username}`, 'latin1');
  const change = Buffer.concat([Buffer.alloc(8), address, pad(address.length)]);
  change.writeUInt8(109, 0); change.writeUInt16LE(change.length / 4, 2); change.writeUInt8(5, 4); change.writeUInt16LE(address.length, 6);
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let received = Buffer.alloc(0);
    const settle = (accepted: boolean) => { socket.destroy(); if (accepted) resolve(); else reject(unavailable()); };
    socket.once('error', () => settle(false));
    socket.once('close', () => settle(false));
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (received.length >= 1 && received[0] !== 1) return settle(false);
      if (received.length < 8) return;
      const reply = 8 + 4 * received.readUInt16LE(6);
      if (received.length >= reply + 32) settle(received[reply] === 1);
    });
    socket.write(Buffer.concat([setup, name, pad(name.length), cookie, pad(cookie.length), change, Buffer.from([43, 0, 1, 0])]));
  });
}

/** Linux-only, lazy daemon-lifetime desktop. Never mutates the daemon/Agent environment. */
export function createComputerDesktop(options?: Readonly<{ runtimeRoot?: string }>) {
  let connection: ComputerDesktopConnection | undefined;
  let initialization: Promise<ComputerDesktopConnection> | undefined;
  let closed = false;
  let alive = true;
  let runtimeDirectory: string | undefined;
  const children: ChildProcess[] = [];

  const stop = async () => {
    const exits: Promise<unknown>[] = [];
    for (const child of [...children].reverse()) {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) continue;
      exits.push(once(child, 'close'));
      // Stop the WM tree while X11 and D-Bus are still available. The daemon's
      // termination owner supplies the grace period, escalation and exit proof.
      await terminateProcessTree(child, { ownedProcessGroup: true });
    }
    // Activated desktop services can inherit another child's output handles.
    // Retire every owned process before waiting for inherited handles to close.
    await Promise.all(exits);
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
  const start = async (xvfb: string, dbus: string, gdbus: string, wm: string, openbox: boolean): Promise<ComputerDesktopConnection> => {
    try {
      runtimeDirectory = await mkdtemp(join(options?.runtimeRoot ?? tmpdir(), 'happier-desktop-'));
      // Enable only this session, without changing the person's persistent desktop preferences.
      const environment: NodeJS.ProcessEnv = { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory, XDG_CONFIG_HOME: runtimeDirectory,
        GSETTINGS_BACKEND: 'memory', NO_AT_BRIDGE: '0', GTK_A11Y: 'always' };
      for (const key of ['DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'AT_SPI_BUS_ADDRESS']) delete environment[key];
      // Without -auth every local uid may connect. One MIT-MAGIC-COOKIE-1 entry (FamilyWild,
      // any display number) in the 0700 runtime folder admits only holders of this file.
      const authority = join(runtimeDirectory, 'Xauthority');
      const field = (value: Buffer) => Buffer.concat([Buffer.from([value.length >> 8, value.length & 0xff]), value]);
      const cookie = randomBytes(16);
      await writeFile(authority, Buffer.concat([Buffer.from([0xff, 0xff]), field(Buffer.alloc(0)), field(Buffer.alloc(0)),
        field(Buffer.from('MIT-MAGIC-COOKIE-1')), field(cookie)]), { mode: 0o600, flag: 'wx' });
      // Preserve the accessibility bus's X root property between driver/app connections.
      const display = launch(xvfb, ['-displayfd', '3', '-nolisten', 'tcp', '-noreset', '-auth', authority], environment, true);
      const displayNumber = await line(display, display.stdio[3] as Readable);
      if (!/^\d+$/.test(displayNumber)) throw unavailable();
      const displayId = `:${displayNumber}`;
      await admitDaemonUser(`/tmp/.X11-unix/X${displayNumber}`, cookie);
      const bus = launch(dbus, ['--session', '--nofork', '--print-address=1', `--address=unix:path=${join(runtimeDirectory, 'bus')}`],
        { ...environment, DISPLAY: displayId, XAUTHORITY: authority });
      const busAddress = await line(bus, bus.stdout!);
      const desktopEnvironment = { DISPLAY: displayId, XAUTHORITY: authority, DBUS_SESSION_BUS_ADDRESS: busAddress,
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
      // Fluxbox uses HOME rather than XDG_CONFIG_HOME. Only this owned WM
      // receives a private home; the daemon, Agents and apps keep theirs.
      const windowManager = launch(wm, openbox ? ['--sm-disable'] : [], {
        ...environment, ...desktopEnvironment, HOME: runtimeDirectory,
      });
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
      const openbox = resolveExecutableCommand('openbox');
      const wm = openbox ?? resolveExecutableCommand('fluxbox');
      if (!xvfb || !dbus || !gdbus || !wm) throw unavailable();
      return initialization = start(xvfb, dbus, gdbus, wm, Boolean(openbox));
    },
    async dispose() {
      closed = true;
      await stop();
      await initialization?.catch(() => undefined);
      await stop();
    },
  };
}
