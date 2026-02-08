import { describe, expect, it } from 'vitest';

import { shouldRestartCodexSessionForModeBoundary } from './shouldRestartOnModeBoundary';

describe('shouldRestartCodexSessionForModeBoundary', () => {
  it('returns false for MCP when a created session sees a mode hash change (preserve in-memory context)', () => {
    expect(
      shouldRestartCodexSessionForModeBoundary({
        backendKind: 'mcp',
        wasCreated: true,
        currentModeHash: 'a',
        nextModeHash: 'b',
      }),
    ).toBe(false);
  });

  it('returns false before a session is created', () => {
    expect(
      shouldRestartCodexSessionForModeBoundary({
        backendKind: 'mcp',
        wasCreated: false,
        currentModeHash: null,
        nextModeHash: 'b',
      }),
    ).toBe(false);
  });

  it('returns false when mode hash is unchanged', () => {
    expect(
      shouldRestartCodexSessionForModeBoundary({
        backendKind: 'acp',
        wasCreated: true,
        currentModeHash: 'same',
        nextModeHash: 'same',
      }),
    ).toBe(false);
  });

  it('returns false for ACP when a created session sees a mode hash change (apply via gating/modes, not reset)', () => {
    expect(
      shouldRestartCodexSessionForModeBoundary({
        backendKind: 'acp',
        wasCreated: true,
        currentModeHash: 'a',
        nextModeHash: 'b',
      }),
    ).toBe(false);
  });
});
