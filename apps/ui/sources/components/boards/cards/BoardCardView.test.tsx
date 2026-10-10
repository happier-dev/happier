import * as React from 'react';
import { act } from 'react-test-renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderScreen, standardCleanup } from '@/dev/testkit';
import { createWorkflowRunSummaryFixture } from '@/dev/testkit/fixtures/workflowRunFixtures';
import { workflowRunRowFromSummary } from '@/sync/store/domains/workflowRuns';
import { buildBoardCards, type BoardCard } from '../model/boardCards';
import { BoardCardView } from './BoardCardView';

vi.mock('react-native', async () => (await import('@/dev/testkit/mocks/reactNative')).createReactNativeWebMock());
vi.mock('react-native-unistyles', async () => (await import('@/dev/testkit/mocks/unistyles')).createUnistylesMock());
vi.mock('@/text', async () => (await import('@/dev/testkit/mocks/text')).createTextModuleMock());
afterEach(async () => { await standardCleanup(); vi.useRealTimers(); });

function runCard(state: 'cancelled' | 'outcome_uncertain' | 'waiting_for_review'): BoardCard {
    const ref = { kind: 'workflow_run', qualifiedId: { serverId: 'home-a', id: 'run-1' } } as const;
    return buildBoardCards([{ key: 'run', ref, picked: true, sourced: false, available: true }], {
        nowMs: Date.now(), session: () => null, machine: () => null, workflow: () => null,
        machineSessionCounts: new Map(), accountScopedHome: () => true,
        workflowRun: () => workflowRunRowFromSummary(createWorkflowRunSummaryFixture({ state,
            attentionRequired: true }), null),
    })[0]!;
}

describe('Board body facts', () => {
    it('keeps stopped and uncertain attention neutral, and names a genuine hold without inventing review eligibility', async () => {
        const screen = await renderScreen(<BoardCardView card={runCard('cancelled')} />);
        expect(screen.getTextContent()).toContain('workflows.runState.cancelled');
        expect(screen.getTextContent()).toContain('workStatus.buckets.needs_you');
        expect(screen.getTextContent()).not.toContain('boards.card.run.waitingForYou');
        await screen.update(<BoardCardView card={runCard('outcome_uncertain')} />);
        expect(screen.getTextContent()).not.toContain('boards.card.run.waitingForYou');
        await screen.update(<BoardCardView card={runCard('waiting_for_review')} />);
        expect(screen.getTextContent()).toContain('workflows.review.waitTitle');
        expect(screen.getTextContent()).not.toContain('boards.card.run.waitingForYou');
    });

    it('refreshes workflow countdown and Run age with unchanged cards while unrelated cards stay stable', async () => {
        vi.useFakeTimers();
        const now = new Date(2026, 9, 10, 10).getTime();
        vi.setSystemTime(now);
        const base = runCard('cancelled');
        const workflow: BoardCard = { ...base, key: 'workflow', ref: { kind: 'workflow', qualifiedId: { serverId: 'home-a', id: 'wf' } },
            body: { kind: 'workflow', needsYouCount: 0, lastRunWord: 'Succeeded', lastRunAt: new Date(now - 90_000).toISOString(),
                runSummaryAvailable: true, triggerSummary: null, nextRun: { kind: 'scheduled', at: now + 120_000 } } };
        const run: BoardCard = { ...base, key: 'age', body: { kind: 'workflow_run', runId: 'run-1', waitingForYou: false,
            startedAt: new Date(now - 90_000).toISOString(), progress: null } };
        let idleReads = 0;
        const idle: BoardCard = { ...base, key: 'idle', body: { get kind() { idleReads += 1; return 'none' as const; } } };
        const screen = await renderScreen(<><BoardCardView card={workflow} /><BoardCardView card={run} /><BoardCardView card={idle} /></>);
        const before = idleReads;
        expect(screen.getTextContent()).toContain('nextMinutes(count=2)');
        await act(async () => { vi.advanceTimersByTime(30_001); });
        expect(screen.getTextContent()).toContain('nextMinutes(count=1)');
        expect(screen.getTextContent()).toContain('time.minutesAgoShort(count=2)');
        expect(idleReads).toBe(before);
        expect(vi.getTimerCount()).toBe(1);
    });
});
