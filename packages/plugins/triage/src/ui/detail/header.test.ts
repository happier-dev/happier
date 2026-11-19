import { describe, expect, it } from 'vitest';

import {
    TriageSourceDescriptorV1Schema,
    type TriageSourceDescriptorV1,
} from '@happier-dev/triage-protocol/v1';

import { CORPUS_LANE } from '../../corpus/fold/lane.js';
import {
    testkitLocator,
    testkitPresentOutcome,
    testkitSnapshot,
    testkitViewer,
} from '../../corpus/testkit/observations.test-support.js';
import type { TriagePullRequestStatusV1 } from '@happier-dev/triage-protocol/v1';

import type { TriageListLaneV1, TriageListRowV1 } from '../../projection/listWindow.js';
import { projectTriageDetailHeaderV1, readTriageDetailContextLineV1 } from './header.js';

/**
 * The common header's own boundary.
 *
 * Its failure mode is a sentence: this projection decides what the detail pane
 * says about the connection the entry is being read through, and the reader has
 * no way to check it. So the discriminating case is a connection **no pass
 * asked** — which the surface once reported as one that did not answer.
 */

const SOURCE = { pluginId: 'happier.forge', localId: 'items' } as const;
const INSTANCE = '11111111-1111-4111-8111-111111111111';

function row(): TriageListRowV1 {
    const outcome = testkitPresentOutcome({
        locator: testkitLocator(),
        snapshot: testkitSnapshot({ title: 'Fix the parser' }),
        viewer: testkitViewer(),
    });
    return {
        entryRef: { source: SOURCE, kindId: 'pull-request', collisionScope: 'origin', entryId: '42' },
        content: { sourceInstanceId: INSTANCE, observedAtMs: 1_000, outcome },
        lane: CORPUS_LANE.open,
        sortAtMs: 1_000,
        presence: { kind: 'present' },
        attention: null,
        selected: { kind: 'selected', sourceInstanceId: INSTANCE, reason: 'onlyPresent' },
        observations: [{ sourceInstanceId: INSTANCE, observedAtMs: 1_000, outcome }],
    };
}

const DESCRIPTOR: TriageSourceDescriptorV1 = TriageSourceDescriptorV1Schema.parse({
    v: 1,
    purpose: 'triage-source',
    displayName: 'Example forge',
    kinds: [
        { id: 'issue', workflowSubject: 'issue', displayName: 'Issue' },
        { id: 'pull-request', workflowSubject: 'pullRequest', displayName: 'Pull request' },
    ],
});

function header(
    lane: TriageListLaneV1,
    sourceDescriptor: TriageSourceDescriptorV1 | null = null,
) {
    return projectTriageDetailHeaderV1({
        row: row(),
        lanes: [lane],
        connectionLabel: 'acme/widgets',
        sourceDescriptor,
        linkedSessions: [],
        linkedSessionsHasMore: false,
    });
}

const HEALTHY_LANE: TriageListLaneV1 = {
    sourceInstanceId: INSTANCE,
    source: SOURCE,
    health: { kind: 'unavailable' },
    exhausted: false,
};

