import { describe, expect, it, vi } from 'vitest';

import type { ComputerActionExecute } from '@/sync/domains/computer/computerControlClient';

import { computerTargetPickerProps } from './showComputerTargetPicker';

describe('computerTargetPickerProps', () => {
  it("lists targets through the requester's executor, not the front door's", () => {
    // A guided-tour stage or another scoped host supplies its own executor; the picker must not escape it.
    const execute: ComputerActionExecute = vi.fn(async () => ({ ok: false as const, errorCode: 'unused', error: 'unused' }));
    const props = computerTargetPickerProps({
      scope: { sessionId: 'session-1', machineId: 'machine-1' },
      agentName: 'Agent',
      machineName: 'Laptop',
      execute,
      onSelected: () => {},
    });
    expect(props.execute).toBe(execute);
  });
});
