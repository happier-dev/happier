import { describe, expect, it } from 'vitest';

import { readSessionIncludedInVoiceFromState, resolveVoiceSessionUpdatePolicy } from '@/voice/runtime/voiceUpdatePolicy';
import { useVoiceTargetStore } from './voiceTargetStore';
import { createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';

describe('voiceUpdatePolicy', () => {
  it('reads synchronized Account Follow state from the exact Home list projection after reload', () => {
    const state = {
      sessionListRowsByServerId: {
        'home-a': { same: { viewer: { follow: { includeInVoice: true } } } },
        'home-b': { same: { viewer: { follow: { includeInVoice: false } } } },
      },
    };

    expect(readSessionIncludedInVoiceFromState(state, { serverId: 'home-a', sessionId: 'same' })).toBe(true);
    expect(readSessionIncludedInVoiceFromState(state, { serverId: 'home-b', sessionId: 'same' })).toBe(false);
  });

  it('treats canonical Account Follow Include in Voice as activeSession policy level', () => {
    const policy = resolveVoiceSessionUpdatePolicy({
      sessionId: 's1',
      includeInVoice: true,
      settings: {
        voice: {
          ui: {
            updates: {
              activeSession: 'snippets',
              otherSessions: 'none',
              snippetsMaxMessages: 5,
              includeUserMessagesInSnippets: true,
              otherSessionsSnippetsMode: 'never',
            },
          },
        },
      },
    });

    expect(policy.isIncludedInVoice).toBe(true);
    expect(policy.level).toBe('snippets');
    expect(policy.snippetsMaxMessages).toBe(5);
    expect(policy.includeUserMessagesInSnippets).toBe(true);
  });

  it('downgrades otherSessions snippets to summaries unless otherSessionsSnippetsMode is auto', () => {
    const policy = resolveVoiceSessionUpdatePolicy({
      sessionId: 's2',
      includeInVoice: false,
      settings: {
        voice: {
          ui: {
            updates: {
              activeSession: 'none',
              otherSessions: 'snippets',
              otherSessionsSnippetsMode: 'on_demand_only',
            },
          },
        },
      },
    });

    expect(policy.isIncludedInVoice).toBe(false);
    expect(policy.level).toBe('summaries');
  });

  it('allows otherSessions snippets when otherSessionsSnippetsMode is auto', () => {
    const policy = resolveVoiceSessionUpdatePolicy({
      sessionId: 's2',
      includeInVoice: false,
      settings: {
        voice: {
          ui: {
            updates: {
              otherSessions: 'snippets',
              otherSessionsSnippetsMode: 'auto',
            },
          },
        },
      },
    });

    expect(policy.isIncludedInVoice).toBe(false);
    expect(policy.level).toBe('snippets');
  });

  it('does not let a stale compatibility target cache elevate disclosure', () => {
    const previousTargets = useVoiceTargetStore.getState();
    const retainedAddress = { serverId: 'server-a', sessionId: 'same' };
    const currentAddress = { serverId: 'server-b', sessionId: 'same' };
    const includedViewer = createSessionViewerFixture({ follow: {
      follows: true, notificationLevel: 'important', includeInVoice: true,
    } });
    const excludedViewer = createSessionViewerFixture({ follow: {
      follows: true, notificationLevel: 'important', includeInVoice: false,
    } });
    const state = { sessionListRowsByServerId: {
      'server-a': { same: { viewer: includedViewer } },
      'server-b': { same: { viewer: excludedViewer } },
    } };
    const readPolicy = () => resolveVoiceSessionUpdatePolicy({
      sessionId: currentAddress.sessionId,
      sessionAddress: currentAddress,
      includeInVoice: readSessionIncludedInVoiceFromState(state, currentAddress),
      settings: { voice: { ui: { updates: { activeSession: 'snippets', otherSessions: 'activity' } } } },
    });
    try {
      previousTargets.setScope('global');
      previousTargets.setPrimaryActionSessionAddress(retainedAddress);
      previousTargets.setLastFocusedSessionAddress(retainedAddress);
      previousTargets.setVoiceLiveContextSessionAddresses([retainedAddress]);
      expect(useVoiceTargetStore.getState().voiceLiveContextSessionAddresses).toEqual([retainedAddress]);
      expect(readSessionIncludedInVoiceFromState(state, retainedAddress)).toBe(true);
      expect(readPolicy()).toMatchObject({ isIncludedInVoice: false, level: 'activity' });

      // A genuine Follow change, not retained target selection, authorizes the active level.
      state.sessionListRowsByServerId['server-b'].same.viewer = includedViewer;
      expect(readPolicy()).toMatchObject({ isIncludedInVoice: true, level: 'snippets' });
      expect(useVoiceTargetStore.getState().primaryActionSessionAddress).toEqual(retainedAddress);
    } finally {
      useVoiceTargetStore.setState(previousTargets, true);
    }
  });

  it('treats absent synchronized Follow state as not included', () => {
    const policy = resolveVoiceSessionUpdatePolicy({
      sessionId: 's2',
      includeInVoice: undefined,
      settings: {
        voice: {
          ui: {
            updates: {
              activeSession: 'none',
              otherSessions: 'snippets',
              otherSessionsSnippetsMode: 'auto',
            },
          },
        },
      },
    });

    expect(policy.isIncludedInVoice).toBe(false);
    expect(policy.level).toBe('snippets');
  });
});