describe('projectTriageDetailHeaderV1', () => {
    it('never repeats the title as the address: a task addressed by its own title falls back to its scope', () => {
        const outcome = testkitPresentOutcome({
            locator: testkitLocator({ displayPath: 'Write the release notes' }),
            snapshot: testkitSnapshot({ title: 'Write the release notes', scopeLabel: 'Personal tasks' }),
            viewer: testkitViewer(),
        });
        const projected = projectTriageDetailHeaderV1({
            row: { ...row(), content: { sourceInstanceId: INSTANCE, observedAtMs: 1_000, outcome },
                observations: [{ sourceInstanceId: INSTANCE, observedAtMs: 1_000, outcome }] },
            lanes: [HEALTHY_LANE], connectionLabel: null, sourceDescriptor: DESCRIPTOR,
            linkedSessions: [], linkedSessionsHasMore: false,
        });
        expect(projected.title).toBe('Write the release notes');
        expect(projected.addressLabel).toBe('Personal tasks');
        // An ordinary provider path still leads.
        expect(header(HEALTHY_LANE).addressLabel).toBe('example/repository #17');
    });

    it('gives the attention chip the same mark as its row chip', () => {
        const projected = projectTriageDetailHeaderV1({
            row: { ...row(), attention: { level: 'required', fromSourceInstanceId: INSTANCE, reasonId: 'involvement/review-requested', reasonLabel: 'Review requested' } },
            lanes: [HEALTHY_LANE],
            connectionLabel: null,
            sourceDescriptor: DESCRIPTOR,
            linkedSessions: [],
            linkedSessionsHasMore: false,
        });
        expect(projected.attention).toEqual({ level: 'required', reasonLabel: 'Review requested', icon: 'review', danger: false });
    });

    it('names the source and this entry\'s kind in the source\'s own words', () => {
        // The row's `kindId` is `pull-request`, and the descriptor declares
        // `issue` first. A projection that took the declared order — or the
        // first kind — would call a pull request an Issue.
        const named = header(HEALTHY_LANE, DESCRIPTOR);

        expect(named.sourceLabel).toBe('Example forge');
        expect(named.kindLabel).toBe('Pull request');
    });

    it('says nothing about a kind the source never declared', () => {
        // The `kindId` is a routing token the source chose. Falling back to it
        // would print an internal identifier as the source's own word for the
        // thing, which is worse than saying nothing.
        const undeclared = header(HEALTHY_LANE, TriageSourceDescriptorV1Schema.parse({
            v: 1,
            purpose: 'triage-source',
            displayName: 'Example forge',
            kinds: [{ id: 'issue', workflowSubject: 'issue', displayName: 'Issue' }],
        }));

        expect(undeclared.sourceLabel).toBe('Example forge');
        expect(undeclared.kindLabel).toBeNull();
    });

    it('splits the entry\'s address into where it lives and its own number, for the breadcrumb', () => {
        const projected = (snapshot: Parameters<typeof testkitSnapshot>[0]) => {
            const outcome = testkitPresentOutcome({ locator: testkitLocator(), snapshot: testkitSnapshot(snapshot), viewer: testkitViewer() });
            return projectTriageDetailHeaderV1({
                row: { ...row(), content: { sourceInstanceId: INSTANCE, observedAtMs: 1_000, outcome },
                    observations: [{ sourceInstanceId: INSTANCE, observedAtMs: 1_000, outcome }] },
                lanes: [HEALTHY_LANE], connectionLabel: null, sourceDescriptor: DESCRIPTOR,
                linkedSessions: [], linkedSessionsHasMore: false,
            }).breadcrumb;
        };
        // The source's own scope and designation, never a split of the display path.
        expect(projected({ title: 'Fix the parser', scopeLabel: 'tidewater/checkout-web', designation: '#2476' }))
            .toEqual(['tidewater/checkout-web', '#2476']);
        // A kind with no designation still says where it lives.
        expect(projected({ title: 'Write the release notes', scopeLabel: 'Personal tasks' })).toEqual(['Personal tasks']);
    });

    it('carries neither name while no admitted contribution has answered', () => {
        expect(header(HEALTHY_LANE).sourceLabel).toBeNull();
        expect(header(HEALTHY_LANE).kindLabel).toBeNull();
    });
});

