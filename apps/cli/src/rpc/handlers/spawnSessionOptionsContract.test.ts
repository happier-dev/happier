import { describe, expect, it } from 'vitest';

import { SpawnDaemonSessionRequestSchema } from './spawnSessionOptionsContract';

describe('SpawnDaemonSessionRequestSchema', () => {
  it('accepts Windows terminal modes in the terminal payload', () => {
    const parsed = SpawnDaemonSessionRequestSchema.parse({
      directory: '/tmp',
      terminal: {
        mode: 'windows_terminal',
      },
      windowsRemoteSessionLaunchMode: 'windows_terminal',
    });

    expect(parsed.terminal?.mode).toBe('windows_terminal');
    expect(parsed.windowsRemoteSessionLaunchMode).toBe('windows_terminal');
  });
});
