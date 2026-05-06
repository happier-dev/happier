import { describe, expect, it } from 'vitest';

import { resolveSessionMachineId } from './resolveSessionMachineId';

describe('resolveSessionMachineId', () => {
  it('prefers the top-level session machine id when present', () => {
    expect(resolveSessionMachineId({
      machineId: ' machine-top ',
      directSessionV1: {
        v: 1,
        providerId: 'claude',
        machineId: 'machine-direct',
        remoteSessionId: 'remote-1',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
      },
    } as any)).toBe('machine-top');
  });

  it('falls back to the linked direct-session machine id when the top-level machine id is absent', () => {
    expect(resolveSessionMachineId({
      directSessionV1: {
        v: 1,
        providerId: 'claude',
        machineId: ' machine-direct ',
        remoteSessionId: 'remote-1',
        source: { kind: 'claudeConfig', configDir: '/tmp/claude' },
      },
    } as any)).toBe('machine-direct');
  });

  it('returns null when neither machine id source is available', () => {
    expect(resolveSessionMachineId({ agent: 'claude' } as any)).toBeNull();
  });
});
