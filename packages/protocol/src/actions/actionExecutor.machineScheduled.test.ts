import { describe, expect, it } from 'vitest';
import { createActionExecutor, type ActionExecutorDeps } from './actionExecutor.js';

describe('Machine scheduled read Action', () => {
  it('reads the exact Machine page and refuses a different Home before transport', async () => {
    const requests: unknown[] = [];
    // The native Machine transport is the system boundary; Action admission remains real.
    const executor = createActionExecutor({ machineScheduledAction: async (request: unknown) => {
      requests.push(request);
      return { kind: 'snapshot', revision: 1, sources: [{ source: 'system_cron', kind: 'available', totalJobs: 1, jobs: [{ id: 'cron:1', name: 'backup', schedule: '0 2 * * *' }] }], nextOffset: null };
    } } as ActionExecutorDeps);
    expect(await executor.execute('machines.scheduled.list', { serverId: 'h', machineId: 'm', pageSize: 10 }, { surface: 'cli', serverId: 'h' }))
      .toMatchObject({ ok: true, result: { kind: 'snapshot', sources: [{ jobs: [{ name: 'backup' }] }] } });
    expect(await executor.execute('machines.scheduled.list', { serverId: 'other', machineId: 'm', pageSize: 10 }, { surface: 'cli', serverId: 'h' }))
      .toMatchObject({ ok: false, errorCode: 'server_target_mismatch' });
    expect(requests).toHaveLength(1);
  });
});
