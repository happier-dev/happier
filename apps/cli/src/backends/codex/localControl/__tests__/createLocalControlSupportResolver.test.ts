import { describe, expect, it, vi } from 'vitest';

import { createCodexLocalControlSupportResolver } from '../createLocalControlSupportResolver';

describe('createCodexLocalControlSupportResolver', () => {
  it('does not probe ACP capabilities when ACP mode is disabled', async () => {
    const probeAcpLoadSessionSupport = vi.fn(async () => ({ ok: true as const, loadSession: true }));

    const resolveSupport = createCodexLocalControlSupportResolver(
      {
        startedBy: 'cli',
        experimentalCodexAcpEnabled: false,
        experimentalCodexResumeEnabled: true,
      },
      { probeAcpLoadSessionSupport },
    );

    const decision = await resolveSupport({ includeAcpProbe: true });

    expect(decision).toEqual({ ok: true, backend: 'mcp' });
    expect(probeAcpLoadSessionSupport).not.toHaveBeenCalled();
  });

  it('probes ACP support once and caches the resolved decision', async () => {
    const probeAcpLoadSessionSupport = vi.fn(async () => ({ ok: true as const, loadSession: true }));

    const resolveSupport = createCodexLocalControlSupportResolver(
      {
        startedBy: 'cli',
        experimentalCodexAcpEnabled: true,
        experimentalCodexResumeEnabled: true,
      },
      { probeAcpLoadSessionSupport },
    );

    const first = await resolveSupport({ includeAcpProbe: true });
    const second = await resolveSupport({ includeAcpProbe: true });

    expect(first).toEqual({ ok: true, backend: 'acp' });
    expect(second).toEqual({ ok: true, backend: 'acp' });
    expect(probeAcpLoadSessionSupport).toHaveBeenCalledTimes(1);
  });

  it('treats failed ACP probes as loadSession unsupported', async () => {
    const probeAcpLoadSessionSupport = vi.fn(async () => ({ ok: false as const }));

    const resolveSupport = createCodexLocalControlSupportResolver(
      {
        startedBy: 'cli',
        experimentalCodexAcpEnabled: true,
        experimentalCodexResumeEnabled: true,
      },
      { probeAcpLoadSessionSupport },
    );

    const decision = await resolveSupport({ includeAcpProbe: true });

    expect(decision).toEqual({ ok: false, reason: 'acp-load-session-unsupported' });
    expect(probeAcpLoadSessionSupport).toHaveBeenCalledTimes(1);
  });
});