describe('the detail header line (lab meta: where the entry lives, then who opened it)', () => {
    const CREATED = 1_760_000_000_000;
    const NOW = CREATED + 42 * 60_000;
    const english = (_key: string, fallback = '', values: Readonly<Record<string, string>> = {}) =>
        fallback.replace(/\{(\w+)\}/gu, (_match, name: string) => values[name] ?? '');
    const OTHER = '22222222-2222-4222-8222-222222222222';

    function observed(viewer = testkitViewer(), authorLabel: string | null = 'Mara Oduya') {
        return testkitPresentOutcome({
            locator: testkitLocator(),
            snapshot: testkitSnapshot({ title: 'Fix the parser', createdAtMs: CREATED, ...(authorLabel === null ? {} : { authorLabel }) }),
            viewer,
        });
    }

    const lane = (sourceInstanceId: string): TriageListLaneV1 => ({
        sourceInstanceId, source: SOURCE, health: { kind: 'unavailable' }, exhausted: false,
    });

    function lineFor(input: Readonly<{ outcome?: ReturnType<typeof observed>; second?: boolean; secondConfigured?: boolean }>) {
        const outcome = input.outcome ?? observed();
        const base = row();
        const entry: TriageListRowV1 = {
            ...base,
            content: { sourceInstanceId: INSTANCE, observedAtMs: 1_000, outcome },
            observations: [
                { sourceInstanceId: INSTANCE, observedAtMs: 1_000, outcome },
                ...(input.second === true ? [{ sourceInstanceId: OTHER, observedAtMs: 1_000, outcome }] : []),
            ],
        };
        const projected = projectTriageDetailHeaderV1({
            row: entry,
            lanes: [lane(INSTANCE), ...(input.second === true || input.secondConfigured === true ? [lane(OTHER)] : [])],
            connectionLabel: 'Example account',
            sourceDescriptor: DESCRIPTOR,
            linkedSessions: [],
            linkedSessionsHasMore: false,
            text: english,
        });
        return readTriageDetailContextLineV1(projected, english, { locale: 'en', nowMs: NOW });
    }

    it('names the entry\'s address and who opened it when, without the source name or the state word', () => {
        expect(lineFor({})).toBe('example/repository #17 · Mara Oduya opened 42 minutes ago');
    });

    it('leaves a pull request\'s branch pair to the facts row, where its diff size stands beside it', () => {
        const outcome = testkitPresentOutcome({
            locator: testkitLocator(),
            snapshot: testkitSnapshot({ title: 'Fix the parser', createdAtMs: CREATED, authorLabel: 'Mara Oduya',
                branches: { head: 'leeroy/server-rounding', base: 'main' } }),
            viewer: testkitViewer(),
        });
        expect(lineFor({ outcome })).not.toContain('leeroy/server-rounding');
    });

    it('says "You" when the reader opened it, through the row display\'s one rule', () => {
        expect(lineFor({ outcome: observed(testkitViewer({ involvement: ['author'] })) }))
            .toBe('example/repository #17 · You opened 42 minutes ago');
    });

    it('says when it was opened without inventing who, when the source names nobody', () => {
        expect(lineFor({ outcome: observed(testkitViewer(), null) }))
            .toBe('example/repository #17 · Opened 42 minutes ago');
    });

    it('names the connection only when the reader has more than one connection to this source', () => {
        expect(lineFor({ second: true }))
            .toBe('example/repository #17 · Mara Oduya opened 42 minutes ago · via Example account');
        // A second configured connection that does not observe the entry still makes the choice real: a launch can
        // name it, and the header must say which one this detail is read through.
        expect(lineFor({ secondConfigured: true }))
            .toBe('example/repository #17 · Mara Oduya opened 42 minutes ago · via Example account');
    });
});

/**
 * The change request's facts the header reads at a glance: its diff size, one checks outcome and who reviewed it.
 *
 * Each comes from the source's own live status read, so the failure this guards is the header inventing a fact the
 * source never stated (a zero diff, "no checks") or showing a stale shape for a source that states nothing.
 */
