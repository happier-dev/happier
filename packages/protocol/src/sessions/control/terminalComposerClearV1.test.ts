import { describe, expect, it } from 'vitest';

import {
  SessionTerminalComposerClearRequestV1Schema,
  SessionTerminalComposerClearResultV1Schema,
  buildUnsupportedSessionTerminalComposerClearResult,
} from './terminalComposerClearV1.js';

describe('session terminal composer clear contract', () => {
  it('accepts provider-neutral clear requests with an optional expected state timestamp', () => {
    expect(SessionTerminalComposerClearRequestV1Schema.parse({
      sessionId: ' sess_1 ',
      expectedStateAtMs: 1_700_000_000_000,
    })).toEqual({
      sessionId: 'sess_1',
      expectedStateAtMs: 1_700_000_000_000,
    });

    expect(SessionTerminalComposerClearRequestV1Schema.safeParse({
      sessionId: '   ',
    }).success).toBe(false);
    expect(SessionTerminalComposerClearRequestV1Schema.safeParse({
      sessionId: 'sess_1',
      expectedStateAtMs: -1,
    }).success).toBe(false);
  });

  it('normalizes success statuses and provider-neutral failure statuses', () => {
    expect(SessionTerminalComposerClearResultV1Schema.parse({
      ok: true,
      status: 'cleared',
      sessionId: 'sess_1',
    })).toEqual({
      ok: true,
      status: 'cleared',
      sessionId: 'sess_1',
    });
    expect(SessionTerminalComposerClearResultV1Schema.parse({
      ok: true,
      status: 'already_empty',
      sessionId: 'sess_1',
    })).toEqual({
      ok: true,
      status: 'already_empty',
      sessionId: 'sess_1',
    });
    for (const status of [
      'unsupported',
      'no_live_terminal',
      'not_safe',
      'generating',
      'dialog_open',
      'capture_unavailable',
      'clear_failed',
      'host_dead',
    ] as const) {
      expect(SessionTerminalComposerClearResultV1Schema.parse({
        ok: false,
        status,
        errorCode: status,
        sessionId: 'sess_1',
      })).toEqual({
        ok: false,
        status,
        errorCode: status,
        sessionId: 'sess_1',
      });
    }
    for (const status of ['stale_state', 'failed'] as const) {
      expect(SessionTerminalComposerClearResultV1Schema.parse({
        ok: false,
        status,
        sessionId: 'sess_1',
      })).toEqual({
        ok: false,
        status,
        sessionId: 'sess_1',
      });
    }
    expect(SessionTerminalComposerClearResultV1Schema.safeParse({
      ok: false,
      status: 'claude_menu_open',
      sessionId: 'sess_1',
    }).success).toBe(false);
  });

  it('builds the typed unsupported result used by session runtime-control fallbacks', () => {
    expect(buildUnsupportedSessionTerminalComposerClearResult(
      'sess_1',
      'session.terminalComposer.clear',
    )).toEqual({
      ok: false,
      status: 'unsupported',
      sessionId: 'sess_1',
      errorCode: 'unsupported_session_runtime_method',
      error: 'unsupported_session_runtime_method:session.terminalComposer.clear',
    });
  });
});
