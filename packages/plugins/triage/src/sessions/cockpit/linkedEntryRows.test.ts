import { describe, expect, it } from 'vitest';
import { createSurfaceContextFixture } from '@happier-dev/plugin-sdk/testing';
import {
    TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1,
    TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1,
} from '@happier-dev/triage-protocol/v1';
import { resolveTriageSourceWorkflowSubjectV1 } from '../../ui/detail/sourceSurface.js';

import { CORPUS_SESSION_LINKS_FIELD } from '../../corpus/collections/ids.js';
import { testkitEntryRef, testkitPresentOutcome, testkitSnapshot, TESTKIT_SOURCE_INSTANCE_ID } from '../../corpus/testkit/observations.test-support.js';
import { foldTriageListWindow, TRIAGE_LIST_DEFAULT_LENS_V1 } from '../../projection/listWindow.js';
import { MAX_TRIAGE_SESSION_LINKED_ENTRY_ROWS_V1 } from './linkedEntriesQuery.js';
import {
    projectTriageSessionLinkedEntries,
    triageSessionLinkHydrationTargets,
    type TriageSessionLinkHydrationV1,
    type TriageSessionLinkQueryRowV1,
    type TriageSessionLinkedEntriesQueryStateV1,
} from './linkedEntryRows.js';

/**
 * The cockpit's two honesty contracts, proven where they are decided.
 *
 * A link is durable Account state and the entry it names is not stored at all,
 * so the failure this file exists to catch is a projection that quietly makes a
 * durable link disappear — by dropping an unhydrated row, by reporting an
 * unsettled page as an empty link set, or by presenting a stale read as current.
 */

function queryRow(
    rowId: string,
    linkedAtMs: number,
    revision = 1,
): TriageSessionLinkQueryRowV1 {
    return {
        rowId,
        revision,
        fields: {
            [CORPUS_SESSION_LINKS_FIELD.sessionId]: 'session-1',
            [CORPUS_SESSION_LINKS_FIELD.entryTag]: `${rowId}-entry`,
            [CORPUS_SESSION_LINKS_FIELD.linkedAtMs]: linkedAtMs,
        },
    };
}

function state(
    overrides: Partial<TriageSessionLinkedEntriesQueryStateV1> = {},
): TriageSessionLinkedEntriesQueryStateV1 {
    return { status: 'ready', rows: [], hasMore: false, failure: null, ...overrides };
}

/** The reference the private link row held, as every `ready` read carries it. */
const ENTRY_REF = testkitEntryRef();
const SOURCE_PROTOCOL = { id: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_ID_V1, version: TRIAGE_SOURCES_CONTRIBUTION_PROTOCOL_VERSION_V1 };
const SOURCE_CONTEXT = createSurfaceContextFixture({ targetedContributions: {
    target: { pluginId: 'happier.triage', occurrenceId: 'triage-occurrence', sourceCustody: { kind: 'development', registeredRootId: 'triage-root' } },
    points: [{ pointId: TRIAGE_SOURCES_CONTRIBUTION_POINT_ID_V1, protocols: [{ protocol: SOURCE_PROTOCOL, contributions: [{
        contributor: { pluginId: ENTRY_REF.source.pluginId, contributionId: ENTRY_REF.source.localId,
            occurrenceId: 'source-occurrence', sourceCustody: { kind: 'development', registeredRootId: 'source-root' } },
        protocol: SOURCE_PROTOCOL,
        descriptor: { v: 1, purpose: 'triage-source', displayName: 'Example forge',
            kinds: [{ id: ENTRY_REF.kindId, workflowSubject: 'pullRequest', displayName: 'Pull request' }] },
        operations: [], surfaces: [],
    }] }] }],
} });

function hydration(
    entries: readonly (readonly [string, TriageSessionLinkHydrationV1])[],
): ReadonlyMap<string, TriageSessionLinkHydrationV1> {
    return new Map(entries);
}

