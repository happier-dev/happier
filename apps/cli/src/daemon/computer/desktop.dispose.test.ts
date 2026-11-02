import { execFile, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';
import { resolveExecutableCommand } from '@happier-dev/cli-common/process';
import { describe, expect, it, vi } from 'vitest';
import { createComputerDesktop } from './desktop';

const launched = vi.hoisted(() => [] as ChildProcess[]);
// Observe real OS children; the desktop and its termination helper remain real.
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>();
  return { ...real, spawn: (...args: Parameters<typeof real.spawn>) => {
    const child = real.spawn(...args);
    if (['Xvfb', 'dbus-daemon', 'gdbus', 'openbox', 'fluxbox'].includes(basename(args[0]))) launched.push(child);
    return child;
  } };
});

const prerequisites = ['Xvfb', 'dbus-daemon', 'gdbus', 'ps', 'xprop', 'xdpyinfo'] as const;
const commands = Object.fromEntries(prerequisites.map(name => [name, resolveExecutableCommand(name)]));
const managers = ['openbox', 'fluxbox'] as const;
const installed = managers.map(name => ({ name, path: resolveExecutableCommand(name) }));
const available = process.platform === 'linux' && prerequisites.every(name => commands[name]);
const exec = promisify(execFile);

async function ownedProcesses() {
  const { stdout } = await exec(commands.ps!, ['-eo', 'pid=,ppid=,pgid=,stat=,wchan=,comm=']);
  const groups = new Set(launched.map(child => child.pid));
  return stdout.trim().split('\n').map(line => {
    const [pid, ppid, pgid, state, waitChannel, command] = line.trim().split(/\s+/);
    return { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), state, waitChannel, command };
  }).filter(row => groups.has(row.pgid) && !row.state?.startsWith('Z'));
}

describe.skipIf(!available)('managed desktop real process disposal', () => {
  for (const manager of installed) it.skipIf(!manager.path)(`${manager.name}: disposes every owned process and recreates a working desktop`, async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'happier-desktop-dispose-'));
    const desktops: ReturnType<typeof createComputerDesktop>[] = [];
    const inheritedPath = process.env.PATH;
    launched.length = 0;
    try {
      // Select each installed WM through the production executable discovery path.
      for (const name of ['Xvfb', 'dbus-daemon', 'gdbus', 'ps'] as const) await symlink(commands[name]!, join(scratch, name));
      await symlink(manager.path!, join(scratch, manager.name));
      vi.stubEnv('PATH', scratch);
      for (let cycle = 0; cycle < 3; cycle++) {
        const firstChild = launched.length;
        const desktop = createComputerDesktop();
        desktops.push(desktop);
        const connection = await desktop.ensure();
        const env = { ...process.env, ...connection.environment, PATH: inheritedPath };
        await vi.waitFor(async () => {
          const { stdout } = await exec(commands.xprop!, ['-root', '_NET_SUPPORTING_WM_CHECK'], { env });
          expect(stdout).toMatch(/window id # 0x[1-9a-f]/);
        }, { timeout: 10_000 });
        await exec(commands.xdpyinfo!, ['-display', connection.displayId], { env });
        console.info('desktop-dispose ready', JSON.stringify({ manager: manager.name, cycle, processes: await ownedProcesses() }));
        const wm = launched.at(-1)!;
        let windowManagerEndedBeforeDisplay = false;
        launched[firstChild]!.once('exit', () => {
          windowManagerEndedBeforeDisplay = wm.exitCode !== null || wm.signalCode !== null;
        });
        if (cycle === 1) {
          // A real WM that cannot handle TERM must consume the existing helper's
          // escalation, and the next cycle must still create a working desktop.
          process.kill(wm.pid!, 'SIGSTOP');
        }
        let settled = false;
        const disposing = desktop.dispose().then(() => { settled = true; });
        try {
          await vi.waitFor(() => expect(settled).toBe(true), { timeout: 10_000 });
          await disposing;
        } catch (error) {
          console.info('desktop-dispose survivors', JSON.stringify({ manager: manager.name, processes: await ownedProcesses() }));
          throw error;
        }
        expect(await ownedProcesses()).toEqual([]);
        expect(windowManagerEndedBeforeDisplay).toBe(true);
        expect(desktop.current()).toBeUndefined();
        await expect(access(`/tmp/.X11-unix/X${connection.displayId.slice(1)}`)).rejects.toMatchObject({ code: 'ENOENT' });
        await expect(access(connection.environment.XDG_RUNTIME_DIR!)).rejects.toMatchObject({ code: 'ENOENT' });
        console.info('desktop-dispose complete', manager.name, cycle, 'survivors=0');
      }
    } finally {
      // Failure cleanup addresses only exact PIDs from this test's detached groups.
      const remaining = await ownedProcesses();
      const closes = launched.filter(child => child.exitCode === null && child.signalCode === null).map(child => once(child, 'close'));
      for (const row of remaining) {
        try { process.kill(row.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
      }
      await Promise.all(closes);
      for (const desktop of desktops) await desktop.dispose();
      vi.unstubAllEnvs();
      await rm(scratch, { recursive: true, force: true });
    }
  });
});
