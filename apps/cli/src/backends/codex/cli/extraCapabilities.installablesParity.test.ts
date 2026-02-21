import { describe, expect, it } from 'vitest';
import { INSTALLABLES_CATALOG } from '@happier-dev/protocol/installables';

import { capabilities } from './extraCapabilities';

describe('codex extraCapabilities installables parity', () => {
  it('includes capabilities for all protocol installable deps', () => {
    const ids = capabilities.map((c) => c.descriptor.id);
    expect(ids).toEqual(expect.arrayContaining(INSTALLABLES_CATALOG.map((e) => e.capabilityId)));
  });
});

