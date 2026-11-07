import { describe, expect, it } from 'vitest';
import type { TriagePullRequestStatusV1 } from '@happier-dev/triage-protocol/v1';
import type { TriageListRowV1 } from '../../projection/listWindow.js';
import { testkitObservation, testkitEntryRef, testkitPresentOutcome, testkitSnapshot } from '../../corpus/testkit/observations.test-support.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../projection/listWindow.js';
import { projectTriageSessionLinkedEntrySummary, projectTriageSessionLinkedEntrySummaries, applyTriageSessionPullRequestStatus, type TriageSessionLinkedEntrySummaryBaselineV1 } from './linkedEntrySummary.js';

describe('source-declared session entry summaries', () => {
    it('keeps summaries keyed to unchanged admitted rows and evicts retired membership', () => {
        const observations = Array.from({ length: 1_000 }, (_, index) => ({ ...testkitObservation(),
            entryRef: testkitEntryRef({ kindId: 'external-finding', entryId: String(index) }) }));
        const window = foldTriageListWindow({ observations, lanes: [], activeSourceInstanceIds: [observations[0]!.sourceInstanceId],
            configuredSourcesStatus: 'complete', lens: { ...TRIAGE_LIST_DEFAULT_LENS_V1, limit: observations.length }, assembledAtMs: 10 });
        const baseline: TriageSessionLinkedEntrySummaryBaselineV1 = new Map();
        const first = projectTriageSessionLinkedEntrySummaries(window.rows, () => 'errorIssue', baseline);
        const reordered = projectTriageSessionLinkedEntrySummaries([...window.rows].reverse(), () => 'errorIssue', baseline);
        expect([...first].filter(([key, summary]) => reordered.get(key) !== summary)).toHaveLength(0);
        const original = window.rows[0]!;
        if (original.content === null) throw new Error('Expected a present fixture');
        const changed = { ...original, content: { ...original.content, outcome: { ...original.content.outcome,
            snapshot: { ...original.content.outcome.snapshot, title: 'Updated finding' } } } };
        const next = projectTriageSessionLinkedEntrySummaries([changed, ...window.rows.slice(1)], () => 'errorIssue', baseline);
        expect([...first].filter(([key, summary]) => next.get(key) !== summary)).toHaveLength(1);
        expect([...next.values()].some((summary) => summary?.title === 'Updated finding')).toBe(true);
        projectTriageSessionLinkedEntrySummaries([changed], () => 'errorIssue', baseline);
        expect(baseline.size).toBe(1);
    });

    it('keeps a custom finding visible with its native label and canonical lifecycle, without PR status', () => {
        const entryRef = testkitEntryRef({ kindId: 'dependency-finding' });
        for (const [presentation, lifecycle] of [['active', 'open'], ['resolved', 'done'], ['suppressed', 'suppressed'], ['unknown', 'unknown']] as const) {
            const observation = testkitObservation({ outcome: testkitPresentOutcome({ snapshot: testkitSnapshot({
                state: { presentation, nativeLabel: 'Provider state in its own language' },
            }) }) });
            const window = foldTriageListWindow({ observations: [{ ...observation, entryRef }], lanes: [],
                activeSourceInstanceIds: [observation.sourceInstanceId], configuredSourcesStatus: 'complete',
                lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 10 });
            const entry = projectTriageSessionLinkedEntrySummary(window.rows[0]!, 'errorIssue');
            expect(entry).toMatchObject({ kind: 'errorIssue', lifecycle, entryRef,
                stateLabel: 'Provider state in its own language', sourceInstanceId: observation.sourceInstanceId,
                checks: null, review: null });
            expect(entry?.detailSource?.selection.entryRef).toEqual(entryRef);
            if (entry === null) continue;
            expect(applyTriageSessionPullRequestStatus(entry, { kind: 'status', observedAtMs: 10,
                checks: null, review: null, merge: null, branch: null, facts: [] })).toBe(entry);
        }
    });

    it('recognizes a PR through its declared workflow subject rather than a forge kind-id spelling', () => {
        const observation = testkitObservation();
        if (observation.outcome.kind !== 'present') throw new Error('Expected a present fixture');
        const row: TriageListRowV1 = {
            entryRef: testkitEntryRef({ kindId: 'merge-request' }),
            content: { ...observation, outcome: observation.outcome },
            lane: '1-open', sortAtMs: observation.observedAtMs,
            presence: { kind: 'present', observedAtMs: observation.observedAtMs }, attention: null,
            selected: { kind: 'selected', sourceInstanceId: observation.sourceInstanceId, reason: 'onlyPresent' },
            observations: [observation],
        };
        expect(projectTriageSessionLinkedEntrySummary(row, 'pullRequest')).toMatchObject({
            kind: 'pullRequest', title: observation.outcome.snapshot.title,
            sourceInstanceId: observation.sourceInstanceId,
        });
        const entry = projectTriageSessionLinkedEntrySummary(row, 'pullRequest')!;
        const status: TriagePullRequestStatusV1 = { kind: 'status', observedAtMs: 1000,
            checks: { state: 'incomplete', passed: 9, failed: 1, pending: 0, total: 10, incomplete: true,
                rows: [{ id: 'web', name: 'ui-tests (web)', state: 'failed' }] },
            review: { decision: 'changesRequested', reviewers: [], incomplete: false }, merge: null, branch: null, facts: [] };
        expect(applyTriageSessionPullRequestStatus(entry, status)).toMatchObject({
            checks: { passed: 9, failed: 1, total: 10, firstFailingName: 'ui-tests (web)' },
            review: { decision: 'changesRequested' },
        });
        expect(applyTriageSessionPullRequestStatus(entry, { ...status,
            checks: { ...status.checks!, passed: null, failed: null, pending: null, total: null },
            review: { ...status.review!, decision: null },
        })).toMatchObject({ checks: null, review: null });
    });
});
