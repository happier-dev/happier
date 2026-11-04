import { describe, expect, it } from 'vitest';

import { createSessionFixture, createSessionListRenderableSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { getSessionStatus } from '@/utils/sessions/sessionUtils';

import { readBotActivity } from './botActivity';

describe('Bot activity from real Session awareness', () => {
  const now = 1_800_000_000_000;

  it('counts C1 admission rather than a raw operational request or unseen failure', () => {
    const row = createSessionListRenderableSessionFixture({ active: true, activeAt: now,
      hasPendingPermissionRequests: true, pendingRequestObservedAt: now, viewer: createSessionViewerFixture() });
    expect(readBotActivity(row, now)).toBe('quiet');
    const admitted = createSessionViewerFixture({ attention: { needsAttention: true,
      reasons: ['permission_required'], primary: 'permission_required', presentation: 'full' } });
    expect(readBotActivity({ ...row, viewer: admitted }, now)).toBe('needsYou');
    const failure = createSessionViewerFixture({ attention: { needsAttention: true,
      reasons: ['failed'], primary: 'failed', presentation: 'full' } });
    expect(readBotActivity({ ...row, hasPendingPermissionRequests: false,
      latestTurnStatus: 'failed', viewer: failure }, now)).toBe('quiet');
  });

  it.each(['manager', 'continue'] as const)('keeps admitted %s decisions in membership without promoting quiet tone', kind => {
    const questionV1 = kind === 'continue'
      ? { mode: 'continue' as const, assumption: 'Continue safely', type: 'decision' as const, lasting: false }
      : { mode: 'wait' as const, type: 'decision' as const, lasting: false };
    const currentHandler = kind === 'manager' ? { kind: 'session' as const, sessionId: 'manager' } : { kind: 'person' as const };
    const session = createSessionFixture({ active: true, activeAt: now,
      viewer: createSessionViewerFixture({ attention: { needsAttention: true,
        reasons: ['user_action_required'], primary: 'user_action_required', presentation: 'full' } }),
      agentState: { requests: { question: { tool: 'AskUserQuestion', kind: 'user_action', arguments: {},
        createdAt: now, questionV1, currentHandler } } },
    });
    expect(readBotActivity(session, now)).toBe('needsYou');
  });

  it.each([
    { name: 'offline blocked input', facts: { presence: 0, pendingBlockedCount: 1 }, primary: 'action_required', state: 'action_required', activity: 'needsYou' },
    { name: 'offline failure', facts: { presence: 0, latestTurnStatus: 'failed' }, primary: 'failed', state: 'disconnected', activity: 'quiet' },
    { name: 'online blocked input', facts: { presence: 'online', pendingBlockedCount: 1 }, primary: 'action_required', state: 'action_required', activity: 'needsYou' },
    { name: 'online working turn', facts: { presence: 'online', latestTurnStatus: 'in_progress', thinking: true, thinkingAt: now }, primary: 'working', state: 'thinking', activity: 'working' },
    { name: 'offline working turn', facts: { presence: 0, active: false, latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: now }, primary: 'working', state: 'disconnected', activity: 'quiet' },
    { name: 'unknown presence with a working turn', facts: { presence: undefined, latestTurnStatus: 'in_progress', thinking: true, thinkingAt: now }, primary: 'working', state: 'thinking', activity: 'working' },
    { name: 'online failure', facts: { presence: 'online', latestTurnStatus: 'failed' }, primary: 'failed', state: 'unknown', activity: 'quiet' },
    { name: 'unreadable working turn', facts: { presence: 'online', latestTurnStatus: 'in_progress', encryptedContentAvailability: 'encrypted_content_unavailable' }, primary: 'working', state: 'content_unavailable', activity: 'quiet' },
  ] as const)('agrees with the shared Session presentation for $name', ({ facts, primary, state, activity }) => {
    const session = createSessionListRenderableSessionFixture({
      active: true, activeAt: now, updatedAt: now, ...facts,
    });
    const status = getSessionStatus(session, now);
    // Keep the operational evidence: losing it in a fixture would hide this regression.
    expect(status.awareness.operational.primary).toBe(primary);
    expect(status.state).toBe(state);
    expect(readBotActivity(session, now)).toBe(activity);
  });
});
