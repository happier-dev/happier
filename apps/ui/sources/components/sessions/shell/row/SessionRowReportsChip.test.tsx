import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SessionManagedSessionsV1Schema, type SessionManagedSessionsV1 } from '@happier-dev/protocol/sessions/follow/sessionManagerV1';

import { HappierUiPlatformProvider } from '@happier-dev/plugin-ui/environment';

import { renderScreen, standardCleanup } from '@/dev/testkit';
import { layoutHitArea } from '@/dev/testkit/harness/hitFrameReach';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { buildSessionListRenderableFromSession } from '@/sync/domains/session/listing/sessionListRenderable';
import { selectSessionReportSubtree } from '@/components/sessions/work/reportSubtree';
import { readSessionPresentationRecord, readSessionPresentationInputSource } from '@/sync/domains/session/listing/sessionListRenderableSessionProjection';
import { readSessionWorkStatusFacts, readSessionWorkStalled } from '@/components/work/status/sessionWorkStatusFacts';
import { projectWork, groupWorkByState, readWorkWorkingCount } from '@/components/sessions/work/workProjection';
import { readSessionAwarenessWorkStatusV1 } from '@happier-dev/protocol/sessions/awareness/presentationV1';
import { presentSessionAwarenessStateV1 } from '@/utils/sessions/sessionUtils';
import { t } from '@/text';

import {
  hasSessionRowReportsChip,
  SessionRowReportsChip,
  SessionRowReportsDisclosure,
} from './SessionRowReportsChip';

const REPORTS: SessionManagedSessionsV1 = { total: 3, needsYou: 1, working: 1, stalled: 0, finished: 1, attentionPrimary: 'permission_required' };

