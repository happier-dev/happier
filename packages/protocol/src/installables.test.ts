import { describe, expect, it } from 'vitest';

import { CODEX_ACP_DIST_TAG, INSTALLABLES_CATALOG } from './installables.js';

describe('installables catalog', () => {
  it('has unique keys', () => {
    const keys = INSTALLABLES_CATALOG.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('has unique capability ids', () => {
    const ids = INSTALLABLES_CATALOG.map((e) => e.capabilityId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('preserves the legacy dist-tag export for public consumers', () => {
    expect(CODEX_ACP_DIST_TAG).toBe('latest');
  });
});
