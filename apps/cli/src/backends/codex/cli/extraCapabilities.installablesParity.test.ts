import { describe, expect, it } from 'vitest';
import { CODEX_ACP_DEP_ID } from '@happier-dev/protocol/installables';

import { capabilities } from './extraCapabilities';

describe('codex extraCapabilities installables parity', () => {
  it('keeps Codex-owned installable deps scoped to Codex ACP', () => {
    const ids = capabilities.map((c) => c.descriptor.id);
    expect(ids).toEqual([CODEX_ACP_DEP_ID]);
  });
});
