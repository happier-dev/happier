import { describe, expect, it } from 'vitest';

import {
    MAX_TRIAGE_LOCATION_UTF8_BYTES_V1,
    reconcileTriagePullRequestStatusV1 as reconcile,
    TriagePullRequestStatusV1Schema,
    TriagePullRequestStatusResultV1Schema,
    type TriagePullRequestStatusV1,
} from './index.js';

function status(observedAtMs = 1, configure?: (input: TriagePullRequestStatusV1) => void): TriagePullRequestStatusV1 {
    const input: TriagePullRequestStatusV1 = {
        kind: 'status', observedAtMs,
        checks: {
            state: 'complete', passed: 201, failed: 0, pending: 0, total: 201, incomplete: false,
            rows: Array.from({ length: 201 }, (_, id) => ({ id: `check:${id}`, name: `Check ${id}`, state: 'passed', required: id !== 0 })),
        },
        review: { decision: 'approved', incomplete: false, reviewers: [{ id: 'user:alice', name: 'Alice', verb: 'approved' }, { id: 'team:maintainers', name: 'Maintainers', verb: 'pending' }] },
        merge: {
            state: 'blocked', blocker: 'Queued', draft: false, nativeState: 'BLOCKED', queueRequired: true,
            queue: { id: 'entry:1', state: 'QUEUED', position: 1, estimatedTimeToMergeSeconds: 30 },
            autoMerge: { enabled: true, method: 'squash' }, canMergeWithoutWaiting: true,
            nodeId: 'PR_1', viewerCanUpdate: true, viewerCanEnableAutoMerge: true, viewerCanDisableAutoMerge: true,
            branchRules: { state: 'complete', rows: [{ type: 'merge_queue', rulesetId: '7' }] }, upToDateRequired: null,
        },
        branch: { head: 'feature', base: 'main', headRevision: 'sha-1' },
        facts: [{ id: 'updated', importance: 'primary', value: { kind: 'timestamp', atMs: 100, format: 'relative' } }],
    };
    // Vary the provider fixture before admission; admitted values are frozen.
    configure?.(input);
    return TriagePullRequestStatusV1Schema.parse(input);
}

