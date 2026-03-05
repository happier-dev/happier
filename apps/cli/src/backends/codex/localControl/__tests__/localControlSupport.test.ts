import { describe, expect, it } from 'vitest';

import {
  decideCodexLocalControlSupport,
  formatCodexLocalControlLaunchFallbackMessage,
  formatCodexLocalControlSwitchDeniedMessage,
} from '../localControlSupport';

describe('Codex local-control support (pure decisions)', () => {
  describe('decideCodexLocalControlSupport', () => {
    it('fails closed when started by daemon without a TTY', () => {
      expect(decideCodexLocalControlSupport({
        startedBy: 'daemon',
        experimentalCodexAcpEnabled: true,
        hasTtyForLocal: false,
      })).toEqual({ ok: false, reason: 'started-by-daemon' });
    });

    it('allows switching to local control when started by daemon with a TTY', () => {
      expect(decideCodexLocalControlSupport({
        startedBy: 'daemon',
        experimentalCodexAcpEnabled: true,
        hasTtyForLocal: true,
      })).toEqual({ ok: true, backend: 'acp' });
    });

    it('fails closed when ACP is disabled', () => {
      expect(decideCodexLocalControlSupport({
        startedBy: 'cli',
        experimentalCodexAcpEnabled: false,
        hasTtyForLocal: true,
      })).toEqual({ ok: false, reason: 'resume-disabled' });
    });

    it('returns ok for ACP when enabled', () => {
      expect(decideCodexLocalControlSupport({
        startedBy: 'cli',
        experimentalCodexAcpEnabled: true,
        hasTtyForLocal: true,
      })).toEqual({ ok: true, backend: 'acp' });
    });
  });

  describe('user-facing messages', () => {
    it('formats launch fallback reasons', () => {
      expect(formatCodexLocalControlLaunchFallbackMessage('started-by-daemon')).toContain('daemon');
      expect(formatCodexLocalControlLaunchFallbackMessage('resume-disabled')).toContain('ACP');
    });

    it('formats switch denied reasons', () => {
      expect(formatCodexLocalControlSwitchDeniedMessage('resume-disabled')).toContain('disabled');
      expect(formatCodexLocalControlSwitchDeniedMessage('started-by-daemon')).toContain('daemon');
    });
  });
});
