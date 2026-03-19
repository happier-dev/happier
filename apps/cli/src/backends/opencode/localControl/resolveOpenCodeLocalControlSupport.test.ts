import { describe, expect, it } from 'vitest';

import { resolveOpenCodeLocalControlSupport } from './resolveOpenCodeLocalControlSupport';

describe('resolveOpenCodeLocalControlSupport', () => {
  it('supports server-backed sessions with a tty even when started by the daemon', () => {
    expect(resolveOpenCodeLocalControlSupport({
      backendMode: 'server',
      hasTTY: true,
    })).toEqual({ ok: true });
  });

  it('rejects acp mode', () => {
    expect(resolveOpenCodeLocalControlSupport({
      backendMode: 'acp',
      hasTTY: true,
    })).toEqual({ ok: false, reason: 'backend_mode_unsupported' });
  });

  it('rejects missing tty', () => {
    expect(resolveOpenCodeLocalControlSupport({
      backendMode: 'server',
      hasTTY: false,
    })).toEqual({ ok: false, reason: 'tty_unavailable' });
  });
});
