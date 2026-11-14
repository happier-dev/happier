import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSpawnHappyCliEnvScope, withTempHappyCliEntrypoint } from '@/testkit/process/spawnHappyCliHarness';
import { PROCESS_OWNER_ENV_KEY } from '@/processes/ownerTag';
import { spawnBackgroundServiceProcessChannel } from './backgroundServiceProcessChannel';

const boundary = vi.hoisted(() => ({ spawn: vi.fn(), readProc: vi.fn(), readdir: vi.fn() }));
// Only native process creation and procfs are replaced. Census parsing, group
// selection, native-identity revalidation and the shared stopper remain real.
vi.mock('child_process', async importOriginal => ({
  ...await importOriginal<typeof import('child_process')>(), spawn: boundary.spawn,
}));
vi.mock('@/processes/census/linuxProcfs', () => ({ readLinuxProcFile: boundary.readProc }));
vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: ((...args: Parameters<typeof actual.readdir>) => String(args[0]).startsWith('/proc')
    ? boundary.readdir(String(args[0])) : actual.readdir(...args)) };
});

type NativeRow = { parent: number; group: number; birth: number; owner?: string };

describe.skipIf(process.platform !== 'linux')('background service group identity', () => {
  const environment = createSpawnHappyCliEnvScope();
  afterEach(() => { environment.restore(); vi.restoreAllMocks(); boundary.spawn.mockReset(); });

  async function withNativeBoundary(run: (fixture: {
    rows: Map<number, NativeRow>;
    child: EventEmitter;
    owner: string;
    signalled: number[];
    channel: Awaited<ReturnType<typeof spawnBackgroundServiceProcessChannel>>;
    procReads: string[];
  }) => Promise<void>) {
    await withTempHappyCliEntrypoint(async entrypoint => {
      environment.patch({ HAPPIER_CLI_SUBPROCESS_RUNTIME: 'node', HAPPIER_CLI_SUBPROCESS_ENTRYPOINT: entrypoint,
        HAPPIER_CLI_SUBPROCESS_RUNTIME_BACKED: undefined, HAPPIER_MANAGED_NODE_BIN: process.execPath });
      const rows = new Map<number, NativeRow>([[process.pid, { parent: 1, group: process.pid, birth: 10 }]]);
      const child = Object.assign(new EventEmitter(), { pid: 4100, stdin: new PassThrough(), stdout: new PassThrough() });
      let owner = '';
      boundary.spawn.mockImplementation((_command, _args, options: { env: NodeJS.ProcessEnv }) => {
        owner = options.env[PROCESS_OWNER_ENV_KEY]!;
        return child;
      });
      boundary.readdir.mockImplementation(async (path: string) => path.endsWith('/task')
        ? [path.split('/')[2]!] : [...rows.keys()].map(String));
      const procReads: string[] = [];
      boundary.readProc.mockImplementation(async (path: string) => {
        procReads.push(path);
        const pid = Number(path.split('/')[2]);
        const row = rows.get(pid);
        if (!row) throw Object.assign(new Error('Process absent'), { code: 'ENOENT' });
        if (path.endsWith('/status')) return 'Uid:\t1000\n';
        if (path.endsWith('/environ')) return row.owner ? `${PROCESS_OWNER_ENV_KEY}=${row.owner}\0` : '';
        if (path.endsWith('/children')) return [...rows].filter(([, value]) => value.parent === pid).map(([value]) => value).join(' ');
        if (path.endsWith('/stat')) {
          const fields = ['S', String(row.parent), String(row.group), '1', '0', '0', ...Array(13).fill('0'), String(row.birth), '0', '0'];
          return `${pid} (fixture) ${fields.join(' ')}`;
        }
        return '';
      });
      const signalled: number[] = [];
      vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        // A group probe (kill(-pgid, 0)) answers ESRCH exactly when no process is in the group.
        if (pid < 0 && signal === 0 && ![...rows.values()].some(row => row.group === -pid)) {
          throw Object.assign(new Error('No such process group'), { code: 'ESRCH' });
        }
        if (signal !== 0) { signalled.push(pid); rows.delete(pid); }
        return true;
      });
      const channel = await spawnBackgroundServiceProcessChannel({ serviceId: 'identity-test' });
      try { await run({ rows, child, owner, signalled, channel, procReads }); }
      finally {
        child.emit('exit', 0, null);
        await channel.terminate();
      }
    });
  }

  it('never signals an unrelated group that recycled the ended worker PID', async () => {
    await withNativeBoundary(async ({ rows, child, channel, signalled }) => {
      // The old worker/group is completely gone. These are new native births
      // whose new group happens to have the same numeric identifier.
      rows.set(4100, { parent: 1, group: 4100, birth: 900, owner: 'v1.000000000000.service.foreign' });
      rows.set(4101, { parent: 4100, group: 4100, birth: 901, owner: 'v1.000000000000.service.foreign' });
      child.emit('exit', 0, null);
      await channel.waitForTermination();
      expect(signalled).toEqual([]);
      expect([...rows.keys()]).toContain(4101);
    });
  });

  it('reads no unrelated process when the ended service left no group member', async () => {
    await withNativeBoundary(async ({ rows, child, channel, signalled, procReads }) => {
      for (let pid = 5000; pid < 5200; pid++) rows.set(pid, { parent: 1, group: pid, birth: pid });
      procReads.length = 0;
      child.emit('exit', 0, null);
      await channel.waitForTermination();
      expect(signalled).toEqual([]);
      expect(procReads.filter(path => { const pid = Number(path.split('/')[2]); return pid >= 5000 && pid < 5200; })).toHaveLength(0);
    });
  });

  it('still releases same-owner inherited members after root exit', async () => {
    await withNativeBoundary(async ({ rows, child, channel, signalled, owner }) => {
      rows.set(4101, { parent: 1, group: 4100, birth: 21, owner });
      child.emit('exit', 0, null);
      await channel.waitForTermination();
      expect(signalled).toEqual([4101]);
    });
  });

  it('still releases captured untagged descendants in a separate group', async () => {
    await withNativeBoundary(async ({ rows, child, channel, signalled, owner }) => {
      rows.set(4100, { parent: 1, group: 4100, birth: 20, owner });
      rows.set(4101, { parent: 4100, group: 4100, birth: 21, owner });
      rows.set(4102, { parent: 4100, group: 4102, birth: 22 });
      const stopping = channel.terminate();
      await vi.waitFor(() => expect(signalled).toContain(4100));
      child.emit('exit', 0, null);
      await stopping;
      expect(signalled).toEqual(expect.arrayContaining([4100, 4101, 4102]));
    });
  });
});
