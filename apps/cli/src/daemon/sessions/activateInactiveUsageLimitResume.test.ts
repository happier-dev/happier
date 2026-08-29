import { beforeEach, describe, expect, it, vi } from 'vitest';

import { activateInactiveUsageLimitResume } from './activateInactiveUsageLimitResume';

const metadata = {
  machineId: 'machine-1',
  path: '/repo',
  flavor: 'codex',
  codexSessionId: 'vendor-1',
  backendTarget: { kind: 'builtInAgent', agentId: 'codex' },
};

const rawSession = {
  id: 'session-1',
  active: false,
  machineId: 'machine-1',
  path: '/repo',
  seq: 3,
};

describe('activateInactiveUsageLimitResume', () => {
  let spawnSession: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    spawnSession = vi.fn(async () => ({
      type: 'success' as const,
      sessionId: 'session-1',
    }));
  });

  it('keeps auto-resuming a plain unlinked inactive session when recovery is ready', async () => {
    await expect(activateInactiveUsageLimitResume({
      fallbackMachineId: 'machine-1',
      sessionId: 'session-1',
      rawSession,
      metadata,
      spawnSession,
    })).resolves.toBe(true);

    expect(spawnSession).toHaveBeenCalledTimes(1);
    expect(spawnSession).toHaveBeenCalledWith(expect.objectContaining({
      existingSessionId: 'session-1',
      machineId: 'machine-1',
    }));
  });

  it('refuses to spawn an externally linked session so takeover owns hosted admission', async () => {
    await expect(activateInactiveUsageLimitResume({
      fallbackMachineId: 'machine-1',
      sessionId: 'session-1',
      rawSession,
      metadata: {
        ...metadata,
        externalSessionV1: {
          v: 1,
          agentId: 'codex',
          machineId: 'machine-1',
          remoteSessionId: 'vendor-1',
          source: { kind: 'codexHome', home: 'user' },
          linkedAtMs: 1,
        },
      },
      spawnSession,
    })).resolves.toBe(false);

    expect(spawnSession).not.toHaveBeenCalled();
  });

  it('refuses to spawn when the external link exists but is unresolved', async () => {
    await expect(activateInactiveUsageLimitResume({
      fallbackMachineId: 'machine-1',
      sessionId: 'session-1',
      rawSession,
      metadata: {
        ...metadata,
        externalSessionV1: { v: 1 },
      },
      spawnSession,
    })).resolves.toBe(false);

    expect(spawnSession).not.toHaveBeenCalled();
  });
});
