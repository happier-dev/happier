import { describe, expect, it } from 'vitest';

import { resolveClaudeTerminalHostDisposeIntent } from './terminalHostDisposeIntent';

describe('resolveClaudeTerminalHostDisposeIntent', () => {
  it('destroys only for an explicit session close', () => {
    expect(resolveClaudeTerminalHostDisposeIntent('session_closed')).toEqual({
      kind: 'destroy_owned_host',
      reason: 'session_closed',
    });
  });

  it.each(['plugin_deactivated', 'host_shutdown', 'runtime_recovery'] as const)(
    'preserves the host for %s',
    (reason) => {
      expect(resolveClaudeTerminalHostDisposeIntent({ reason })).toEqual({
        kind: 'preserve_host',
        reason,
      });
    },
  );

  it('fails closed to preservation when disposal provenance is absent', () => {
    expect(resolveClaudeTerminalHostDisposeIntent(undefined)).toEqual({
      kind: 'preserve_host',
      reason: 'unspecified',
    });
  });
});
