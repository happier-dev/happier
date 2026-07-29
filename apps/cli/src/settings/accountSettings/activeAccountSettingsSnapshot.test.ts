import { accountSettingsParse } from '@happier-dev/protocol';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  commitActiveAccountSettingsSnapshot,
  getActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests,
  setActiveAccountSettingsSnapshot,
  subscribeActiveAccountSettingsSnapshot,
} from './activeAccountSettingsSnapshot';

function snapshot(params: Readonly<{
  scopeKey: string;
  version: number;
  timing: 'after_foreground_ready' | 'after_runtime_idle';
}>) {
  return {
    source: 'network' as const,
    settings: accountSettingsParse({ sessionPendingQueueDeliveryTiming: params.timing }),
    settingsVersion: params.version,
    loadedAtMs: params.version,
    settingsSecretsReadKeys: [],
    scopeKey: params.scopeKey,
  };
}

describe('active account settings snapshot publication', () => {
  beforeEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
  });

  it('keeps the same-scope accepted winner for equal and older commits without notifying', () => {
    const winner = snapshot({ scopeKey: 'scope-a', version: 4, timing: 'after_runtime_idle' });
    setActiveAccountSettingsSnapshot(winner);
    const listener = vi.fn();
    const unsubscribe = subscribeActiveAccountSettingsSnapshot(listener);

    const equal = commitActiveAccountSettingsSnapshot(
      snapshot({ scopeKey: 'scope-a', version: 4, timing: 'after_foreground_ready' }),
    );
    const older = commitActiveAccountSettingsSnapshot(
      snapshot({ scopeKey: 'scope-a', version: 3, timing: 'after_foreground_ready' }),
    );

    expect(equal).toEqual({ snapshot: winner, didCommit: false });
    expect(older).toEqual({ snapshot: winner, didCommit: false });
    expect(getActiveAccountSettingsSnapshot()).toBe(winner);
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('allows a different credential scope to become the active winner', () => {
    const previous = snapshot({ scopeKey: 'scope-a', version: 9, timing: 'after_runtime_idle' });
    const next = snapshot({ scopeKey: 'scope-b', version: 1, timing: 'after_foreground_ready' });
    setActiveAccountSettingsSnapshot(previous);
    const listener = vi.fn();
    const unsubscribe = subscribeActiveAccountSettingsSnapshot(listener);

    expect(commitActiveAccountSettingsSnapshot(next)).toEqual({ snapshot: next, didCommit: true });
    expect(getActiveAccountSettingsSnapshot()).toBe(next);
    expect(listener).toHaveBeenCalledWith(previous, next);
    unsubscribe();
  });

  it('keeps a committed winner when a subscriber throws', () => {
    const next = snapshot({ scopeKey: 'scope-a', version: 1, timing: 'after_runtime_idle' });
    const unsubscribe = subscribeActiveAccountSettingsSnapshot(() => {
      throw new Error('consumer wake failed');
    });

    expect(commitActiveAccountSettingsSnapshot(next)).toEqual({ snapshot: next, didCommit: true });
    expect(getActiveAccountSettingsSnapshot()).toBe(next);
    unsubscribe();
  });
});
