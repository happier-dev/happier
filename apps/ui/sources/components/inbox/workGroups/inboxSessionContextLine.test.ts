import { describe, expect, it } from 'vitest';

import { buildSessionActivityAttention } from '@/activity/attention/buildSessionActivityAttention';
import { createSessionFixture, createSessionViewerFixture } from '@/dev/testkit/fixtures/sessionFixtures';
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
    active: true,
    activeAt: 1000,
    latestTurnStatus: 'completed',
    metadata: {
      path: '/home/alice/repo',
      host: 'test-host',
      displayName: 'Marker adoption',
    },
    viewer: {
      latestFailureSeq: null,
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
  it('names the projected current work in the Inbox row beside its workspace', () => {
    const ready = readyCandidate();
    const session = {
      ...ready.session,
      metadata: {
        ...ready.session.metadata!,
        work: { statusReason: 'Waiting on the staging deploy' },
      },
    };
    const candidate = { ...buildSessionActivityAttention({ session, nowMs: 1000 }), context: ready.context };
    const line = buildInboxSessionContextLine(candidate, { showHome: false, showNeed: false });
    expect(line).toContain('Waiting on the staging deploy');
    expect(line).toContain('0.3');
  });

  it.each([
    { total: 2, working: 0, needsYou: 0, stalled: 2, finished: 0, attentionPrimary: 'disconnected' as const },
    { total: 2, working: 0, needsYou: 2, stalled: 0, finished: 0, attentionPrimary: 'permission_required' as const },
    { total: 6, working: 2, needsYou: 1, stalled: 3, finished: 0, attentionPrimary: 'permission_required' as const },
  ])('labels only server-bucketed working reports as still working: %j', (reports) => {
    const candidate = readyCandidate();
    const line = buildInboxSessionContextLine({ ...candidate, session: { ...candidate.session, managedSessions: reports } }) ?? '';
    if (reports.working === 0) {
      expect(line).not.toContain(t('sessionWork.strip.stillWorking', { count: reports.total }));
    } else {
      expect(line).toContain(t('sessionWork.strip.stillWorking', { count: reports.working }));
      expect(line).not.toContain(t('sessionWork.strip.stillWorking', { count: reports.total }));
    }
  });
  it('says what the session needs first, as the start of a sentence, before where it runs', () => {
    const line =
      buildInboxSessionContextLine(readyCandidate(), { showHome: true }) ?? '';
    const need = t('workStatus.buckets.finished');
    expect(line.startsWith(need.charAt(0).toLocaleUpperCase() + need.slice(1))).toBe(true);
    expect(line).toContain('0.3');
  });

  it('never states a failure on the line: the row says its one status through the work-status owner', () => {
    const ready = readyCandidate();
    const session = { ...ready.session, latestTurnStatus: 'failed' as const,
      viewer: createSessionViewerFixture({ latestFailureSeq: 4,
        readState: { state: 'tracking', lastViewedSessionSeq: 1, unreadSince: null },
        attention: { needsAttention: true, reasons: ['failed'], primary: 'failed', presentation: 'full' },
      }),
    };
    const failed = { ...buildSessionActivityAttention({ session, nowMs: 1000 }), context: ready.context };
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
        { ...unsettled, awareness: { ...unsettled.awareness, runtime, freshness: runtime,
          // Retained ready/stale facts are their own statuses; these rows have neither.
          operational: { ...unsettled.awareness.operational, primary: 'none' as const, reasons: [] },
        } },
        { showHome: false, showNeed: false },
      ) ?? '';
      expect(line).not.toContain(offlineWords);
      expect(line).toContain('0.3');
    }
  });

  it('says whom a worker reports to and its latest update instead of the place every report shares (lab inbox-I1)', () => {
    const candidate = readyCandidate();
    const line = buildInboxSessionContextLine(candidate, { showHome: true, showNeed: false,
      worker: { leadTitle: 'Payments v2 rollout', headline: 'Runbook drafted' } }) ?? '';
    expect(line).toBe(`Runbook drafted ·\u00A0${t('inbox.work.rows.reportsTo', { lead: 'Payments v2 rollout' })}`);
    // An unreadable lead has no title to show: the row keeps saying where it runs.
    expect(buildInboxSessionContextLine(candidate, { showHome: false, showNeed: false, worker: { leadTitle: null } })).toContain('0.3');
  });
});
