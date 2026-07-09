import { describe, expect, it } from 'vitest';

import { classifyWindowsConptyByteSupport } from './windows';

describe('terminal Windows/ConPTY byte support diagnostics', () => {
  it('keeps Windows legacy-only when raw byte fidelity is not proven', () => {
    expect(
      classifyWindowsConptyByteSupport({
        platform: 'win32',
        emittedType: 'string',
        checksumMatches: false,
      }),
    ).toEqual({
      state: 'legacy-only',
      reason: 'raw-bytes-not-proven',
      byteStreamAdvertised: false,
    });
  });

  it('allows byte-stream advertisement only after Buffer output and checksum proof', () => {
    expect(
      classifyWindowsConptyByteSupport({
        platform: 'win32',
        emittedType: 'buffer',
        checksumMatches: true,
      }),
    ).toEqual({
      state: 'byte-capable',
      byteStreamAdvertised: true,
    });
  });
});
