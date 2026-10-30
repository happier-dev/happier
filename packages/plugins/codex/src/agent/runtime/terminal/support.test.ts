import { describe, expect, it } from 'vitest';

import {
  createCodexTerminalRuntimeSupportResolver,
  decideCodexTerminalRuntimeSupport,
  formatCodexTerminalRuntimeLaunchFallbackMessage,
  formatCodexTerminalRuntimeSwitchDeniedMessage,
  type CodexTerminalRuntimeBackend,
} from './support.js';

describe('Codex terminal-runtime support (pure decisions)', () => {
  describe('decideCodexTerminalRuntimeSupport', () => {
    it('fails closed when started by daemon without a TTY', () => {
      expect(decideCodexTerminalRuntimeSupport({
        startedBy: 'daemon',
        terminalRuntimeBackend: 'acp',
        hasTtyForTerminal: false,
      })).toEqual({ ok: false, reason: 'started-by-daemon' });
    });

  });

  describe('createCodexTerminalRuntimeSupportResolver', () => {
    it('returns resume-disabled when ACP mode is disabled', async () => {
      const resolveSupport = createCodexTerminalRuntimeSupportResolver({
        startedBy: 'cli',
        terminalRuntimeBackend: null,
        hasTtyForTerminal: true,
      });

      const decision = await resolveSupport({ includeAcpProbe: true });
      expect(decision).toEqual({ ok: false, reason: 'resume-disabled' });
    });

    it('returns acp support when ACP mode is enabled', async () => {
      const resolveSupport = createCodexTerminalRuntimeSupportResolver({
        startedBy: 'cli',
        terminalRuntimeBackend: 'acp',
        hasTtyForTerminal: true,
      });

      const decision = await resolveSupport({ includeAcpProbe: true });
      expect(decision).toEqual({ ok: true, backend: 'acp' });
    });

    it('allows daemon-started sessions with a TTY', async () => {
      const resolveSupport = createCodexTerminalRuntimeSupportResolver({
        startedBy: 'daemon',
        terminalRuntimeBackend: 'acp',
        hasTtyForTerminal: true,
      });

      const decision = await resolveSupport({ includeAcpProbe: true });
      expect(decision).toEqual({ ok: true, backend: 'acp' });
    });

    it('returns appServer support when app-server terminal mode is enabled', async () => {
      const resolveSupport = createCodexTerminalRuntimeSupportResolver({
        startedBy: 'cli',
        hasTtyForTerminal: true,
        terminalRuntimeBackend: 'appServer',
      });

      const decision = await resolveSupport({ includeAcpProbe: true });
      expect(decision).toEqual({ ok: true, backend: 'appServer' });
    });

    it('does not cache a stale "ok" decision when the resolved backend changes', async () => {
      const state: {
        terminalRuntimeBackend: CodexTerminalRuntimeBackend | null;
      } = {
        terminalRuntimeBackend: 'acp',
      };

      const resolveSupport = createCodexTerminalRuntimeSupportResolver({
        startedBy: 'cli',
        terminalRuntimeBackend: () => state.terminalRuntimeBackend,
        hasTtyForTerminal: true,
      });

      expect(await resolveSupport({ includeAcpProbe: false })).toEqual({ ok: true, backend: 'acp' });

      state.terminalRuntimeBackend = null;

      expect(await resolveSupport({ includeAcpProbe: false })).toEqual({ ok: false, reason: 'resume-disabled' });
    });

    it('returns an immediate decision without ACP probes', async () => {
      const resolveSupport = createCodexTerminalRuntimeSupportResolver({
        startedBy: 'cli',
        terminalRuntimeBackend: 'acp',
      });

      const decision = await resolveSupport({ includeAcpProbe: true });
      expect(decision).toEqual({ ok: true, backend: 'acp' });
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
