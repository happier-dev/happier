import { describe, expect, it, vi } from 'vitest';

import { createCodexLocalControlSupportResolver } from './createLocalControlSupportResolver';

describe('createCodexLocalControlSupportResolver (integration)', () => {
  it('does not block on ACP probe when includeAcpProbe=false even if probe would be slow', async () => {
    const slowProbe = vi.fn(async (): Promise<{ ok: boolean; loadSession?: boolean }> => {
      return await new Promise<{ ok: boolean; loadSession?: boolean }>(() => {
        // never resolves
      });
    });

    const resolveSupport = createCodexLocalControlSupportResolver(
      {
        startedBy: 'cli',
        experimentalCodexAcpEnabled: true,
        experimentalCodexResumeEnabled: true,
      },
      { probeAcpLoadSessionSupport: slowProbe },
    );

    const decision = await resolveSupport({ includeAcpProbe: false });

    expect(decision).toEqual({ ok: true, backend: 'acp' });
    expect(slowProbe).not.toHaveBeenCalled();
  });
});
