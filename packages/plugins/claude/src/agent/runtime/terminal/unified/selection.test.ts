import { describe, expect, it } from 'vitest';

import { isClaudeUnifiedTerminalSelected, readClaudeTerminalRuntimeSelection } from './selection';

describe('readClaudeTerminalRuntimeSelection', () => {
  it('keeps every terminal host the runtime can realize', () => {
    for (const host of ['tmux', 'zellij', 'herdr', 'windows_console'] as const) {
      expect(readClaudeTerminalRuntimeSelection({ v: 1, agentId: 'claude', agent: { backendMode: 'unifiedTerminal', terminalHostKind: host } }))
        .toEqual({ mode: 'unifiedTerminal', host });
    }
    expect(readClaudeTerminalRuntimeSelection({ v: 1, agentId: 'claude', agent: { backendMode: 'unifiedTerminal', terminalHostKind: 'other' } }))
      .toEqual({ mode: 'unifiedTerminal' });
  });
});

describe('isClaudeUnifiedTerminalSelected', () => {
  const context = (featureEnabled: boolean, setting: unknown) => ({
    features: { isEnabled: () => featureEnabled },
    settings: { get: async () => setting },
  });
  it('reports which input decided the backend, so a running Session shows why it is not unified', async () => {
    const decisions: unknown[] = [];
    const onDecision = (decision: unknown) => { decisions.push(decision); };
    await isClaudeUnifiedTerminalSelected({ context: context(true, true), onDecision,
      runtimeDescriptorV1: { v: 1, agentId: 'claude', agent: { backendMode: 'agentSdk' } } as never });
    await isClaudeUnifiedTerminalSelected({ context: context(false, true), onDecision });
    await isClaudeUnifiedTerminalSelected({ context: context(true, true), onDecision });
    expect(decisions).toEqual([
      { selected: false, reason: 'captured_descriptor' },
      { selected: false, reason: 'feature_disabled' },
      { selected: true, reason: 'account_setting' },
    ]);
  });
});

describe('Windows hidden-console default (HOLDER-PTY A2 b)', () => {
  const context = (featureEnabled: boolean, setting: unknown) => ({
    features: { isEnabled: () => featureEnabled },
    settings: { get: async () => setting },
  });
  it('selects the unified terminal for a Windows hidden-console Session when the feature is on, and stays fail-closed when it is off', async () => {
    const decisions: unknown[] = [];
    const onDecision = (decision: unknown) => { decisions.push(decision); };
    expect(await isClaudeUnifiedTerminalSelected({ context: context(true, false), requestedHost: 'windows_console', onDecision })).toBe(true);
    expect(await isClaudeUnifiedTerminalSelected({ context: context(false, true), requestedHost: 'windows_console', onDecision })).toBe(false);
    // Other hosts keep the account setting.
    expect(await isClaudeUnifiedTerminalSelected({ context: context(true, false), requestedHost: 'tmux', onDecision })).toBe(false);
    expect(decisions).toEqual([
      { selected: true, reason: 'windows_hidden_console_default' },
      { selected: false, reason: 'feature_disabled' },
      { selected: false, reason: 'account_setting' },
    ]);
  });
});
