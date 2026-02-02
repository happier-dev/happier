import { describe, expect, it } from 'vitest';

import { runProviderContractMatrix } from '../../src/testkit/providers/harness';

describe('providers: contract matrix (harness)', () => {
  it('runs provider scenario matrix when explicitly enabled', async () => {
    // Harness owns all opt-in gating; this test stays green when providers are disabled.
    const res = await runProviderContractMatrix();
    if (!res.ok) {
      throw new Error(res.error);
    }
    expect(res.ok).toBe(true);
  });
});
