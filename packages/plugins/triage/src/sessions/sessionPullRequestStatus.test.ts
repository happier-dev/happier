import { describe, expect, it } from 'vitest';
import type { ResourceContent } from '@happier-dev/plugin-sdk/ui';
import { ScmPullRequestSummaryProtocolSchema } from '@happier-dev/plugin-sdk/protocol';
import { TriageEntryRefV1Schema, TriagePullRequestStatusV1Schema, type TriagePullRequestStatusV1 } from '@happier-dev/triage-protocol/v1';
import { createTriageSourceV1Fixture } from '@happier-dev/triage-protocol/testing/v1';

import { TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1, selectTriageSessionPullRequestStatusV1, projectTriageSessionPullRequestCardsV1,
    type TriageSessionPullRequestBindingV1 } from './sessionPullRequestStatus.js';

const url = 'https://github.com/acme/widgets/pull/7';
function content(checkedAtMs: number, latestUpdate: unknown = null,
    fields: Readonly<{ entry?: TriageSessionPullRequestBindingV1['entry']; title?: string;
        nativeValue?: TriagePullRequestStatusV1; nativeStatus?: TriageSessionPullRequestBindingV1['nativeStatus'];
        link?: TriageSessionPullRequestBindingV1['link'] }> = {}): ResourceContent {
    return { contentType: 'application/json', digest: `check-${checkedAtMs}`, bytes: new TextEncoder().encode(JSON.stringify({
        kind: 'ready', sessionId: 'session-1', pullRequests: [{ bindingId: 'binding-1', revision: 1,
            link: fields.link ?? { provider: 'github', repository: 'acme/widgets', number: 7, url },
            watch: { policy: { mode: 'notify', archiveAfterMerge: false },
                reason: null, fixAttemptLimit: 3, roundsStarted: 0, watchingMachine: null }, latestUpdate,
            ...(fields.entry === undefined ? {} : { entry: fields.entry }),
            nativeStatus: fields.nativeStatus ?? { kind: 'current', checkedAtMs, value: fields.nativeValue ?? { kind: 'status', observedAtMs: 100,
                ...(fields.title === undefined ? {} : { title: fields.title }),
                checks: null, review: null, merge: null, branch: null, facts: [] } },
        }],
    })) };
}

function entryProof(): NonNullable<TriageSessionPullRequestBindingV1['entry']> {
    const fixture = createTriageSourceV1Fixture();
    return { entryRef: TriageEntryRefV1Schema.parse({ source: fixture.configuredInstance.instance.source,
        ...fixture.getInput.localRef }), sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId };
}

function populatedStatus(): TriagePullRequestStatusV1 {
    return TriagePullRequestStatusV1Schema.parse({ kind: 'status', observedAtMs: 100,
        checks: { state: 'complete', passed: 201, failed: 0, pending: 0, total: 201, incomplete: false,
            rows: Array.from({ length: 201 }, (_, index) => ({ id: `check:${index}`, name: `Check ${index}`, state: 'passed' })) },
        review: { decision: 'approved', incomplete: false,
            reviewers: [{ id: 'user:one', name: 'One', verb: 'approved' }, { id: 'user:two', name: 'Two', verb: 'pending' }] },
        merge: { state: 'mergeable', blocker: null }, branch: { head: 'topic', base: 'main', headRevision: 'sha-1' }, facts: [],
    });
}

