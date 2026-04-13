import { describe, expect, it, vi } from 'vitest';

import { createCodexTerminalRuntimeSupportResolver } from '../createTerminalRuntimeSupportResolver';

describe('createCodexTerminalRuntimeSupportResolver', () => {
  it('returns resume-disabled when ACP mode is disabled', async () => {
    const resolveSupport = createCodexTerminalRuntimeSupportResolver({
      startedBy: 'cli',
      experimentalCodexAcpEnabled: false,
      hasTtyForLocal: true,
    });

    const decision = await resolveSupport({ includeAcpProbe: true });
    expect(decision).toEqual({ ok: false, reason: 'resume-disabled' });
  });

  it('returns acp support when ACP mode is enabled', async () => {
    const resolveSupport = createCodexTerminalRuntimeSupportResolver({
      startedBy: 'cli',
      experimentalCodexAcpEnabled: true,
      hasTtyForLocal: true,
    });

    const decision = await resolveSupport({ includeAcpProbe: true });
    expect(decision).toEqual({ ok: true, backend: 'acp' });
  });

  it('allows daemon-started sessions with a TTY', async () => {
    const resolveSupport = createCodexTerminalRuntimeSupportResolver({
      startedBy: 'daemon',
      experimentalCodexAcpEnabled: true,
      hasTtyForLocal: true,
    });

    const decision = await resolveSupport({ includeAcpProbe: true });
    expect(decision).toEqual({ ok: true, backend: 'acp' });
  });

  it('returns appServer support when app-server local control is enabled', async () => {
    const resolveSupport = createCodexTerminalRuntimeSupportResolver({
      startedBy: 'cli',
      experimentalCodexAcpEnabled: false,
      hasTtyForLocal: true,
      terminalRuntimeBackend: 'appServer',
    });

    const decision = await resolveSupport({ includeAcpProbe: true });
    expect(decision).toEqual({ ok: true, backend: 'appServer' });
  });

  it('does not cache a stale "ok" decision when the resolved backend changes (ACP fallback → MCP)', async () => {
    const state: {
      experimentalCodexAcpEnabled: boolean;
      terminalRuntimeBackend: import('../terminalRuntimeSupport').CodexTerminalRuntimeBackend | null;
    } = {
      experimentalCodexAcpEnabled: true,
      terminalRuntimeBackend: 'acp',
    };

    const resolveSupport = createCodexTerminalRuntimeSupportResolver({
      startedBy: 'cli',
      experimentalCodexAcpEnabled: () => state.experimentalCodexAcpEnabled,
      terminalRuntimeBackend: () => state.terminalRuntimeBackend,
      hasTtyForLocal: true,
    });

    expect(await resolveSupport({ includeAcpProbe: false })).toEqual({ ok: true, backend: 'acp' });

    // Simulate ACP failing closed and falling back to MCP.
    state.experimentalCodexAcpEnabled = false;
    state.terminalRuntimeBackend = null;

    expect(await resolveSupport({ includeAcpProbe: false })).toEqual({ ok: false, reason: 'resume-disabled' });
  });
});
