import { describe, expect, it, vi } from 'vitest';

import { createConnectedServicesAuthUpdatedRestartHandler } from './createConnectedServicesAuthUpdatedRestartHandler';

describe('createConnectedServicesAuthUpdatedRestartHandler', () => {
  it('marks pi spawn targets for restart and SIGTERMs the child process', () => {
    const restartRequestedPids = new Set<number>();
    const kill = vi.fn();
    const pidToTrackedSession = new Map<number, any>([
      [1, { pid: 1, startedBy: 'daemon', happySessionId: 's1', childProcess: { kill } }],
      [2, { pid: 2, startedBy: 'daemon', happySessionId: 's2', childProcess: { kill } }],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      restartAgentIds: new Set(['pi']),
    });

    handler({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [
        { pid: 1, agentId: 'pi' },
        { pid: 2, agentId: 'codex' },
      ],
    });

    expect(restartRequestedPids.has(1)).toBe(true);
    expect(restartRequestedPids.has(2)).toBe(false);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('does not double-restart the same pid', () => {
    const restartRequestedPids = new Set<number>([1]);
    const kill = vi.fn();
    const pidToTrackedSession = new Map<number, any>([
      [1, { pid: 1, startedBy: 'daemon', happySessionId: 's1', childProcess: { kill } }],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      restartAgentIds: new Set(['pi']),
    });

    handler({
      binding: { serviceId: 'openai-codex', profileId: 'work' },
      affectedTargets: [{ pid: 1, agentId: 'pi' }],
    });

    expect(kill).toHaveBeenCalledTimes(0);
  });

  it('does not mark the pid for restart when SIGTERM throws', () => {
    const restartRequestedPids = new Set<number>();
    const kill = vi.fn(() => {
      throw new Error('kill-failed');
    });
    const pidToTrackedSession = new Map<number, any>([
      [1, { pid: 1, startedBy: 'daemon', happySessionId: 's1', childProcess: { kill } }],
    ]);

    const handler = createConnectedServicesAuthUpdatedRestartHandler({
      restartRequestedPids,
      pidToTrackedSession,
      restartAgentIds: new Set(['pi']),
    });

    expect(() => {
      handler({
        binding: { serviceId: 'openai-codex', profileId: 'work' },
        affectedTargets: [{ pid: 1, agentId: 'pi' }],
      });
    }).not.toThrow();

    expect(restartRequestedPids.size).toBe(0);
  });
});
