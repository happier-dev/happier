import { describe, expect, it } from 'vitest';

import { resolveCodexAcpResumePreflight } from './codexAcpResumePreflight';

describe('Codex ACP resume preflight', () => {
  it('returns ok when no resumeId is provided', () => {
    expect(resolveCodexAcpResumePreflight({
      resumeId: null,
      probe: { ok: true, loadSessionSupported: false },
    })).toEqual({ ok: true });
  });

  it('returns ok when resumeId is whitespace-only, even if probe fails', () => {
    expect(resolveCodexAcpResumePreflight({
      resumeId: '   ',
      probe: { ok: false, errorMessage: 'spawn failed' },
    })).toEqual({ ok: true });
  });

  it('returns ok when loadSession is supported', () => {
    expect(resolveCodexAcpResumePreflight({
      resumeId: 'abc',
      probe: { ok: true, loadSessionSupported: true },
    })).toEqual({ ok: true });
  });

  it('returns an actionable error when loadSession is unsupported', () => {
    const result = resolveCodexAcpResumePreflight({
      resumeId: 'abc',
      probe: { ok: true, loadSessionSupported: false },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toContain('Codex ACP');
      expect(result.errorMessage).toContain('loadSession');
      expect(result.errorMessage).toContain('--resume');
    }
  });

  it('returns an actionable error when the probe fails', () => {
    const result = resolveCodexAcpResumePreflight({
      resumeId: 'abc',
      probe: { ok: false, errorMessage: '  spawn failed  ' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toContain('Codex ACP');
      expect(result.errorMessage).toContain('spawn failed');
    }
  });

  it('falls back to unknown error text when probe error is blank', () => {
    const result = resolveCodexAcpResumePreflight({
      resumeId: 'abc',
      probe: { ok: false, errorMessage: '   ' },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorMessage).toContain('Unknown error');
    }
  });
});
