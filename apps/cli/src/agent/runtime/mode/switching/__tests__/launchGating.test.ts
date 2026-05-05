import { describe, expect, it } from 'vitest';

import { applyTerminalRemoteLaunchGating } from '../launchGating';

describe('terminal/remote launch gating', () => {
  it.each([
    {
      label: 'falls back to remote when starting terminal mode is unsupported',
      input: { startingMode: 'local' as const, support: { ok: false as const, reason: 'unavailable' } },
      expected: { mode: 'remote', fallback: { reason: 'unavailable' } },
    },
    {
      label: 'keeps terminal mode when starting terminal mode is supported',
      input: { startingMode: 'local' as const, support: { ok: true as const } },
      expected: { mode: 'local' },
    },
    {
      label: 'keeps remote when starting remote and support is unsupported',
      input: { startingMode: 'remote' as const, support: { ok: false as const, reason: 'unavailable' } },
      expected: { mode: 'remote' },
    },
    {
      label: 'keeps remote when starting remote and support is available',
      input: { startingMode: 'remote' as const, support: { ok: true as const } },
      expected: { mode: 'remote' },
    },
    {
      label: 'preserves fallback reason tokens for unsupported terminal start',
      input: { startingMode: 'local' as const, support: { ok: false as const, reason: 'future-capability-token' } },
      expected: { mode: 'remote', fallback: { reason: 'future-capability-token' } },
    },
  ])('$label', ({ input, expected }) => {
    expect(applyTerminalRemoteLaunchGating(input)).toEqual(expected);
  });
});