describe('admitted Session PR status projection', () => {
    it('delivers source recovery changes while retaining equal recovery and untouched binding leaves', () => {
        const offer = { destination: { pluginId: 'example.source', localId: 'source-settings' },
            displayName: 'Example source', kindNames: ['Pull requests'] };
        const unavailable = { kind: 'unavailable' as const,
            failure: { class: 'unsupportedContract' as const, code: 'configuredSourceUnavailable' } };
        const withRecovery = { ...unavailable, recovery: { kind: 'configureSources' as const, offers: [offer] } };
        const first = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(200, null, { nativeStatus: withRecovery }), undefined);
        expect(first).toMatchObject({ pullRequests: [{ nativeStatus: withRecovery }] });
        expect(TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(200, null, { nativeStatus: withRecovery }), first)).toBe(first);
        const replacement = { ...withRecovery, recovery: { ...withRecovery.recovery,
            offers: [{ ...offer, destination: { ...offer.destination, localId: 'replacement-settings' } }] } };
        const changed = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(200, null, { nativeStatus: replacement }), first);
        if (changed.kind !== 'ready' || first.kind !== 'ready') throw new Error('Expected ready binding');
        expect(changed.pullRequests[0]?.nativeStatus).toEqual(replacement);
        expect(changed.pullRequests[0]?.link).toBe(first.pullRequests[0]?.link);
        expect(changed.pullRequests[0]?.watch).toBe(first.pullRequests[0]?.watch);
        const retired = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(200, null, { nativeStatus: unavailable }), changed);
        expect(retired).toMatchObject({ pullRequests: [{ nativeStatus: unavailable }] });
        expect(retired.kind === 'ready' && retired.pullRequests[0]?.nativeStatus).not.toHaveProperty('recovery');
    });

    it('retains 200 native check peers and other entities through encoded changed-row and reorder arrivals', () => {
        const entry = entryProof();
        const value = populatedStatus();
        const first = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(200, null, { entry, nativeValue: value }), undefined);
        if (first.kind !== 'ready' || first.pullRequests[0]?.nativeStatus.kind !== 'current') throw new Error('Expected current fixture');
        const before = first.pullRequests[0].nativeStatus.value;
        if (!value.checks || !before.checks) throw new Error('Expected checks fixture');
        const changed = { ...value, observedAtMs: 101, checks: { ...value.checks, passed: 200, failed: 1,
            rows: value.checks.rows.map((row, index) => index === 100 ? { ...row, state: 'failed' as const } : row).reverse() } };
        const next = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(9001, null, { entry, nativeValue: changed }), first);
        if (next.kind !== 'ready' || next.pullRequests[0]?.nativeStatus.kind !== 'current') throw new Error('Expected current result');
        const after = next.pullRequests[0].nativeStatus.value;
        const peers = new Map(before.checks.rows.map(row => [row.id, row]));
        expect(after.checks?.rows.filter(row => row !== peers.get(row.id))).toHaveLength(1);
        expect(after.checks?.rows.map(row => row.id)).toEqual(changed.checks.rows.map(row => row.id));
        expect(after.review).toBe(before.review);
        expect(after.review?.reviewers).toBe(before.review?.reviewers);
        expect(after.merge).toBe(before.merge);
        expect(after.branch).toBe(before.branch);
        expect(next.pullRequests[0].nativeStatus.checkedAtMs).toBe(9001);
        const equal = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(9002, null, {
            entry, nativeValue: { ...changed, observedAtMs: 102 },
        }), next);
        if (equal.kind !== 'ready' || equal.pullRequests[0]?.nativeStatus.kind !== 'current') throw new Error('Expected current result');
        expect(equal.pullRequests[0].nativeStatus.value).toBe(after);
        expect(equal.pullRequests[0].nativeStatus.checkedAtMs).toBe(9002);
        const metadata = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(9003, null, {
            entry, nativeValue: { ...changed, observedAtMs: 103 }, link: { ...next.pullRequests[0].link, state: 'closed' },
        }), equal);
        if (metadata.kind !== 'ready' || metadata.pullRequests[0]?.nativeStatus.kind !== 'current') throw new Error('Expected current result');
        expect(metadata.pullRequests[0].nativeStatus.value).toBe(after);
        expect(metadata.pullRequests[0].nativeStatus.checkedAtMs).toBe(9003);
        const stale = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(9003, null, {
            entry, link: metadata.pullRequests[0].link, nativeStatus: { kind: 'stale', checkedAtMs: 9003,
                value: { ...changed, observedAtMs: 104 }, failure: { class: 'transient', code: 'native_network_error' } },
        }), metadata);
        if (stale.kind !== 'ready' || stale.pullRequests[0]?.nativeStatus.kind !== 'stale') throw new Error('Expected stale result');
        expect(stale.pullRequests[0].nativeStatus.value).toBe(after);
        expect(stale.pullRequests[0].nativeStatus.value.checks?.rows[0]).toBe(after.checks?.rows[0]);
        expect(stale.pullRequests[0].nativeStatus.checkedAtMs).toBe(9003);
        expect(stale.pullRequests[0].nativeStatus.failure).toEqual({ class: 'transient', code: 'native_network_error' });
        const recovered = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(9004, null, {
            entry, link: metadata.pullRequests[0].link, nativeValue: { ...changed, observedAtMs: 105 },
        }), stale);
        if (recovered.kind !== 'ready' || recovered.pullRequests[0]?.nativeStatus.kind !== 'current') throw new Error('Expected recovered result');
        expect(recovered.pullRequests[0].nativeStatus.value).toBe(after);
        expect(recovered.pullRequests[0].nativeStatus.checkedAtMs).toBe(9004);
        expect(Object.hasOwn(recovered.pullRequests[0].nativeStatus, 'failure')).toBe(false);
    });

    it('retires native identities for changed source proof, PR identity, head and unavailable authority', () => {
        const entry = entryProof();
        const value = populatedStatus();
        const first = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(200, null, { entry, nativeValue: value }), undefined);
        if (first.kind !== 'ready' || first.pullRequests[0]?.nativeStatus.kind !== 'current') throw new Error('Expected current fixture');
        const before = first.pullRequests[0].nativeStatus.value;
        const arrivals = [
            content(200, null, { entry: { ...entry, sourceInstanceId: '0f1c9c4e-8c1f-4a53-9c2a-4c9a7b1d3e05' }, nativeValue: value }),
            content(200, null, { entry, nativeValue: value, link: { ...first.pullRequests[0].link, number: 8, url: 'https://github.com/acme/widgets/pull/8' } }),
            content(200, null, { entry, nativeValue: { ...value, branch: { ...value.branch!, headRevision: 'sha-2' } } }),
            content(200, null, { nativeValue: value }),
        ];
        for (const arrival of arrivals) {
            const next = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(arrival, first);
            if (next.kind !== 'ready' || next.pullRequests[0]?.nativeStatus.kind !== 'current') throw new Error('Expected current result');
            expect(next.pullRequests[0].nativeStatus).not.toBe(first.pullRequests[0].nativeStatus);
            expect(next.pullRequests[0].nativeStatus.value.checks?.rows[0]).not.toBe(before.checks?.rows[0]);
            expect(next.pullRequests[0].nativeStatus.value.review).not.toBe(before.review);
        }
        const unavailable = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(200, null, { entry,
            nativeStatus: { kind: 'unavailable', failure: { class: 'permission', code: 'sourceAuthorityChanged' } },
        }), first);
        const replacement = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(200, null, { entry, nativeValue: value }), unavailable);
        if (replacement.kind !== 'ready' || replacement.pullRequests[0]?.nativeStatus.kind !== 'current') throw new Error('Expected current result');
        expect(replacement.pullRequests[0].nativeStatus.value.checks?.rows[0]).not.toBe(before.checks?.rows[0]);
    });

    it('publishes canonical entry proof changes independently of equal metadata and native facts', () => {
        const fixture = createTriageSourceV1Fixture();
        const entry = { entryRef: TriageEntryRefV1Schema.parse({ source: fixture.configuredInstance.instance.source,
            ...fixture.getInput.localRef }), sourceInstanceId: fixture.configuredInstance.instance.sourceInstanceId };
        const first = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(200), undefined);
        const added = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(200, null, { entry }), first);
        if (first.kind !== 'ready' || added.kind !== 'ready') throw new Error('Expected admitted bindings');
        expect(added.pullRequests[0]?.entry).toEqual(entry);
        expect(added.pullRequests[0]?.nativeStatus).not.toBe(first.pullRequests[0]?.nativeStatus);
        expect(added.pullRequests[0]?.link).toBe(first.pullRequests[0]?.link);
        expect(added.pullRequests[0]?.watch).toBe(first.pullRequests[0]?.watch);
        const same = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(200, null, { entry }), added);
        expect(same).toBe(added);
        const replacement = { ...entry, entryRef: TriageEntryRefV1Schema.parse({ ...entry.entryRef, entryId: 'other-entry' }) };
        const changed = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(200, null, { entry: replacement }), added);
        if (changed.kind !== 'ready') throw new Error('Expected admitted bindings');
        expect(changed.pullRequests[0]?.entry).toEqual(replacement);
        const removed = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(200), changed);
        if (removed.kind !== 'ready') throw new Error('Expected admitted bindings');
        expect(Object.hasOwn(removed.pullRequests[0]!, 'entry')).toBe(false);
    });

    it('delivers the optional native title through the admitted bound-card projection without a fallback', () => {
        const value = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(200, null, { title: 'Observed PR title' }), undefined);
        const binding = selectTriageSessionPullRequestStatusV1(value, 'session-1', url);
        expect(binding?.nativeStatus).toMatchObject({ kind: 'current', value: { title: 'Observed PR title' } });
        const unknown = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(200), undefined);
        const before = selectTriageSessionPullRequestStatusV1(unknown, 'session-1', url)?.nativeStatus;
        if (before?.kind !== 'current') throw new Error('Expected current fixture');
        expect(Object.hasOwn(before.value, 'title')).toBe(false);
    });

    it('preserves native and metadata leaves while a successful check advances independently', () => {
        const first = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(200), undefined);
        const next = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(300), first);
        if (first.kind !== 'ready' || next.kind !== 'ready') throw new Error('Expected admitted bindings');
        expect(next.pullRequests[0]!.link).toBe(first.pullRequests[0]!.link);
        expect(next.pullRequests[0]!.watch).toBe(first.pullRequests[0]!.watch);
        const before = first.pullRequests[0]!.nativeStatus;
        const after = next.pullRequests[0]!.nativeStatus;
        if (before.kind !== 'current' || after.kind !== 'current') throw new Error('Expected current status');
        expect(after.value).toBe(before.value);
        expect(after.checkedAtMs).toBe(300);
        expect(after.value.observedAtMs).toBe(100);
    });

    it('selects only the exact mounted Session and canonical linked URL', () => {
        const value = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(200), undefined);
        expect(selectTriageSessionPullRequestStatusV1(value, 'session-1', url)?.bindingId).toBe('binding-1');
        expect(selectTriageSessionPullRequestStatusV1(value, 'session-2', url)).toBeNull();
        expect(selectTriageSessionPullRequestStatusV1(value, 'session-1', 'acme/widgets#7')).toBeNull();
        expect(selectTriageSessionPullRequestStatusV1(value, 'session-1', 'https://github.com/acme/widgets/pull/8')).toBeNull();
    });

    it('treats an unmatched branch snapshot as a hint rather than substituting another bound PR', () => {
        const value = TRIAGE_SESSION_PULL_REQUEST_STATUS_PROJECTION_V1.decode(content(200), undefined);
        const snapshot = ScmPullRequestSummaryProtocolSchema.parse({
            provider: { id: 'github', kind: 'github', displayName: 'GitHub', baseUrl: 'https://github.com', nameWithOwner: 'acme/widgets' },
            number: 8, url: 'https://github.com/acme/widgets/pull/8', title: 'Same branch, different PR',
            baseBranch: 'main', headBranch: 'topic', state: 'open', checks: { state: 'pending' },
        });
        expect(projectTriageSessionPullRequestCardsV1(snapshot, 'session-1', value)).toMatchObject([
            { kind: 'bound', binding: { bindingId: 'binding-1' } }, { kind: 'branchHint', pullRequest: snapshot },
        ]);
        const exact = { ...snapshot, number: 7, url };
        expect(projectTriageSessionPullRequestCardsV1(exact, 'session-1', value)).toMatchObject([{ kind: 'bound', binding: { bindingId: 'binding-1' } }]);
        expect(projectTriageSessionPullRequestCardsV1(exact, null, value)).toEqual([{ kind: 'branchHint', pullRequest: exact }]);
    });
});
