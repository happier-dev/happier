import { describe, expect, it } from 'vitest';

import {
  TERMINAL_LEGACY_STREAM_COMPATIBILITY,
  isTerminalLegacyCompatibilitySunsetReached,
  isTerminalLegacyClientFallbackAllowed,
  isWindowsTerminalProviderLegacyFallbackAllowed,
} from './compatibility';

describe('terminal stream compatibility policy', () => {
  it('allows only the named predecessor release without byte-stream capability', () => {
    expect(isTerminalLegacyClientFallbackAllowed({
      currentAppRelease: '0.2.10',
      peerByteStreamCapability: 'unknown',
    })).toBe(true);
    expect(isTerminalLegacyClientFallbackAllowed({
      currentAppRelease: '0.2.10',
      peerByteStreamCapability: 'enabled',
    })).toBe(false);
    expect(isTerminalLegacyClientFallbackAllowed({
      currentAppRelease: TERMINAL_LEGACY_STREAM_COMPATIBILITY.removalRelease,
      peerByteStreamCapability: 'unknown',
    })).toBe(false);
    expect(isTerminalLegacyCompatibilitySunsetReached('0.3.0')).toBe(true);
    expect(isTerminalLegacyCompatibilitySunsetReached('0.2.10')).toBe(false);
  });

  it('keeps Windows provider fallback independent of client compatibility', () => {
    expect(isWindowsTerminalProviderLegacyFallbackAllowed({
      provider: 'windows-conpty',
      byteFidelityProven: false,
    })).toBe(true);
    expect(isWindowsTerminalProviderLegacyFallbackAllowed({
      provider: 'windows-conpty',
      byteFidelityProven: true,
    })).toBe(false);
  });
});
