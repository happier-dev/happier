import { describe, expect, it } from 'vitest';

import { classifyWindowsConptyByteSupport } from '../../../src/testkit/terminal/windows';

describe('stress: terminal Windows/ConPTY fallback diagnostics', () => {
  it('does not advertise byte stream on Windows unless raw byte fidelity is proven', () => {
    const diagnostic = classifyWindowsConptyByteSupport({
      platform: 'win32',
      emittedType: 'unknown',
      checksumMatches: false,
    });

    expect(diagnostic).toEqual({
      state: 'legacy-only',
      reason: 'raw-bytes-not-proven',
      byteStreamAdvertised: false,
    });
  });
});
