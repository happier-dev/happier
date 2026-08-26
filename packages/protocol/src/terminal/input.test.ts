import { describe, expect, it } from 'vitest';

import * as protocol from '../index.js';

const terminalProtocol = protocol as Record<string, any>;

function requireTerminalInputApi() {
  expect(typeof terminalProtocol.TerminalInputEventSchema?.safeParse).toBe('function');
  expect(typeof terminalProtocol.TerminalStreamInputRequestSchema?.safeParse).toBe('function');
  return terminalProtocol;
}

describe('terminal input protocol', () => {
  it('accepts renderer-neutral terminal input events', () => {
    const api = requireTerminalInputApi();

    expect(api.TerminalInputEventSchema.safeParse({ t: 'text', text: 'ls\n' }).success).toBe(true);
    expect(api.TerminalInputEventSchema.safeParse({
      t: 'key',
      key: 'Enter',
      modifiers: ['ctrl'],
    }).success).toBe(true);
    expect(api.TerminalInputEventSchema.safeParse({
      t: 'paste',
      text: 'hello',
      bracketed: true,
    }).success).toBe(true);
    expect(api.TerminalInputEventSchema.safeParse({
      t: 'ime',
      phase: 'commit',
      text: 'こんにちは',
    }).success).toBe(true);
    expect(api.TerminalInputEventSchema.safeParse({
      t: 'mouse',
      kind: 'wheel',
      x: 10,
      y: 5,
      modifiers: ['shift'],
    }).success).toBe(true);
    expect(api.TerminalInputEventSchema.safeParse({ t: 'resize', cols: 120, rows: 40 }).success).toBe(true);
  });

  it('rejects raw byte input payloads in TERM V1', () => {
    const api = requireTerminalInputApi();

    expect(api.TerminalStreamInputRequestSchema.safeParse({
      terminalId: 'term-1',
      event: { t: 'text', text: Uint8Array.from([1, 2, 3]) },
    }).success).toBe(false);
  });

  it('rejects unknown fields at every terminal input wire boundary', () => {
    const api = requireTerminalInputApi();
    const events = [
      { t: 'text', text: 'ls\n' },
      { t: 'key', key: 'Enter', modifiers: [] },
      { t: 'paste', text: 'hello', bracketed: true },
      { t: 'ime', phase: 'commit', text: 'こんにちは' },
      { t: 'mouse', kind: 'wheel', x: 10, y: 5, modifiers: [] },
      { t: 'resize', cols: 120, rows: 40 },
    ];

    for (const event of events) {
      expect(api.TerminalInputEventSchema.safeParse({ ...event, unexpected: true }).success).toBe(false);
      expect(api.TerminalStreamInputRequestSchema.safeParse({
        terminalId: 'term-1',
        event: { ...event, unexpected: true },
      }).success).toBe(false);
    }
    expect(api.TerminalStreamInputRequestSchema.safeParse({
      terminalId: 'term-1',
      event: events[0],
      unexpected: true,
    }).success).toBe(false);
    expect(api.TerminalStreamInputResponseSchema.safeParse({ ok: true, unexpected: true }).success).toBe(false);
    expect(api.TerminalStreamInputResponseSchema.safeParse({
      ok: false,
      code: 'terminal_not_found',
      message: 'terminal_not_found',
      unexpected: true,
    }).success).toBe(false);
  });

  it('maps renderer-neutral input events to safe PTY actions', () => {
    const api = requireTerminalInputApi();

    expect(api.terminalInputEventToPtyAction({ t: 'paste', text: 'a\nb', bracketed: true })).toEqual({
      kind: 'write',
      data: '\u001b[200~a\rb\u001b[201~',
    });
    expect(api.terminalInputEventToPtyAction({ t: 'key', key: 'Enter', modifiers: [] })).toEqual({
      kind: 'write',
      data: '\r',
    });
    expect(api.terminalInputEventToPtyAction({ t: 'key', key: 'c', modifiers: ['ctrl'] })).toEqual({
      kind: 'write',
      data: '\u0003',
    });
    expect(api.terminalInputEventToPtyAction({ t: 'mouse', kind: 'down', button: 0, x: 1, y: 1, modifiers: [] })).toEqual({
      kind: 'unsupported',
      code: 'terminal_input_unsupported',
      message: 'terminal_input_unsupported',
    });
  });
});