describe('SessionRowReportsChip', () => {
  afterEach(() => {
    standardCleanup();
  });

  it('keeps a strongest failure and an independent admitted request audible when folded', async () => {
    const reports: SessionManagedSessionsV1 = {
      total: 5, finished: 3, working: 1, needsYou: 1, stalled: 0, attentionPrimary: 'failed',
    };
    const screen = await renderScreen(<SessionRowReportsChip sessionId="lead-failure" reports={reports} />);
    const label = screen.findByTestId('session-row-reports-chip:lead-failure')?.props.accessibilityLabel;
    expect(label).toContain(presentSessionAwarenessStateV1('failed').statusText);
    expect(label).toContain(t('sessionWork.list.reportsNeedYou', { count: reports.needsYou }));
  });

  it('agrees with real Work projection for the same offline in-progress list facts', async () => {
    const now = Date.now();
    const child = createSessionFixture({ id: 'child', serverId: 'home', manager: { sessionId: 'lead' },
      active: false, activeAt: now, presence: 0, latestTurnStatus: 'in_progress', latestTurnStatusObservedAt: now });
    const row = buildSessionListRenderableFromSession(child);
    const reports = selectSessionReportSubtree({}, 'lead', 'home', { home: { child: row } });
    const status = readSessionAwarenessWorkStatusV1({ awareness: readSessionWorkStatusFacts(row, now).awareness });
    const stalled = readSessionWorkStalled(row, now);
    const counts = SessionManagedSessionsV1Schema.parse({ total: 1, working: Number(status.bucket === 'working'), needsYou: Number(status.bucket === 'needs_you'), stalled: Number(stalled), finished: 0, attentionPrimary: 'disconnected' });
    const work = projectWork({ sessionId: 'lead', reportSessions: reports.map(input => {
      const session = readSessionPresentationRecord(input);
      const source = readSessionPresentationInputSource(input);
      return { sessionId: session.id, managerSessionId: 'lead', title: 'Payment retries', agentId: null, facts: [],
        statusFacts: readSessionWorkStatusFacts(session, now, source), stalled: readSessionWorkStalled(session, now, source), archived: false };
    }), agentEntries: [], workflowHeadlineRuns: [], managedRuns: [], ownTriggerRunIds: new Set(),
      describeAgentStatus: () => '', describeProgress: () => '' });
    expect(groupWorkByState(work).recent.map(item => item.status.bucket)).toEqual(['offline']);
    expect(readWorkWorkingCount(work.summary)).toBe(0);
    const screen = await renderScreen(<SessionRowReportsChip sessionId="lead" reports={counts} />);
    // The lead's progress stays calm ink; the reports' state is spoken with it, never as "working".
    const label = String(screen.findByTestId('session-row-reports-chip:lead')?.props.accessibilityLabel).toLowerCase();
    expect(label).not.toContain('working');
    expect(label).toContain(presentSessionAwarenessStateV1('disconnected').statusText.toLowerCase());
  });

  it('shows a lead\'s progress over its live sub-sessions, with the needs-you glyph and count while one waits', async () => {
    const screen = await renderScreen(
      <SessionRowReportsChip
        sessionId="bot"
        reports={REPORTS}
      />,
    );
    expect(screen.getTextContent()).toContain('1/3');
    expect(screen.findByTestId('session-row-reports-chip:bot')?.props.accessibilityLabel)
      .toContain(t('sessionWork.list.reportsNeedYou', { count: 1 }));
    const settled = await renderScreen(
      <SessionRowReportsChip
        sessionId="bot"
        reports={{ total: 3, needsYou: 0, working: 0, stalled: 0, finished: 3, attentionPrimary: null }}
      />,
    );
    // The progress count shows only while in progress (ruling 2026-11-01): a settled lead drops the chip; its
    // count stays in the caret's label and the sub-sessions under it.
    expect(settled.findByTestId('session-row-reports-chip:bot')).toBeNull();
    expect(hasSessionRowReportsChip({ total: 3, needsYou: 0, working: 0, stalled: 0, finished: 3, attentionPrimary: null })).toBe(false);
  });

  it('says progress as a bare count, never "done" (a shelf mirror has no children under it)', async () => {
    const reports = { total: 5, needsYou: 0, working: 3, stalled: 0, finished: 2, attentionPrimary: null };
    const screen = await renderScreen(<SessionRowReportsChip sessionId="lead" reports={reports} />);
    expect(screen.getTextContent()).toBe('2/5');
  });

  it('counts only the sub-sessions that are not archived, and says nothing when every report is archived', async () => {
    const counted = await renderScreen(
      <SessionRowReportsChip sessionId="bot" reports={{ total: 4, needsYou: 0, working: 1, stalled: 0, finished: 2, attentionPrimary: null, archived: 1 }} />,
    );
    expect(counted.getTextContent()).toBe('2/3');
    const archivedOnly = await renderScreen(
      <SessionRowReportsChip sessionId="bot" reports={{ total: 1, needsYou: 0, working: 0, stalled: 0, finished: 0, attentionPrimary: null, archived: 1 }} />,
    );
    expect(archivedOnly.findByTestId('session-row-reports-chip:bot')).toBeNull();
  });

  it('writes the explicit opposite of the current fold for its own list node', async () => {
    const onSetCollapsed = vi.fn();
    const screen = await renderScreen(
      <SessionRowReportsDisclosure
        sessionId="bot"
        nodeId="session:home/bot"
        name="Release captain"
        count={3}
        collapsed
        onSetCollapsed={onSetCollapsed}
      />,
    );
    const control = screen.findByTestId('session-row-reports-disclosure:bot');
    expect(control?.props.accessibilityState).toMatchObject({
      expanded: false,
    });
    screen.pressByTestId('session-row-reports-disclosure:bot');
    expect(onSetCollapsed).toHaveBeenCalledWith('session:home/bot', false);

    const expanded = await renderScreen(
      <SessionRowReportsDisclosure
        sessionId="bot2"
        nodeId="session:home/bot2"
        name="Release captain"
        count={3}
        collapsed={false}
        onSetCollapsed={onSetCollapsed}
      />,
    );
    expanded.pressByTestId('session-row-reports-disclosure:bot2');
    expect(onSetCollapsed).toHaveBeenLastCalledWith('session:home/bot2', true);
  });

  it('keeps its drawn caret box and never reaches into the row content that follows it, on a finger and a pointer', async () => {
    for (const platform of ['ios', 'web'] as const) {
      const screen = await renderScreen(
        <HappierUiPlatformProvider platform={{ platform, colorScheme: 'light' }}>
          <SessionRowReportsDisclosure sessionId="bot" nodeId="session:home/bot" name="Reading desk" count={9} collapsed onSetCollapsed={vi.fn()} />
        </HappierUiPlatformProvider>,
      );
      const area = await layoutHitArea(() => screen.findByTestId('session-row-reports-disclosure:bot'), { width: 12, height: 24 });
      // The Session row's identity follows the caret at once: the hit area ends at the caret's drawn right edge.
      expect(area.insets.right).toBe(0);
      // Only the 8 px of row padding before the caret is taken; the row band is never left.
      expect(area.insets.left).toBe(8);
      expect(area.width).toBe(20);
      expect(area.insets.top).toBe(0);
      expect(area.insets.bottom).toBe(0);
      await screen.unmount();
    }
  });
});
