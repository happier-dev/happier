import { describe, expect, it } from 'vitest';

import { createCodexLocalControlSupportResolver } from './createLocalControlSupportResolver';

describe('createCodexLocalControlSupportResolver (integration)', () => {
  it('returns an immediate decision without ACP probes', async () => {
    const resolveSupport = createCodexLocalControlSupportResolver({
      startedBy: 'cli',
      experimentalCodexAcpEnabled: true,
    });

    const decision = await resolveSupport({ includeAcpProbe: true });
    expect(decision).toEqual({ ok: true, backend: 'acp' });
  });
});
