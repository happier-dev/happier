import { describe, expect, it } from 'vitest';

import { buildClaudeGoalCommand } from './command.js';

describe('buildClaudeGoalCommand', () => {
  it('formats a set command as `/goal <objective>`', () => {
    expect(buildClaudeGoalCommand({ type: 'set', objective: 'ship the goal feature' }))
      .toBe('/goal ship the goal feature');
  });

  it('trims surrounding whitespace from the objective', () => {
    expect(buildClaudeGoalCommand({ type: 'set', objective: '   tidy up   ' }))
      .toBe('/goal tidy up');
  });

  it('preserves interior horizontal whitespace in the objective', () => {
    expect(buildClaudeGoalCommand({ type: 'set', objective: 'a   b' }))
      .toBe('/goal a   b');
  });

  it('collapses interior newlines to a single space so a multiline objective is one TUI turn', () => {
    // A raw `\n` in the injected `/goal` user turn would submit the command
    // prematurely at the first newline in Claude's TUI. Collapse newline runs
    // (incl. CRLF and surrounding horizontal whitespace) to a single space.
    expect(buildClaudeGoalCommand({ type: 'set', objective: 'line one\nline two' }))
      .toBe('/goal line one line two');
    expect(buildClaudeGoalCommand({ type: 'set', objective: 'line one\r\nline two' }))
      .toBe('/goal line one line two');
    expect(buildClaudeGoalCommand({ type: 'set', objective: 'a\n\n  b' }))
      .toBe('/goal a b');
  });

  it('formats a clear command as `/goal clear`', () => {
    expect(buildClaudeGoalCommand({ type: 'clear' })).toBe('/goal clear');
  });
});