describe('the Session cockpit linked-entry projection', () => {
    it('joins by the complete canonical reference to the existing window content winner', () => {
        const window = foldTriageListWindow({
            observations: [{ entryRef: ENTRY_REF, sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID, observedAtMs: 10,
                outcome: testkitPresentOutcome({ snapshot: testkitSnapshot({ title: 'A real title', state: { presentation: 'resolved', nativeLabel: 'Merged' }, facts: [
                    { id: 'github/number', importance: 'primary', value: { kind: 'text', value: '#17' } },
                    { id: 'github/comments', importance: 'secondary', value: { kind: 'number', value: 7, format: 'compact' } },
                    { id: 'github/author', importance: 'secondary', value: { kind: 'actor', value: 'octocat' } },
                ] }) }) }],
            lanes: [], activeSourceInstanceIds: [TESTKIT_SOURCE_INSTANCE_ID], configuredSourcesStatus: 'complete',
            lens: TRIAGE_LIST_DEFAULT_LENS_V1, assembledAtMs: 10,
        });
        const view = projectTriageSessionLinkedEntries({
            query: state({ rows: [queryRow('known', 10), queryRow('unknown', 9)] }),
            hydration: hydration([
                ['known', { kind: 'ready', revision: 1, displayPath: 'old/path', entryRef: ENTRY_REF }],
                ['unknown', { kind: 'ready', revision: 1, displayPath: 'other/path', entryRef: { ...ENTRY_REF, collisionScope: 'another/repo' } }],
            ]),
            entries: window.rows,
            workflowSubject: (entryRef) => resolveTriageSourceWorkflowSubjectV1(SOURCE_CONTEXT.targetedContributions, entryRef),
        });
        if (view.kind !== 'linked') throw new Error('expected links');
        expect(view.rows[0]?.presentation).toMatchObject({ kind: 'linked', entry: {
            kind: 'pullRequest', title: 'A real title', number: '17', repository: 'repository',
            lifecycle: 'merged', stateLabel: 'Merged', comments: 7, author: { name: 'octocat', avatarUrl: null },
            sourceInstanceId: TESTKIT_SOURCE_INSTANCE_ID,
        } });
        expect(view.rows[1]?.presentation).toMatchObject({ kind: 'linked', displayPath: 'other/path', entry: null });
    });
    it('renders the link from its own frozen display path', () => {
        const view = projectTriageSessionLinkedEntries({
            query: state({ rows: [queryRow('link-a', 10)] }),
            hydration: hydration([
                ['link-a', { kind: 'ready', revision: 1, displayPath: 'example/repository#42', entryRef: ENTRY_REF }],
            ]),
        });

        expect(view).toEqual({
            kind: 'linked',
            rows: [{
                key: 'link-a',
                linkedAtMs: 10,
                presentation: {
                    kind: 'linked',
                    displayPath: 'example/repository#42',
                    // Unlink is addressed by the entry AND the Session, and the
                    // mounted surface knows only the Session. Without the
                    // reference the private read already returned, a reader who
                    // linked the wrong entry has nothing to undo it with.
                    entryRef: ENTRY_REF,
                    entry: null,
                },
            }],
            more: false,
            notice: null,
        });
    });

    it('keeps a link whose private row has not been read yet, rather than dropping it', () => {
        const view = projectTriageSessionLinkedEntries({
            query: state({ rows: [queryRow('link-a', 10), queryRow('link-b', 20)] }),
            hydration: hydration([
                ['link-b', { kind: 'ready', revision: 1, displayPath: 'example/repository#7', entryRef: ENTRY_REF }],
            ]),
        });

        if (view.kind !== 'linked') throw new Error(`Expected linked rows, saw ${view.kind}.`);
        expect(view.rows.map((row) => row.key)).toEqual(['link-b', 'link-a']);
        expect(view.rows[1]?.presentation).toEqual({ kind: 'reading' });
    });

    it('says a link was removed underneath the page instead of hiding the row', () => {
        const view = projectTriageSessionLinkedEntries({
            query: state({ rows: [queryRow('link-a', 10)] }),
            hydration: hydration([['link-a', { kind: 'unlinked', revision: 1 }]]),
        });

        if (view.kind !== 'linked') throw new Error(`Expected linked rows, saw ${view.kind}.`);
        expect(view.rows[0]?.presentation).toEqual({ kind: 'unlinked' });
    });

    it('says a link could not be read instead of presenting it as unlinked', () => {
        const view = projectTriageSessionLinkedEntries({
            query: state({ rows: [queryRow('link-a', 10)] }),
            hydration: hydration([['link-a', { kind: 'unreadable', revision: 1 }]]),
        });

        if (view.kind !== 'linked') throw new Error(`Expected linked rows, saw ${view.kind}.`);
        expect(view.rows[0]?.presentation).toEqual({ kind: 'unreadable' });
    });

    it('does not present a hydration read taken at an older revision as current', () => {
        const view = projectTriageSessionLinkedEntries({
            query: state({ rows: [queryRow('link-a', 10, 4)] }),
            hydration: hydration([
                ['link-a', { kind: 'ready', revision: 3, displayPath: 'stale/path#1', entryRef: ENTRY_REF }],
            ]),
        });

        if (view.kind !== 'linked') throw new Error(`Expected linked rows, saw ${view.kind}.`);
        expect(view.rows[0]?.presentation).toEqual({ kind: 'reading' });
    });

    it('reports absence only from a settled page', () => {
        expect(projectTriageSessionLinkedEntries({
            query: state({ status: 'ready' }),
            hydration: hydration([]),
        })).toEqual({ kind: 'empty' });

        for (const status of ['idle', 'loading'] as const) {
            expect(projectTriageSessionLinkedEntries({
                query: state({ status }),
                hydration: hydration([]),
            })).toEqual({ kind: 'loading' });
        }
    });

    it('never reports an unavailable or failed empty page as an empty link set', () => {
        expect(projectTriageSessionLinkedEntries({
            query: state({ status: 'unavailable', failure: 'collection_unavailable' }),
            hydration: hydration([]),
        })).toEqual({
            kind: 'unavailable',
            message: 'Linked PRs and issues are unavailable for this account right now.',
        });

        expect(projectTriageSessionLinkedEntries({
            query: state({ status: 'error', failure: 'collection_index_not_ready' }),
            hydration: hydration([]),
        })).toEqual({
            kind: 'unavailable',
            message: 'Linked PRs and issues are still being prepared for this account.',
        });

        expect(projectTriageSessionLinkedEntries({
            query: state({ status: 'error', failure: null }),
            hydration: hydration([]),
        })).toEqual({
            kind: 'unavailable',
            message: 'Linked PRs and issues could not be read.',
        });
    });

    it('keeps last-known-good rows on a failed refresh and says why they may be stale', () => {
        const view = projectTriageSessionLinkedEntries({
            query: state({
                status: 'error',
                failure: 'collection_unavailable',
                rows: [queryRow('link-a', 10)],
            }),
            hydration: hydration([
                ['link-a', { kind: 'ready', revision: 1, displayPath: 'example/repository#42', entryRef: ENTRY_REF }],
            ]),
        });

        if (view.kind !== 'linked') throw new Error(`Expected linked rows, saw ${view.kind}.`);
        expect(view.rows).toHaveLength(1);
        expect(view.notice).toBe('Linked PRs and issues are unavailable for this account right now.');
    });

    it('keeps every row the canonical pager has accumulated across pages', () => {
        const rows = Array.from(
            { length: MAX_TRIAGE_SESSION_LINKED_ENTRY_ROWS_V1 + 5 },
            (_unused, index) => queryRow(`link-${String(index).padStart(3, '0')}`, index),
        );

        const view = projectTriageSessionLinkedEntries({
            query: state({ rows }),
            hydration: hydration([]),
        });

        if (view.kind !== 'linked') throw new Error(`Expected linked rows, saw ${view.kind}.`);
        expect(view.rows).toHaveLength(MAX_TRIAGE_SESSION_LINKED_ENTRY_ROWS_V1 + 5);
        expect(view.more).toBe(false);
        expect(view.rows[0]?.key).toBe('link-054');
        expect(view.rows.at(-1)?.key).toBe('link-000');
    });

    it('reports more links when the pager still has a page, even inside the bound', () => {
        const view = projectTriageSessionLinkedEntries({
            query: state({ rows: [queryRow('link-a', 10)], hasMore: true }),
            hydration: hydration([]),
        });

        if (view.kind !== 'linked') throw new Error(`Expected linked rows, saw ${view.kind}.`);
        expect(view.more).toBe(true);
    });

    it('orders by the link clock and breaks ties on the host-stamped row id', () => {
        const view = projectTriageSessionLinkedEntries({
            query: state({
                rows: [queryRow('link-b', 5), queryRow('link-a', 5), queryRow('link-c', 9)],
            }),
            hydration: hydration([]),
        });

        if (view.kind !== 'linked') throw new Error(`Expected linked rows, saw ${view.kind}.`);
        expect(view.rows.map((row) => row.key)).toEqual(['link-c', 'link-a', 'link-b']);
    });

    it('keeps a link whose projected clock is missing or malformed', () => {
        const malformed: TriageSessionLinkQueryRowV1 = {
            rowId: 'link-a',
            revision: 1,
            fields: { [CORPUS_SESSION_LINKS_FIELD.linkedAtMs]: 'not-a-clock' },
        };

        const view = projectTriageSessionLinkedEntries({
            query: state({ rows: [malformed] }),
            hydration: hydration([]),
        });

        if (view.kind !== 'linked') throw new Error(`Expected linked rows, saw ${view.kind}.`);
        expect(view.rows).toEqual([
            { key: 'link-a', linkedAtMs: 0, presentation: { kind: 'reading' } },
        ]);
    });
});

describe('the hydration target set', () => {
    it('is exactly every accumulated row the projection renders', () => {
        const rows = Array.from(
            { length: MAX_TRIAGE_SESSION_LINKED_ENTRY_ROWS_V1 + 5 },
            (_unused, index) => queryRow(`link-${String(index).padStart(3, '0')}`, index),
        );

        const targets = triageSessionLinkHydrationTargets(state({ rows }));
        const view = projectTriageSessionLinkedEntries({
            query: state({ rows }),
            hydration: hydration([]),
        });

        if (view.kind !== 'linked') throw new Error(`Expected linked rows, saw ${view.kind}.`);
        expect(targets).toHaveLength(MAX_TRIAGE_SESSION_LINKED_ENTRY_ROWS_V1 + 5);
        expect(targets.map((row) => row.rowId)).toEqual(view.rows.map((row) => row.key));
    });
});
