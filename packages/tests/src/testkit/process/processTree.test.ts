import { describe, expect, it, vi } from 'vitest';

import { collectDescendantPids } from './processTree';

describe('collectDescendantPids', () => {
  it('collects a Windows descendant tree through the process-list system boundary', () => {
    const spawnProcessList = vi.fn(() => ({
      status: 0,
      stdout: JSON.stringify([
        { ProcessId: 101, ParentProcessId: 1 },
        { ProcessId: 202, ParentProcessId: 101 },
        { ProcessId: 303, ParentProcessId: 202 },
        { ProcessId: 404, ParentProcessId: 1 },
      ]),
    }));

    expect(collectDescendantPids(101, {
      platform: 'win32',
      spawnProcessList,
    })).toEqual([202, 303]);
    expect(spawnProcessList).toHaveBeenCalledOnce();
  });
});
