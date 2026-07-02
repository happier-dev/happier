import { describe, expect, it } from 'vitest';

import {
  ConnectedServiceSessionAuthSwitchLockRegistry,
  createConnectedServiceSessionAuthSwitchCore,
} from './connectedServiceSessionAuthSwitchCore';

describe('connectedServiceSessionAuthSwitchCore', () => {
  it('allows the same async transition to re-enter the same session lock', async () => {
    const core = createConnectedServiceSessionAuthSwitchCore({
      locks: new ConnectedServiceSessionAuthSwitchLockRegistry(),
    });
    const events: string[] = [];

    const transition = core.run({
      sessionId: 'session-1',
      reason: 'automatic_runtime_failure',
      execute: async () => {
        events.push('outer:start');
        const inner = await core.run({
          sessionId: 'session-1',
          reason: 'manual',
          execute: async () => {
            events.push('inner');
            return 'inner-result';
          },
        });
        events.push(`outer:${inner}`);
        return 'outer-result';
      },
    });

    const result = await Promise.race([
      transition.then((value) => ({ kind: 'resolved' as const, value })),
      new Promise<{ kind: 'timed_out' }>((resolve) => {
        setTimeout(() => resolve({ kind: 'timed_out' }), 25);
      }),
    ]);

    expect(result).toEqual({ kind: 'resolved', value: 'outer-result' });
    expect(events).toEqual(['outer:start', 'inner', 'outer:inner-result']);
  });

  it('serializes concurrent switches for the same session', async () => {
    const core = createConnectedServiceSessionAuthSwitchCore({
      locks: new ConnectedServiceSessionAuthSwitchLockRegistry(),
    });
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = core.run({
      sessionId: 'session-1',
      reason: 'automatic_runtime_failure',
      execute: async () => {
        events.push('first:start');
        await firstCanFinish;
        events.push('first:end');
        return { status: 'first' as const };
      },
    });

    await Promise.resolve();

    const second = core.run({
      sessionId: 'session-1',
      reason: 'manual',
      execute: async () => {
        events.push('second:start');
        return { status: 'second' as const };
      },
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);

    releaseFirst();
    await expect(first).resolves.toEqual({ status: 'first' });
    await expect(second).resolves.toEqual({ status: 'second' });
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
  });
});
