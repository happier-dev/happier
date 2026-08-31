import { describe, expect, it, vi } from 'vitest';

import { applyStackSessionPriority } from './applyStackSessionPriority';

describe('applyStackSessionPriority', () => {
  it('normalizes rescue session runners before provider dispatch', () => {
    const setPriority = vi.fn();
    expect(applyStackSessionPriority({
      env: {
        HAPPIER_STACK_RESCUE: '1',
        HAPPIER_STACK_PROCESS_KIND: 'session',
      },
      platform: 'darwin',
      setPriority,
    })).toBe(true);
    expect(setPriority).toHaveBeenCalledWith(0, 5);
  });

  it('does not alter ordinary CLI or control-plane processes', () => {
    const setPriority = vi.fn();
    expect(applyStackSessionPriority({
      env: { HAPPIER_STACK_RESCUE: '1', HAPPIER_STACK_PROCESS_KIND: 'infra' },
      platform: 'darwin',
      setPriority,
    })).toBe(false);
    expect(setPriority).not.toHaveBeenCalled();
  });

  it('keeps a rescue session runnable when the OS denies raising inherited priority', () => {
    const denial = Object.assign(new Error('uv_os_setpriority returned EACCES'), {
      code: 'ERR_SYSTEM_ERROR',
      errno: -13,
    });
    expect(applyStackSessionPriority({
      env: {
        HAPPIER_STACK_RESCUE: '1',
        HAPPIER_STACK_PROCESS_KIND: 'session',
      },
      platform: 'linux',
      setPriority: () => { throw denial; },
    })).toBe(false);
  });

  it('surfaces unexpected priority failures', () => {
    const failure = new Error('unexpected priority failure');
    expect(() => applyStackSessionPriority({
      env: {
        HAPPIER_STACK_RESCUE: '1',
        HAPPIER_STACK_PROCESS_KIND: 'session',
      },
      platform: 'linux',
      setPriority: () => { throw failure; },
    })).toThrow('Could not normalize rescue-mode agent session priority');
  });
});
