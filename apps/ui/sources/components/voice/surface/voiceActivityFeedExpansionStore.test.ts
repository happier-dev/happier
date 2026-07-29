import { beforeEach, describe, expect, it } from 'vitest';

import {
  getVoiceActivityFeedExpansionSnapshot,
  reconcileVoiceActivityFeedExpansion,
  resetVoiceActivityFeedExpansionForTests,
  toggleVoiceActivityFeedExpansion,
} from './voiceActivityFeedExpansionStore';

function reconcile(
  attemptId: string | null,
  options: Readonly<{ feedEnabled?: boolean; autoExpand?: boolean }> = {},
): void {
  reconcileVoiceActivityFeedExpansion({
    attemptId,
    feedEnabled: options.feedEnabled ?? true,
    autoExpand: options.autoExpand ?? true,
  });
}

describe('voiceActivityFeedExpansionStore', () => {
  beforeEach(() => resetVoiceActivityFeedExpansionForTests());

  it('auto-expands exactly once on the first observation of a canonical attempt', () => {
    reconcile(null);
    reconcile('attempt-1');
    expect(getVoiceActivityFeedExpansionSnapshot().expanded).toBe(true);
    toggleVoiceActivityFeedExpansion();
    reconcile('attempt-1');
    expect(getVoiceActivityFeedExpansionSnapshot()).toMatchObject({ expanded: false, manuallySuppressed: true });
  });

  it('consumes the attempt without expanding when either setting is disabled', () => {
    reconcile('attempt-1', { feedEnabled: false });
    reconcile('attempt-1', { feedEnabled: true });
    expect(getVoiceActivityFeedExpansionSnapshot().expanded).toBe(false);
    resetVoiceActivityFeedExpansionForTests();
    reconcile('attempt-2', { autoExpand: false });
    reconcile('attempt-2', { autoExpand: true });
    expect(getVoiceActivityFeedExpansionSnapshot().expanded).toBe(false);
  });

  it('keeps manual collapse sticky through reconnect churn and remount reconciliation', () => {
    reconcile('attempt-1');
    toggleVoiceActivityFeedExpansion();
    reconcile('attempt-1');
    reconcile('attempt-1');
    expect(getVoiceActivityFeedExpansionSnapshot()).toMatchObject({
      attemptId: 'attempt-1', expanded: false, manuallySuppressed: true,
    });
  });

  it('auto-expands a rapid stop/start represented by a new canonical attempt id', () => {
    reconcile('attempt-1');
    toggleVoiceActivityFeedExpansion();
    reconcile(null);
    reconcile('attempt-2');
    expect(getVoiceActivityFeedExpansionSnapshot()).toMatchObject({
      attemptId: 'attempt-2', expanded: true, manuallySuppressed: false,
    });
  });

  it('treats an active control-session replacement attempt id as new', () => {
    reconcile('attempt-1');
    toggleVoiceActivityFeedExpansion();
    reconcile('attempt-2');
    expect(getVoiceActivityFeedExpansionSnapshot().expanded).toBe(true);
  });

  it('collapses when disabled and does not reopen the same handled attempt when re-enabled', () => {
    reconcile('attempt-1');
    reconcile('attempt-1', { feedEnabled: false });
    reconcile('attempt-1', { feedEnabled: true });
    expect(getVoiceActivityFeedExpansionSnapshot().expanded).toBe(false);
    reconcile('attempt-2');
    expect(getVoiceActivityFeedExpansionSnapshot().expanded).toBe(true);
  });

  it('collapses when the feed is disabled after the attempt has ended', () => {
    reconcile('attempt-1');
    expect(getVoiceActivityFeedExpansionSnapshot().expanded).toBe(true);

    reconcile(null, { feedEnabled: false });
    reconcile(null, { feedEnabled: true });
    expect(getVoiceActivityFeedExpansionSnapshot()).toMatchObject({
      attemptId: 'attempt-1',
      expanded: false,
    });

    reconcile('attempt-2');
    expect(getVoiceActivityFeedExpansionSnapshot()).toMatchObject({
      attemptId: 'attempt-2',
      expanded: true,
    });
  });

  it('preserves a handled attempt across navigation remounts', () => {
    reconcile('attempt-1');
    toggleVoiceActivityFeedExpansion();
    reconcile('attempt-1');
    expect(getVoiceActivityFeedExpansionSnapshot()).toMatchObject({ expanded: false, manuallySuppressed: true });
  });
});
