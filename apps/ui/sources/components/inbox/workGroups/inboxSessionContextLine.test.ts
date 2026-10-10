import { describe, expect, it } from 'vitest';

import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import {
  buildSessionContextFacts,
  projectSessionContextPresentation,
} from '@/sync/domains/session/presentation/sessionContextPresentation';
import { t } from '@/text';

import { buildInboxSessionContextLine } from './inboxSessionContextLine';

const HOME = 'happier-agent-qa-orc.localhost:3022';

function readyCandidate() {
  const session = createSessionFixture({
    id: 'ready',
    serverId: 'home-a',
    latestTurnStatus: 'completed',
    metadata: {
      path: '/home/alice/repo',
      host: 'test-host',
      displayName: 'Marker adoption',
    },
    viewer: {
      readState: {
        state: 'tracking',
        lastViewedSessionSeq: 0,
        unreadSince: null,
      },
      relevance: { relevant: true, reasons: ['owned_by_me'] },
      follow: { follows: false, notificationLevel: null, includeInVoice: true },
      notification: { level: 'important', source: 'owner' },
      attention: {
        needsAttention: true,
        reasons: ['ready_after_read'],
        primary: 'ready_after_read',
        presentation: 'full',
      },
    },
  });
  const candidate = buildSessionActivityAttention({ session, nowMs: 1000 });
  return {
    ...candidate,
    context: projectSessionContextPresentation(
      buildSessionContextFacts({
        address: { serverId: 'home-a', sessionId: 'ready' },
        homeName: HOME,
        workspaceLabel: '0.3',
      }),
    ),
  };
}

describe('Inbox session row line', () => {
  it('says what the session needs first, as the start of a sentence, before where it runs', () => {
    const line =
      buildInboxSessionContextLine(readyCandidate(), { showHome: true }) ?? '';
    const need = t('status.readyForReview');
    expect(line.startsWith(need.charAt(0).toLocaleUpperCase() + need.slice(1))).toBe(true);
    expect(line).toContain('0.3');
  });

  it('never states a failure on the line: the row says its one status through the work-status owner', () => {
    const failed = { ...readyCandidate(), attentionState: 'failed' as const };
    const line = buildInboxSessionContextLine(failed, { showHome: true }) ?? '';
    expect(line.toLowerCase()).not.toContain(t('status.error').toLowerCase());
    expect(line).toContain('0.3');
  });

  it('leaves the Home out when every row in the Inbox shares it, so no raw host repeats down the list', () => {
    const line =
      buildInboxSessionContextLine(readyCandidate(), { showHome: false }) ?? '';
    expect(line).not.toContain(HOME);
    expect(line).toContain('0.3');
    expect(
      buildInboxSessionContextLine(readyCandidate(), { showHome: true }),
    ).toContain(HOME);
  });
  it('says one status: a row whose own status reads unknown or offline never repeats the Home’s currentness beside it', () => {
    const candidate = readyCandidate();
    const withHome = (phase: 'error' | 'offline') => ({
      ...candidate,
      context: projectSessionContextPresentation(
        buildSessionContextFacts({
          address: { serverId: 'home-a', sessionId: 'ready' },
          homeName: HOME,
          workspaceLabel: '0.3',
          homeObservation: { phase, lastSuccessAt: 500 },
          nowMs: 1000,
        }),
      ),
    });
    const staleWords = t('session.homeFreshness.stale');
    const offlineWords = t('session.homeFreshness.offline');
    // A known status keeps the Home's currentness: the status may be out of date.
    expect(buildInboxSessionContextLine(withHome('error'), { showHome: false })).toContain(staleWords);
    // The row's status comes from the session's own awareness, so every caller (Needs you, Updates,
    // the Voice brief) drops the repeat without being told to.
    for (const runtime of ['unknown', 'offline'] as const) {
      const unsettled = withHome('offline');
      const line = buildInboxSessionContextLine(
        { ...unsettled, awareness: { ...unsettled.awareness, runtime } },
        { showHome: false, showNeed: false },
      ) ?? '';
      expect(line).not.toContain(offlineWords);
      expect(line).toContain('0.3');
    }
  });
});
