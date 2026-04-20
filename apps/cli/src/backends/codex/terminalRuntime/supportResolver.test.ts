import { describe, expect, it, vi } from 'vitest';

import { createCodexTerminalRuntimeSupportResolver } from './supportResolver';

describe('createCodexTerminalRuntimeSupportResolver', () => {
  it('returns resume-disabled when ACP mode is disabled', async () => {
    const resolveSupport = createCodexTerminalRuntimeSupportResolver({
      startedBy: 'cli',
      experimentalCodexAcpEnabled: false,
      hasTtyForTerminal: true,
    });

    const decision = await resolveSupport({ includeAcpProbe: true });
    expect(decision).toEqual({ ok: false, reason: 'resume-disabled' });
  });

  it('returns acp support when ACP mode is enabled', async () => {
    const resolveSupport = createCodexTerminalRuntimeSupportResolver({
      startedBy: 'cli',
      experimentalCodexAcpEnabled: true,
      hasTtyForTerminal: true,
    });

    const decision = await resolveSupport({ includeAcpProbe: true });
    expect(decision).toEqual({ ok: true, backend: 'acp' });
  });

  it('allows daemon-started sessions with a TTY', async () => {
    const resolveSupport = createCodexTerminalRuntimeSupportResolver({
      startedBy: 'daemon',
      experimentalCodexAcpEnabled: true,
      hasTtyForTerminal: true,
    });

    const decision = await resolveSupport({ includeAcpProbe: true });
    expect(decision).toEqual({ ok: true, backend: 'acp' });
  });

  it('returns appServer support when app-server terminal mode is enabled', async () => {
    const resolveSupport = createCodexTerminalRuntimeSupportResolver({
      startedBy: 'cli',
      experimentalCodexAcpEnabled: false,
      hasTtyForTerminal: true,
      terminalRuntimeBackend: 'appServer',
    });

    const decision = await resolveSupport({ includeAcpProbe: true });
    expect(decision).toEqual({ ok: true, backend: 'appServer' });
  });

  it('does not cache a stale "ok" decision when the resolved backend changes (ACP fallback → MCP)', async () => {
    const state: {
      experimentalCodexAcpEnabled: boolean;
      terminalRuntimeBackend: import('./terminalRuntimeSupport').CodexTerminalRuntimeBackend | null;
    } = {
      experimentalCodexAcpEnabled: true,
      terminalRuntimeBackend: 'acp',
    };

    const resolveSupport = createCodexTerminalRuntimeSupportResolver({
      startedBy: 'cli',
      experimentalCodexAcpEnabled: () => state.experimentalCodexAcpEnabled,
      terminalRuntimeBackend: () => state.terminalRuntimeBackend,
      hasTtyForTerminal: true,
    });

    expect(await resolveSupport({ includeAcpProbe: false })).toEqual({ ok: true, backend: 'acp' });

    // Simulate ACP failing closed and falling back to MCP.
    state.experimentalCodexAcpEnabled = false;
    state.terminalRuntimeBackend = null;

    expect(await resolveSupport({ includeAcpProbe: false })).toEqual({ ok: false, reason: 'resume-disabled' });
  });
});
