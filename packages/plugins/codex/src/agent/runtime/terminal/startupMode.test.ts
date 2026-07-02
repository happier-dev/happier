import { describe, expect, it } from 'vitest';

import { resolveCodexStartupRuntimeMode } from './startupMode.js';

describe('resolveCodexStartupRuntimeMode', () => {
  it('respects an explicit runtimeMode override', () => {
    expect(resolveCodexStartupRuntimeMode({
      explicitRuntimeMode: 'remote',
      startedBy: 'cli',
      hasTtyForTerminal: true,
      terminalRuntimeEnabled: true,
    })).toBe('remote');

    expect(resolveCodexStartupRuntimeMode({
      explicitRuntimeMode: 'terminal',
      startedBy: 'cli',
      hasTtyForTerminal: true,
      terminalRuntimeEnabled: false,
    })).toBe('terminal');
  });

  it('forces remote when started by daemon even with an explicit terminal override', () => {
    expect(resolveCodexStartupRuntimeMode({
      explicitRuntimeMode: 'terminal',
      startedBy: 'daemon',
      hasTtyForTerminal: true,
      terminalRuntimeEnabled: true,
    })).toBe('remote');
  });

  it('defaults to terminal only when terminal mode is enabled and a TTY is available', () => {
    expect(resolveCodexStartupRuntimeMode({
      explicitRuntimeMode: undefined,
      startedBy: 'cli',
      hasTtyForTerminal: true,
      terminalRuntimeEnabled: true,
    })).toBe('terminal');

    expect(resolveCodexStartupRuntimeMode({
      explicitRuntimeMode: undefined,
      startedBy: 'cli',
      hasTtyForTerminal: false,
      terminalRuntimeEnabled: true,
    })).toBe('remote');
  });
});
