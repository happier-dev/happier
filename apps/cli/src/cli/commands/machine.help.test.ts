import { describe, expect, it, vi } from 'vitest';

import { handleMachineCommand } from './machine';
import type { MachineCommandDeps } from './machine';

describe('happier machine --help', () => {
  it('prints usage without touching the system task runner', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const createRunner = vi.fn();
    const deps: Partial<MachineCommandDeps> = {
      createRunner,
    };

    try {
      await handleMachineCommand(['--help'], deps);

      expect(createRunner).not.toHaveBeenCalled();
      const output = logSpy.mock.calls.flat().join('\n');
      expect(output).toContain('happier machine');
      expect(output).toContain('happier machine enroll');
      expect(output).toContain('specific Home profile');
    } finally {
      logSpy.mockRestore();
    }
  });
});
