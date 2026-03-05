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
});
