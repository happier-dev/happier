import { describe, expect, it } from 'vitest';

import { testkitEntryRef, testkitPresentOutcome, testkitSnapshot, TESTKIT_SOURCE_INSTANCE_ID } from '../../corpus/testkit/observations.test-support.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../projection/listWindow.js';
import { projectTriageSessionLinkedEntries } from './linkedEntryRows.js';
import type { TriageSessionLinkedEntrySummaryBaselineV1 } from './linkedEntrySummary.js';

const entryRef = testkitEntryRef();
const link = { entryRef, sessionId: 'session-1', linkedAtMs: 42, displayPath: 'example/repository#42' };

describe('the Session cockpit composed relationship projection', () => {
    it('retains unchanged finding rows across relation refresh and derives only changed summaries', () => {
        const refs = Array.from({ length: 100 }, (_, index) => ({ ...entryRef, kindId: 'external-finding', entryId: String(index) }));
        const window = foldTriageListWindow({ observations: refs.map(ref => ({ entryRef: ref, sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID,
            observedAtMs: 10, outcome: testkitPresentOutcome() })), lanes: [], activeSourceInstanceIds: [TESTKIT_SOURCE_INSTANCE_ID],
            configuredSourcesStatus: 'complete', lens: { ...TRIAGE_LIST_DEFAULT_LENS_V1, limit: refs.length }, assembledAtMs: 10 });
        const links = refs.map(ref => ({ ...link, entryRef: ref }));
        const summaryBaseline: TriageSessionLinkedEntrySummaryBaselineV1 = new Map();
        const input = { links, status: 'ready' as const, entries: window.rows, workflowSubject: () => 'errorIssue' as const, summaryBaseline };
        const first = projectTriageSessionLinkedEntries(input);
        const equal = projectTriageSessionLinkedEntries({ ...input, links: structuredClone(links), previous: first });
        expect(equal).toBe(first);
        const changed = projectTriageSessionLinkedEntries({ ...input, links: links.map((item, index) => index === 0
            ? { ...item, displayPath: 'Renamed finding' } : item), previous: equal });
        if (first.kind !== 'linked' || changed.kind !== 'linked') throw new Error('Expected linked findings');
        const prior = new Map(first.rows.map(row => [row.key, row]));
        expect(changed.rows.filter(row => row !== prior.get(row.key))).toHaveLength(1);
    });

    it('keeps healthy co-links visible with explicit failed-kind coverage', () => {
        const issue = { ...link, entryRef: { ...entryRef, kindId: 'issue' }, displayPath: 'Issue #42' };
        const view = projectTriageSessionLinkedEntries({ links: [issue], status: 'partial', lanes: [{
            source: entryRef.source, sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, displayLabel: 'Example forge',
            kindIds: ['pull-request'], health: { kind: 'unavailable' },
        }] });
        expect(view).toMatchObject({ kind: 'linked', more: false,
            rows: [{ presentation: { kind: 'linked', displayPath: issue.displayPath, entryRef: issue.entryRef } }],
            notice: { sources: [{ label: 'Example forge' }] },
        });
    });

    it.each(['partial', 'failed'] as const)('does not claim absence for an empty %s result', status => {
        expect(projectTriageSessionLinkedEntries({ links: [], status })).toEqual({
            kind: 'unavailable', notice: { sources: [] },
        });
    });

    it('claims an empty set only after the owner completes the relation walk', () => {
        expect(projectTriageSessionLinkedEntries({ links: [], status: 'loading' })).toEqual({ kind: 'loading' });
        expect(projectTriageSessionLinkedEntries({ links: [], status: 'ready' })).toEqual({ kind: 'empty' });
    });

    it('retains known links while a refresh is pending and marks a failed refresh stale', () => {
        expect(projectTriageSessionLinkedEntries({ links: [link], status: 'loading' }))
            .toMatchObject({ kind: 'linked', rows: [{ presentation: { entryRef } }], notice: null });
        expect(projectTriageSessionLinkedEntries({ links: [link], status: 'failed' }))
            .toMatchObject({ kind: 'linked', rows: [{ presentation: { entryRef } }], notice: { sources: [] } });
    });

    it('uses the canonical reference and frozen display path without inventing source ownership', () => {
        const view = projectTriageSessionLinkedEntries({ links: [link], status: 'ready' });
        if (view.kind !== 'linked') throw new Error('Expected linked entries');
        expect(view.rows[0]).toEqual({ key: expect.any(String), linkedAtMs: 42,
            presentation: { kind: 'linked', displayPath: link.displayPath, entryRef, entry: null } });
        if (view.rows[0]!.presentation.kind !== 'linked') throw new Error('Expected a linked row');
        expect(view.rows[0]!.presentation.entryRef).toBe(entryRef);
    });

    it('joins the admitted link to the exact existing window entry', () => {
        const window = foldTriageListWindow({
            observations: [{ entryRef, sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, observedAtMs: 10,
                outcome: testkitPresentOutcome({ snapshot: testkitSnapshot({ title: 'A real title' }) }) }],
            lanes: [], activeSourceInstanceIds: [TESTKIT_SOURCE_INSTANCE_ID], configuredSourcesStatus: 'complete',
            lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 10,
        });
        const other = { ...link, entryRef: { ...entryRef, collisionScope: 'another/repo' } };
        const view = projectTriageSessionLinkedEntries({ links: [link, other], status: 'ready',
            entries: window.rows, workflowSubject: () => 'pullRequest' });
        if (view.kind !== 'linked') throw new Error('Expected linked entries');
        expect(view.rows.find(row => row.presentation.kind === 'linked' && row.presentation.entryRef === entryRef)?.presentation)
            .toMatchObject({ entry: { title: 'A real title', sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID } });
        expect(view.rows.find(row => row.presentation.kind === 'linked' && row.presentation.entryRef === other.entryRef)?.presentation)
            .toMatchObject({ entry: null });
    });

    it('keeps every link from the full owner result reachable and orders ties deterministically', () => {
        const links = Array.from({ length: 101 }, (_, index) => ({ ...link,
            entryRef: { ...entryRef, entryId: String(index) }, linkedAtMs: index === 100 ? 100 : 42 }));
        const view = projectTriageSessionLinkedEntries({ links, status: 'ready' });
        if (view.kind !== 'linked') throw new Error('Expected linked entries');
        expect(view.rows).toHaveLength(101);
        expect(view.more).toBe(false);
        expect(view.rows[0]!.presentation).toMatchObject({ entryRef: links[100]!.entryRef });
        expect(projectTriageSessionLinkedEntries({ links: [...links].reverse(), status: 'ready' })).toEqual(view);
    });
});
