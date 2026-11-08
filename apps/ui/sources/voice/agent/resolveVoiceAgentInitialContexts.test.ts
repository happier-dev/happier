import { beforeEach, describe, expect, it } from 'vitest';
import { createSessionFixture } from '@/dev/testkit';

const fixtureMetadata = (() => {
    const metadata = createSessionFixture().metadata;
    if (!metadata) throw new Error('Canonical Session fixture metadata missing');
    return metadata;
})();
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { settingsParse } from '@/sync/domains/settings/settings';
import { storage } from '@/sync/domains/state/storage';
import { useVoiceTargetStore } from '@/voice/runtime/voiceTargetStore';
import { resolveVoiceAgentInitialContexts } from './resolveVoiceAgentInitialContexts';

describe('resolveVoiceAgentInitialContexts', () => {
  beforeEach(() => {
    const serverId = getActiveServerSnapshot().serverId;
    storage.setState({ settings: settingsParse({ voice: { privacy: { shareSessionSummary: true } } }),
      sessions: {
        'voice-carrier': createSessionFixture({ id: 'voice-carrier', serverId }),
        'shared-session': createSessionFixture({ id: 'shared-session', serverId,
          metadata: { ...fixtureMetadata, summary: { text: 'Active Home private summary', updatedAt: 1 } } }),
      },
      sessionMessages: {},
      sessionListRowsByServerId: { 'home-b': { 'shared-session': createSessionFixture({ id: 'shared-session',
        metadata: { ...fixtureMetadata, summaryText: 'Qualified Home B summary' } }) } },
      ordinarySessionListMembershipByServerId: { 'home-b': ['shared-session'] },
      sessionListIndexByServerId: {}, concurrentSessionListCacheByServerId: {},
    });
    useVoiceTargetStore.getState().setPrimaryActionSessionAddress(null);
    useVoiceTargetStore.getState().setVoiceLiveContextSessionAddresses([]);
    useVoiceTargetStore.getState().setLastFocusedSessionAddress(null);
  });

  it('preserves the qualified target address when composing deferred context', () => {
    const targetSessionAddress = { serverId: 'home-b', sessionId: 'shared-session' } as const;

    const result = resolveVoiceAgentInitialContexts('voice-carrier', { targetSessionAddress });
    expect(result.bootstrapInitialContext).toContain('THIS IS AN ACTIVE SESSION:');
    expect(result.bootstrapInitialContext).not.toContain('Qualified Home B summary');
    const targetContext = result.deferredTargetSessionContext?.();
    expect(targetContext).toContain('THIS IS THE CURRENT TARGET SESSION:');
    expect(targetContext).toContain('Qualified Home B summary');
    expect(targetContext).not.toContain('Active Home private summary');
  });
});
