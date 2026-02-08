import { describe, expect, it } from 'vitest';

import {
  decideCodexLocalControlSupport,
  formatCodexLocalControlLaunchFallbackMessage,
  formatCodexLocalControlSwitchDeniedMessage,
  shouldUseCodexMcpResumeServer,
} from '../localControlSupport';

describe('Codex local-control support (pure decisions)', () => {
  describe('shouldUseCodexMcpResumeServer', () => {
    it('returns true when a vendor resume id is present', () => {
      expect(shouldUseCodexMcpResumeServer({
        experimentalCodexResumeEnabled: true,
        vendorResumeId: 'abc',
        localControlSupported: false,
      })).toBe(true);
    });

    it('returns true when local-control is supported (even with no resume id yet)', () => {
      expect(shouldUseCodexMcpResumeServer({
        experimentalCodexResumeEnabled: true,
        vendorResumeId: null,
        localControlSupported: true,
      })).toBe(true);
    });

    it('returns false when experimental resume is disabled', () => {
      expect(shouldUseCodexMcpResumeServer({
        experimentalCodexResumeEnabled: false,
        vendorResumeId: 'abc',
        localControlSupported: true,
      })).toBe(false);
    });

    it('returns false when resume is not needed and local-control is unsupported', () => {
      expect(shouldUseCodexMcpResumeServer({
        experimentalCodexResumeEnabled: true,
        vendorResumeId: null,
        localControlSupported: false,
      })).toBe(false);
    });

    it('treats whitespace vendor resume ids as absent', () => {
      expect(shouldUseCodexMcpResumeServer({
        experimentalCodexResumeEnabled: true,
        vendorResumeId: '   ',
        localControlSupported: false,
      })).toBe(false);
    });
  });

  describe('decideCodexLocalControlSupport', () => {
    it('fails closed when started by daemon', () => {
      expect(decideCodexLocalControlSupport({
        startedBy: 'daemon',
        experimentalCodexAcpEnabled: false,
        experimentalCodexResumeEnabled: true,
        acpLoadSessionSupported: true,
      })).toEqual({ ok: false, reason: 'started-by-daemon' });
    });

    it('fails closed for ACP when loadSession is unsupported', () => {
      expect(decideCodexLocalControlSupport({
        startedBy: 'cli',
        experimentalCodexAcpEnabled: true,
        experimentalCodexResumeEnabled: false,
        acpLoadSessionSupported: false,
      })).toEqual({ ok: false, reason: 'acp-load-session-unsupported' });
    });

    it('fails closed when neither experimental resume nor ACP is enabled', () => {
      expect(decideCodexLocalControlSupport({
        startedBy: 'cli',
        experimentalCodexAcpEnabled: false,
        experimentalCodexResumeEnabled: false,
        acpLoadSessionSupported: true,
      })).toEqual({ ok: false, reason: 'resume-disabled' });
    });

    it('returns ok for MCP when resume server is available', () => {
      expect(decideCodexLocalControlSupport({
        startedBy: 'cli',
        experimentalCodexAcpEnabled: false,
        experimentalCodexResumeEnabled: true,
        acpLoadSessionSupported: true,
      })).toEqual({ ok: true, backend: 'mcp' });
    });

    it('returns ok for ACP when loadSession is supported', () => {
      expect(decideCodexLocalControlSupport({
        startedBy: 'cli',
        experimentalCodexAcpEnabled: true,
        experimentalCodexResumeEnabled: false,
        acpLoadSessionSupported: true,
      })).toEqual({ ok: true, backend: 'acp' });
    });

    it('prefers ACP backend when both ACP and resume are enabled', () => {
      expect(decideCodexLocalControlSupport({
        startedBy: 'cli',
        experimentalCodexAcpEnabled: true,
        experimentalCodexResumeEnabled: true,
        acpLoadSessionSupported: true,
      })).toEqual({ ok: true, backend: 'acp' });
    });
  });

  describe('user-facing messages', () => {
    it('formats launch fallback reasons', () => {
      expect(formatCodexLocalControlLaunchFallbackMessage('started-by-daemon')).toContain('daemon');
      expect(formatCodexLocalControlLaunchFallbackMessage('resume-disabled')).toContain('resume support');
      expect(formatCodexLocalControlLaunchFallbackMessage('acp-load-session-unsupported')).toContain('loadSession');
    });

    it('formats switch denied reasons', () => {
      expect(formatCodexLocalControlSwitchDeniedMessage('resume-disabled')).toContain('disabled');
      expect(formatCodexLocalControlSwitchDeniedMessage('acp-load-session-unsupported')).toContain('loadSession');
      expect(formatCodexLocalControlSwitchDeniedMessage('started-by-daemon')).toContain('daemon');
    });
  });
});
