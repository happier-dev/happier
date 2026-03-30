import { describe, expect, it, vi } from 'vitest';

import { createCodexLocalControlSupportResolver } from '../createLocalControlSupportResolver';

describe('createCodexLocalControlSupportResolver', () => {
  it('returns resume-disabled when ACP mode is disabled', async () => {
    const resolveSupport = createCodexLocalControlSupportResolver({
      startedBy: 'cli',
      experimentalCodexAcpEnabled: false,
      hasTtyForLocal: true,
    });

    const decision = await resolveSupport({ includeAcpProbe: true });
    expect(decision).toEqual({ ok: false, reason: 'resume-disabled' });
  });

  it('returns acp support when ACP mode is enabled', async () => {
    const resolveSupport = createCodexLocalControlSupportResolver({
      startedBy: 'cli',
      experimentalCodexAcpEnabled: true,
      hasTtyForLocal: true,
    });

    const decision = await resolveSupport({ includeAcpProbe: true });
    expect(decision).toEqual({ ok: true, backend: 'acp' });
  });

  it('allows daemon-started sessions with a TTY', async () => {
    const resolveSupport = createCodexLocalControlSupportResolver({
      startedBy: 'daemon',
      experimentalCodexAcpEnabled: true,
      hasTtyForLocal: true,
    });

    const decision = await resolveSupport({ includeAcpProbe: true });
    expect(decision).toEqual({ ok: true, backend: 'acp' });
  });

  it('returns appServer support when app-server local control is enabled', async () => {
    const resolveSupport = createCodexLocalControlSupportResolver({
      startedBy: 'cli',
      experimentalCodexAcpEnabled: false,
      hasTtyForLocal: true,
      localControlBackend: 'appServer',
    });

    const decision = await resolveSupport({ includeAcpProbe: true });
    expect(decision).toEqual({ ok: true, backend: 'appServer' });
  });

  it('does not cache a stale "ok" decision when the resolved backend changes (ACP fallback → MCP)', async () => {
    const state: {
      experimentalCodexAcpEnabled: boolean;
      localControlBackend: import('../localControlSupport').CodexLocalControlBackend | null;
    } = {
      experimentalCodexAcpEnabled: true,
      localControlBackend: 'acp',
    };

    const resolveSupport = createCodexLocalControlSupportResolver({
      startedBy: 'cli',
      experimentalCodexAcpEnabled: () => state.experimentalCodexAcpEnabled,
      localControlBackend: () => state.localControlBackend,
      hasTtyForLocal: true,
    });

    expect(await resolveSupport({ includeAcpProbe: false })).toEqual({ ok: true, backend: 'acp' });

    // Simulate ACP failing closed and falling back to MCP.
    state.experimentalCodexAcpEnabled = false;
    state.localControlBackend = null;

    expect(await resolveSupport({ includeAcpProbe: false })).toEqual({ ok: false, reason: 'resume-disabled' });
  });
});
