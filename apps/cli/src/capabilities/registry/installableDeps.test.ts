import { describe, expect, it } from 'vitest';

import { CODEX_ACP_DEP_ID, GH_DEP_ID } from '@happier-dev/protocol/installables';

describe('installable dep capabilities', () => {
  it('registers global dep capabilities for protocol installables outside provider-owned extras', async () => {
    const { installableDepCapabilities } = await import('./installableDeps');

    const ids = installableDepCapabilities.map((capability) => capability.descriptor.id);
    expect(ids).toEqual([GH_DEP_ID]);
    expect(ids).not.toContain(CODEX_ACP_DEP_ID);
  });
});
