import { EventEmitter } from 'node:events';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawned: Array<
  Readonly<{ name: string; args: readonly string[]; child: ChildProcess }>
> = [];

// Process spawn is the only boundary: each fake answers the readiness signal desktop.ts waits for.
vi.mock('node:child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:child_process')>();
  return { ...real, spawn: (executable: string, args: readonly string[], options: SpawnOptions) => {
    const name = basename(executable);
    // Real child lifetimes keep the real daemon termination path below this OS boundary.
    const readiness = name === 'Xvfb' ? 'require("fs").writeSync(3,"7\\n");'
      : name === 'dbus-daemon' ? 'process.stdout.write("unix:path=/private/bus\\n");' : '';
    const child = real.spawn(process.execPath, ['-e', name === 'gdbus' ? '' : `${readiness}setInterval(() => {}, 1000);`], options);
    spawned.push({ name, args, child });
    return child;
  } };
});

// The X display socket is a transport boundary: record what the owner sends and answer as an X
// server would (setup success, then the GetInputFocus reply that proves ChangeHosts was accepted).
const xConnections: Array<Readonly<{ path: string; written: Buffer[] }>> = [];
vi.mock('node:net', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:net')>()),
  createConnection: (path: string) => {
    const written: Buffer[] = [];
    xConnections.push({ path, written });
    const socket = Object.assign(new EventEmitter(), {
      write: (chunk: Buffer) => {
        written.push(chunk);
        setImmediate(() => socket.emit('data', Buffer.concat([Buffer.from([1, 0, 11, 0, 0, 0, 0, 0]), Buffer.from([1, ...new Array(31).fill(0)])])));
        return true;
      },
      destroy: () => undefined,
    });
    return socket;
  },
}));

describe('managed desktop X authority', () => {
  let bin: string | undefined;
  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    spawned.length = 0;
    if (bin) await rm(bin, { recursive: true, force: true });
  });

  it.skipIf(process.platform !== 'linux')(
    'starts Xvfb with a private cookie that only the desktop environment carries',
    async () => {
      bin = await mkdtemp(join(tmpdir(), 'happier-desktop-bin-'));
      for (const name of ['Xvfb', 'dbus-daemon', 'gdbus', 'openbox']) {
        await writeFile(join(bin, name), '');
        await chmod(join(bin, name), 0o755);
      }
      vi.stubEnv('PATH', bin);
      vi.stubEnv('XAUTHORITY', '/home/person/.Xauthority');
      vi.stubEnv('DISPLAY', '');
      const { createComputerDesktop } = await import('./desktop');
      const desktop = createComputerDesktop({ runtimeRoot: bin });
      try {
        const connection = await desktop.ensure();
        expect(dirname(connection.environment.XDG_RUNTIME_DIR!)).toBe(bin);
        const xvfb = spawned.find((entry) => entry.name === 'Xvfb')!;
        const authority = xvfb.args[xvfb.args.indexOf('-auth') + 1];
        expect(xvfb.args).toContain('-auth');
        expect(dirname(authority!)).toBe(
          connection.environment.XDG_RUNTIME_DIR,
        );
        expect((await stat(authority!)).mode & 0o777).toBe(0o600);
        expect((await stat(dirname(authority!))).mode & 0o777).toBe(0o700);
        const entry = await readFile(authority!);
        // FamilyWild, empty address and display number, MIT-MAGIC-COOKIE-1, 16 random bytes.
        expect(entry.subarray(0, 6)).toEqual(
          Buffer.from([0xff, 0xff, 0, 0, 0, 0]),
        );
        expect(entry.subarray(6).toString('latin1')).toContain(
          'MIT-MAGIC-COOKIE-1',
        );
        expect(entry.readUInt16BE(entry.length - 18)).toBe(16);
        expect(connection.environment.XAUTHORITY).toBe(authority);
        // Agent shells inherit the daemon environment: they receive neither the display nor its cookie.
        expect(process.env.XAUTHORITY).toBe('/home/person/.Xauthority');
        expect(process.env.DISPLAY).toBe('');
        // Explicit launch: the daemon's own OS user is admitted by the server (SI:localuser), so an
        // app it runs with DISPLAY alone connects; any other uid still needs the cookie.
        const sent = Buffer.concat(xConnections.find(entry => entry.path === '/tmp/.X11-unix/X7')!.written);
        const address = Buffer.from(`localuser\0${userInfo().username}`, 'latin1');
        const change = sent.indexOf(address) - 8;
        expect(change).toBeGreaterThan(0);
        expect([sent[change], sent[change + 1], sent[change + 4]]).toEqual([109, 0, 5]);
        expect(sent.subarray(12, 30).toString('latin1')).toBe('MIT-MAGIC-COOKIE-1');
        expect(sent.subarray(32, 48)).toEqual(entry.subarray(entry.length - 16));
      } finally {
        await desktop.dispose();
      }
    },
  );
});
