import { describe, expect, it } from 'vitest';

import { resolveCodexStartupRuntimeMode } from './resolveCodexStartupRuntimeMode';

describe('resolveCodexStartupRuntimeMode', () => {
  it('respects an explicit runtimeMode override', () => {
    expect(
      resolveCodexStartupRuntimeMode({
        explicitRuntimeMode: 'remote',
        startedBy: 'cli',
        hasTtyForTerminal: true,
        terminalRuntimeEnabled: true,
      }),
    ).toBe('remote');

    expect(
      resolveCodexStartupRuntimeMode({
        explicitRuntimeMode: 'terminal',
        startedBy: 'cli',
        hasTtyForTerminal: true,
        terminalRuntimeEnabled: false,
      }),
    ).toBe('terminal');
  });

  it('respects an explicit terminal runtimeMode override even without a TTY', () => {
    expect(
      resolveCodexStartupRuntimeMode({
        explicitRuntimeMode: 'terminal',
        startedBy: 'cli',
        hasTtyForTerminal: false,
        terminalRuntimeEnabled: true,
      }),
    ).toBe('terminal');
  });

  it('forces remote when started by daemon even with an explicit terminal override', () => {
    expect(
      resolveCodexStartupRuntimeMode({
        explicitRuntimeMode: 'terminal',
        startedBy: 'daemon',
        hasTtyForTerminal: true,
        terminalRuntimeEnabled: true,
      }),
    ).toBe('remote');
  });

  it('defaults to remote when started by daemon', () => {
    expect(
      resolveCodexStartupRuntimeMode({
        explicitRuntimeMode: undefined,
        startedBy: 'daemon',
        hasTtyForTerminal: true,
        terminalRuntimeEnabled: true,
      }),
    ).toBe('remote');
  });

  it('defaults to terminal when terminal mode is enabled and a TTY is available', () => {
    expect(
      resolveCodexStartupRuntimeMode({
        explicitRuntimeMode: undefined,
        startedBy: 'cli',
        hasTtyForTerminal: true,
        terminalRuntimeEnabled: true,
      }),
    ).toBe('terminal');
  });

  it('defaults to remote when terminal mode is disabled or a TTY is unavailable', () => {
    expect(
      resolveCodexStartupRuntimeMode({
        explicitRuntimeMode: undefined,
        startedBy: 'cli',
        hasTtyForTerminal: true,
        terminalRuntimeEnabled: false,
      }),
    ).toBe('remote');

    expect(
      resolveCodexStartupRuntimeMode({
        explicitRuntimeMode: undefined,
        startedBy: 'cli',
        hasTtyForTerminal: false,
        terminalRuntimeEnabled: true,
      }),
    ).toBe('remote');
  });
});