describe('the change request facts (diff size, checks outcome, reviewers)', () => {
    function status(overrides: Partial<TriagePullRequestStatusV1> = {}): TriagePullRequestStatusV1 {
        return {
            kind: 'status', observedAtMs: 1_000, facts: [],
            checks: { state: 'complete', passed: 5, failed: 0, pending: 0, total: 7, rows: [], incomplete: false },
            review: { decision: 'changesRequested', incomplete: false, reviewers: [
                { id: 'u1', name: 'Mika Tanaka', verb: 'approved' },
                { id: 'u2', name: 'Sam Okafor', verb: 'changesRequested' },
                { id: 'u3', name: 'Ada Brook', verb: 'pending' },
                { id: 'u4', name: 'Old Reviewer', verb: 'dismissed' },
            ] },
            merge: null,
            branch: { head: 'leeroy/server-rounding', base: 'main', additions: 28, deletions: 3 },
            ...overrides,
        };
    }

    const facts = (pullRequestStatus: TriagePullRequestStatusV1 | null | undefined) => projectTriageDetailHeaderV1({
        row: row(), lanes: [HEALTHY_LANE], connectionLabel: null, sourceDescriptor: DESCRIPTOR,
        linkedSessions: [], linkedSessionsHasMore: false,
        ...(pullRequestStatus === undefined ? {} : { pullRequestStatus }),
    }).changeFacts;

    it('states nothing for a source that reads no change-request status (an issue, an error group)', () => {
        expect(facts(undefined)).toBeNull();
        expect(facts(null)).toBeNull();
    });

    it('carries the diff size the source counted, and none when it did not count it', () => {
        expect(facts(status())?.diff).toEqual({ additions: 28, deletions: 3 });
        expect(facts(status({ branch: { head: 'a', base: 'b' } }))?.diff).toBeNull();
        expect(facts(status({ branch: null }))?.diff).toBeNull();
    });

    it('carries one checks rollup from the source\'s counts, never a verdict over checks nobody read', () => {
        expect(facts(status())?.checks).toEqual({ failingCount: 0, runningCount: 0, passingCount: 5 });
        expect(facts(status({ checks: { state: 'incomplete', passed: null, failed: 2, pending: 1, total: null, rows: [], incomplete: true } }))?.checks)
            .toEqual({ incomplete: true, failingCount: 2, runningCount: 1 });
        // No checks configured, or counts the source could not establish: nothing to say.
        expect(facts(status({ checks: { state: 'none', passed: 0, failed: 0, pending: 0, total: 0, rows: [], incomplete: false } }))?.checks).toBeNull();
        expect(facts(status({ checks: { state: 'complete', passed: null, failed: null, pending: null, total: null, rows: [], incomplete: false } }))?.checks).toBeNull();
        expect(facts(status({ checks: null }))?.checks).toBeNull();
    });

    it('groups reviewers by where their review stands, most consequential first, leaving dismissed reviews out', () => {
        expect(facts(status())?.reviewers).toEqual([
            { verb: 'changesRequested', names: ['Sam Okafor'] },
            { verb: 'approved', names: ['Mika Tanaka'] },
            { verb: 'pending', names: ['Ada Brook'] },
        ]);
        expect(facts(status({ review: null }))?.reviewers).toEqual([]);
    });

    it('names the branch pair from the status read when the entry\'s own snapshot did not carry it', () => {
        const projected = (pullRequestStatus: TriagePullRequestStatusV1 | null) => projectTriageDetailHeaderV1({
            row: row(), lanes: [HEALTHY_LANE], connectionLabel: null, sourceDescriptor: DESCRIPTOR,
            linkedSessions: [], linkedSessionsHasMore: false, pullRequestStatus,
        }).branches;
        expect(projected(status())).toEqual({ head: 'leeroy/server-rounding', base: 'main' });
        expect(projected(status({ branch: { head: 'leeroy/server-rounding' } }))).toBeNull();
        expect(projected(null)).toBeNull();
    });

    it('states nothing when the status read carries none of the three facts', () => {
        expect(facts(status({ checks: null, review: null, branch: null }))).toBeNull();
    });
});
