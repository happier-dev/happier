import { describe, expect, it, vi } from 'vitest';

import { resolveDaemonTerminalLaunch } from './launch';

describe('resolveDaemonTerminalLaunch', () => {
  it('delegates attached-session launch argv to the canonical Happier CLI runtime owner', () => {
    const buildLaunchSpec = vi.fn(() => ({
      runtime: 'binary' as const,
      filePath: '/opt/happier/bin/happier',
      args: ['attach', 'session-1'],
    }));

    expect(resolveDaemonTerminalLaunch(
      { kind: 'session_attach', sessionId: 'session-1' },
      { buildLaunchSpec },
    )).toEqual({
      file: '/opt/happier/bin/happier',
      args: ['attach', 'session-1'],
      env: undefined,
    });
    expect(buildLaunchSpec).toHaveBeenCalledWith(['attach', 'session-1']);
  });
});
