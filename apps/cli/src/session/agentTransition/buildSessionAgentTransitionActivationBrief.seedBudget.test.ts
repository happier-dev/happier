import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { accountSettingsParse } from '@happier-dev/protocol';

import { createEnvKeyScope } from '@/testkit/env/envScope';

const mocks = vi.hoisted(() => ({ resolveReplaySeedDraft: vi.fn() }));

vi.mock('@/session/replay/resolveReplaySeedDraft', () => ({
  resolveReplaySeedDraft: mocks.resolveReplaySeedDraft,
}));

const { buildSessionAgentTransitionActivationBrief } = await import(
  './buildSessionAgentTransitionActivationBrief'
);
const {
  setActiveAccountSettingsSnapshot,
  resetActiveAccountSettingsSnapshotForTests,
} = await import('@/settings/accountSettings/activeAccountSettingsSnapshot');
const { reloadConfiguration } = await import('@/configuration');

/**
 * The in-place Agent transition is the one Replay entry point with no client on
 * the other end of a `maxSeedChars` field: neither the transition request nor
 * the read-only brief preview carries a budget. Fork and resume honour the
 * Account's `sessionReplayMaxSeedChars` because their UI resolves it and sends
 * it; this path has to read the same preference itself or the number the user
 * set in Settings simply does not apply to switching Agent in place.
 */
describe('buildSessionAgentTransitionActivationBrief — replay seed budget', () => {
  let envScope = createEnvKeyScope(['HAPPIER_REPLAY_MAX_SEED_CHARS']);

  beforeEach(() => {
    envScope = createEnvKeyScope(['HAPPIER_REPLAY_MAX_SEED_CHARS']);
    resetActiveAccountSettingsSnapshotForTests();
    mocks.resolveReplaySeedDraft.mockReset();
    mocks.resolveReplaySeedDraft.mockResolvedValue({ status: 'no_source_dialog' });
  });

  afterEach(() => {
    resetActiveAccountSettingsSnapshotForTests();
    envScope.restore();
    reloadConfiguration();
  });

  function publishAccountReplayBudget(value: unknown): void {
    setActiveAccountSettingsSnapshot({
      source: 'cache',
      settings: accountSettingsParse({ sessionReplayMaxSeedChars: value }),
      settingsVersion: 1,
      loadedAtMs: 1,
      settingsSecretsReadKeys: [],
    });
  }

  async function buildAndReadSeedBudget(): Promise<number | undefined> {
    await buildSessionAgentTransitionActivationBrief({
      credentials: { token: 't' } as never,
      sessionId: 'sess_1',
      sourceAgentId: 'claude',
      targetAgentId: 'codex',
      workspacePath: '/home/u/project',
      departingAgentCurrentView: { path: '/home/u/project' },
      transcriptHeadSeqInclusive: 42,
    });
    return (mocks.resolveReplaySeedDraft.mock.calls[0]?.[0] as { maxSeedChars?: number }).maxSeedChars;
  }

  it('bounds the seed by the Account preference when it is smaller than the daemon default', async () => {
    envScope.patch({ HAPPIER_REPLAY_MAX_SEED_CHARS: '96000' });
    reloadConfiguration();
    publishAccountReplayBudget(8_192);

    expect(await buildAndReadSeedBudget()).toBe(8_192);
  });

  it('falls back to the daemon budget when no Account snapshot states one', async () => {
    envScope.patch({ HAPPIER_REPLAY_MAX_SEED_CHARS: '96000' });
    reloadConfiguration();

    expect(await buildAndReadSeedBudget()).toBe(96_000);
  });

  /**
   * The floor is the shared Replay-budget bound, not a range restated here:
   * beneath it the seed builder deliberately produces NO seed, so a stored value
   * under it must not reach the builder as if the user had asked for a tiny seed.
   */
  it('ignores an out-of-range Account value rather than passing it through', async () => {
    envScope.patch({ HAPPIER_REPLAY_MAX_SEED_CHARS: '96000' });
    reloadConfiguration();
    publishAccountReplayBudget(12);

    expect(await buildAndReadSeedBudget()).toBe(96_000);
  });
});
