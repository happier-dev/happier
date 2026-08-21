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
});
