import { describe, expect, it } from 'vitest';
import { PluginError } from '@happier-dev/plugin-sdk';
import { testkitEntryRef, testkitObservation, TESTKIT_SOURCE_INSTANCE_ID } from '../../corpus/testkit/observations.test-support.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../projection/listWindow.js';
import { projectTriageSessionLinkedEntryCandidates, linkTriageSessionEntry } from './linkedEntrySearch.js';
import { projectTriageSessionLinkedEntrySummary } from './linkedEntrySummary.js';
import type { TriageSessionLinkedEntrySummaryBaselineV1 } from './linkedEntrySummary.js';
import type { TriageSourceSessionLinksLaneV1 } from '../../actions/sessionLinksProtocol.js';

describe('Session entry linking', () => {
    it('admits candidates only from complete exact source-instance and kind slices while preserving named health', () => {
        const pr = testkitEntryRef();
        const issue = { ...pr, kindId: 'issue' };
        const rows = foldTriageListWindow({ observations: [pr, issue].map(entryRef => ({ ...testkitObservation(), entryRef })),
            lanes: [], activeSourceInstanceIds: [TESTKIT_SOURCE_INSTANCE_ID], configuredSourcesStatus: 'complete',
            lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 10 }).rows;
        const lanes: readonly TriageSourceSessionLinksLaneV1[] = [
            { source: pr.source, sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, displayLabel: 'Example forge',
                kindIds: ['pull-request'], health: { kind: 'complete' } },
            { source: pr.source, sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, displayLabel: 'Example forge',
                kindIds: ['issue'], health: { kind: 'unavailable' } },
        ];
        const project = (health: readonly TriageSourceSessionLinksLaneV1[]) => projectTriageSessionLinkedEntryCandidates(
            rows, '', [pr], () => 'pullRequest', undefined, undefined, health);
        expect(project(lanes).map(candidate => [candidate.entry.entryRef.kindId, candidate.alreadyLinked]))
            .toEqual([['pull-request', true]]);
        expect(project(lanes.map(lane => ({ ...lane, sourceInstanceId: '22222222-2222-4222-8222-222222222222' })))).toEqual([]);
        expect(project([...lanes, { ...lanes[0]!, health: { kind: 'unavailable' } }])).toEqual([]);
        expect(project([{ ...lanes[0]!, kindIds: undefined }])).toEqual([]);
    });
    it('keeps readable candidates from a partial kind and excludes only the exact unavailable owner reference', () => {
        const readable = testkitEntryRef({ kindId: 'issue', collisionScope: 'account:readable' });
        const unavailable = { ...readable, collisionScope: 'account:unavailable' };
        const rows = foldTriageListWindow({ observations: [readable, unavailable].map(entryRef => ({ ...testkitObservation(), entryRef })),
            lanes: [], activeSourceInstanceIds: [TESTKIT_SOURCE_INSTANCE_ID], configuredSourcesStatus: 'complete',
            lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 10 }).rows;
        const health: readonly TriageSourceSessionLinksLaneV1[] = [{ source: readable.source,
            sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, displayLabel: 'Example source', kindIds: ['issue'],
            health: { kind: 'partial', unavailableRefs: [unavailable] } }];
        expect(projectTriageSessionLinkedEntryCandidates(rows, '', [readable], () => 'issue', undefined, undefined, health)
            .map(candidate => [candidate.entry.entryRef, candidate.alreadyLinked])).toEqual([[readable, true]]);
    });
    it('retains unchanged candidate objects while updating only a changed link', () => {
        const observations = Array.from({ length: 100 }, (_, index) => ({ ...testkitObservation(),
            entryRef: testkitEntryRef({ kindId: 'external-finding', entryId: String(index) }) }));
        const window = foldTriageListWindow({ observations, lanes: [], activeSourceInstanceIds: [TESTKIT_SOURCE_INSTANCE_ID],
            configuredSourcesStatus: 'complete', lens: { ...TRIAGE_LIST_DEFAULT_LENS_V1, limit: observations.length }, assembledAtMs: 10 });
        const baseline: TriageSessionLinkedEntrySummaryBaselineV1 = new Map();
        const first = projectTriageSessionLinkedEntryCandidates(window.rows, '', [], () => 'errorIssue', baseline);
        const same = projectTriageSessionLinkedEntryCandidates(window.rows, '', [], () => 'errorIssue', baseline, first);
        expect(same).toBe(first);
        const next = projectTriageSessionLinkedEntryCandidates(window.rows, '', [window.rows[0]!.entryRef], () => 'errorIssue', baseline, same);
        expect(next.filter((candidate, index) => candidate !== same[index])).toHaveLength(1);
        expect(next[0]?.alreadyLinked).toBe(true);
        expect(next[0]?.entry).toBe(same[0]?.entry);
    });

    it('searches distinct findings sharing one native number and links only the exact kind', () => {
        const kinds = ['pull-request', 'issue', 'dependabot-alert', 'code-scanning-alert', 'external-finding'];
        const observations = kinds.map((kindId) => ({ ...testkitObservation(), entryRef: testkitEntryRef({ kindId }) }));
        const window = foldTriageListWindow({ observations, lanes: [], activeSourceInstanceIds: [TESTKIT_SOURCE_INSTANCE_ID],
            configuredSourcesStatus: 'complete', lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 10 });
        const linked = testkitEntryRef({ kindId: 'dependabot-alert' });
        const candidates = projectTriageSessionLinkedEntryCandidates(window.rows, 'normalizer', [linked],
            (ref) => ref.kindId === 'pull-request' ? 'pullRequest' : ref.kindId === 'issue' ? 'issue' : 'errorIssue');
        expect(candidates).toHaveLength(kinds.length);
        expect(candidates.map((candidate) => candidate.entry.entryRef.kindId).sort()).toEqual([...kinds].sort());
        expect(candidates.filter((candidate) => candidate.alreadyLinked).map((candidate) => candidate.entry.entryRef)).toEqual([linked]);
    });

    it('uses the existing entry search matcher and marks full-reference Session links', () => {
        const entryRef = testkitEntryRef();
        const window = foldTriageListWindow({
            observations: [{ ...testkitObservation(), entryRef }],
            lanes: [], activeSourceInstanceIds: [TESTKIT_SOURCE_INSTANCE_ID], configuredSourcesStatus: 'complete',
            lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 10,
        });
        expect(projectTriageSessionLinkedEntryCandidates(window.rows, 'repository NORMALIZER', [entryRef], () => 'pullRequest'))
            .toMatchObject([{ alreadyLinked: true, entry: { title: 'Replace the duplicated normalizer' } }]);
        expect(projectTriageSessionLinkedEntryCandidates(window.rows, 'missing', [entryRef], () => 'pullRequest')).toEqual([]);
        expect(projectTriageSessionLinkedEntryCandidates(window.rows, '', [{ ...entryRef, collisionScope: 'other' }], () => 'pullRequest'))
            .toMatchObject([{ alreadyLinked: false }]);
    });
    it('reports the existing link action outcome and never claims a failed write linked', async () => {
        const entryRef = testkitEntryRef();
        const window = foldTriageListWindow({ observations: [{ ...testkitObservation(), entryRef }],
            lanes: [], activeSourceInstanceIds: [TESTKIT_SOURCE_INSTANCE_ID], configuredSourcesStatus: 'complete',
            lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 10 });
        const entry = projectTriageSessionLinkedEntrySummary(window.rows[0]!, 'pullRequest')!;
        const requests: unknown[] = [];
        const host = { executeAction: async (action: string, input: unknown) => {
            requests.push({ action, input });
            return { v: 1, status: 'failed' };
        } };
        expect(await linkTriageSessionEntry(host, 'session-1', entry)).toEqual({ v: 1, status: 'failed' });
        expect(requests[0]).toMatchObject({ action: 'sessions/link-entry-v1', input: {
            sessionId: 'session-1', entryRef, display: { scopeLabel: 'example/repository', locator: { displayPath: 'example/repository #17' } },
        } });
        expect(await linkTriageSessionEntry({ executeAction: async () => ({ v: 1, status: 'linked' }) }, 'session-1', entry))
            .toEqual({ v: 1, status: 'linked' });
        expect(await linkTriageSessionEntry({ executeAction: async () => ({ v: 1, status: 'linked', extra: true }) }, 'session-1', entry))
            .toEqual({ v: 1, status: 'failed' });
        expect(await linkTriageSessionEntry({ executeAction: async () => { throw new Error('Account unreachable'); } }, 'session-1', entry))
            .toEqual({ v: 1, status: 'failed' });
        const refusal = new PluginError({ code: 'channels_pr_link_binding_not_ready', retryable: false });
        await expect(linkTriageSessionEntry({ executeAction: async () => { throw refusal; } }, 'session-1', entry))
            .rejects.toBe(refusal);
    });
});
