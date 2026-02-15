import { spawn } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import { createManagedChildProcess } from '../managedChildProcess';

describe('managedChildProcess.waitForTermination', () => {
  it('settles for non-zero exits', async () => {
    const child = spawn(process.execPath, ['-e', 'process.exit(7)'], { stdio: 'ignore' });
    const managed = createManagedChildProcess(child);
    const event = await managed.waitForTermination();
    expect(event).toEqual({ type: 'exited', code: 7 });
  });
});

