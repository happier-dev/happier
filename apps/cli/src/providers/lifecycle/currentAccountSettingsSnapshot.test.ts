import { describe, expect, it } from 'vitest';

import type { ActiveAccountSettingsSnapshot } from '@/settings/accountSettings/activeAccountSettingsSnapshot';
import {
  createAccountBoundProviderSnapshotReader,
  createAuthoritativeProviderSnapshotReader,
} from './currentAccountSettingsSnapshot';

function snapshot(version: number, marker: string, scopeKey = 'account-a'): ActiveAccountSettingsSnapshot {
  return {
    source: 'network',
    settings: { marker } as never,
    settingsVersion: version,
    loadedAtMs: version,
    settingsSecretsReadKeys: [],
    scopeKey,
  };
}

describe('direct Provider authoritative settings snapshot reader', () => {
  it('re-reads a newer same-account snapshot during commit revalidation', () => {
    const initial = snapshot(1, 'initial');
    let current: ActiveAccountSettingsSnapshot | null = initial;
    const read = createAuthoritativeProviderSnapshotReader({
      initial,
      mode: 'live',
      readCurrent: () => current,
    });

    expect(read()).toBe(initial);
    current = snapshot(2, 'grant-revoked');
    expect(read()).toBe(current);
  });

  it('fails closed when the live settings owner disappears or changes account scope', () => {
    const initial = snapshot(3, 'initial');
    let current: ActiveAccountSettingsSnapshot | null = snapshot(2, 'older');
    const read = createAuthoritativeProviderSnapshotReader({
      initial,
      mode: 'live',
      readCurrent: () => current,
    });
    expect(read()).toBeNull();

    current = snapshot(4, 'other-account', 'account-b');
    expect(read()).toBeNull();

    current = { ...snapshot(4, 'missing-scope'), scopeKey: undefined };
    expect(read()).toBeNull();

    current = null;
    expect(read()).toBeNull();
  });

  it('uses an explicit immutable fallback only when no live owner existed at launch', () => {
    const initial = snapshot(3, 'bootstrap-only');
    let current: ActiveAccountSettingsSnapshot | null = null;
    const read = createAuthoritativeProviderSnapshotReader({
      initial,
      mode: 'static',
      readCurrent: () => current,
    });

    expect(read()).toBe(initial);
    current = snapshot(4, 'unrelated-live-owner', 'account-b');
    expect(read()).toBe(initial);
  });

  it('fails closed when live mode cannot prove the initial account scope', () => {
    const initial = { ...snapshot(1, 'scope-less'), scopeKey: undefined };
    const read = createAuthoritativeProviderSnapshotReader({
      initial,
      mode: 'live',
      readCurrent: () => snapshot(2, 'account-b', 'account-b'),
    });

    expect(read()).toBeNull();
  });
});

describe('Provider authorization account-bound snapshot reader', () => {
  it('pins the first live account scope and refuses a same-shaped snapshot from another account', () => {
    let current: ActiveAccountSettingsSnapshot | null = snapshot(1, 'account-a', 'account-a');
    const read = createAccountBoundProviderSnapshotReader(() => current);

    expect(read()).toBe(current);
    current = snapshot(1, 'account-b', 'account-b');
    expect(read()).toBeNull();
  });

  it('refuses a settings-version regression within the same account scope', () => {
    let current: ActiveAccountSettingsSnapshot | null = snapshot(3, 'current', 'account-a');
    const read = createAccountBoundProviderSnapshotReader(() => current);
    expect(read()).toBe(current);

    current = snapshot(2, 'older', 'account-a');
    expect(read()).toBeNull();
  });

  it('pins identity for legacy unscoped snapshot readers instead of accepting a replacement', () => {
    const initial = { ...snapshot(1, 'unscoped'), scopeKey: undefined };
    let current: ActiveAccountSettingsSnapshot | null = initial;
    const read = createAccountBoundProviderSnapshotReader(() => current);

    expect(read()).toBe(initial);
    current = { ...initial };
    expect(read()).toBeNull();
  });
});