describe('pull-request status admission and reconciliation', () => {
    it('admits native thread resolution and conflict evidence without hiding identity or unknown coverage', () => {
        const base = status();
        const evidence = { ...base, review: { ...base.review!, threads: { rows: [
            { id: 'thread:1', isResolved: false }, { id: 'thread:2', isResolved: true },
        ], incomplete: false } }, merge: { ...base.merge!, conflicts: false } };
        const previous = TriagePullRequestStatusV1Schema.parse(evidence);
        const equal = reconcile(previous, TriagePullRequestStatusV1Schema.parse({ ...evidence, observedAtMs: 2 }));
        expect(equal.value).toBe(previous);
        const next = reconcile(previous, TriagePullRequestStatusV1Schema.parse({ ...evidence,
            review: { ...evidence.review, threads: { ...evidence.review.threads, rows: [
                { id: 'thread:1', isResolved: true }, evidence.review.threads.rows[1],
            ] } },
        })).value;
        expect(next.review).not.toBe(previous.review);
        expect(next.checks).toBe(previous.checks);
        expect(next.review!.threads!.rows[1]).toBe(previous.review!.threads!.rows[1]);
        expect(TriagePullRequestStatusV1Schema.safeParse({ ...evidence, review: { ...evidence.review,
            threads: { rows: [{ id: 'thread:1', isResolved: null }], incomplete: false },
        } }).success).toBe(false);
        expect(TriagePullRequestStatusV1Schema.parse({ ...evidence, merge: { ...evidence.merge, conflicts: null } }))
            .toMatchObject({ merge: { conflicts: null } });
    });

    it('admits an observed branch head independently of unavailable display labels', () => {
        const value = status();
        for (const branch of [{ headRevision: 'sha-2' }, { headRevision: 'sha-2', base: 'main' }]) {
            const admitted = TriagePullRequestStatusResultV1Schema.parse({ ...value, branch });
            expect(admitted).toMatchObject({ kind: 'status', branch });
            if (admitted.kind !== 'status') throw new Error('expected admitted status');
            expect(admitted.branch).not.toHaveProperty('head');
        }
        expect(TriagePullRequestStatusV1Schema.safeParse({ ...value,
            branch: { headRevision: 'sha-2', head: 1 },
        }).success).toBe(false);
    });

    it('retains portable original Action offers as semantic source-owned data', () => {
        const base = status();
        const operations = { readiness: 'blocked', unmetRequirements: [], primary: {
            id: 'merge', title: 'Merge', titleKey: 'plugins.example.merge', disabledReason: 'Required check pending',
            actionRef: { pluginId: 'example.forge', localId: 'merge' },
            variants: [{ id: 'merge', method: { title: 'Merge' }, input: { expectedHeadSha: 'sha-1', mergeMethod: 'merge' } },
                { id: 'squash', method: { title: 'Squash and merge' }, input: { expectedHeadSha: 'sha-1', mergeMethod: 'squash' } }],
        }, alternatives: [] };
        const admitted = TriagePullRequestStatusV1Schema.parse({ ...base, operations });
        expect(admitted).toMatchObject({ operations });
        expect(reconcile(admitted, TriagePullRequestStatusV1Schema.parse({ ...base, operations, observedAtMs: 2 })).value).toBe(admitted);
        const changed = reconcile(admitted, TriagePullRequestStatusV1Schema.parse({ ...base, operations: { ...operations,
            primary: { ...operations.primary, variants: [{ ...operations.primary.variants[0]!, input: { expectedHeadSha: 'sha-2' } }] },
        } })).value;
        expect(changed).not.toBe(admitted);
        expect(changed.checks).toBe(admitted.checks);
        const removed = reconcile(admitted, TriagePullRequestStatusV1Schema.parse({ ...base, operations: { ...operations,
            primary: { ...operations.primary, variants: [operations.primary.variants[1]!] },
        } })).value;
        expect(removed.operations!.primary.variants[0]).toBe(admitted.operations!.primary.variants[1]);
        expect(TriagePullRequestStatusV1Schema.safeParse({ ...base, operations: { ...operations,
            primary: { ...operations.primary, actionRef: { pluginId: 'example.forge', localId: '' } },
        } }).success).toBe(false);
    });

    it('retains bounded provider destinations and publishes only changed URL facts', () => {
        const previous = status();
        const sourceUrl = 'https://github.com/example/project/pull/7';
        const detailsUrl = 'https://ci.example.com/runs/71';
        const input = { ...previous, sourceUrl, checks: { ...previous.checks!, rows: [
            { ...previous.checks!.rows[0]!, detailsUrl }, ...previous.checks!.rows.slice(1),
        ] } };
        const admitted = TriagePullRequestStatusV1Schema.parse(input);
        expect(admitted).toMatchObject({ sourceUrl, checks: { rows: [
            { detailsUrl }, ...previous.checks!.rows.slice(1),
        ] } });
        expect(Object.hasOwn(previous, 'sourceUrl')).toBe(false);
        expect(Object.hasOwn(previous.checks!.rows[0]!, 'detailsUrl')).toBe(false);
        expect(reconcile(admitted, TriagePullRequestStatusV1Schema.parse({ ...input, observedAtMs: 2 })).value).toBe(admitted);
        const changed = reconcile(admitted, TriagePullRequestStatusV1Schema.parse({ ...input,
            checks: { ...input.checks, rows: [{ ...input.checks.rows[0]!, detailsUrl: `${detailsUrl}/next` },
                ...input.checks.rows.slice(1)] },
        })).value;
        expect(changed.checks!.rows[0]).not.toBe(admitted.checks!.rows[0]);
        expect(changed.checks!.rows[1]).toBe(admitted.checks!.rows[1]);
        expect(changed.merge).toBe(admitted.merge);
        const sourceChanged = reconcile(admitted, TriagePullRequestStatusV1Schema.parse({ ...input,
            sourceUrl: `${sourceUrl}?view=checks`,
        })).value;
        expect(sourceChanged).not.toBe(admitted);
        expect(sourceChanged.sourceUrl).toBe(`${sourceUrl}?view=checks`);
        expect(sourceChanged.checks).toBe(admitted.checks);
        for (const value of [null, '', 'x'.repeat(MAX_TRIAGE_LOCATION_UTF8_BYTES_V1 + 1)]) {
            expect(TriagePullRequestStatusV1Schema.safeParse({ ...input, sourceUrl: value }).success).toBe(false);
            expect(TriagePullRequestStatusV1Schema.safeParse({ ...input, checks: { ...input.checks,
                rows: [{ ...input.checks.rows[0]!, detailsUrl: value }],
            } }).success).toBe(false);
        }
    });

    it('admits an observed title without inventing one for older or unknown status', () => {
        const previous = status();
        expect(Object.hasOwn(previous, 'title')).toBe(false);
        const next = TriagePullRequestStatusV1Schema.parse({ ...previous, title: 'Keep the observed PR title' });
        expect(next.title).toBe('Keep the observed PR title');
        expect(TriagePullRequestStatusV1Schema.safeParse({ ...previous, title: null }).success).toBe(false);
        expect(TriagePullRequestStatusV1Schema.safeParse({ ...previous, title: '' }).success).toBe(false);
        const renamed = TriagePullRequestStatusV1Schema.parse({ ...next, title: 'The PR was renamed', observedAtMs: 2 });
        const changed = reconcile(next, renamed);
        expect(changed.value.title).toBe('The PR was renamed');
        expect(changed.value.checks).toBe(next.checks);
        expect(changed.checkedAtMs).toBe(2);
        expect(reconcile(renamed, TriagePullRequestStatusV1Schema.parse({ ...renamed, observedAtMs: 3 })).value).toBe(renamed);
    });

    it('admits provider evidence in the closed result and rejects unknown native members', () => {
        const admitted = status();
        expect(admitted.checks?.rows[0]).toMatchObject({ required: false });
        expect(admitted.merge).toMatchObject({ nativeState: 'BLOCKED', canMergeWithoutWaiting: true });
        const nullableRequired = TriagePullRequestStatusV1Schema.safeParse({ ...admitted,
            checks: { ...admitted.checks!, rows: [{ ...admitted.checks!.rows[0]!, required: null }], total: 1, passed: 1 } });
        expect(nullableRequired.success).toBe(true);
        if (nullableRequired.success) expect(nullableRequired.data.checks?.rows[0]?.required).toBeNull();
        expect(TriagePullRequestStatusV1Schema.parse({ ...admitted, checks: { ...admitted.checks!,
            state: 'unknown', incomplete: true, failure: { class: 'transient', code: 'native-read-failed' } } }).checks?.failure)
            .toEqual({ class: 'transient', code: 'native-read-failed' });
        expect(TriagePullRequestStatusResultV1Schema.safeParse({ ...admitted, merge: { ...admitted.merge, ready: true } }).success).toBe(false);
        expect(TriagePullRequestStatusResultV1Schema.safeParse({ ...admitted, review: { ...admitted.review, reviewers: [{ name: 'Alice', verb: 'approved' }] } }).success).toBe(false);
        expect(TriagePullRequestStatusResultV1Schema.safeParse({ ...admitted, review: { ...admitted.review, reviewers: [{ id: 'x'.repeat(1000), name: 'Alice', verb: 'approved' }] } }).success).toBe(false);
        expect(TriagePullRequestStatusV1Schema.parse(admitted)).toEqual(TriagePullRequestStatusResultV1Schema.parse(admitted));
    });

    it('preserves unknown versus observed absence and bounded future native labels', () => {
        const input = { ...status(), merge: { state: 'unknown', blocker: null } };
        const unknown = TriagePullRequestStatusV1Schema.parse(input);
        expect(Object.hasOwn(unknown.merge!, 'queue')).toBe(false);
        expect(Object.hasOwn(unknown.merge!, 'autoMerge')).toBe(false);
        const absent = TriagePullRequestStatusV1Schema.parse({ ...input, merge: { ...input.merge, queue: null, autoMerge: { enabled: false, method: null }, nativeState: 'FUTURE_STATE', canMergeWithoutWaiting: null } });
        expect(absent.merge).toMatchObject({ queue: null, autoMerge: { enabled: false }, nativeState: 'FUTURE_STATE', canMergeWithoutWaiting: null });
        expect(TriagePullRequestStatusV1Schema.safeParse({ ...input, merge: { ...input.merge, queue: { id: 'entry', state: null, position: -1 } } }).success).toBe(false);
        expect(TriagePullRequestStatusV1Schema.safeParse({ ...input, merge: { ...input.merge, autoMerge: { enabled: true, method: 'future' } } }).success).toBe(false);
    });

    it('preserves native review-thread rule evidence and publishes a changed requirement', () => {
        const base = status();
        const ruleInput = (reviewThreadResolutionRequired: boolean | null) => ({
            ...base, merge: { ...base.merge, branchRules: { state: 'complete', rows: [
                { type: 'pull_request', reviewThreadResolutionRequired },
            ] } },
        });
        for (const evidence of [true, false, null]) {
            const parsed = TriagePullRequestStatusV1Schema.safeParse(ruleInput(evidence));
            expect(parsed.success).toBe(true);
            if (parsed.success) expect(parsed.data.merge?.branchRules?.rows[0]?.reviewThreadResolutionRequired).toBe(evidence);
        }
        const withRule = (evidence: boolean | null) => TriagePullRequestStatusV1Schema.parse(ruleInput(evidence));
        const previous = withRule(false);
        expect(reconcile(previous, withRule(false)).value).toBe(previous);
        for (const evidence of [true, null]) {
            const next = withRule(evidence);
            expect(next.merge?.branchRules?.rows[0]?.reviewThreadResolutionRequired).toBe(evidence);
            expect(reconcile(previous, next).value).not.toBe(previous);
        }
    });

    it('retains semantic status through repeated fresh successes while advancing the successful clock', () => {
        const previous = status();
        expect(reconcile(null, previous)).toEqual({ value: previous, checkedAtMs: 1 });
        expect(reconcile(null, previous).value).toBe(previous);
        let publications = 0;
        for (let time = 2; time <= 12; time += 1) {
            const result = reconcile(previous, status(time));
            publications += Number(result.value !== previous);
            expect(result.checkedAtMs).toBe(time);
            expect(result.value).toBe(previous);
        }
        expect(publications).toBe(0);
    });

    it('reuses 200 check peers and all other entities for one changed check, including reorder', () => {
        const previous = status();
        const next = status(2, (input) => {
            if (!input.checks) throw new Error('checks fixture missing');
            input.checks.rows[100] = { ...input.checks.rows[100]!, required: null };
            input.checks.rows.reverse();
        });
        if (!previous.checks || !next.checks) throw new Error('checks fixture missing');
        const { value } = reconcile(previous, next);
        const prior = new Map(previous.checks.rows.map((row) => [row.id, row]));
        expect(value.checks?.rows.filter((row) => row !== prior.get(row.id))).toHaveLength(1);
        expect(value.checks?.rows.map((row) => row.id)).toEqual(next.checks.rows.map((row) => row.id));
        expect(value.review).toBe(previous.review);
        expect(value.merge).toBe(previous.merge);
        expect(value.branch).toBe(previous.branch);
        expect(value.facts).toBe(previous.facts);
    });

    it('keys reviewers independently of display names and preserves equal rows through reorder', () => {
        const sameDisplayNames = (input: TriagePullRequestStatusV1) => {
            if (!input.review) throw new Error('review fixture missing');
            // Distinct native principals can have the same display name.
            for (const reviewer of input.review.reviewers) reviewer.name = 'Maintainer';
        };
        const previous = status(1, sameDisplayNames);
        const next = status(2, (input) => {
            sameDisplayNames(input);
            input.review!.reviewers.reverse();
        });
        if (!previous.review || !next.review) throw new Error('review fixture missing');
        const reordered = reconcile(previous, next).value;
        expect(reordered.review?.reviewers[0]).toBe(previous.review.reviewers[1]);
        expect(reordered.review?.reviewers[1]).toBe(previous.review.reviewers[0]);
        const changed = reconcile(previous, status(3, (input) => {
            sameDisplayNames(input);
            input.review!.reviewers.reverse();
            input.review!.reviewers[0] = { ...input.review!.reviewers[0]!, verb: 'approved' };
        })).value;
        expect(changed.review?.reviewers[0]).not.toBe(previous.review.reviewers[1]);
        expect(changed.review?.reviewers[1]).toBe(previous.review.reviewers[0]);
        expect(changed.checks).toBe(previous.checks);
    });

    it('retains surviving keyed rows across membership changes and admits empty or unavailable sections', () => {
        const previous = status();
        const next = status(2, (input) => {
            if (!input.checks) throw new Error('checks fixture missing');
            input.checks.rows = [input.checks.rows[1]!, { id: 'new-check', name: 'New check', state: 'pending' }];
            input.checks = { ...input.checks, total: 2, passed: 1, pending: 1 };
        });
        if (!previous.checks || !next.checks) throw new Error('checks fixture missing');
        const changed = reconcile(previous, next).value;
        expect(changed.checks?.rows[0]).toBe(previous.checks.rows[1]);
        expect(changed.checks?.rows[1]).toEqual({ id: 'new-check', name: 'New check', state: 'pending' });
        const empty = { ...next, checks: { ...next.checks, state: 'none' as const, total: 0, passed: 0, pending: 0, rows: [] } };
        expect(reconcile(changed, empty).value.checks?.rows).toEqual([]);
        const unavailable = { ...empty, checks: null, review: null, merge: null, branch: null, facts: [] };
        const installed = reconcile(empty, unavailable).value;
        expect(installed.checks).toBeNull();
        expect(reconcile(installed, { ...unavailable, observedAtMs: 3 }).value).toBe(installed);
    });

    it('publishes native capability, queue, head, completeness, truncation and real domain time changes', () => {
        const previous = status();
        for (const change of [
            (next: TriagePullRequestStatusV1) => { next.merge = { ...next.merge!, canMergeWithoutWaiting: false }; },
            (next: TriagePullRequestStatusV1) => { next.merge = { ...next.merge!, queue: null }; },
            (next: TriagePullRequestStatusV1) => { delete next.merge!.queue; },
            (next: TriagePullRequestStatusV1) => { next.merge = { ...next.merge!, autoMerge: { enabled: false, method: null } }; },
            (next: TriagePullRequestStatusV1) => { next.branch = { ...next.branch!, headRevision: 'sha-2' }; },
            (next: TriagePullRequestStatusV1) => { next.checks = { ...next.checks!, incomplete: true }; },
            (next: TriagePullRequestStatusV1) => { next.projectionTruncated = true; },
            (next: TriagePullRequestStatusV1) => { next.facts[0] = { ...next.facts[0]!, value: { kind: 'timestamp', atMs: 101, format: 'relative' } }; },
        ]) {
            const next = status(2, change);
            expect(reconcile(previous, next).value).not.toBe(previous);
        }
        const next = status(2, (input) => { input.merge = { ...input.merge!, canMergeWithoutWaiting: false }; });
        const changed = reconcile(previous, next).value;
        expect(changed.merge?.queue).toBe(previous.merge?.queue);
        expect(changed.merge?.autoMerge).toBe(previous.merge?.autoMerge);
        expect(changed.checks).toBe(previous.checks);
    });
});
