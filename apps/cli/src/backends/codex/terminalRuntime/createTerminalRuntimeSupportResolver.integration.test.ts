import { describe, expect, it } from 'vitest';

import { createCodexTerminalRuntimeSupportResolver } from './createTerminalRuntimeSupportResolver';

describe('createCodexTerminalRuntimeSupportResolver (integration)', () => {
  it('returns an immediate decision without ACP probes', async () => {
    const resolveSupport = createCodexTerminalRuntimeSupportResolver({
      startedBy: 'cli',
      experimentalCodexAcpEnabled: true,
    });

    const decision = await resolveSupport({ includeAcpProbe: true });
    expect(decision).toEqual({ ok: true, backend: 'acp' });
  });
});
