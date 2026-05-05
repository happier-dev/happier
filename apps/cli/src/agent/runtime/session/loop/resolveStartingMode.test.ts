import { describe, expect, it } from 'vitest';

import { normalizeStartingMode, resolveStartingMode } from './resolveStartingMode';

describe('normalizeStartingMode', () => {
  it('normalizes explicit and legacy terminal mode values', () => {
    expect(normalizeStartingMode('terminal')).toBe('terminal');
    expect(normalizeStartingMode('local')).toBe('terminal');
  });

  it('normalizes explicit remote mode values and rejects unknown values', () => {
    expect(normalizeStartingMode('remote')).toBe('remote');
    expect(normalizeStartingMode('auto')).toBeNull();
  });
});

describe('resolveStartingMode', () => {
  it('preserves explicit terminal intent when terminal mode is available', () => {
    expect(resolveStartingMode({
      terminalCapable: true,
      userIntent: 'terminal',
      providerHint: 'remote',
    })).toEqual({ kind: 'switching', startingMode: 'terminal' });
  });

  it('preserves explicit remote intent when terminal mode is available', () => {
    expect(resolveStartingMode({
      terminalCapable: true,
      userIntent: 'remote',
      providerHint: 'terminal',
    })).toEqual({ kind: 'switching', startingMode: 'remote' });
  });

  it('uses provider hint for auto/default terminal-capable starts', () => {
    expect(resolveStartingMode({
      terminalCapable: true,
      userIntent: undefined,
      providerHint: 'remote',
    })).toEqual({ kind: 'switching', startingMode: 'remote' });
  });

  it('defaults terminal-capable starts to terminal when no intent or hint exists', () => {
    expect(resolveStartingMode({
      terminalCapable: true,
      userIntent: undefined,
      providerHint: undefined,
    })).toEqual({ kind: 'switching', startingMode: 'terminal' });
  });

  it('falls back to remote-only when terminal mode is unavailable', () => {
    expect(resolveStartingMode({
      terminalCapable: false,
      userIntent: 'terminal',
      providerHint: 'terminal',
    })).toEqual({ kind: 'remote-only', requestedMode: 'terminal' });
  });
});
