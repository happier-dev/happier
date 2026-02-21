import { describe, expect, it } from 'vitest';

import { INSTALLABLES_CATALOG } from './installables.js';

describe('installables catalog', () => {
  it('has unique keys', () => {
    const keys = INSTALLABLES_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has unique capability ids', () => {
    const ids = INSTALLABLES_CATALOG.map((e) => e.capabilityId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

