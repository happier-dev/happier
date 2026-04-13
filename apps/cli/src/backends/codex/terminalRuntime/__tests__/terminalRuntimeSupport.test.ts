import { describe, expect, it } from 'vitest';

import {
  decideCodexTerminalRuntimeSupport,
  formatCodexTerminalRuntimeLaunchFallbackMessage,
  formatCodexTerminalRuntimeSwitchDeniedMessage,
} from '../terminalRuntimeSupport';

describe('Codex terminal-runtime support (pure decisions)', () => {
  describe('decideCodexTerminalRuntimeSupport', () => {
    it('fails closed when started by daemon without a TTY', () => {
      expect(decideCodexTerminalRuntimeSupport({
        startedBy: 'daemon',
        experimentalCodexAcpEnabled: true,
        hasTtyForLocal: false,
      })).toEqual({ ok: false, reason: 'started-by-daemon' });
    });

    it('allows switching to local control when started by daemon with a TTY', () => {
      expect(decideCodexTerminalRuntimeSupport({
        startedBy: 'daemon',
        experimentalCodexAcpEnabled: true,
        hasTtyForLocal: true,
      })).toEqual({ ok: true, backend: 'acp' });
    });

    it('fails closed when ACP is disabled', () => {
      expect(decideCodexTerminalRuntimeSupport({
        startedBy: 'cli',
        experimentalCodexAcpEnabled: false,
        hasTtyForLocal: true,
      })).toEqual({ ok: false, reason: 'resume-disabled' });
    });

    it('returns ok for ACP when enabled', () => {
      expect(decideCodexTerminalRuntimeSupport({
        startedBy: 'cli',
        experimentalCodexAcpEnabled: true,
        hasTtyForLocal: true,
      })).toEqual({ ok: true, backend: 'acp' });
    });

    it('returns ok for app-server when local control is enabled there', () => {
      expect(decideCodexTerminalRuntimeSupport({
        startedBy: 'cli',
        experimentalCodexAcpEnabled: true,
        hasTtyForLocal: true,
        terminalRuntimeBackend: 'appServer',
      })).toEqual({ ok: true, backend: 'appServer' });
    });
  });

  describe('user-facing messages', () => {
    it('formats launch fallback reasons', () => {
      expect(formatCodexTerminalRuntimeLaunchFallbackMessage('started-by-daemon')).toContain('daemon');
      expect(formatCodexTerminalRuntimeLaunchFallbackMessage('resume-disabled')).toContain('resumable');
    });

    it('formats switch denied reasons', () => {
      expect(formatCodexTerminalRuntimeSwitchDeniedMessage('resume-disabled')).toContain('enabled');
      expect(formatCodexTerminalRuntimeSwitchDeniedMessage('started-by-daemon')).toContain('daemon');
    });
  });
});
