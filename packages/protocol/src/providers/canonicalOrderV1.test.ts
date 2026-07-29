import { describe, expect, it } from 'vitest';

import { compareProviderCanonicalStringsV1 } from './canonicalOrderV1.js';

describe('compareProviderCanonicalStringsV1', () => {
  it('uses locale-independent UTF-16 code-unit order for persisted identities', () => {
    const values = ['z', 'ä', 'a', 'A', '😀', '😃'];
    expect([...values].sort(compareProviderCanonicalStringsV1)).toEqual([
      'A', 'a', 'z', 'ä', '😀', '😃',
    ]);
  });

  it('does not call the host locale comparator', () => {
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error('localeCompare must not participate in canonical identity');
    };
    try {
      expect(['ä', 'z'].sort(compareProviderCanonicalStringsV1)).toEqual(['z', 'ä']);
    } finally {
      String.prototype.localeCompare = original;
    }
  });
});
