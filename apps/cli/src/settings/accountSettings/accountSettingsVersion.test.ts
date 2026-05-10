import { describe, expect, it } from 'vitest';

import {
  isAccountSettingsVersionAtLeast,
  normalizeAccountSettingsVersion,
  normalizeAccountSettingsVersionHint,
  readAccountSettingsVersionFromHint,
} from './accountSettingsVersion';

describe('accountSettingsVersion', () => {
  it('normalizes finite non-negative integer versions', () => {
    expect(normalizeAccountSettingsVersion(0)).toBe(0);
    expect(normalizeAccountSettingsVersion(42)).toBe(42);
  });

  it('rejects malformed versions', () => {
    expect(normalizeAccountSettingsVersion(-1)).toBeNull();
    expect(normalizeAccountSettingsVersion(1.5)).toBeNull();
    expect(normalizeAccountSettingsVersion(Number.NaN)).toBeNull();
    expect(normalizeAccountSettingsVersion('1')).toBeNull();
  });

  it('compares current versions against optional minimums', () => {
    expect(isAccountSettingsVersionAtLeast(2, 2)).toBe(true);
    expect(isAccountSettingsVersionAtLeast(3, 2)).toBe(true);
    expect(isAccountSettingsVersionAtLeast(1, 2)).toBe(false);
    expect(isAccountSettingsVersionAtLeast(null, 2)).toBe(false);
    expect(isAccountSettingsVersionAtLeast(undefined, null)).toBe(true);
  });

  it('reads settingsVersion from compact change hints', () => {
    expect(readAccountSettingsVersionFromHint({ settingsVersion: 9 })).toBe(9);
    expect(readAccountSettingsVersionFromHint({ settingsVersion: -1 })).toBeNull();
    expect(readAccountSettingsVersionFromHint(null)).toBeNull();
  });

  it('normalizes transport version hints', () => {
    expect(normalizeAccountSettingsVersionHint(0)).toBe(0);
    expect(normalizeAccountSettingsVersionHint(5)).toBe(5);
    expect(normalizeAccountSettingsVersionHint('5')).toBeNull();
  });
});
