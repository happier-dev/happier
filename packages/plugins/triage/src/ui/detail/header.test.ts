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
import { projectTriageDetailHeaderV1, readTriageDetailAttentionBadgeV1, readTriageDetailContextLineV1 } from './header.js';

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
        expect(projected.attention).toEqual({ level: 'required', reasonLabel: 'Review requested', icon: 'review', danger: false, reviewRequested: true });
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

    it('leaves a pull request\'s branch pair to the story\'s What changed, beside its diff', () => {
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
 * A change request's glance cells (status, checks, review), read through the one PR facts owner.
 *
 * The failures this guards: an issue drawing a pull request's cells (a linked fix PR is drawn once, in its own step),
 * cells that appear only once the status read lands (pushing the actions down), and the reader's own requested review
 * said twice, as a cell and as a badge.
 */
describe('the change request cells', () => {
    function status(overrides: Partial<TriagePullRequestStatusV1> = {}): TriagePullRequestStatusV1 {
        return {
            kind: 'status', observedAtMs: 1_000, facts: [],
            checks: { state: 'complete', passed: 5, failed: 0, pending: 0, total: 7, rows: [], incomplete: false },
            review: { decision: 'changesRequested', incomplete: false, reviewers: [
                { id: 'u1', name: 'Mika Tanaka', verb: 'approved' },
                { id: 'u2', name: 'Sam Okafor', verb: 'changesRequested' },
            ] },
            merge: null,
            branch: { head: 'leeroy/server-rounding', base: 'main', additions: 28, deletions: 3 },
            ...overrides,
        };
    }

    const REVIEW_REQUESTED = { level: 'required', fromSourceInstanceId: INSTANCE, reasonId: 'involvement/review-requested', reasonLabel: 'Review requested' } as const;

    const project = (input: Readonly<{ kindId?: string; pullRequestStatus?: TriagePullRequestStatusV1 | null;
        presentation?: 'active' | 'resolved' | 'closed'; attention?: TriageListRowV1['attention'] }>) => {
        const base = row();
        const outcome = testkitPresentOutcome({
            locator: testkitLocator(),
            snapshot: testkitSnapshot({ title: 'Fix the parser',
                state: { presentation: input.presentation ?? 'active', nativeLabel: input.presentation === 'resolved' ? 'Merged' : 'Open' } }),
            viewer: testkitViewer(),
        });
        return projectTriageDetailHeaderV1({
            row: { ...base, entryRef: { ...base.entryRef, kindId: input.kindId ?? 'pull-request' },
                content: { sourceInstanceId: INSTANCE, observedAtMs: 1_000, outcome },
                observations: [{ sourceInstanceId: INSTANCE, observedAtMs: 1_000, outcome }],
                attention: input.attention ?? null },
            lanes: [HEALTHY_LANE], connectionLabel: null, sourceDescriptor: DESCRIPTOR,
            linkedSessions: [], linkedSessionsHasMore: false,
            ...(input.pullRequestStatus === undefined ? {} : { pullRequestStatus: input.pullRequestStatus }),
        });
    };

    it('draws no cells for an issue, even when a status is offered beside it (a linked fix PR)', () => {
        expect(project({ kindId: 'issue' }).pullRequestFacts).toBeNull();
        expect(project({ kindId: 'issue', pullRequestStatus: status() }).pullRequestFacts).toBeNull();
    });

    it('holds a pull request\'s cells from first paint, unknown until its status read lands', () => {
        expect(project({}).pullRequestFacts).toEqual({ branch: null, checks: { kind: 'unknown' }, review: { kind: 'unknown' }, merge: { kind: 'unknown' } });
    });

    it('fills them from the PR facts owner once the status read lands', () => {
        const facts = project({ pullRequestStatus: status() }).pullRequestFacts;
        expect(facts?.checks).toEqual({ kind: 'passed', count: 5, cancelled: 0 });
        expect(facts?.review).toEqual({ kind: 'changesRequested', people: ['Sam Okafor'] });
    });

    it('says a merged pull request is merged, from its own lifecycle', () => {
        expect(project({ presentation: 'resolved', pullRequestStatus: status() }).pullRequestFacts?.merge).toEqual({ kind: 'merged' });
    });

    it('lets the Reviewers cell say the reader\'s own requested review, so the badge does not say it again', () => {
        expect(readTriageDetailAttentionBadgeV1(project({ attention: REVIEW_REQUESTED }))).toBeNull();
        // An issue has no Reviewers cell: its badge stays.
        expect(readTriageDetailAttentionBadgeV1(project({ kindId: 'issue', attention: REVIEW_REQUESTED }))?.reasonLabel).toBe('Review requested');
    });
});
